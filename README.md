# Ring + mediasoup Console (POC)

A proof-of-concept that streams **Ring camera live video + audio** into a browser using:

**Ring → RTP → FFmpeg → mediasoup → WebRTC (browser)**  
…and supports **hold-to-talk** (browser mic → mediasoup → FFmpeg → Ring talkback) when the device/API supports it.

It also includes a **History** view to list Ring motion/ding events and play recordings (when available).

---

## Features

- ✅ List Ring cameras
- ✅ Start a live stream for a selected camera
- ✅ Browser receives live video (and attempts audio)
- ✅ Hold-to-talk (two-way audio) via mic RTP → FFmpeg → Ring (when supported)
- ✅ History: list events and play recordings for `recorded=true` + `recording_status=ready`
- ✅ Clean UI: Live / History / Logs tabs

---

## Repo Structure (important)

```
ring-poc/
  docker-compose.yml
  media/                       # optional local media mount (demo file)
  server/
    Dockerfile
    .dockerignore              # MUST be committed
    .env                       # NOT committed (secrets)
    server-ingest.js           # main server
    ring-control.js            # Ring API integration
    public/
      ingest.html              # UI page
      ingest-client.js         # client source (bundled)
      ingest-client-bundle.js  # built output (created by build-client.js)
```

> Your UI is served by Express as static assets from `server/public`.

---

## Requirements

- Docker Desktop (WSL2 backend is fine)
- A Ring account with a **refresh token**
- Ports available:
  - `3000/tcp` (web UI + websocket)
  - `40000-40100/udp` (mediasoup RTC ports)

---

## Environment Variables

Create this file:

```
server/.env
```

Minimum required:

```env
RING_REFRESH_TOKEN=YOUR_RING_REFRESH_TOKEN_HERE
```

Optional:

```env
RING_DEBUG=0
LISTEN_IP=0.0.0.0
ANNOUNCED_IP=              # optional (LAN/WAN scenarios)
RTC_MIN_PORT=40000
RTC_MAX_PORT=40100

# Talkback output RTP config (advanced / optional)
RING_TALK_PT=111
RING_TALK_SSRC=55555555
```

### Where is `RING_REFRESH_TOKEN` used?
- `server/ring-control.js` reads `process.env.RING_REFRESH_TOKEN`
- Docker Compose injects it at runtime via `env_file: ./server/.env`

---

## Security Notes (important)

✅ **Do not commit** `server/.env`  
✅ **Do commit** `server/.dockerignore`  

Your `.dockerignore` should include:

```dockerignore
.env
node_modules
temp
*.log
```

This ensures secrets are never baked into the Docker image.

---

## Run (Docker Compose)

From repo root (`ring-poc/`):

```bash
docker compose build --no-cache
docker compose up
```

Open:

- UI: http://localhost:3000/ingest.html

---

## How it works (high level)

### Live streaming
1. Server starts a Ring live session:
   - either SIP session (`createSipSession`) or LiveCall (`startLiveCall`)
2. Incoming Ring RTP is forwarded into a local UDP port
3. FFmpeg reads that RTP (via a generated SDP file) and re-encodes to a known H264 profile
4. FFmpeg outputs RTP to a mediasoup `PlainTransport`
5. Browser connects to mediasoup via WebSocket signaling and consumes producers

### Audio (Ring → Browser)
- When LiveCall provides `onAudioRtp`, server subscribes and repeats a similar RTP→FFmpeg→PlainTransport flow.
- The server then creates an `audioProducer` (Opus) and the browser consumes it.

### Talkback (Browser → Ring)
1. Browser captures microphone and produces audio to mediasoup (`sendTransport.produce`)
2. Server consumes mic audio to a `PlainTransport` and writes an SDP for FFmpeg
3. FFmpeg transcodes mic audio to Opus and sends RTP to a local UDP receiver
4. UDP receiver forwards RTP packets to Ring via `liveCall.sendAudioPacket(pkt)` (if supported)

> Talkback support varies by Ring device + API path.

---

## UI Usage

1. Click **Load** to fetch cameras
2. Select a camera
3. Click **Connect**
4. Watch the live stream in **Live** tab
5. If supported, hold **🎙 Hold to Talk**
6. Go to **History** tab and click **Refresh** to load events
7. Click **Play** on recordings marked READY

---

## API Endpoints

### Cameras
- `GET /api/ring/cameras`
- `GET /api/ring/cameras/:id/capabilities`

### Live
- `POST /api/ring/cameras/:id/live/start`
- `POST /api/ingest/stop`

### History / Recordings
- `GET /api/ring/cameras/:id/history?limit=25`
- `GET /api/ring/cameras/:id/recordings/:eventId` (redirects to URL or streams MP4)

---

## Troubleshooting

### “Missing env RING_REFRESH_TOKEN”
- Ensure `server/.env` exists
- Ensure `docker-compose.yml` includes:

```yaml
env_file:
  - ./server/.env
```

- Rebuild & restart:

```bash
docker compose down
docker compose up --build
```

### No live video
- Check server logs for:
  - `[ring] first header flags`
  - `[ring->ffmpeg] spawn: ...`
- Ensure FFmpeg is installed (it is in the Dockerfile)
- Some Ring devices don’t provide RTP via the same method; inspect `ring-control.js` logs (camera methods dump)

### Talkback doesn’t work
- Talkback requires:
  - `ingest.liveCall` path AND
  - `liveCall.sendAudioPacket` to exist
- If you see: `Talkback not supported on this device/API path`, your camera/account API path likely doesn’t expose it.

### History clips not playable
A clip is playable only when:
- `recorded === true`
- `recording_status === "ready"`

Subscriptions and Ring plan affect this.

---

## Development Notes

- Client UI source: `server/public/ingest-client.js`
- HTML page: `server/public/ingest.html`
- Bundle: served as `/ingest-client-bundle.js` (built by `npm run build:client`)
- Server entry: `server/server-ingest.js`

---

## Disclaimer

##This project is a POC for personal/educational use. Ring device capabilities, APIs, and behavior vary by model/account and may change over time.
