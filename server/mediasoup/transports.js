// server/mediasoup/transports.js
const { LISTEN_IP, ANNOUNCED_IP } = require("../config/env");

async function createWebRtcTransport(router) {
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

module.exports = { createWebRtcTransport };
