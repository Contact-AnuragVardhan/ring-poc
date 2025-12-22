const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const mediasoup = require("mediasoup");

const LISTEN_IP = process.env.LISTEN_IP || "0.0.0.0";
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || ""; // set this (see steps)
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 40000);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || 40100);

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let worker;
let router;

const peers = new Map(); // peerId -> { ws, transports, producers, consumers }

const mediaCodecs = [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1
        }
    }
];

function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}

async function initMediasoup() {
    worker = await mediasoup.createWorker({
        logLevel: "warn",
        rtcMinPort: RTC_MIN_PORT,
        rtcMaxPort: RTC_MAX_PORT
    });

    worker.on("died", () => {
        console.error("mediasoup worker died; exiting");
        process.exit(1);
    });

    router = await worker.createRouter({ mediaCodecs });
    console.log("mediasoup router ready");
}

// NOTE: If your mediasoup version warns that listenIps is deprecated,
// switch to the newer “listenInfos/listenInfo” style (see note at bottom). :contentReference[oaicite:3]{index=3}
async function createWebRtcTransport() {
    const transport = await router.createWebRtcTransport({
        listenIps: [
            ANNOUNCED_IP
                ? { ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }
                : { ip: LISTEN_IP }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: 1_000_000
    });

    return transport;
}

function randId() {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

wss.on("connection", (ws) => {
    const peerId = randId();
    peers.set(peerId, {
        ws,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map()
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
                    if (!transport) {
                        throw new Error("transport not found");
                    }
                    peer.transports.set(transport.id, transport);

                    transport.on("dtlsstatechange", (dtlsState) => {
                        if (dtlsState === "closed") transport.close();
                    });

                    send(ws, {
                        type: "transportCreated",
                        data: {
                            direction: msg.data?.direction,   // ✅ add this line
                            transportId: transport.id,
                            iceParameters: transport.iceParameters,
                            iceCandidates: transport.iceCandidates,
                            dtlsParameters: transport.dtlsParameters
                        }
                    });
                    break;
                }

                case "connectTransport": {
                    const transport = peer.transports.get(msg.data.transportId);
                    await transport.connect({ dtlsParameters: msg.data.dtlsParameters });
                    send(ws, { type: "transportConnected", data: { transportId: transport.id } });
                    break;
                }

                case "produce": {
                    const transport = peer.transports.get(msg.data.transportId);
                    const producer = await transport.produce({
                        kind: msg.data.kind,
                        rtpParameters: msg.data.rtpParameters
                    });

                    peer.producers.set(producer.id, producer);

                    producer.on("transportclose", () => peer.producers.delete(producer.id));

                    // notify others
                    for (const [otherId, otherPeer] of peers.entries()) {
                        if (otherId === peerId) continue;
                        send(otherPeer.ws, {
                            type: "newProducer",
                            data: { producerId: producer.id, kind: producer.kind }
                        });
                    }

                    send(ws, { type: "produced", data: { producerId: producer.id } });
                    break;
                }

                case "consume": {
                    const { transportId, producerId, rtpCapabilities } = msg.data;

                    if (!router.canConsume({ producerId, rtpCapabilities })) {
                        throw new Error("router cannot consume this producer");
                    }

                    const transport = peer.transports.get(transportId);
                    const consumer = await transport.consume({
                        producerId,
                        rtpCapabilities,
                        paused: true
                    });

                    peer.consumers.set(consumer.id, consumer);

                    consumer.on("transportclose", () => peer.consumers.delete(consumer.id));

                    send(ws, {
                        type: "consumed",
                        data: {
                            consumerId: consumer.id,
                            producerId,
                            kind: consumer.kind,
                            rtpParameters: consumer.rtpParameters
                        }
                    });
                    break;
                }

                case "resume": {
                    const consumer = peer.consumers.get(msg.data.consumerId);
                    await consumer.resume();
                    send(ws, { type: "resumed", data: { consumerId: consumer.id } });
                    break;
                }

                case "getProducers": {
                    // return all current producer IDs except this peer's own
                    const producerIds = [];
                    for (const [otherId, otherPeer] of peers.entries()) {
                        if (otherId === peerId) continue;
                        for (const p of otherPeer.producers.values()) {
                            producerIds.push({ producerId: p.id, kind: p.kind });
                        }
                    }
                    send(ws, { type: "producers", data: producerIds });
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
        for (const p of peer.producers.values()) p.close();
        for (const c of peer.consumers.values()) c.close();
        peers.delete(peerId);
    });
});

server.listen(3000, async () => {
    await initMediasoup();
    console.log("Open: http://<ANNOUNCED_IP>:3000  (or http://localhost:3000 for pure localhost mode)");
});