// server/services/ringAudioService.js
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ingest = require("../state/ingestState");
const { producers, peers } = require("../state/peerState");
const { broadcast } = require("../utils/ws");
const { LISTEN_IP } = require("../config/env");
const { writeAudioRtpSdp } = require("../utils/sdp");
const { getRawRtpBytes } = require("../utils/rtp");

async function startAudio(router, cameraId) {
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
        payloadType: ingest.audioPayloadType,
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

  broadcast(peers, {
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
        hasFfmpeg: !!ingest.audioFfmpeg,
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

module.exports = { startAudio, subscribeRingAudioRtp };
