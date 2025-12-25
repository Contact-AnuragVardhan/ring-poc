// server/ws/signaling.js
const { peers, producers } = require("../state/peerState");
const { randId, send } = require("../utils/ws");
const { createWebRtcTransport } = require("../mediasoup/transports");
const { startTalkBridge, stopTalkBridge } = require("../services/talkService");

function attachSignaling(wss, ms) {
  const { router } = ms;

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
            const transport = await createWebRtcTransport(router);
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
            if (!transport) throw new Error("transport not found");

            const producer = await transport.produce({ kind, rtpParameters, appData });
            peer.producers.set(producer.id, producer);

            send(ws, { type: "produced", data: { producerId: producer.id, reqId } });
            break;
          }

          case "startTalk": {
            const { cameraId, producerId } = msg.data || {};
            if (!cameraId || !producerId) throw new Error("startTalk requires cameraId and producerId");
            await startTalkBridge(router, { cameraId, producerId });
            send(ws, { type: "talkStatus", data: { ok: true, state: "bridging", cameraId } });
            break;
          }

          case "stopTalk":
            await stopTalkBridge();
            send(ws, { type: "talkStatus", data: { ok: true, state: "stopped" } });
            break;
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
}

module.exports = { attachSignaling };
