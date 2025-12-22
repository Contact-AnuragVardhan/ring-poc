// server/ring-control.js
const { RingApi } = require("ring-client-api");

// Keep a singleton in-memory instance
let ringApi = null;
let cachedCameras = null;

function requireRefreshToken() {
    const token = process.env.RING_REFRESH_TOKEN;
    if (!token) {
        throw new Error("Missing env RING_REFRESH_TOKEN");
    }
    return token;
}

async function getRingApi() {
    if (ringApi) return ringApi;

    const refreshToken = requireRefreshToken();

    ringApi = new RingApi({
        refreshToken,
        // Optional: reduce noise
        debug: process.env.RING_DEBUG === "1",
    });

    // If refresh token rotates, persist it somewhere safe (DB/secret store)
    ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
        console.log("[ring] Refresh token updated (store this securely!)");
        // IMPORTANT: Don't log the token in real apps.
        // Persist newRefreshToken to your secret store.
    });

    return ringApi;
}

async function listCameras() {
    const api = await getRingApi();
    const cameras = await api.getCameras(); // ring-client-api standard entry point :contentReference[oaicite:5]{index=5}
    cachedCameras = cameras;
    return cameras;
}

async function getCameraById(cameraId) {
    if (!cachedCameras) await listCameras();
    const cam = cachedCameras.find((c) => String(c.id) === String(cameraId));
    if (!cam) throw new Error(`Camera not found: ${cameraId}`);
    return cam;
}

async function startRingToRtp({ cameraId, ffmpegOptions }) {
    const cam = await getCameraById(cameraId);

    console.log("[ring] cam proto methods:",
        Object.getOwnPropertyNames(Object.getPrototypeOf(cam)).filter(k => typeof cam[k] === "function")
    );

    // create a SIP session (Ring->you), then start transcoding to RTP (you->mediasoup)
    let live;
    if (typeof cam.createSipSession === "function") {
        console.log(`[ring] createSipSession() for camera ${cam.id}`);
        live = await cam.createSipSession();
    } else if (typeof cam.startLiveCall === "function") {
        console.log(`[ring] startLiveCall() for camera ${cam.id}`);
        live = await cam.startLiveCall();
    } else if (typeof cam.streamVideo === "function") {
        // older API sometimes uses streamVideo + ffmpeg args
        console.log(`[ring] streamVideo() for camera ${cam.id}`);
        live = await cam.streamVideo({ ffmpegOptions });
    } else {
        // Last resort: log keys to see what this camera actually exposes
        console.log("[ring] camera keys:", Object.keys(cam));
        throw new Error(
            "Camera does not expose createSipSession/startLiveCall/streamVideo. " +
            "Check logged camera keys and we’ll map the right method."
        );
    }

    const sipSession = live?.sipSession || live;

    if (sipSession && typeof sipSession.start === "function") {
        await sipSession.start(ffmpegOptions);
        return { cameraId: cam.id, name: cam.name, sipSession };
    }

    // If it's a LiveCall (has videoSplitter / onVideoRtp)
    if (live && (live.videoSplitter || live.onVideoRtp)) {
        return { cameraId: cam.id, name: cam.name, liveCall: live };
    }

    console.log("[ring] live keys:", live ? Object.keys(live) : live);
    throw new Error("Live session created but no supported media interface found");
}

async function getCameraCapabilities(cameraId) {
    const cam = await getCameraById(cameraId);

    const protoMethods = Object
        .getOwnPropertyNames(Object.getPrototypeOf(cam))
        .filter(k => typeof cam[k] === "function");

    const keys = Object.keys(cam);

    // Best-effort heuristics (Ring models differ)
    const canStartSip = protoMethods.includes("createSipSession");
    const canStartLiveCall = protoMethods.includes("startLiveCall");
    const hasAudioHints =
        keys.some(k => /audio|speaker|microphone|twoWay/i.test(k)) ||
        protoMethods.some(k => /audio|talk|speaker/i.test(k));

    // "Talk" support is notoriously inconsistent; keep conservative:
    const canTalk = hasAudioHints && (canStartSip || canStartLiveCall);

    return {
        cameraId: cam.id,
        name: cam.name,
        canStartSip,
        canStartLiveCall,
        hasAudioHints,
        canListen: true,    // if live starts, audio may or may not show, but we try
        canTalk,            // best effort guess
    };
}


module.exports = {
    listCameras,
    startRingToRtp,
    getCameraCapabilities
};
