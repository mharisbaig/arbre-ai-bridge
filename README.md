# Arbre AI Bridge — Gemini Live API WebSocket Server

This Node.js server bridges **Twilio Media Streams** with **Google Gemini Live API** to power
real-time AI voice calls for Arbre IT Solutions.

## How It Works

```
Phone Call → Twilio → Firebase Webhook → TwiML → wss://your-render-url/media
                                                           ↓
                                              [This Server — AI Bridge]
                                                           ↓
                                                 Gemini Live API
                                                           ↓
                                              Voice response → Twilio → Caller
```

## Audio Pipeline

| Stage | Format | Rate |
|-------|--------|------|
| Twilio → Server | μ-law (G.711) | 8 kHz |
| Server → Gemini | PCM 16-bit LE | 16 kHz |
| Gemini → Server | PCM 16-bit LE | 24 kHz |
| Server → Twilio | μ-law (G.711) | 8 kHz |

## Deploy to Render.com (Free)

### Step 1: Push to GitHub
Make sure your project (or just the `server/ai-bridge/` folder) is on GitHub.

### Step 2: Create Render Web Service
1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Set **Root Directory** to `server/ai-bridge`
4. Build Command: `npm install`
5. Start Command: `node index.js`

### Step 3: Set Environment Variables
In Render Dashboard → **Environment**:
```
GEMINI_API_KEY = your_gemini_api_key_from_aistudio.google.com
GEMINI_MODEL   = gemini-live-2.5-flash-preview
```

### Step 4: Deploy
Click **Deploy** — your WebSocket URL will be:
```
wss://arbre-ai-bridge.onrender.com/media
```

## Configure Firebase Function (Twilio Webhook)

After deploying to Render, update your Firebase Function environment to use the new WebSocket URL:

```bash
# In your project root:
firebase functions:config:set twilio.stream_url="wss://arbre-ai-bridge.onrender.com/media"
firebase deploy --only functions
```

Or set the `TWILIO_STREAM_URL` environment variable in Firebase Console:
- Firebase Console → Functions → `twilioVoiceCall` → Environment variables
- Add: `TWILIO_STREAM_URL = wss://arbre-ai-bridge.onrender.com/media`

## Configure Twilio Console

1. Go to [Twilio Console](https://console.twilio.com) → Phone Numbers
2. Select **+16056277176**
3. Under **Voice & Fax → A CALL COMES IN**:
   - Type: **Webhook**
   - URL: `https://us-central1-arbre-fd916.cloudfunctions.net/twilioVoiceCall`
   - Method: **HTTP POST**
4. Click **Save**

## Run Locally for Testing

```bash
cd server/ai-bridge
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
npm install
npm start
```

Then use [ngrok](https://ngrok.com) to expose port 8080:
```bash
ngrok http 8080
# Update Twilio webhook to your ngrok URL
```

## Health Check

```
GET https://arbre-ai-bridge.onrender.com/health
→ { "status": "ok", "service": "arbre-ai-bridge", "model": "gemini-live-2.5-flash-preview" }
```

## Voice Customization

Edit the `ARBRE_SYSTEM_PROMPT` in `index.js` to change the AI assistant's personality.
Available Gemini voices: `Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede` (current).

## ⚠️ Free Tier Cold Starts

Render.com free tier spins down after 15 minutes of inactivity.
The **first call** after inactivity may experience a 30–60 second delay.

To fix this:
- Upgrade to Render **Starter plan** ($7/month) for always-on service
- Or use a free keep-alive service like [cron-job.org](https://cron-job.org) to ping `/health` every 10 minutes
