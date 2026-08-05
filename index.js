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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';

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

// ─── HTTP Server (Health Check + TwiML Webhook + Outbound Call API) ──────────

const server = http.createServer(async (req, res) => {
  // Enable CORS headers for API requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlPath = req.url ? req.url.split('?')[0] : '/';

  // 1. Health Check
  if (urlPath === '/health' || urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'arbre-ai-bridge',
      version: '1.0.0',
      model: GEMINI_MODEL,
      hasTwilioConfig: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    }));
    return;
  }

  // 2. Twilio Incoming Voice Webhook (TwiML Generator)
  if (urlPath === '/twiml/incoming' || urlPath === '/twilioVoiceCall') {
    const host = req.headers.host || 'arbre-ai-bridge.onrender.com';
    const streamUrl = `wss://${host}/media`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Welcome to Arbre IT Solutions. Connecting your call to our AI voice assistant stream.</Say>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="company" value="Arbre IT Solutions" />
    </Stream>
  </Connect>
</Response>`;

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml);
    return;
  }

  // 3. Outbound Call Trigger API (/api/trigger-call)
  if (urlPath === '/api/trigger-call' && req.method === 'POST') {
    let bodyText = '';
    req.on('data', chunk => { bodyText += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText || '{}');
        const phoneNumber = (body.phoneNumber || '').trim();
        const customerName = (body.customerName || 'Valued Customer').trim();
        const topic = (body.topic || 'IT Support Inquiry').trim();

        if (!phoneNumber) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Phone number is required.' }));
          return;
        }

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const twilioNumber = process.env.TWILIO_PHONE_NUMBER || '+16056277176';
        const host = req.headers.host || 'arbre-ai-bridge.onrender.com';
        const streamUrl = `wss://${host}/media`;

        if (!accountSid || !authToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: 'Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) not set in Render environment variables.'
          }));
          return;
        }

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Hello ${customerName}. Connecting your call to Arbre IT Solutions AI voice assistant.</Say>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="customerName" value="${customerName}" />
      <Parameter name="topic" value="${topic}" />
    </Stream>
  </Connect>
</Response>`;

        const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
        const params = new URLSearchParams();
        params.append('To', phoneNumber);
        params.append('From', twilioNumber);
        params.append('Twiml', twiml);

        const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });

        const responseData = await twilioRes.json();

        if (twilioRes.ok && responseData.sid) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            callSid: responseData.sid,
            message: `Outbound Twilio call placed successfully! Dialing ${phoneNumber}...`
          }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            message: responseData.message || 'Twilio API error placing outbound call.'
          }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    });
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
  let hasSentGreeting = false;

  // Helper to trigger Gemini greeting as soon as session and stream are ready
  const triggerGreetingIfReady = () => {
    if (!geminiSession || !isGeminiReady || hasSentGreeting || !streamSid) return;
    hasSentGreeting = true;
    console.log(`[ArbreBridge] 📢 Triggering initial Gemini AI greeting prompt (Call: ${callSid}, Stream: ${streamSid})`);
    try {
      geminiSession.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{
            text: 'A customer has just connected to the phone call. Please speak out loud immediately to greet them warmly: "Hello! Thank you for calling Arbre IT Solutions. My name is Arbre, your AI assistant. How can I help you today?"'
          }]
        }],
        turnComplete: true
      });
    } catch (e) {
      console.warn('[ArbreBridge] Could not send greeting prompt:', e.message);
    }
  };

  // ── Initialize Gemini Live Session ──────────────────────────────────────────
  try {
    geminiSession = await ai.live.connect({
      model: GEMINI_MODEL,
      callbacks: {
        onopen: () => {
          isGeminiReady = true;
          console.log(`[ArbreBridge] ✅ Gemini Live session open (call: ${callSid})`);
          triggerGreetingIfReady();
        },

        onmessage: async (message) => {
          try {
            console.log('[ArbreBridge] Gemini msg keys:', Object.keys(message || {}).join(', '));

            // Collect inlineData parts from all possible response structures
            const audioParts = [];

            // Structure 1: serverContent.modelTurn.parts
            const parts = message.serverContent?.modelTurn?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) audioParts.push(part.inlineData);
            }

            // Structure 2: candidates[0].content.parts
            const candidates = message.candidates || [];
            for (const candidate of candidates) {
              for (const part of (candidate.content?.parts || [])) {
                if (part.inlineData?.data) audioParts.push(part.inlineData);
              }
            }

            // Structure 3: data field directly
            if (message.data) {
              audioParts.push({ data: message.data, mimeType: 'audio/pcm;rate=24000' });
            }

            if (audioParts.length > 0) {
              console.log(`[ArbreBridge] Received ${audioParts.length} audio part(s) from Gemini`);
            }

            for (const inlineData of audioParts) {
              const mimeType = inlineData.mimeType || '';
              const rawPCM = Buffer.from(inlineData.data, 'base64');

              let pcm8Buffer;
              if (mimeType.includes('16000')) {
                const outSamples = Math.floor(rawPCM.length / 4);
                pcm8Buffer = Buffer.alloc(outSamples * 2);
                for (let i = 0; i < outSamples; i++) {
                  pcm8Buffer.writeInt16LE(rawPCM.readInt16LE(i * 4), i * 2);
                }
              } else {
                // Default: assume 24kHz
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

            if (message.serverContent?.turnComplete) {
              console.log(`[ArbreBridge] Gemini turn complete (call: ${callSid})`);
            }
          } catch (err) {
            console.error('[ArbreBridge] Error processing Gemini message:', err.message, err.stack);
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
            prebuiltVoiceConfig: { voiceName: 'Aoede' }
          }
        }
      }
    });

    console.log('[ArbreBridge] Gemini Live session initialization started');
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
        case 'connected':
          console.log('[ArbreBridge] Twilio signaled: connected');
          break;

        case 'start':
          streamSid = data.streamSid;
          callSid = data.start?.callSid || 'unknown';
          console.log(`[ArbreBridge] Stream started — SID: ${streamSid}, Call: ${callSid}`);
          triggerGreetingIfReady();
          break;

        case 'media':
          if (!data.media?.payload || !geminiSession || !isGeminiReady) break;

          try {
            const mulawBuffer = Buffer.from(data.media.payload, 'base64');
            const pcm8Buffer = mulawBufferToPCM16(mulawBuffer);
            const pcm16Buffer = upsample8to16kHz(pcm8Buffer);

            const base64Audio = pcm16Buffer.toString('base64');

            // Correct API: sendRealtimeInput({ media: { mimeType, data } })
            geminiSession.sendRealtimeInput({
              media: {
                mimeType: 'audio/pcm;rate=16000',
                data: base64Audio
              }
            });
          } catch (e) {
            console.warn('[ArbreBridge] Error forwarding audio to Gemini:', e.message);
          }
          break;

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
