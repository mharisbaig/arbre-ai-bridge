/**
 * Arbre IT Solutions — AI Bridge WebSocket Media Server
 *
 * Bridges Twilio Media Streams <--> Gemini Live API
 * Deploy this on Render.com (free tier) as a Web Service.
 *
 * Flow:
 *   Twilio (μ-law 8kHz) → decode → PCM 16kHz → Gemini Live API
 *   Gemini Live API (PCM 24kHz) → downsample → μ-law 8kHz → Twilio
 */

import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';
import http from 'http';
import { config } from 'dotenv';

config();

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8080', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-live-2.5-flash-preview';

if (!GEMINI_API_KEY) {
  console.error('[ArbreBridge] FATAL: GEMINI_API_KEY environment variable is required.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ─── Arbre IT Solutions System Prompt ─────────────────────────────────────────

const ARBRE_SYSTEM_PROMPT = `You are Arbre, a professional and helpful AI voice assistant for Arbre IT Solutions, 
a leading IT services company based in Karachi, Pakistan.

Your job is to help callers with inquiries about:
- IT Support & Infrastructure (hardware, networking, servers)
- PABX & IP Telephony Systems (Zycoo, Cisco, Yealink)
- Cybersecurity Solutions (Fortinet, firewall audits, monitoring)
- CCTV & Solar Surveillance Systems
- Cloud Migration & SaaS Consulting
- Managed IT Services
- Access Control Systems

Guidelines:
- Be professional, warm, and concise — this is a phone call, so keep responses brief (2-3 sentences max).
- If asked about pricing, say packages start from PKR 5,000/month and offer to have a specialist call back.
- For urgent IT issues, offer emergency support at +92 313 2689511.
- Business hours: Monday–Saturday, 9 AM – 7 PM PKT.
- Address: G-17 Friends Shopping Mall, Korangi 5, Karachi, Pakistan.
- Always offer to connect the caller with a human specialist (Haris Baig) if needed.
- Speak naturally and clearly, as if on a real phone call.`;

// ─── Audio Codec Helpers (μ-law ↔ PCM) ───────────────────────────────────────

/**
 * Decode a single μ-law encoded byte to a 16-bit signed PCM sample.
 * ITU-T G.711 μ-law decode.
 */
function mulawDecode(mulaw) {
  mulaw = ~mulaw & 0xFF;
  const sign = mulaw & 0x80;
  const exponent = (mulaw & 0x70) >> 4;
  const mantissa = mulaw & 0x0F;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

/**
 * Encode a 16-bit signed PCM sample to a μ-law byte.
 * ITU-T G.711 μ-law encode.
 */
function mulawEncode(sample) {
  const BIAS = 132;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/**
 * Convert a Buffer of 8-bit μ-law samples to a Buffer of 16-bit PCM samples (LE).
 * 1 byte in → 2 bytes out.
 */
function mulawBufferToPCM16(mulawBuffer) {
  const out = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    out.writeInt16LE(mulawDecode(mulawBuffer[i]), i * 2);
  }
  return out;
}

/**
 * Convert a Buffer of 16-bit PCM samples (LE) to a Buffer of 8-bit μ-law samples.
 * 2 bytes in → 1 byte out.
 */
function pcm16ToMulawBuffer(pcmBuffer) {
  const samples = Math.floor(pcmBuffer.length / 2);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = mulawEncode(pcmBuffer.readInt16LE(i * 2));
  }
  return out;
}

/**
 * Upsample 8kHz 16-bit PCM → 16kHz 16-bit PCM (2× linear interpolation).
 * Gemini Live API requires 16kHz input.
 */
function upsample8to16kHz(buf) {
  const samples = Math.floor(buf.length / 2);
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const s0 = buf.readInt16LE(i * 2);
    const s1 = (i + 1 < samples) ? buf.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0, i * 4);
    out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }
  return out;
}

/**
 * Downsample 24kHz 16-bit PCM → 8kHz 16-bit PCM (3× decimation with averaging).
 * Gemini Live API outputs at 24kHz; Twilio requires 8kHz.
 */
function downsample24to8kHz(buf) {
  const inSamples = Math.floor(buf.length / 2);
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const base = i * 6;
    const s0 = buf.readInt16LE(base);
    const s1 = (base + 2 < buf.length) ? buf.readInt16LE(base + 2) : s0;
    const s2 = (base + 4 < buf.length) ? buf.readInt16LE(base + 4) : s1;
    // Average 3 samples for basic low-pass anti-aliasing
    out.writeInt16LE(Math.round((s0 + s1 + s2) / 3), i * 2);
  }
  return out;
}

// ─── HTTP Server (Health Check + WebSocket host) ──────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'arbre-ai-bridge',
      version: '1.0.0',
      model: GEMINI_MODEL
    }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

// ─── WebSocket Server at /media (Twilio Media Streams endpoint) ───────────────

const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', async (ws, req) => {
  const remoteIp = req.socket.remoteAddress;
  console.log(`[ArbreBridge] New Twilio Media Stream connection from ${remoteIp}`);

  let streamSid = null;
  let callSid = null;
  let geminiSession = null;
  let isGeminiReady = false;

  // ── Initialize Gemini Live Session ──────────────────────────────────────────
  try {
    geminiSession = await ai.live.connect({
      model: GEMINI_MODEL,
      callbacks: {
        onopen: () => {
          isGeminiReady = true;
          console.log(`[ArbreBridge] ✅ Gemini Live session open (call: ${callSid})`);
        },

        onmessage: async (message) => {
          try {
            // Process audio parts from Gemini's response
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const mimeType = part.inlineData.mimeType || '';
                const rawPCM = Buffer.from(part.inlineData.data, 'base64');

                let pcm8Buffer;
                if (mimeType.includes('rate=24000') || mimeType.includes('24000')) {
                  // Gemini default: 24kHz → downsample to 8kHz
                  pcm8Buffer = downsample24to8kHz(rawPCM);
                } else if (mimeType.includes('rate=16000') || mimeType.includes('16000')) {
                  // 16kHz → downsample to 8kHz (take every other sample)
                  const outSamples = Math.floor(rawPCM.length / 4);
                  pcm8Buffer = Buffer.alloc(outSamples * 2);
                  for (let i = 0; i < outSamples; i++) {
                    pcm8Buffer.writeInt16LE(rawPCM.readInt16LE(i * 4), i * 2);
                  }
                } else {
                  // Assume 24kHz if unspecified (Gemini default)
                  pcm8Buffer = downsample24to8kHz(rawPCM);
                }

                const mulawBuffer = pcm16ToMulawBuffer(pcm8Buffer);

                if (ws.readyState === ws.OPEN && streamSid) {
                  ws.send(JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload: mulawBuffer.toString('base64') }
                  }));
                }
              }
            }

            if (message.serverContent?.turnComplete) {
              console.log(`[ArbreBridge] Gemini turn complete (call: ${callSid})`);
            }
          } catch (err) {
            console.error('[ArbreBridge] Error sending Gemini audio to Twilio:', err.message);
          }
        },

        onerror: (err) => {
          console.error('[ArbreBridge] Gemini Live error:', err);
        },

        onclose: (event) => {
          isGeminiReady = false;
          console.log(`[ArbreBridge] Gemini session closed (code: ${event?.code})`);
        },
      },

      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: ARBRE_SYSTEM_PROMPT }]
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Aoede' } // Available: Puck, Charon, Kore, Fenrir, Aoede
          }
        }
      }
    });

    console.log('[ArbreBridge] Gemini Live session initialized');
  } catch (err) {
    console.error('[ArbreBridge] FATAL: Failed to initialize Gemini Live session:', err.message);
    ws.close(1011, 'Gemini initialization failed');
    return;
  }

  // ── Handle Twilio Media Stream Messages ─────────────────────────────────────
  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage.toString());

      switch (data.event) {
        // ── Twilio connected ─────────────────────────────────────────────────
        case 'connected':
          console.log('[ArbreBridge] Twilio signaled: connected');
          break;

        // ── Stream started: send greeting ────────────────────────────────────
        case 'start':
          streamSid = data.streamSid;
          callSid = data.start?.callSid || 'unknown';
          console.log(`[ArbreBridge] Stream started — SID: ${streamSid}, Call: ${callSid}`);

          // Prompt Gemini to greet the caller
          if (geminiSession && isGeminiReady) {
            try {
              geminiSession.sendClientContent({
                turns: [{
                  role: 'user',
                  parts: [{
                    text: 'A customer has just connected to the call. Please greet them warmly, introduce yourself as the Arbre IT Solutions AI assistant, and ask how you can help them today.'
                  }]
                }],
                turnComplete: true
              });
            } catch (e) {
              console.warn('[ArbreBridge] Could not send greeting prompt:', e.message);
            }
          }
          break;

        // ── Inbound audio from caller → forward to Gemini ───────────────────
        case 'media':
          if (!data.media?.payload || !geminiSession || !isGeminiReady) break;

          try {
            // Twilio sends: base64 μ-law 8kHz audio
            const mulawBuffer = Buffer.from(data.media.payload, 'base64');
            // Step 1: μ-law → PCM 16-bit 8kHz
            const pcm8Buffer = mulawBufferToPCM16(mulawBuffer);
            // Step 2: 8kHz → 16kHz (Gemini requirement)
            const pcm16Buffer = upsample8to16kHz(pcm8Buffer);

            geminiSession.sendRealtimeInput({
              audio: {
                data: pcm16Buffer.toString('base64'),
                mimeType: 'audio/pcm;rate=16000'
              }
            });
          } catch (e) {
            console.warn('[ArbreBridge] Error forwarding audio to Gemini:', e.message);
          }
          break;

        // ── Call ended ───────────────────────────────────────────────────────
        case 'stop':
          console.log(`[ArbreBridge] Stream stopped — SID: ${streamSid}`);
          if (geminiSession) {
            try { geminiSession.close(); } catch (_) {}
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('[ArbreBridge] Failed to parse Twilio message:', err.message);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[ArbreBridge] WebSocket closed (code: ${code}, stream: ${streamSid})`);
    if (geminiSession) {
      try { geminiSession.close(); } catch (_) {}
    }
  });

  ws.on('error', (err) => {
    console.error(`[ArbreBridge] WebSocket error (stream: ${streamSid}):`, err.message);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║        Arbre AI Bridge — WebSocket Media Server        ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║  Port    : ${PORT.toString().padEnd(44)}║`);
  console.log(`║  Model   : ${GEMINI_MODEL.padEnd(44)}║`);
  console.log(`║  WS Path : /media                                      ║`);
  console.log(`║  Health  : /health                                      ║`);
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[ArbreBridge] SIGTERM received — shutting down gracefully');
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => {
    console.log('[ArbreBridge] Server closed');
    process.exit(0);
  });
});
