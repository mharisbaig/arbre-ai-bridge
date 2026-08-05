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
import WebSocket from 'ws';
import http from 'http';
import { config } from 'dotenv';

config();

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8080', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Supported Live API models
const VALID_LIVE_MODELS = [
  'gemini-2.5-flash-preview-native-audio-dialog',
  'gemini-3.1-flash-live-preview',
  'gemini-2.0-flash-live-001',
];
const _envModel = process.env.GEMINI_MODEL || '';
const GEMINI_MODEL = VALID_LIVE_MODELS.includes(_envModel) ? _envModel : 'gemini-2.5-flash-preview-native-audio-dialog';

// Raw WebSocket endpoint — no SDK, no versioning issues
const GEMINI_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

if (!GEMINI_API_KEY) {
  console.error('[ArbreBridge] FATAL: GEMINI_API_KEY environment variable is required.');
  process.exit(1);
}

/**
 * Hang up an active Twilio call programmatically via Twilio REST API.
 */
async function hangupTwilioCall(callSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!callSid || callSid === 'unknown' || !accountSid || !authToken) {
    console.warn(`[ArbreBridge] Cannot hangup call Sid ${callSid} — Twilio credentials or callSid missing.`);
    return;
  }

  try {
    console.log(`[ArbreBridge] 🛑 Programmatically hanging up Twilio Call: ${callSid}`);
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const params = new URLSearchParams();
    params.append('Status', 'completed');

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (res.ok) {
      console.log(`[ArbreBridge] ✅ Twilio call ${callSid} successfully terminated.`);
    } else {
      const errText = await res.text();
      console.error(`[ArbreBridge] Failed to hang up call ${callSid}:`, errText);
    }
  } catch (err) {
    console.error('[ArbreBridge] Error in hangupTwilioCall:', err.message);
  }
}

// ─── Arbre IT Solutions System Prompt ─────────────────────────────────────────

const ARBRE_SYSTEM_PROMPT = `You are Arbre, a professional, bilingual AI voice assistant for Arbre IT Solutions, 
a leading IT services provider based in Karachi, Pakistan.

CRITICAL VOICE & INTERRUPTION RULES:
1. STOP IMMEDIATELY WHEN USER SPEAKS: If the customer speaks or cuts in while you are talking, STOP TALKING IMMEDIATELY and listen. Never talk over the customer.
2. SHORT & CONCISE RESPONSES: Keep spoken answers very short (1 to 2 short sentences max). Never deliver long monologues on the phone.
3. DYNAMIC BILINGUAL ADAPTATION:
   - If the caller speaks Urdu (or Roman Urdu), respond in polite, concise Urdu.
   - If the caller speaks English, respond in clear English.
   - If mixed (Urdish), respond in natural Pakistani business tone.
4. INITIAL GREETING: Start with a short greeting: "Hello! Welcome to Arbre IT Solutions. Assalamu Alaikum! Main aap ki kya madad kar sakta hoon?"

Your job is to assist callers with:
- IT Support & Infrastructure (hardware, networking, servers, helpdesk)
- PABX & IP Telephony Systems (Zycoo, Cisco, Yealink)
- Cybersecurity Solutions (Fortinet, firewall audits, monitoring)
- CCTV & Solar Surveillance Systems
- Cloud Migration & SaaS Consulting
- Managed IT Services
- Access Control & Biometric Systems

Guidelines:
- Keep answers under 15-20 words per response so the caller can interact easily.
- If asked about pricing, state that packages start from PKR 5,000/month and offer a specialist callback.
- For urgent IT issues, provide emergency support at +92 313 2689511.
- Business hours: Monday–Saturday, 9 AM – 7 PM PKT.
- Address: G-17 Friends Shopping Mall, Korangi 5, Karachi, Pakistan.
- Always offer to connect the caller with a human specialist (Haris Baig) if needed.
- IMPORTANT CALL DROP RULE: When concluding the call or after saying goodbye ("Goodbye!", "Allah Hafiz!", "Shukriya!", "Have a great day!"), end your text message with "[GOODBYE]".`;

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
    const recordingCallbackUrl = `https://${host}/twiml/recording-status`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Recording channels="dual" recordingStatusCallback="${recordingCallbackUrl}" />
  </Start>
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

  // 2b. Recording Status Callback
  if (urlPath === '/twiml/recording-status' && req.method === 'POST') {
    let bodyText = '';
    req.on('data', chunk => { bodyText += chunk; });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(bodyText);
        const recordingUrl = params.get('RecordingUrl');
        const recordingSid = params.get('RecordingSid');
        const callSid = params.get('CallSid');
        const duration = params.get('RecordingDuration');
        console.log(`[ArbreBridge] 🎙️ CALL RECORDING SAVED! Call: ${callSid}, Recording: ${recordingSid}, Duration: ${duration}s, URL: ${recordingUrl}.mp3`);
      } catch (err) {
        console.error('[ArbreBridge] Recording callback parse error:', err.message);
      }
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response/>');
    });
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
        const recordingCallbackUrl = `https://${host}/twiml/recording-status`;

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
  <Start>
    <Recording channels="dual" recordingStatusCallback="${recordingCallbackUrl}" />
  </Start>
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

  const cleanPath = urlPath.replace(/\/$/, '') || '/';

  // 4. Fetch Live Call Recordings API (/api/recordings)
  if ((cleanPath === '/api/recordings' || cleanPath === '/recordings') && req.method === 'GET') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        message: 'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be configured in Render environment variables.'
      }));
      return;
    }

    try {
      const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings.json?PageSize=25`, {
        headers: { 'Authorization': authHeader }
      });

      const data = await twilioRes.json();
      const recordings = (data.recordings || []).map(r => ({
        id: r.sid,
        recordingSid: r.sid,
        callSid: r.call_sid,
        duration: (r.duration || '0') + 's',
        dateCreated: r.date_created,
        mediaUrl: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${r.sid}.mp3`,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: recordings.length, recordings }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, message: `Endpoint ${urlPath} not found on Arbre AI Bridge.` }));
});

// ─── WebSocket Server at /media (Twilio Media Streams endpoint) ───────────────

const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', async (ws, req) => {
  const remoteIp = req.socket.remoteAddress;
  console.log(`[ArbreBridge] New Twilio Media Stream connection from ${remoteIp}`);

  let streamSid = null;
  let callSid = null;
  let geminiWs = null;        // Raw WebSocket to Gemini
  let isGeminiReady = false;
  let hasSentGreeting = false;

  // ── Send raw JSON message to Gemini WebSocket ──────────────────────────────
  const sendToGemini = (obj) => {
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.send(JSON.stringify(obj));
    }
  };

  // ── Trigger greeting once stream + Gemini session are both ready ───────────
  const triggerGreetingIfReady = () => {
    if (!isGeminiReady || hasSentGreeting || !streamSid) return;
    hasSentGreeting = true;
    console.log(`[ArbreBridge] 📢 Sending bilingual greeting prompt to Gemini (Call: ${callSid})`);
    sendToGemini({
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text: 'A customer has connected to the call. Greet them immediately in a warm bilingual voice: "Hello! Welcome to Arbre IT Solutions. Assalamu Alaikum! Main aap ki kya madad kar sakta hoon?"' }]
        }],
        turnComplete: true
      }
    });
  };

  // ── Open raw WebSocket to Gemini BidiGenerateContent ──────────────────────
  const geminiUrl = `${GEMINI_WS_BASE}?key=${GEMINI_API_KEY}`;
  geminiWs = new WebSocket(geminiUrl);

  geminiWs.on('open', () => {
    console.log(`[ArbreBridge] ✅ Gemini WS open — sending setup (model: ${GEMINI_MODEL})`);
    // Send setup message — must be first message
    sendToGemini({
      setup: {
        model: `models/${GEMINI_MODEL}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } }
          }
        },
        systemInstruction: {
          parts: [{ text: ARBRE_SYSTEM_PROMPT }]
        }
      }
    });
  });

  let audioChunkCount = 0;

  geminiWs.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      const keys = Object.keys(msg).join(', ');

      // Setup complete — session is ready
      if (msg.setupComplete !== undefined) {
        isGeminiReady = true;
        console.log('[ArbreBridge] ✅ Gemini setupComplete — session ready');
        triggerGreetingIfReady();
        return;
      }

      // Check for user interruption signal -> CLEAR Twilio audio playback queue immediately!
      if (msg.serverContent?.interrupted) {
        console.log('[ArbreBridge] ⚡ Gemini detected user barge-in! Clearing Twilio audio queue.');
        if (ws.readyState === ws.OPEN && streamSid) {
          ws.send(JSON.stringify({
            event: 'clear',
            streamSid: streamSid
          }));
        }
      }

      // Collect audio parts & text from all known response structures
      const audioParts = [];
      const textParts = [];

      // Structure A: serverContent.modelTurn.parts
      for (const part of (msg.serverContent?.modelTurn?.parts || [])) {
        if (part.inlineData?.data) audioParts.push(part.inlineData);
        if (part.text) textParts.push(part.text);
      }
      // Structure B: candidates[0].content.parts
      for (const cand of (msg.candidates || [])) {
        for (const part of (cand.content?.parts || [])) {
          if (part.inlineData?.data) audioParts.push(part.inlineData);
          if (part.text) textParts.push(part.text);
        }
      }

      if (textParts.length > 0) {
        const fullText = textParts.join(' ');
        console.log(`[ArbreBridge] 💬 Gemini text: "${fullText}"`);

        // Check if Gemini indicated goodbye or call completion
        const lower = fullText.toLowerCase();
        if (lower.includes('[goodbye]') || lower.includes('goodbye') || lower.includes('have a great day') || lower.includes('bye for now') || lower.includes('have a wonderful day')) {
          console.log(`[ArbreBridge] 🏁 Call conclusion detected! Scheduling automatic Twilio call drop for ${callSid} in 3.5s...`);
          setTimeout(() => {
            hangupTwilioCall(callSid);
          }, 3500);
        }
      }

      if (audioParts.length > 0) {
        console.log(`[ArbreBridge] 🔊 ${audioParts.length} audio part(s) from Gemini → forwarding to Twilio`);
      } else if (textParts.length === 0 && !msg.serverContent?.turnComplete) {
        console.log(`[ArbreBridge] Gemini msg: ${keys}`);
      }

      for (const inlineData of audioParts) {
        const mimeType = inlineData.mimeType || '';
        const rawPCM = Buffer.from(inlineData.data, 'base64');

        const pcm8Buffer = mimeType.includes('16000')
          ? (() => { const n = Math.floor(rawPCM.length / 4); const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(rawPCM.readInt16LE(i * 4), i * 2); return b; })()
          : downsample24to8kHz(rawPCM);

        const mulawBuffer = pcm16ToMulawBuffer(pcm8Buffer);

        if (ws.readyState === ws.OPEN && streamSid) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: mulawBuffer.toString('base64') }
          }));
        }
      }

      if (msg.serverContent?.turnComplete) {
        console.log('[ArbreBridge] ✅ Gemini model turn complete');
      }
    } catch (err) {
      console.error('[ArbreBridge] Error processing Gemini message:', err.message);
    }
  });

  geminiWs.on('close', (code, reason) => {
    isGeminiReady = false;
    console.log(`[ArbreBridge] Gemini WS closed (code: ${code}, reason: ${reason?.toString() || 'none'})`);
  });

  geminiWs.on('error', (err) => {
    console.error('[ArbreBridge] Gemini WS error:', err.message);
  });

  // ── Handle Twilio Media Stream Messages ───────────────────────────────────
  ws.on('message', async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage.toString());

      switch (data.event) {
        case 'connected':
          console.log('[ArbreBridge] Twilio: connected');
          break;

        case 'start':
          streamSid = data.streamSid;
          callSid = data.start?.callSid || 'unknown';
          console.log(`[ArbreBridge] Stream started — SID: ${streamSid}, Call: ${callSid}`);
          triggerGreetingIfReady();
          break;

        case 'media': {
          if (!data.media?.payload || !isGeminiReady) break;
          const mulawBuffer = Buffer.from(data.media.payload, 'base64');
          const pcm8Buffer = mulawBufferToPCM16(mulawBuffer);
          const pcm16Buffer = upsample8to16kHz(pcm8Buffer);
          const base64Audio = pcm16Buffer.toString('base64');
          
          audioChunkCount++;
          if (audioChunkCount % 50 === 0) {
            console.log(`[ArbreBridge] 🎙️ Forwarded ${audioChunkCount} audio chunks from user to Gemini`);
          }

          sendToGemini({
            realtimeInput: {
              audio: {
                data: base64Audio,
                mimeType: 'audio/pcm;rate=16000'
              }
            }
          });
          break;
        }

        case 'stop':
          console.log(`[ArbreBridge] Stream stopped — SID: ${streamSid}`);
          if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
          break;

        default:
          break;
      }
    } catch (err) {
      console.error('[ArbreBridge] Failed to parse Twilio message:', err.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[ArbreBridge] Twilio WS closed (code: ${code}, stream: ${streamSid})`);
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });

  ws.on('error', (err) => {
    console.error(`[ArbreBridge] Twilio WS error:`, err.message);
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
