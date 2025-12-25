// server/mediasoup/init.js
const mediasoup = require("mediasoup");
const { RTC_MIN_PORT, RTC_MAX_PORT } = require("../config/env");

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

async function initMediasoup() {
  const worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });

  worker.on("died", () => {
    console.error("mediasoup worker died; exiting");
    process.exit(1);
  });

  const router = await worker.createRouter({ mediaCodecs });
  console.log("mediasoup router ready");

  return { worker, router, mediaCodecs };
}

module.exports = { initMediasoup };
