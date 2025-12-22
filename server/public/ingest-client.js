//server\public\ingest-client.js
import * as mediasoupClient from "mediasoup-client";

const logEl = document.getElementById("log");
const remoteVideo = document.getElementById("remoteVideo");

const btnLoadCameras = document.getElementById("btnLoadCameras");
const cameraSelect = document.getElementById("cameraSelect");
const btnStartLive = document.getElementById("btnStartLive");
const ringStatus = document.getElementById("ringStatus");
const btnTalk = document.getElementById("btnTalk");

function setRingStatus(msg) {
  ringStatus.textContent = msg;
  console.log("[ring-ui]", msg);
}

function setStartLiveEnabled(enabled) {
  btnStartLive.disabled = !enabled;
}

function log(...args) {
  logEl.textContent += args.join(" ") + "\n";
}

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const ws = new WebSocket(wsUrl);

let device;
let recvTransport;

//for audio ring --> browser
let producerIds = new Set();   // holds ring video + ring audio producerIds
let remoteStream = null;
let consumed = new Set();      // avoid consuming same producer twice

//for audio browser --> ring
let sendTransport;
let micStream;
let micProducer;

let deviceReadyResolve;
const deviceReady = new Promise((resolve) => (deviceReadyResolve = resolve));

function waitFor(cond, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(true); }
      if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error("timeout")); }
    }, 50);
  });
}

async function loadRingCameras() {
  setRingStatus("Loading cameras...");
  const res = await fetch("/api/ring/cameras");
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Failed to load cameras");

  // populate dropdown
  cameraSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(select camera)";
  cameraSelect.appendChild(placeholder);

  for (const cam of json.cameras || []) {
    const opt = document.createElement("option");
    opt.value = String(cam.id);
    opt.textContent = cam.name ? `${cam.name} (${cam.id})` : String(cam.id);
    cameraSelect.appendChild(opt);
  }

  setRingStatus(`Loaded ${json.cameras?.length || 0} cameras`);
  setStartLiveEnabled(!!cameraSelect.value);
}

async function startRingLive(cameraId) {
  if (!cameraId) throw new Error("Select a camera first");
  setRingStatus(`Starting live for camera ${cameraId}...`);

  const res = await fetch(`/api/ring/cameras/${encodeURIComponent(cameraId)}/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Failed to start live");

  setRingStatus(`Live started: ${json.name || cameraId}`);
}


async function ensureDevice() {
  if (device) return;

  ws.send(JSON.stringify({ type: "getRouterRtpCapabilities" }));
  await waitFor(() => window.__routerCaps);

  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: window.__routerCaps });
  log("device loaded");
  deviceReadyResolve();
}

async function ensureRecvTransport() {
  await ensureDevice();
  if (recvTransport) return;

  ws.send(JSON.stringify({ type: "createTransport", data: { direction: "recv" } }));
  await waitFor(() => recvTransport);
  // consume any producers we already learned about before recvTransport was ready
  for (const id of producerIds) {
    if (!consumed.has(id)) {
      consumeProducer(id);
      consumed.add(id);
    }
  }

  log("recvTransport ready");
}

let consuming = false;

async function autoConsumeIngest() {
  if (consuming) return;
  consuming = true;
  try {
    await ensureRecvTransport();

    // ask server for current producers (video+audio)
    ws.send(JSON.stringify({ type: "getProducers" }));

    // wait until we see at least one ring producer
    try {
      await waitFor(() => producerIds.size > 0, 5000);
    } catch {
      log("No ingest producer yet after Start Live.");
      return;
    }

    for (const id of producerIds) {
      if (!consumed.has(id)) {
        consumeProducer(id);
        consumed.add(id);
      }
    }
  }
  finally {
    consuming = false;
  }

}

function consumeProducer(producerId) {
  ws.send(JSON.stringify({
    type: "consume",
    data: {
      transportId: recvTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities
    }
  }));
}

async function ensureSendTransport() {
  await ensureDevice();
  if (sendTransport) return;

  ws.send(JSON.stringify({ type: "createTransport", data: { direction: "send" } }));
  await waitFor(() => sendTransport);

  log("sendTransport ready");
}

async function startMic() {
  await ensureSendTransport();
  if (micProducer) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });

  const track = micStream.getAudioTracks()[0];
  micProducer = await sendTransport.produce({
    track,
    appData: { label: "mic", cameraId: cameraSelect.value }
  });

  ws.send(JSON.stringify({
    type: "startTalk",
    data: { cameraId: cameraSelect.value, producerId: micProducer.id }
  }));

  setRingStatus("Talking… (mic sending)");
}

async function stopMic() {
  try { micProducer?.close(); } catch { }
  micProducer = null;

  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }

  ws.send(JSON.stringify({ type: "stopTalk" }));

  setRingStatus("Talk stopped");
}


function setTalkEnabled(enabled, reason = "") {
  btnTalk.disabled = !enabled;
  btnTalk.title = enabled ? "Hold to speak" : (reason || "Talk not available");
}

//setTalkEnabled(false, "Talk not wired yet (listen-only mode)");

function resetRemoteObjects() {
  producerIds = new Set();
  consumed = new Set();
  remoteStream = null;
  remoteVideo.srcObject = null;
  playbackUnlocked = false; // important: allow new autoplay unlock per session
}

let playbackUnlocked = false;

async function unlockPlayback() {
  if (playbackUnlocked) return;
  playbackUnlocked = true;

  // optional: helps autoplay on some browsers
  remoteVideo.muted = true;

  tryStartPlayback();

  // if audio is actually flowing, you can unmute video
  //remoteVideo.muted = false;
}


async function tryStartPlayback() {
  try { await remoteVideo.play(); } catch { }
}

let isHolding = false;

function setTalkUI(isTalking) {
  btnTalk.textContent = isTalking ? "🎙️ Talking…" : "Hold to Talk";
  btnTalk.style.opacity = isTalking ? "0.8" : "1";
}

const produceCbs = new Map(); // reqId -> cb

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "welcome") log("welcome peerId=", msg.peerId);

  if (msg.type === "routerRtpCapabilities") {
    window.__routerCaps = msg.data;
    log("got routerRtpCapabilities");
  }

  if (msg.type === "transportCreated") {
    const t = msg.data;
    await deviceReady;

    if (t.direction === "recv") {
      recvTransport = device.createRecvTransport({
        id: t.transportId,
        iceParameters: t.iceParameters,
        iceCandidates: t.iceCandidates,
        dtlsParameters: t.dtlsParameters,
      });

      recvTransport.on("connect", ({ dtlsParameters }, cb, errCb) => {
        try {
          ws.send(JSON.stringify({
            type: "connectTransport",
            data: { transportId: recvTransport.id, dtlsParameters }
          }));
          cb();
        }
        catch (err) {
          errCb(err);
        }
      });
    } else if (t.direction === "send") {
      sendTransport = device.createSendTransport({
        id: t.transportId,
        iceParameters: t.iceParameters,
        iceCandidates: t.iceCandidates,
        dtlsParameters: t.dtlsParameters,
      });

      sendTransport.on("connect", ({ dtlsParameters }, cb, errCb) => {
        try {
          ws.send(JSON.stringify({
            type: "connectTransport",
            data: { transportId: sendTransport.id, dtlsParameters }
          }));
          cb();
        } catch (e) { errCb(e); }
      });

      sendTransport.on("produce", ({ kind, rtpParameters, appData }, cb, errCb) => {
        try {
          const reqId = `${Date.now()}-${Math.random()}`;
          produceCbs.set(reqId, cb);

          ws.send(JSON.stringify({
            type: "produce",
            data: {
              transportId: sendTransport.id,
              kind,
              rtpParameters,
              appData,
              reqId
            }
          }));
           window.__produceCb = cb;
        } catch (e) { errCb(e); }
      });
    }
  }

  if (msg.type === "newProducer") {
    const label = msg.data?.label || "";
    if (label.startsWith("ingest:") || label.startsWith("ring:") || label.startsWith("ring-audio:")) {
      producerIds.add(msg.data.producerId);
      log("new producer:", label, "id=", msg.data.producerId);

      // If already started, immediately consume new producers
      if (recvTransport && !consumed.has(msg.data.producerId)) {
        consumeProducer(msg.data.producerId);
        consumed.add(msg.data.producerId);
      }
    }
  }

  if (msg.type === "producers") {
    const rings = msg.data.filter(p => {
      const label = (p.label || "");
      return label.startsWith("ingest:") || label.startsWith("ring:") || label.startsWith("ring-audio:");
    });

    if (rings.length) {
      for (const p of rings) producerIds.add(p.producerId);
      log("found producers:", rings.map(r => r.label).join(", "));
    } else {
      log("no ring producers yet");
    }
  }

  if (msg.type === "consumed") {
    const { consumerId, kind, rtpParameters } = msg.data;

    const consumer = await recvTransport.consume({
      id: consumerId,
      producerId: msg.data.producerId,
      kind,
      rtpParameters
    });

    if (!remoteStream) {
      remoteStream = new MediaStream();
    }
    remoteStream.addTrack(consumer.track);
    remoteVideo.srcObject = remoteStream;
    // Resume first (start packets), then attempt play
    ws.send(JSON.stringify({ type: "resume", data: { consumerId } }));

    await tryStartPlayback();
    // unmute after first track arrives
    remoteVideo.muted = false;

    log("consuming", kind, "consumerId=", consumerId);
  }

  if (msg.type === "produced") {
    const cb = produceCbs.get(msg.data.reqId);
    if (cb) {
      cb({ id: msg.data.producerId });
      produceCbs.delete(msg.data.reqId);
    }
  }

  if (msg.type === "ingestStopped") {
    resetRemoteObjects();
    setRingStatus("Stopped");
  }

  if (msg.type === "error") {
    log("ERROR:", msg.error);
  }
};

btnLoadCameras.onclick = async () => {
  try {
    await loadRingCameras();
  } catch (e) {
    setRingStatus(`ERROR: ${e.message || e}`);
  }
};

cameraSelect.onchange = async () => {
  setStartLiveEnabled(!!cameraSelect.value);
  setTalkEnabled(false, "Select camera then Start Live");

  const id = cameraSelect.value;
  if (!id) return;

  try {
    const res = await fetch(`/api/ring/cameras/${encodeURIComponent(id)}/capabilities`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "caps failed");

    // For now, we keep listen-only unless you implement talk-back server
    if (json.caps.canTalk) {
      setTalkEnabled(false, "Talk supported by camera, but not wired yet");
    } else {
      setTalkEnabled(false, "Camera appears listen-only");
    }
  } catch (e) {
    setTalkEnabled(false, "Caps check failed");
  }
};

btnStartLive.onclick = async () => {
  try {
    resetRemoteObjects();
    await unlockPlayback();
    await fetch("/api/ring/live/stop", { method: "POST" });
    await startRingLive(cameraSelect.value);
    await autoConsumeIngest();
    await tryStartPlayback();
    //enable only if your server talk-back is implemented AND camera supports talk
    //setTalkEnabled(true);
    setTalkEnabled(true, "Mic sends to server (Ring talk-back not wired yet)");
  } catch (e) {
    setRingStatus(`ERROR: ${e.message || e}`);
    setTalkEnabled(false);
  }
};

document.getElementById("btnStopIngest").onclick = async () => {
  try {
    resetRemoteObjects();
    const res = await fetch("/api/ingest/stop", { method: "POST" });
    const json = await res.json();
    log("stop ingest:", JSON.stringify(json));
  }
  finally {
    setTalkEnabled(false);
  }
};

btnTalk.onpointerdown = async (e) => {
  e.preventDefault();
  if (btnTalk.disabled || isHolding) return;
  isHolding = true;
  setTalkUI(true);

  try {
    btnTalk.setPointerCapture?.(e.pointerId);
  } catch { }

  try {
    await startMic();
  } catch (err) {
    setRingStatus(`Talk ERROR: ${err.message || err}`);
    isHolding = false;
    setTalkUI(false);
  }
};

async function endHold() {
  if (!isHolding) return;
  isHolding = false;
  try { await stopMic(); } catch { }
  setTalkUI(false);
}

btnTalk.onpointerup = (e) => { e.preventDefault(); endHold(); };
btnTalk.onpointercancel = (e) => { e.preventDefault(); endHold(); };
btnTalk.onpointerleave = (e) => { e.preventDefault(); endHold(); };

/*window.addEventListener("blur", endHold);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) endHold();
});*/
