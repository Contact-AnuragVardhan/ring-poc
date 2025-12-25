// server/ring-control.js
const { RingApi } = require("ring-client-api");
const { Readable } = require("stream");
const util = require("util");

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

async function getCameraHistory(cameraId, limit = 25) {
    const cam = await getCameraById(cameraId);
    if (typeof cam.getHistory !== "function") {
        debugDumpCamera(cam, `camera ${cam.id} (${cam.name})`);
        throw new Error("This camera object does not support getHistory()");
    }
    const items = await cam.getHistory(Number(limit) || 25);

    // Normalize a few useful fields (Ring varies by device/account)
    return (items || []).map((h) => ({
        id: h.id ?? h.ding_id ?? h.dingId,
        kind: h.kind ?? h.alert ?? h.type,
        createdAt: h.created_at ?? h.createdAt ?? h.start_time,
        // any extra fields you might want:
        // hasRecording: h.recording_status ?? undefined,
    })).filter(x => x.id != null);
}

/**
 * RECORDING
 * Return either:
 *  - { type: 'url', url: 'https://...' }
 *  - { type: 'stream', stream: Readable }
 */
async function getCameraRecording(cameraId, eventId) {
    const cam = await getCameraById(cameraId);
    console.log(`inputs cameraId=`, cameraId, "eventId=", eventId, "eventIdType=", typeOf(eventId));
    const idStr = String(eventId);

    if (typeof cam.getRecordingUrl === "function") {
        console.log("==================In getRecordingUrl with idStr ", idStr);
        const url = await cam.getRecordingUrl(idStr).catch(async (error) => {
            console.error(`First attempt failed with: ${JSON.stringify(safeErr(error))}`);
            // some versions want a number, try that too
            const n = Number(idStr);
            if (!Number.isNaN(n)) {
                try {
                    return await cam.getRecordingUrl(n);
                } catch (secondError) {
                    throw new Error(`getRecordingUrl failed. String error: ${error.message}. Number error: ${secondError.message}`);
                }
            }
            throw error;
        });


        console.log("========================url from getCameraRecording is ", JSON.stringify(url));

        if (typeof url === "string" && url.length) {
            return { type: "url", url };
        }
    }

    //If older API: getRecording(eventId)
    if (typeof cam.getRecording === "function") {
        const rec = await cam.getRecording(idStr);

        if (typeof rec === "string") {
            return { type: "url", url: rec };
        }

        if (rec && typeof rec === "object") {
            const url =
                rec.url ||
                rec.recordingUrl ||
                rec.recording_url ||
                rec.downloadUrl ||
                rec.download_url;

            if (typeof url === "string") return { type: "url", url };

            const stream =
                rec.stream ||
                rec.body ||
                (typeof rec.pipe === "function" ? rec : null);

            if (stream && typeof stream.pipe === "function") {
                return { type: "stream", stream };
            }
        }
    }

    debugDumpCamera(cam, `camera ${cam.id} (${cam.name})`);
    throw new Error(
        "No supported recording method found. Expected cam.getRecordingUrl() or cam.getRecording(). " +
        "See ring-debug dump above for available methods."
    );
}

function debugDumpCamera(cam, label = "camera") {
    try {
        console.log(`\n[ring-debug] ===== ${label} =====`);
        console.log("[ring-debug] ctor:", cam?.constructor?.name);
        console.log("[ring-debug] typeof:", typeof cam);

        // Own keys (enumerable)
        console.log("[ring-debug] Object.keys:", Object.keys(cam || {}));

        // Own property names (includes non-enumerable)
        console.log("[ring-debug] Object.getOwnPropertyNames:", Object.getOwnPropertyNames(cam || {}));

        // Symbols
        console.log("[ring-debug] Object.getOwnPropertySymbols:", Object.getOwnPropertySymbols(cam || {}).map(String));

        // Prototype chain methods
        let p = Object.getPrototypeOf(cam);
        let depth = 0;
        while (p && depth < 6) {
            const names = Object.getOwnPropertyNames(p);
            const methods = names.filter((k) => typeof cam[k] === "function" && k !== "constructor");
            console.log(`[ring-debug] proto depth ${depth} (${p?.constructor?.name}): methods=`, methods);
            p = Object.getPrototypeOf(p);
            depth++;
        }

        // Safe snapshot (primitives only)
        const snapshot = {};
        for (const k of Object.getOwnPropertyNames(cam || {})) {
            try {
                const v = cam[k];
                if (v == null || ["string", "number", "boolean"].includes(typeof v)) snapshot[k] = v;
            } catch { }
        }
        console.log("[ring-debug] primitive snapshot:", snapshot);

        // Deep-ish inspect (handles circular)
        console.log(
            "[ring-debug] util.inspect:",
            util.inspect(cam, { depth: 2, colors: false, showHidden: true, getters: true })
        );

        console.log(`[ring-debug] ===== end ${label} =====\n`);
    } catch (e) {
        console.log("[ring-debug] dump failed:", e?.message || e);
    }
}

function safeErr(err) {
    if (!err) return err;
    return {
        name: err.name,
        message: err.message,
        stack: err.stack,
        code: err.code,
        status: err.status,
        statusCode: err.statusCode,
        response: err.response ? {
            status: err.response.status,
            statusText: err.response.statusText,
            dataType: typeof err.response.data,
            dataKeys: err.response.data && typeof err.response.data === "object"
                ? Object.keys(err.response.data).slice(0, 30)
                : undefined,
        } : undefined,
    };
}

function redactUrl(u) {
    try {
        if (typeof u !== "string") return u;
        const url = new URL(u);
        // keep host + path, drop secrets
        url.search = "";
        return url.toString();
    } catch {
        return u;
    }
}

function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
}


module.exports = {
    listCameras,
    startRingToRtp,
    getCameraCapabilities,
    getCameraHistory,
    getCameraRecording,
};
