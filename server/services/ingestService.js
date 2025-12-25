// server/services/ingestService.js
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ingest = require("../state/ingestState");
const { producers, peers } = require("../state/peerState");
const { broadcast } = require("../utils/ws");
const { delay } = require("../utils/async");
const { killProcess } = require("../utils/process");
const { LISTEN_IP } = require("../config/env");
const { writeRtpSdp } = require("../utils/sdp");
const { getRawRtpBytes } = require("../utils/rtp");

const { stopTalkBridge } = require("./talkService");

async function stopIngest() {
  // stop mic->ring bridge first
  await stopTalkBridge();

  // 0) Stop receiving RTP events first
  if (ingest.__videoSub) {
    try { ingest.__videoSub.unsubscribe(); } catch {}
    ingest.__videoSub = null;
  }

  // 1) Stop Ring session
  if (ingest.sipSession) {
    try { ingest.sipSession.stop(); } catch {}
    ingest.sipSession = null;
  }

  if (ingest.liveCall) {
    try { ingest.liveCall.stop?.(); } catch {}
    try { ingest.liveCall.end?.(); } catch {}
    try { ingest.liveCall.camera?.disconnect?.(); } catch {}
    ingest.liveCall = null;
  }

  // 2) Stop FFmpeg
  if (ingest.ffmpeg) {
    const p = ingest.ffmpeg;
    ingest.ffmpeg = null;
    await killProcess(p, 1000);
  }

  // 3) Close UDP socket
  if (ingest.rtpSock) {
    try { ingest.rtpSock.close(); } catch {}
    ingest.rtpSock = null;
  }

  // 4) Close mediasoup producer then transport
  if (ingest.videoProducer) {
    try { producers.delete(ingest.videoProducer.id); } catch {}
    try { ingest.videoProducer.close(); } catch {}
    ingest.videoProducer = null;
  }

  if (ingest.plainTransport) {
    try { ingest.plainTransport.close(); } catch {}
    ingest.plainTransport = null;
    ingest.rtpPort = null;
  }

  // 5) Cleanup temp SDP
  if (ingest.sdpPath) {
    try { fs.unlinkSync(ingest.sdpPath); } catch {}
    ingest.sdpPath = null;
  }

  // 6) timers + flags
  if (ingest.bytesTimer) {
    clearInterval(ingest.bytesTimer);
    ingest.bytesTimer = null;
  }

  ingest.label = null;
  ingest.ringPt = null;
  ingest.ringSsrc = null;
  ingest.rtpInPort = null;

  // --- audio cleanup ---
  if (ingest.__audioSub) {
    try { ingest.__audioSub.unsubscribe(); } catch {}
    ingest.__audioSub = null;
  }

  if (ingest.audioFfmpeg) {
    const p = ingest.audioFfmpeg;
    ingest.audioFfmpeg = null;
    await killProcess(p, 1000);
  }

  if (ingest.audioRtpSock) {
    try { ingest.audioRtpSock.close(); } catch {}
    ingest.audioRtpSock = null;
  }

  if (ingest.audioProducer) {
    try { producers.delete(ingest.audioProducer.id); } catch {}
    try { ingest.audioProducer.close(); } catch {}
    ingest.audioProducer = null;
  }

  if (ingest.audioTransport) {
    try { ingest.audioTransport.close(); } catch {}
    ingest.audioTransport = null;
  }

  if (ingest.audioSdpPath) {
    try { fs.unlinkSync(ingest.audioSdpPath); } catch {}
    ingest.audioSdpPath = null;
  }

  ingest.ringAudioPt = null;
  ingest.ringAudioSsrc = null;
  ingest.audioRtpInPort = null;

  await delay(400);

  broadcast(peers, { type: "ingestStopped" });
}

async function startLiveRingToMediasoup(router, { cameraId, startRingToRtp }) {
  // reset ring-related fields (your original)
  ingest.ringPt = null;
  ingest.ringSsrc = null;
  ingest.sdpPath = null;
  ingest.bytesTimer = null;

  ingest.ringAudioPt = null;
  ingest.ringAudioSsrc = null;
  ingest.audioRtpInPort = null;

  // 1) mediasoup plain transport
  const plainTransport = await router.createPlainTransport({
    listenIp: { ip: LISTEN_IP },
    rtcpMux: true,
    comedia: true,
  });

  ingest.plainTransport = plainTransport;
  ingest.rtpPort = plainTransport.tuple.localPort;

  // 2) mediasoup producer
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

  // 3) start Ring session (your original)
  const dstIp = "127.0.0.1";
  const dstPort = plainTransport.tuple.localPort;

  const ffmpegOptions = {
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

    // your debugging dumps kept (unchanged)
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
          "-payload_type", String(ingest.payloadType),
          "-ssrc", String(ingest.ssrc),
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

  // 4) notify clients
  broadcast(peers, {
    type: "newProducer",
    data: { producerId: videoProducer.id, kind: "video", label: ingest.label },
  });

  return { started, videoProducer };
}

module.exports = {
  stopIngest,
  startLiveRingToMediasoup,
};
