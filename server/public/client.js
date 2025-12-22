import * as mediasoupClient from "mediasoup-client";

const logEl = document.getElementById("log");
const log = (...a) => (logEl.textContent += a.join(" ") + "\n");

const ws = new WebSocket(`ws://${location.host}`);
let device, sendTransport, recvTransport;
let routerRtpCapabilities;
let lastProducerId;

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.type === "welcome") log("welcome peerId=", msg.peerId);

    if (msg.type === "routerRtpCapabilities") {
        routerRtpCapabilities = msg.data;
        log("got routerRtpCapabilities");
    }

    if (msg.type === "transportCreated") {
        const t = msg.data;

        if (t.direction === "send") {
            sendTransport = device.createSendTransport({
                id: t.transportId,
                iceParameters: t.iceParameters,
                iceCandidates: t.iceCandidates,
                dtlsParameters: t.dtlsParameters
            });

            sendTransport.on("connect", ({ dtlsParameters }, cb) => {
                ws.send(JSON.stringify({
                    type: "connectTransport",
                    data: { transportId: sendTransport.id, dtlsParameters }
                }));
                cb();
            });

            sendTransport.on("produce", ({ kind, rtpParameters }, cb) => {
                ws.send(JSON.stringify({
                    type: "produce",
                    data: { transportId: sendTransport.id, kind, rtpParameters }
                }));
                cb({ id: "temp" });
            });

            log("sendTransport ready");
        }

        if (t.direction === "recv") {
            recvTransport = device.createRecvTransport({
                id: t.transportId,
                iceParameters: t.iceParameters,
                iceCandidates: t.iceCandidates,
                dtlsParameters: t.dtlsParameters
            });

            recvTransport.on("connect", ({ dtlsParameters }, cb) => {
                ws.send(JSON.stringify({
                    type: "connectTransport",
                    data: { transportId: recvTransport.id, dtlsParameters }
                }));
                cb();
            });

            log("recvTransport ready");
        }
    }

    if (msg.type === "produced") {
        lastProducerId = msg.data.producerId;
        log("produced producerId=", lastProducerId);
    }

    if (msg.type === "newProducer") {
        lastProducerId = msg.data.producerId;
        log("newProducer kind=", msg.data.kind, "producerId=", lastProducerId);
    }

    if (msg.type === "consumed") {
        const { consumerId, producerId, kind, rtpParameters } = msg.data;

        const consumer = await recvTransport.consume({
            id: consumerId,
            producerId,
            kind,
            rtpParameters
        });

        remoteVideo.srcObject = new MediaStream([consumer.track]);
        ws.send(JSON.stringify({ type: "resume", data: { consumerId } }));
        log("consuming consumerId=", consumerId, "kind=", kind);
    }

    if (msg.type === "producers") {
        if (msg.data.length > 0) {
            lastProducerId = msg.data.find(p => p.kind === "video")?.producerId || msg.data[0].producerId;
            log("existing producerId=", lastProducerId);
        } else {
            log("no existing producers");
        }
    }

    if (msg.type === "error") log("ERROR:", msg.error);
};

async function waitFor(cond, timeoutMs = 5000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error("timeout");
        await new Promise(r => setTimeout(r, 50));
    }
}

async function ensureDevice() {
    if (device) return;
    ws.send(JSON.stringify({ type: "getRouterRtpCapabilities" }));
    await waitFor(() => routerRtpCapabilities);

    device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities });
    log("device loaded");
}

async function ensureSendTransport() {
    await ensureDevice();
    if (sendTransport) return;
    ws.send(JSON.stringify({ type: "createTransport", data: { direction: "send" } }));
    await waitFor(() => sendTransport);
}

async function ensureRecvTransport() {
    await ensureDevice();
    if (recvTransport) return;
    ws.send(JSON.stringify({ type: "createTransport", data: { direction: "recv" } }));
    await waitFor(() => recvTransport);
}

async function getUserMedia(constraints) {
    // Modern
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        return navigator.mediaDevices.getUserMedia(constraints);
    }

    // Legacy fallback (older browsers)
    const legacy =
        navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia;

    if (!legacy) {
        throw new Error(
            "getUserMedia not supported in this browser/context. Try Chrome and use http://localhost or HTTPS."
        );
    }

    return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
}

document.getElementById("btnStart").onclick = async () => {
    await ensureSendTransport();
    const stream = await getUserMedia({ video: true, audio: true });
    localVideo.srcObject = stream;

    const audioTrack = stream.getAudioTracks()[0];
    const videoTrack = stream.getVideoTracks()[0];

    if (audioTrack) await sendTransport.produce({ track: audioTrack });
    if (videoTrack) await sendTransport.produce({ track: videoTrack });

    log("local tracks produced");
};

document.getElementById("btnConsume").onclick = async () => {
    await ensureRecvTransport();

    if (!lastProducerId) {
        ws.send(JSON.stringify({ type: "getProducers" }));
        await waitFor(() => lastProducerId, 3000).catch(() => { });
    }

    if (!lastProducerId) {
        log("No producer yet. Open a second tab and click Start there first.");
        return;
    }

    ws.send(JSON.stringify({
        type: "consume",
        data: {
            transportId: recvTransport.id,
            producerId: lastProducerId,
            rtpCapabilities: device.rtpCapabilities
        }
    }));
};