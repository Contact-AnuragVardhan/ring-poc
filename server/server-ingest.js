//server\server-ingest.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mediasoup = require("mediasoup");
const { spawn } = require("child_process");
const path = require("path");
const { listCameras, startRingToRtp, getCameraCapabilities } = require("./ring-control");

const dgram = require("dgram");
const fs = require("fs");
const os = require("os");

const LISTEN_IP = process.env.LISTEN_IP || "0.0.0.0";
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || ""; // optional for LAN
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 40000);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || 40100);

const app = express();
app.use(express.static("public"));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let worker;
let router;

const peers = new Map(); // peerId -> { ws, transports, consumers }
const producers = new Map(); // producerId -> { producer, kind, label }

// --- ingest state ---
let ingest = {
  plainTransport: null,
  videoProducer: null,
  ffmpeg: null,
  rtpPort: null,
  ssrc: 22222222,
  payloadType: 102,
  sipSession: null,
  liveCall: null,
  label: null,
  rtpInPort: null,
  rtpSock: null,
  sdpPath: null,
  ringPt: null,
  ringSsrc: null,
  __videoSub: null,
  bytesTimer: null,

  //audio receive path (Ring -> Browser)
  audioTransport: null,
  audioProducer: null,
  audioFfmpeg: null,

  audioPayloadType: 111,     // opus
  audioSsrc: 33333333,

  ringAudioPt: null,
  ringAudioSsrc: null,
  audioRtpInPort: null,
  audioRtpSock: null,
  audioSdpPath: null,
  __audioSub: null,
};

// --- talkback state ---
let talk = {
  cameraId: null,
  producerId: null,
  plainTransport: null,
  consumer: null,
  ffmpeg: null,
  rtpPort: null,
  udpSock: null,
  udpPort: null,
};

// cleanup helper
async function stopTalkBridge() {
  if (talk.consumer) {
    try {
      talk.consumer.close();
    } catch { }
    talk.consumer = null;
  }
  if (talk.plainTransport) {
    try {
      talk.plainTransport.close();
    } catch { }
    talk.plainTransport = null;
  }
  if (talk.udpSock) {
    try {
      talk.udpSock.close();
    } catch { }
    talk.udpSock = null;
  }

  if (talk.ffmpeg) {
    const p = talk.ffmpeg;
    talk.ffmpeg = null;
    await killProcess(p, 1000);
  }
  if (talk._sdpPath) {
    try {
      fs.unlinkSync(talk._sdpPath);
    } catch { }
    talk._sdpPath = null;
  }
  talk.cameraId = null;
  talk.producerId = null;
  talk.rtpPort = null;
  talk.udpPort = null;
}

const mediaCodecs = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];

function send(ws, msg) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  } catch { }
}

function broadcast(msg) {
  for (const p of peers.values()) send(p.ws, msg);
}

function randId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function killProcess(proc, timeoutMs = 800) {
  if (!proc) return;

  await new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const t = setTimeout(finish, timeoutMs);

    proc.once("exit", () => {
      clearTimeout(t);
      finish();
    });

    proc.once("error", () => {
      clearTimeout(t);
      finish();
    });

    try {
      proc.kill("SIGKILL");
    } catch {
      clearTimeout(t);
      finish();
    }
  });
}

// Simple mutex to prevent Stop+Start overlap
let _switchLock = Promise.resolve();
function withSwitchLock(fn) {
  _switchLock = _switchLock.then(fn, fn);
  return _switchLock;
}

async function initMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });

  worker.on("died", () => {
    console.error("mediasoup worker died; exiting");
    process.exit(1);
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log("mediasoup router ready");
}

function writeOpusInputSdp({ ip, port, payloadType, channels = 2, clockRate = 48000 }) {
  // FFmpeg will listen for RTP on `port`
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=MicRtp",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/${clockRate}/${channels}`,
    "a=recvonly",
    "",
  ].join("\n");
}

async function createWebRtcTransport() {
  const transport = await router.createWebRtcTransport({
    listenIps: [
      ANNOUNCED_IP ? { ip: LISTEN_IP, announcedIp: ANNOUNCED_IP } : { ip: LISTEN_IP },
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
  });

  transport.on("dtlsstatechange", (s) => {
    if (s === "closed") transport.close();
  });

  return transport;
}

/**
 * Create a PlainTransport for FFmpeg RTP ingest (H264).
 * Using comedia=true means mediasoup will learn the sender IP/port once packets arrive.
 * Using rtcpMux=true keeps it simpler (only one RTP port).
 */
async function ensureIngestTransport() {
  if (ingest.plainTransport) return ingest.plainTransport;

  const plainTransport = await router.createPlainTransport({
    listenIp: { ip: LISTEN_IP },
    rtcpMux: true,
    comedia: true,
  });

  ingest.plainTransport = plainTransport;
  ingest.rtpPort = plainTransport.tuple.localPort;

  console.log("[ingest] PlainTransport ready", {
    ip: plainTransport.tuple.localIp,
    port: plainTransport.tuple.localPort,
  });

  return plainTransport;
}

async function startIngest() {
  // already running
  if (ingest.ffmpeg || ingest.videoProducer) return;

  const plainTransport = await ensureIngestTransport();

  // Create a mediasoup Producer that matches the RTP we will send from FFmpeg.
  // For H264:
  const rtpParameters = {
    codecs: [
      {
        mimeType: "video/H264",
        payloadType: ingest.payloadType,
        clockRate: 90000,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "42e01f",
          "level-asymmetry-allowed": 1,
        },
      },
    ],
    encodings: [{ ssrc: ingest.ssrc }],
  };

  const videoProducer = await plainTransport.produce({
    kind: "video",
    rtpParameters,
  });

  ingest.videoProducer = videoProducer;

  producers.set(videoProducer.id, { producer: videoProducer, kind: "video", label: "ingest:sample-mp4" });

  videoProducer.on("transportclose", () => {
    producers.delete(videoProducer.id);
  });

  // Start FFmpeg to send RTP (H264) to the PlainTransport port.
  // Put your MP4 at: ./media/sample.mp4 (we'll add volume in docker-compose)
  const inputFile = process.env.INGEST_FILE || "/app/media/sample.mp4";

  //const dstIp = plainTransport.tuple.localIp;     // inside container
  const dstIp = "127.0.0.1";
  const dstPort = plainTransport.tuple.localPort; // inside container

  const ffmpegArgs = [
    "-re",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-stream_loop", "-1",
    "-i", inputFile,

    // video only for milestone 1
    "-an",

    // make it lighter + more browser-friendly
    "-vf", "scale=1280:-2,fps=30",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-profile:v", "baseline",
    "-level", "3.1",
    "-pix_fmt", "yuv420p",

    // longer GOP reduces overhead a bit; keep consistent with fps
    "-g", "60",
    "-keyint_min", "60",

    // cap bitrate (prevents huge bursts + buffering/jitter)
    "-b:v", "1500k",
    "-maxrate", "1500k",
    "-bufsize", "3000k",

    "-f", "rtp",
    "-payload_type", String(ingest.payloadType),
    "-ssrc", String(ingest.ssrc),
    `rtp://${dstIp}:${dstPort}?pkt_size=1200`,
  ];

  console.log("[ingest] starting ffmpeg:", ffmpegArgs.join(" "));
  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });

  ingest.ffmpeg = ffmpeg;

  ffmpeg.stdout.on("data", (d) => console.log("[ffmpeg]", d.toString().trim()));
  ffmpeg.stderr.on("data", (d) => console.log("[ffmpeg]", d.toString().trim()));

  ffmpeg.on("exit", (code, sig) => {
    console.log("[ingest] ffmpeg exited", { code, sig });
    ingest.ffmpeg = null;
  });

  // Tell all clients a new producer exists
  broadcast({ type: "newProducer", data: { producerId: videoProducer.id, kind: "video", label: "ingest:sample-mp4" } });
}

async function stopIngest() {
  //stop mic->ring bridge first
  await stopTalkBridge();

  // 0) Stop receiving RTP events first (most important)
  if (ingest.__videoSub) {
    try { ingest.__videoSub.unsubscribe(); } catch { }
    ingest.__videoSub = null;
  }

  // 1) Stop Ring session (so it stops emitting RTP)
  if (ingest.sipSession) {
    try { ingest.sipSession.stop(); } catch { }
    ingest.sipSession = null;
  }

  if (ingest.liveCall) {
    try { ingest.liveCall.stop?.(); } catch { }
    try { ingest.liveCall.end?.(); } catch { }
    try { ingest.liveCall.camera?.disconnect?.(); } catch { }
    ingest.liveCall = null;
  }

  // 2) Stop FFmpeg and wait a bit for it to really die
  if (ingest.ffmpeg) {
    const p = ingest.ffmpeg;
    ingest.ffmpeg = null;
    await killProcess(p, 1000);
  }

  // 3) Close UDP socket
  if (ingest.rtpSock) {
    try { ingest.rtpSock.close(); } catch { }
    ingest.rtpSock = null;
  }

  // 4) Close mediasoup producer then transport (order matters)
  if (ingest.videoProducer) {
    try { producers.delete(ingest.videoProducer.id); } catch { }
    try { ingest.videoProducer.close(); } catch { }
    ingest.videoProducer = null;
  }

  if (ingest.plainTransport) {
    try { ingest.plainTransport.close(); } catch { }
    ingest.plainTransport = null;
    ingest.rtpPort = null;
  }

  // 5) Cleanup temp SDP file
  if (ingest.sdpPath) {
    try { fs.unlinkSync(ingest.sdpPath); } catch { }
    ingest.sdpPath = null;
  }

  // 6) Timers + flags
  if (ingest.bytesTimer) {
    clearInterval(ingest.bytesTimer);
    ingest.bytesTimer = null;
  }

  ingest.label = null;
  ingest.ringPt = null;
  ingest.ringSsrc = null;
  ingest.rtpInPort = null;

  //audio related cleanup
  if (ingest.__audioSub) {
    try { ingest.__audioSub.unsubscribe(); } catch { }
    ingest.__audioSub = null;
  }

  if (ingest.audioFfmpeg) {
    const p = ingest.audioFfmpeg;
    ingest.audioFfmpeg = null;
    await killProcess(p, 1000);
  }

  if (ingest.audioRtpSock) {
    try { ingest.audioRtpSock.close(); } catch { }
    ingest.audioRtpSock = null;
  }

  if (ingest.audioProducer) {
    try { producers.delete(ingest.audioProducer.id); } catch { }
    try { ingest.audioProducer.close(); } catch { }
    ingest.audioProducer = null;
  }

  if (ingest.audioTransport) {
    try { ingest.audioTransport.close(); } catch { }
    ingest.audioTransport = null;
  }

  if (ingest.audioSdpPath) {
    try { fs.unlinkSync(ingest.audioSdpPath); } catch { }
    ingest.audioSdpPath = null;
  }

  ingest.ringAudioPt = null;
  ingest.ringAudioSsrc = null;
  ingest.audioRtpInPort = null;

  // 7) tiny delay so Ring + OS sockets settle before next start
  await delay(400);

  broadcast({ type: "ingestStopped" });
}

async function startTalkBridge({ cameraId, producerId }) {
  await stopTalkBridge();

  // Talkback in this implementation requires a Ring LiveCall
  // because we use liveCall.sendAudioPacket().
  const liveCall = ingest.liveCall;

  if (!liveCall) {
    throw new Error("Talkback requires ingest.liveCall (startLiveCall path). Start Live first.");
  }
  if (typeof liveCall.sendAudioPacket !== "function") {
    throw new Error("Ring LiveCall does not expose sendAudioPacket(). Talkback not supported on this device/API path.");
  }

  // Optional but usually required to actually hear talkback
  try {
    if (typeof liveCall.activateCameraSpeaker === "function") {
      await liveCall.activateCameraSpeaker();
      console.log("[talk] activateCameraSpeaker() called");
    } else {
      console.log("[talk] liveCall has no activateCameraSpeaker()");
    }
  } catch (e) {
    console.log("[talk] activateCameraSpeaker failed (may still work):", e?.message || e);
  }

  talk.cameraId = cameraId;
  talk.producerId = producerId;

  // 1) Create a PlainTransport that will SEND RTP out from mediasoup to localhost:rtpPort (FFmpeg reads this)
  const pt = await router.createPlainTransport({
    listenIp: { ip: LISTEN_IP },
    rtcpMux: true,
    comedia: false, // we explicitly connect to FFmpeg's listening port
  });
  talk.plainTransport = pt;

  // local port FFmpeg will bind to as its INPUT (mic RTP)
  const rtpPort = 55000 + Math.floor(Math.random() * 5000);
  talk.rtpPort = rtpPort;

  await pt.connect({ ip: "127.0.0.1", port: rtpPort });

  // 2) Consume the mic producer onto this PlainTransport (RTP flows out of pt)
  if (!router.canConsume({ producerId, rtpCapabilities: router.rtpCapabilities })) {
    throw new Error("Cannot consume mic producer (caps mismatch)");
  }

  const consumer = await pt.consume({
    producerId,
    rtpCapabilities: router.rtpCapabilities,
    paused: false,
  });
  talk.consumer = consumer;

  if (consumer.kind !== "audio") {
    throw new Error("startTalk expects an audio producerId");
  }

  const inCodec = consumer.rtpParameters.codecs?.[0];
  if (!inCodec) throw new Error("Mic consumer has no codec info");

  const inPt = inCodec.payloadType;
  const inCh = inCodec.channels ?? 2;
  const inRate = inCodec.clockRate ?? 48000;

  // 3) SDP so FFmpeg can receive the mic RTP from mediasoup
  const sdpIn = writeOpusInputSdp({
    ip: "127.0.0.1",
    port: rtpPort,
    payloadType: inPt,
    channels: inCh,
    clockRate: inRate,
  });

  const sdpPath = path.join(os.tmpdir(), `mic-in-${cameraId}.sdp`);
  fs.writeFileSync(sdpPath, sdpIn);
  talk._sdpPath = sdpPath;

  // 4) NEW: Create UDP receiver that forwards RTP packets into Ring via liveCall.sendAudioPacket()
  const udpPort = 56000 + Math.floor(Math.random() * 5000);
  talk.udpPort = udpPort;

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("listening", () => {
    const a = sock.address();
    console.log("[talk] udp listening", a);
  });
  talk.udpSock = sock;

  sock.on("error", (err) => {
    console.log("[talk] udpSock error:", err?.message || err);
  });

  sock.on("message", (pkt) => {
    try {
      // pkt is a full RTP packet produced by FFmpeg
      liveCall.sendAudioPacket(pkt);
    } catch (e) {
      console.log("[talk] sendAudioPacket error:", e?.message || e);
    }
  });

  await new Promise((resolve) => sock.bind(udpPort, "127.0.0.1", resolve));
  console.log("[talk] UDP forwarder ready on", { udpPort });

  // 5) FFmpeg: input = mic RTP on localhost, output = RTP to localhost udpPort (not to Ring IP!)
  // Ring expects talkback typically Opus mono 48k; keep it consistent.
  // NOTE: Payload type here is "local" (for our UDP packets) - Ring's sendAudioPacket generally accepts RTP bytes.
  const OUT_PT = Number(process.env.RING_TALK_PT || 111);
  const OUT_SSRC = Number(process.env.RING_TALK_SSRC || 55555555);

  const args = [
    "-loglevel", "info",
    "-protocol_whitelist", "file,udp,rtp",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-analyzeduration", "2000000",
    "-probesize", "2000000",
    "-i", sdpPath,

    "-vn",
    "-ac", "1",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", "32k",

    "-f", "rtp",
    "-payload_type", String(OUT_PT),
    "-ssrc", String(OUT_SSRC),
    `rtp://127.0.0.1:${udpPort}?pkt_size=1200`,
  ];

  console.log("[talk] ffmpeg:", args.join(" "));
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  talk.ffmpeg = ff;

  ff.stderr.on("data", (d) => console.log("[talk ffmpeg]", d.toString().trim()));
  ff.on("exit", (code, sig) => console.log("[talk ffmpeg] exited", { code, sig }));

  console.log("[talk] bridging mic -> ring (via liveCall.sendAudioPacket)");
}

function toBuffer(x) {
  if (!x) return null;
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x);
  if (x.buffer && x.byteLength != null) {
    return Buffer.from(x.buffer, x.byteOffset ?? 0, x.byteLength);
  }
  return null;
}

function buildRtpPacketBytes(evt) {
  const h = evt?.header;
  const payload = toBuffer(evt?.payload);

  if (!h || !payload) {
    return null;
  }
  /*if ((h.csrcLength && h.csrcLength !== 0) || h.extension) {
    console.log("csrcLength is not null and not 0 or extension is not null");
    return null;
  }*/

  const version = (h.version ?? 2) & 0x03;
  const padding = 0;
  const extension = 0;
  const csrcLength = 0;

  const headerLen = 12;
  const headerBuf = Buffer.alloc(headerLen);

  const b0 =
    (version << 6) |
    (padding << 5) |
    (extension << 4) |
    (csrcLength & 0x0f);

  const b1 = ((h.marker ? 1 : 0) << 7) | (h.payloadType & 0x7f);

  headerBuf[0] = b0;
  headerBuf[1] = b1;
  headerBuf.writeUInt16BE(h.sequenceNumber & 0xffff, 2);
  headerBuf.writeUInt32BE(h.timestamp >>> 0, 4);
  headerBuf.writeUInt32BE(h.ssrc >>> 0, 8);

  return Buffer.concat([headerBuf, payload]);
}

let printedKeys = false;

function getRawRtpBytes(evt) {
  if (!evt) return null;

  if (!printedKeys) {
    printedKeys = true;
    console.log("[ring] evt keys:", Object.keys(evt));
    console.log("[ring] header keys:", Object.keys(evt.header || {}));
    console.log("[ring] has raw packet fields:", {
      packet: Buffer.isBuffer(evt.packet),
      raw: Buffer.isBuffer(evt.raw),
    });
  }

  // If ring-client-api already gives raw packet bytes, use it
  if (Buffer.isBuffer(evt.packet)) return evt.packet;
  if (Buffer.isBuffer(evt.raw)) return evt.raw;

  return buildRtpPacketBytes(evt);
}

function writeRtpSdp({ ip, port, payloadType }) {
  // Minimal SDP for H264 over RTP
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=RingRtp",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=video ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} H264/90000`,
    "a=recvonly",
    "",
  ].join("\n");
}

function writeAudioRtpSdp({ ip, port, payloadType }) {
  // Minimal SDP for *unknown* audio RTP payload type from Ring.
  // FFmpeg will probe it (we’ll also increase probesize/analyzeduration).
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=RingAudioRtp",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${payloadType}`,
    audioRtpMapLine(payloadType),
    "a=recvonly",
    "",
  ].join("\n");
}

function audioRtpMapLine(pt) {
  // Best-effort mapping for common RTP PTs
  if (pt === 0) return "a=rtpmap:0 PCMU/8000";
  if (pt === 8) return "a=rtpmap:8 PCMA/8000";
  // Many Ring devices use Opus on dynamic PT; this is a reasonable POC default
  return `a=rtpmap:${pt} opus/48000/2`;
}

async function startAudio(req, res, cameraId) {
  const audioTransport = await router.createPlainTransport({
    listenIp: { ip: LISTEN_IP },
    rtcpMux: true,
    comedia: true,
  });
  ingest.audioTransport = audioTransport;

  const audioRtpParameters = {
    codecs: [
      {
        mimeType: "audio/opus",
        payloadType: ingest.audioPayloadType, // 111
        clockRate: 48000,
        channels: 2,
      },
    ],
    encodings: [{ ssrc: ingest.audioSsrc }],
    rtcp: { cname: "ring-audio" },
  };

  const audioProducer = await audioTransport.produce({
    kind: "audio",
    rtpParameters: audioRtpParameters,
  });

  ingest.audioProducer = audioProducer;

  producers.set(audioProducer.id, {
    producer: audioProducer,
    kind: "audio",
    label: `ring-audio:${cameraId}`,
  });

  audioProducer.on("transportclose", () => {
    producers.delete(audioProducer.id);
  });

  broadcast({
    type: "newProducer",
    data: { producerId: audioProducer.id, kind: "audio", label: `ring-audio:${cameraId}` },
  });

  return audioProducer;
}

async function subscribeRingAudioRtp(cameraId) {
  if (!ingest.liveCall?.onAudioRtp) {
    console.log("[ring] liveCall has no onAudioRtp (listen-only audio or different API path)");
    return;
  }
  if (!ingest.audioTransport) {
    throw new Error("audioTransport not ready");
  }

  ingest.audioRtpInPort = 51000 + Math.floor(Math.random() * 10000);
  ingest.audioRtpSock = dgram.createSocket("udp4");

  ingest.audioRtpSock.on("error", (e) => {
    console.log("[ring-audio] udp error:", e?.message || e);
  });

  const dstAudioPort = ingest.audioTransport.tuple.localPort;

  const audioSub = ingest.liveCall.onAudioRtp.subscribe((evt) => {
    if ((ingest._audioDbg = (ingest._audioDbg || 0) + 1) % 200 === 0) {
      console.log("[ring-audio] pkt", {
        ringAudioPt: ingest.ringAudioPt,
        evtPt: evt?.header?.payloadType,
        hasFfmpeg: !!ingest.audioFfmpeg
      });
    }
    const pkt = getRawRtpBytes(evt);
    if (!pkt) return;

    if (ingest.ringAudioPt == null) {
      ingest.ringAudioPt = evt?.header?.payloadType;
      ingest.ringAudioSsrc = evt?.header?.ssrc;

      if (typeof ingest.ringAudioPt !== "number") return;

      const ip = "127.0.0.1";
      const sdp = writeAudioRtpSdp({
        ip,
        port: ingest.audioRtpInPort,
        payloadType: ingest.ringAudioPt,
      });

      ingest.audioSdpPath = path.join(os.tmpdir(), `ring-audio-${cameraId}.sdp`);
      fs.writeFileSync(ingest.audioSdpPath, sdp);

      const args = [
        "-loglevel", "info",
        "-protocol_whitelist", "file,udp,rtp",
        "-fflags", "nobuffer",
        "-flags", "low_delay",
        "-analyzeduration", "2000000",
        "-probesize", "2000000",
        "-i", ingest.audioSdpPath,

        "-vn",
        "-ac", "2",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "48k",

        "-f", "rtp",
        "-payload_type", String(ingest.audioPayloadType),
        "-ssrc", String(ingest.audioSsrc),
        `rtp://127.0.0.1:${dstAudioPort}?pkt_size=1200`,
      ];

      const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      ingest.audioFfmpeg = ff;

      ff.stderr.on("data", (d) => console.log("[ring-audio->ffmpeg]", d.toString().trim()));
      ff.on("exit", (code, sig) => console.log("[ring-audio->ffmpeg] exited", { code, sig }));
    }

    ingest.audioRtpSock.send(pkt, ingest.audioRtpInPort, "127.0.0.1");
  });

  ingest.__audioSub = audioSub;
}


// --- REST endpoints for ingest ---
app.get("/api/ring/cameras", async (req, res) => {
  try {
    const cams = await listCameras();
    res.json({
      ok: true,
      cameras: cams.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        type: c.deviceType,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// start live -> Ring -> FFmpeg -> mediasoup
app.post("/api/ring/cameras/:id/live/start", async (req, res) => {
  return withSwitchLock(async () => {
    try {
      const cameraId = req.params.id;

      // stop previous ingest if running
      await stopIngest();

      ingest.ringPt = null;
      ingest.ringSsrc = null;
      ingest.sdpPath = null;
      ingest.bytesTimer = null;

      ingest.ringAudioPt = null;
      ingest.ringAudioSsrc = null;
      ingest.audioRtpInPort = null;

      // 1) create mediasoup plain transport
      const plainTransport = await router.createPlainTransport({
        listenIp: { ip: LISTEN_IP },
        rtcpMux: true,
        comedia: true,
      });

      ingest.plainTransport = plainTransport;
      ingest.rtpPort = plainTransport.tuple.localPort;

      // 2) create a mediasoup producer that matches your codec config
      // (you already use H264 in mediaCodecs, keep it consistent)
      const rtpParameters = {
        codecs: [
          {
            mimeType: "video/H264",
            payloadType: ingest.payloadType,
            clockRate: 90000,
            parameters: {
              "packetization-mode": 1,
              "profile-level-id": "42e01f",
              "level-asymmetry-allowed": 1,
            },
          },
        ],
        encodings: [{ ssrc: ingest.ssrc }],
        rtcp: { cname: "ring-ingest" },
      };

      const videoProducer = await plainTransport.produce({
        kind: "video",
        rtpParameters,
      });

      ingest.videoProducer = videoProducer;
      ingest.label = `ring:${cameraId}`;

      producers.set(videoProducer.id, {
        producer: videoProducer,
        kind: "video",
        label: ingest.label,
      });

      videoProducer.on("transportclose", () => {
        producers.delete(videoProducer.id);
      });

      // 3) start Ring SIP session, and tell it to ffmpeg->RTP into mediasoup port
      const dstIp = "127.0.0.1";
      const dstPort = plainTransport.tuple.localPort;

      const ffmpegOptions = {
        // video args (ring-client-api will build the input for the SIP session)
        video: [
          "-an",
          "-vf", "scale=1280:-2,fps=30",
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          "-profile:v", "baseline",
          "-level", "3.1",
          "-pix_fmt", "yuv420p",
          "-g", "60",
          "-keyint_min", "60",
          "-b:v", "1500k",
          "-maxrate", "1500k",
          "-bufsize", "3000k",
        ],
        // NOTE: per SipSession.start() typing, `output` is required :contentReference[oaicite:1]{index=1}
        output: [
          "-f", "rtp",
          "-payload_type", String(ingest.payloadType),
          "-ssrc", String(ingest.ssrc),
          `rtp://${dstIp}:${dstPort}?pkt_size=1200`,
        ],
      };

      const started = await startRingToRtp({ cameraId, ffmpegOptions });
      if (started.sipSession) {
        ingest.sipSession = started.sipSession;
      } else if (started.liveCall) {
        ingest.liveCall = started.liveCall;

        console.log(Object.keys(ingest.liveCall || {}));
        console.log("[ring] videoSplitter:", ingest.liveCall.videoSplitter?.constructor?.name);
        console.log("[ring] videoSplitter has pipe:", typeof ingest.liveCall.videoSplitter?.pipe);

        function dumpMethods(obj, label) {
          if (!obj) return;
          const proto = Object.getPrototypeOf(obj);
          const methods = Object.getOwnPropertyNames(proto).filter(k => typeof obj[k] === "function");
          console.log(`[ring-debug] ${label} keys:`, Object.keys(obj));
          console.log(`[ring-debug] ${label} methods:`, methods.filter(m => /audio|talk|speaker|mic|rtp|return|send/i.test(m)));
        }

        dumpMethods(ingest.liveCall, "liveCall");
        dumpMethods(ingest.liveCall?.sipSession, "liveCall.sipSession");
        dumpMethods(ingest.sipSession, "sipSession");

        console.log("[ring-debug] liveCall.sipSession?", !!ingest.liveCall?.sipSession);
        console.log("[ring-debug] sipSession keys:", Object.keys(ingest.liveCall?.sipSession || {}));

        ingest.rtpInPort = 50000 + Math.floor(Math.random() * 10000);
        ingest.rtpSock = dgram.createSocket("udp4");

        let bytesIn = 0;
        let dropped = 0;

        const sub = ingest.liveCall.onVideoRtp.subscribe((evt) => {
          const pkt = getRawRtpBytes(evt);

          if (!pkt) {
            //ingest.rtpSock.send(pkt, ingest.rtpInPort, "127.0.0.1");
            if ((dropped++ % 200) === 0) {
              console.log("[ring] dropping packet", {
                payloadType: evt?.header?.payloadType,
                csrcLength: evt?.header?.csrcLength,
                extension: evt?.header?.extension,
                payloadIsBuffer: Buffer.isBuffer(evt?.payload),
                payloadLen: evt?.payload?.length,
                hasPacket: Buffer.isBuffer(evt?.packet),
                hasRaw: Buffer.isBuffer(evt?.raw),
              });
            }
            return;
          }
          // First packet: learn PT/SSRC, write SDP, start FFmpeg
          if (ingest.ringPt == null) {
            ingest.ringPt = evt?.header?.payloadType;
            ingest.ringSsrc = evt?.header?.ssrc;

            if (typeof ingest.ringPt !== "number") {
              console.log("[ring->ffmpeg] first packet missing payloadType");
              return;
            }

            console.log("[ring] first header flags:", {
              payloadType: evt.header.payloadType,
              ssrc: evt.header.ssrc,
              csrcLength: evt.header.csrcLength,
              extension: evt.header.extension,
              extensionLength: evt.header.extensionLength,
            });

            const ip = "127.0.0.1";
            const sdp = writeRtpSdp({ ip, port: ingest.rtpInPort, payloadType: ingest.ringPt });

            ingest.sdpPath = path.join(os.tmpdir(), `ring-${cameraId}.sdp`);
            fs.writeFileSync(ingest.sdpPath, sdp);

            const args = [
              "-loglevel", "info",
              "-protocol_whitelist", "file,udp,rtp",
              "-analyzeduration", "2000000",
              "-probesize", "2000000",
              "-fflags", "nobuffer",
              "-flags", "low_delay",
              "-i", ingest.sdpPath,

              // re-encode (safe)
              "-an",
              "-vf", "scale=1280:-2,fps=30",
              "-c:v", "libx264",
              "-preset", "ultrafast",
              "-tune", "zerolatency",
              "-profile:v", "baseline",
              "-level", "3.1",
              "-pix_fmt", "yuv420p",
              "-g", "60",
              "-keyint_min", "60",
              "-b:v", "1500k",
              "-maxrate", "1500k",
              "-bufsize", "3000k",

              "-f", "rtp",
              "-payload_type", String(ingest.payloadType), // output PT for mediasoup
              "-ssrc", String(ingest.ssrc),                // output SSRC for mediasoup
              `rtp://127.0.0.1:${dstPort}?pkt_size=1200`,
            ];

            console.log("[ring->ffmpeg] SDP:", ingest.sdpPath);
            console.log("[ring->ffmpeg] spawn:", args.join(" "));

            const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
            ingest.ffmpeg = ff;

            ff.stderr.on("data", (d) => console.log("[ring->ffmpeg]", d.toString().trim()));
            ff.on("error", (err) => console.error("[ring->ffmpeg] spawn error", err));
            ff.on("exit", (code, sig) => console.log("[ring->ffmpeg] exited", { code, sig }));

            ingest.bytesTimer = setInterval(() => {
              console.log("[ring->ffmpeg] bytesIn", bytesIn, "ringPt", ingest.ringPt, "ringSsrc", ingest.ringSsrc);
            }, 2000);
          }

          bytesIn += pkt.length;
          ingest.rtpSock.send(pkt, ingest.rtpInPort, "127.0.0.1");
        });

        ingest.__videoSub = sub;
      }

      // 4) notify clients like you already do
      broadcast({
        type: "newProducer",
        data: { producerId: videoProducer.id, kind: "video", label: ingest.label },
      });

      await startAudio(req, res, cameraId);

      if (started.liveCall) {
        await subscribeRingAudioRtp(cameraId);
      }

      res.json({ ok: true, cameraId, name: started.name, producerId: videoProducer.id });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
});

app.post("/api/ingest/start", async (req, res) => {
  try {
    await startIngest();
    return res.json({ ok: true, producerId: ingest.videoProducer?.id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/ingest/stop", async (req, res) => {
  try {
    await withSwitchLock(async () => {
      await stopIngest();
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/ring/cameras/:id/capabilities", async (req, res) => {
  try {
    const caps = await getCameraCapabilities(req.params.id);
    res.json({ ok: true, caps });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/ring/live/stop", async (req, res) => {
  try {
    await withSwitchLock(async () => {
      await stopIngest(); // this already stops ring session + closes producers
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// --- WebSocket signaling (consume only; no webcam produce in this file) ---
wss.on("connection", (ws) => {
  const peerId = randId();
  peers.set(peerId, {
    ws,
    transports: new Map(),
    consumers: new Map(),
    producers: new Map(),
  });

  send(ws, { type: "welcome", peerId });

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const peer = peers.get(peerId);
    if (!peer) return;

    try {
      switch (msg.type) {
        case "getRouterRtpCapabilities":
          send(ws, { type: "routerRtpCapabilities", data: router.rtpCapabilities });
          break;

        case "createTransport": {
          const transport = await createWebRtcTransport();
          peer.transports.set(transport.id, transport);

          send(ws, {
            type: "transportCreated",
            data: {
              direction: msg.data?.direction,
              transportId: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          });
          break;
        }

        case "connectTransport": {
          const transport = peer.transports.get(msg.data.transportId);
          if (!transport) throw new Error("transport not found");
          await transport.connect({ dtlsParameters: msg.data.dtlsParameters });
          send(ws, { type: "transportConnected", data: { transportId: transport.id } });
          break;
        }

        case "getProducers": {
          const list = [];
          for (const [producerId, { kind, label }] of producers.entries()) {
            list.push({ producerId, kind, label });
          }
          send(ws, { type: "producers", data: list });
          break;
        }

        case "consume": {
          const { transportId, producerId, rtpCapabilities } = msg.data;

          if (!router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error("router cannot consume this producer");
          }

          const transport = peer.transports.get(transportId);
          if (!transport) throw new Error("transport not found");

          const consumer = await transport.consume({
            producerId,
            rtpCapabilities,
            paused: true,
          });

          peer.consumers.set(consumer.id, consumer);

          consumer.on("transportclose", () => peer.consumers.delete(consumer.id));

          send(ws, {
            type: "consumed",
            data: {
              consumerId: consumer.id,
              producerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
            },
          });
          break;
        }

        case "resume": {
          const consumer = peer.consumers.get(msg.data.consumerId);
          if (!consumer) throw new Error("consumer not found");
          await consumer.resume();
          send(ws, { type: "resumed", data: { consumerId: consumer.id } });
          break;
        }

        case "produce": {
          const { transportId, kind, rtpParameters, appData, reqId } = msg.data;
          const transport = peer.transports.get(transportId);
          if (!transport) {
            throw new Error("transport not found");
          }

          const producer = await transport.produce({ kind, rtpParameters, appData });
          peer.producers.set(producer.id, producer);

          send(ws, { type: "produced", data: { producerId: producer.id, reqId } });
          break;
        }

        case "startTalk": {
          const { cameraId, producerId } = msg.data || {};
          if (!cameraId || !producerId) {
            throw new Error("startTalk requires cameraId and producerId");
          }
          await startTalkBridge({ cameraId, producerId });
          send(ws, { type: "talkStatus", data: { ok: true, state: "bridging", cameraId } });
          break;
        }

        case "stopTalk": {
          await stopTalkBridge();
          send(ws, { type: "talkStatus", data: { ok: true, state: "stopped" } });
          break;
        }
      }
    } catch (e) {
      send(ws, { type: "error", error: String(e.message || e) });
    }
  });

  ws.on("close", () => {
    const peer = peers.get(peerId);
    if (!peer) return;
    for (const t of peer.transports.values()) t.close();
    for (const c of peer.consumers.values()) c.close();
    for (const p of peer.producers.values()) p.close();
    peers.delete(peerId);
  });
});

server.listen(3000, async () => {
  await initMediasoup();
  console.log("Open ingest UI: http://localhost:3000/ingest.html");
});
