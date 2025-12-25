// server/services/talkService.js
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const talk = require("../state/talkState");
const ingest = require("../state/ingestState");
const { LISTEN_IP } = require("../config/env");
const { killProcess } = require("../utils/process");
const { writeOpusInputSdp } = require("../utils/sdp");

async function stopTalkBridge() {
  if (talk.consumer) {
    try { talk.consumer.close(); } catch {}
    talk.consumer = null;
  }
  if (talk.plainTransport) {
    try { talk.plainTransport.close(); } catch {}
    talk.plainTransport = null;
  }
  if (talk.udpSock) {
    try { talk.udpSock.close(); } catch {}
    talk.udpSock = null;
  }

  if (talk.ffmpeg) {
    const p = talk.ffmpeg;
    talk.ffmpeg = null;
    await killProcess(p, 1000);
  }
  if (talk._sdpPath) {
    try { fs.unlinkSync(talk._sdpPath); } catch {}
    talk._sdpPath = null;
  }
  talk.cameraId = null;
  talk.producerId = null;
  talk.rtpPort = null;
  talk.udpPort = null;
}

async function startTalkBridge(router, { cameraId, producerId }) {
  await stopTalkBridge();

  const liveCall = ingest.liveCall;
  if (!liveCall) {
    throw new Error("Talkback requires ingest.liveCall (startLiveCall path). Start Live first.");
  }
  if (typeof liveCall.sendAudioPacket !== "function") {
    throw new Error("Ring LiveCall does not expose sendAudioPacket(). Talkback not supported on this device/API path.");
  }

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

  // 1) PlainTransport for mediasoup -> FFmpeg input
  const pt = await router.createPlainTransport({
    listenIp: { ip: LISTEN_IP },
    rtcpMux: true,
    comedia: false,
  });
  talk.plainTransport = pt;

  const rtpPort = 55000 + Math.floor(Math.random() * 5000);
  talk.rtpPort = rtpPort;

  await pt.connect({ ip: "127.0.0.1", port: rtpPort });

  // 2) Consume mic producer onto that transport
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

  // 3) SDP for FFmpeg to read RTP from mediasoup
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

  // 4) UDP receiver -> liveCall.sendAudioPacket()
  const udpPort = 56000 + Math.floor(Math.random() * 5000);
  talk.udpPort = udpPort;

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sock.on("listening", () => console.log("[talk] udp listening", sock.address()));
  sock.on("error", (err) => console.log("[talk] udpSock error:", err?.message || err));

  sock.on("message", (pkt) => {
    try {
      liveCall.sendAudioPacket(pkt);
    } catch (e) {
      console.log("[talk] sendAudioPacket error:", e?.message || e);
    }
  });

  talk.udpSock = sock;
  await new Promise((resolve) => sock.bind(udpPort, "127.0.0.1", resolve));
  console.log("[talk] UDP forwarder ready on", { udpPort });

  // 5) FFmpeg mic RTP -> RTP packets to UDP forwarder
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

module.exports = { startTalkBridge, stopTalkBridge };
