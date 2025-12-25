//server\public\ingest-client.js
import * as mediasoupClient from "mediasoup-client";

/** ---------- DOM ---------- */
const logEl = document.getElementById("log");
const remoteVideo = document.getElementById("remoteVideo");
const historyVideo = document.getElementById("historyVideo");

const cameraSelect = document.getElementById("cameraSelect");
const btnLoadCameras = document.getElementById("btnLoadCameras");
const btnConnect = document.getElementById("btnConnect");
const btnDisconnect = document.getElementById("btnDisconnect");

const btnTalk = document.getElementById("btnTalk");
const ringStatus = document.getElementById("ringStatus");
const secondaryStatus = document.getElementById("secondaryStatus");

const pillWs = document.getElementById("pillWs");
const pillLive = document.getElementById("pillLive");
const pillTalk = document.getElementById("pillTalk");

const pageTitle = document.getElementById("pageTitle");
const pageSub = document.getElementById("pageSub");
const liveMeta = document.getElementById("liveMeta");

const tabLive = document.getElementById("tabLive");
const tabHistory = document.getElementById("tabHistory");
const tabLogs = document.getElementById("tabLogs");

const viewLive = document.getElementById("viewLive");
const viewHistory = document.getElementById("viewHistory");
const viewLogs = document.getElementById("viewLogs");

const btnLoadHistory = document.getElementById("btnLoadHistory");
const historyLimitEl = document.getElementById("historyLimit");
const historyListEl = document.getElementById("historyList");
const historySearchEl = document.getElementById("historySearch");
const historyRecordedOnlyEl = document.getElementById("historyRecordedOnly");
const historyMeta = document.getElementById("historyMeta");
const historyCounts = document.getElementById("historyCounts");
const listTitle = document.getElementById("listTitle");
const listSubtitle = document.getElementById("listSubtitle");
const playbackMeta = document.getElementById("playbackMeta");

const btnClearLogs = document.getElementById("btnClearLogs");
const btnCopyLogs = document.getElementById("btnCopyLogs");
const btnUnmute = document.getElementById("btnUnmute");
const btnMute = document.getElementById("btnMute");

/** ---------- Helpers ---------- */
function setPill(pill, state /* ok|warn|bad|idle */) {
  pill.classList.remove("ok", "warn", "bad");
  if (state === "ok") pill.classList.add("ok");
  else if (state === "warn") pill.classList.add("warn");
  else if (state === "bad") pill.classList.add("bad");
}
function setRingStatus(msg, secondary = "") {
  ringStatus.textContent = msg || "";
  secondaryStatus.textContent = secondary || "";
  console.log("[ring-ui]", msg, secondary);
}
function log(...args) {
  logEl.textContent += args.join(" ") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function fmtTime(ts) {
  try {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d.toLocaleString();
  } catch { }
  return String(ts || "");
}
function waitFor(cond, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(true); }
      if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error("timeout")); }
    }, 50);
  });
}
function setTab(active) {
  for (const [t, v, title, sub] of [
    [tabLive, viewLive, "Live View", "Streaming from Ring via FFmpeg → mediasoup → browser."],
    [tabHistory, viewHistory, "History", "Play recorded motion/ding clips (recorded=true, status=ready)."],
    [tabLogs, viewLogs, "Logs", "Client-side session logs for debugging."]
  ]) {
    const on = (active === t);
    t.classList.toggle("active", on);
    v.classList.toggle("hidden", !on);
    if (on) {
      pageTitle.textContent = title;
      pageSub.textContent = sub;
    }
  }
}

/** ---------- WebSocket ---------- */
const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
const ws = new WebSocket(wsUrl);

ws.onopen = () => { setPill(pillWs, "ok"); log("[ws] connected"); };
ws.onclose = () => { setPill(pillWs, "bad"); log("[ws] closed"); };
ws.onerror = () => { setPill(pillWs, "warn"); log("[ws] error"); };

/** ---------- mediasoup state ---------- */
let device;
let recvTransport;

let producerIds = new Set();
let remoteStream = null;
let consumed = new Set();

let sendTransport;
let micStream;
let micProducer;

let deviceReadyResolve;
const deviceReady = new Promise((resolve) => (deviceReadyResolve = resolve));

let playbackUnlocked = false;
function tryStartPlayback() { remoteVideo.play().catch(() => { }); }
async function unlockPlayback() {
  if (playbackUnlocked) return;
  playbackUnlocked = true;
  remoteVideo.muted = true;
  tryStartPlayback();
}

/** ---------- App state ---------- */
let selectedCameraId = "";
let isLive = false;
let isHolding = false;
let historyCache = null; // { recorded, activity, counts }

/** ---------- API ---------- */
async function apiJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

async function loadRingCameras() {
  setRingStatus("Loading cameras…");
  const json = await apiJson("/api/ring/cameras");
  if (!json.ok) throw new Error(json.error || "Failed to load cameras");

  cameraSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "(Select camera)";
  cameraSelect.appendChild(placeholder);

  for (const cam of json.cameras || []) {
    const opt = document.createElement("option");
    opt.value = String(cam.id);
    opt.textContent = cam.name ? `${cam.name} (${cam.id})` : String(cam.id);
    cameraSelect.appendChild(opt);
  }

  setRingStatus(`Loaded ${json.cameras?.length || 0} cameras`, "Select one to enable Connect.");
  btnConnect.disabled = !cameraSelect.value;
  btnLoadHistory.disabled = !cameraSelect.value;
}

async function stopRingLive() {
  const json = await apiJson("/api/ingest/stop", { method: "POST" });
  return json;
}

async function startRingLive(cameraId) {
  const json = await apiJson(`/api/ring/cameras/${encodeURIComponent(cameraId)}/live/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!json.ok) throw new Error(json.error || "Failed to start live");
  return json;
}

/** ---------- mediasoup plumbing ---------- */
async function ensureDevice() {
  if (device) return;
  ws.send(JSON.stringify({ type: "getRouterRtpCapabilities" }));
  await waitFor(() => window.__routerCaps);

  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: window.__routerCaps });
  log("[ms] device loaded");
  deviceReadyResolve();
}

async function ensureRecvTransport() {
  await ensureDevice();
  if (recvTransport) return;

  ws.send(JSON.stringify({ type: "createTransport", data: { direction: "recv" } }));
  await waitFor(() => recvTransport);

  // consume any known producers
  for (const id of producerIds) {
    if (!consumed.has(id)) {
      consumeProducer(id);
      consumed.add(id);
    }
  }
  log("[ms] recv transport ready");
}

function consumeProducer(producerId) {
  ws.send(JSON.stringify({
    type: "consume",
    data: { transportId: recvTransport.id, producerId, rtpCapabilities: device.rtpCapabilities }
  }));
}

let consuming = false;
async function autoConsumeIngest() {
  if (consuming) return;
  consuming = true;
  try {
    await ensureRecvTransport();
    ws.send(JSON.stringify({ type: "getProducers" }));

    try { await waitFor(() => producerIds.size > 0, 5000); }
    catch { log("[ms] no producers after connect"); return; }

    for (const id of producerIds) {
      if (!consumed.has(id)) {
        consumeProducer(id);
        consumed.add(id);
      }
    }
  } finally {
    consuming = false;
  }
}

async function ensureSendTransport() {
  await ensureDevice();
  if (sendTransport) return;

  ws.send(JSON.stringify({ type: "createTransport", data: { direction: "send" } }));
  await waitFor(() => sendTransport);
  log("[ms] send transport ready");
}

/** ---------- Talkback ---------- */
async function startMic() {
  await ensureSendTransport();
  if (micProducer) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });

  const track = micStream.getAudioTracks()[0];
  micProducer = await sendTransport.produce({
    track,
    appData: { label: "mic", cameraId: selectedCameraId }
  });

  ws.send(JSON.stringify({ type: "startTalk", data: { cameraId: selectedCameraId, producerId: micProducer.id } }));
  setPill(pillTalk, "ok");
  setRingStatus("Talking…", "Release to stop.");
}
async function stopMic() {
  try { micProducer?.close(); } catch { }
  micProducer = null;

  if (micStream) {
    for (const t of micStream.getTracks()) t.stop();
    micStream = null;
  }
  ws.send(JSON.stringify({ type: "stopTalk" }));
  setPill(pillTalk, "warn");
  setRingStatus("Talk stopped", "");
}

/** ---------- Reset / session ---------- */
function resetRemoteObjects() {
  producerIds = new Set();
  consumed = new Set();
  remoteStream = null;
  remoteVideo.srcObject = null;
  playbackUnlocked = false;
}

function setLiveUi(live) {
  isLive = live;
  setPill(pillLive, live ? "ok" : "warn");
  liveMeta.textContent = live ? `camera=${selectedCameraId || "—"} • streaming` : "idle";

  btnConnect.disabled = !selectedCameraId || live;
  btnDisconnect.disabled = !live;

  btnTalk.disabled = !live; // if you want to be stricter, check caps; keeping simple
}

/** ---------- History ---------- */
function updateHistoryCounts(data) {
  const counts = data?.counts || { recorded: 0, activity: 0, total: 0 };
  historyCounts.classList.add("ok");
  historyCounts.querySelector(".led").style.background = "var(--good)";
  historyCounts.lastChild.textContent = `${counts.recorded} recorded • ${counts.activity} activity`;
  historyMeta.textContent = `Loaded ${counts.total} events`;
}

function matchesSearch(item, q) {
  if (!q) return true;
  q = q.toLowerCase();
  const s = `${item.kind || ""} ${item.created_at || ""} ${item.dingIdStr || ""}`.toLowerCase();
  return s.includes(q);
}

function buildHistoryRows(cameraId, data) {
  historyListEl.innerHTML = "";
  const recorded = data?.recorded || [];
  const activity = data?.activity || [];
  const q = String(historySearchEl.value || "").trim();
  const recordedOnly = !!historyRecordedOnlyEl.checked;

  const recFiltered = recorded.filter(x => matchesSearch(x, q));
  const actFiltered = recordedOnly ? [] : activity.filter(x => matchesSearch(x, q));

  listTitle.textContent = recordedOnly ? "Recorded clips" : "Events";
  listSubtitle.textContent = recordedOnly
    ? `${recFiltered.length} items`
    : `${recFiltered.length} recorded • ${actFiltered.length} activity`;

  function addSection(title, items, playable) {
    // section header
    const header = document.createElement("div");
    header.style.padding = "10px 12px";
    header.style.borderBottom = "1px solid rgba(255,255,255,.06)";
    header.style.fontFamily = "var(--mono)";
    header.style.fontSize = "12px";
    header.style.color = "var(--muted)";
    header.textContent = title;
    historyListEl.appendChild(header);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.style.padding = "12px";
      empty.style.color = "var(--muted)";
      empty.style.fontSize = "12px";
      empty.textContent = "No items.";
      historyListEl.appendChild(empty);
      return;
    }

    for (const h of items) {
      const row = document.createElement("div");
      row.className = "item";

      const left = document.createElement("div");
      left.className = "left";

      const t = document.createElement("div");
      t.className = "title";
      t.textContent = `${fmtTime(h.created_at)} — ${h.kind || "event"}`;

      const sub = document.createElement("div");
      sub.className = "subtitle";
      sub.textContent = `ding=${h.dingIdStr || h.dingId || h.id} • recorded=${h.recorded} • status=${h.recording_status ?? "null"}`;

      left.appendChild(t);
      left.appendChild(sub);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";
      right.style.alignItems = "center";

      const badge = document.createElement("span");
      badge.className = "badge " + (playable ? "good" : "bad");
      badge.textContent = playable ? "READY" : "NO CLIP";

      const btn = document.createElement("button");
      btn.textContent = playable ? "Play" : "N/A";
      btn.disabled = !playable;

      btn.onclick = () => {
        const ding = h.dingIdStr || h.dingId || h.id;
        const url = `/api/ring/cameras/${encodeURIComponent(cameraId)}/recordings/${encodeURIComponent(ding)}`;
        historyVideo.src = url;
        historyVideo.play().catch(() => { });
        playbackMeta.textContent = `playing ding=${ding}`;
        setRingStatus(`Playing recording`, `${h.kind} • ${fmtTime(h.created_at)}`);
      };

      right.appendChild(badge);
      right.appendChild(btn);

      row.appendChild(left);
      row.appendChild(right);
      historyListEl.appendChild(row);
    }
  }

  addSection(`🎥 Recorded (${recFiltered.length})`, recFiltered, true);
  if (!recordedOnly) addSection(`🕒 Activity (${actFiltered.length})`, actFiltered, false);
}

async function loadHistory(cameraId, limit) {
  const json = await apiJson(`/api/ring/cameras/${encodeURIComponent(cameraId)}/history?limit=${encodeURIComponent(limit)}`);
  if (!json.ok) throw new Error(json.error || "history failed");
  return json;
}

/** ---------- WS handling ---------- */
const produceCbs = new Map();

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "welcome") log("[ws] welcome peerId=", msg.peerId);

  if (msg.type === "routerRtpCapabilities") {
    window.__routerCaps = msg.data;
    log("[ws] got router caps");
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
          ws.send(JSON.stringify({ type: "connectTransport", data: { transportId: recvTransport.id, dtlsParameters } }));
          cb();
        } catch (e) { errCb(e); }
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
          ws.send(JSON.stringify({ type: "connectTransport", data: { transportId: sendTransport.id, dtlsParameters } }));
          cb();
        } catch (e) { errCb(e); }
      });

      sendTransport.on("produce", ({ kind, rtpParameters, appData }, cb, errCb) => {
        try {
          const reqId = `${Date.now()}-${Math.random()}`;
          produceCbs.set(reqId, cb);
          ws.send(JSON.stringify({ type: "produce", data: { transportId: sendTransport.id, kind, rtpParameters, appData, reqId } }));
        } catch (e) { errCb(e); }
      });
    }
  }

  if (msg.type === "newProducer") {
    const label = msg.data?.label || "";
    if (label.startsWith("ingest:") || label.startsWith("ring:") || label.startsWith("ring-audio:")) {
      producerIds.add(msg.data.producerId);
      log("[ms] new producer:", label, "id=", msg.data.producerId);

      if (recvTransport && !consumed.has(msg.data.producerId)) {
        consumeProducer(msg.data.producerId);
        consumed.add(msg.data.producerId);
      }
    }
  }

  if (msg.type === "producers") {
    const rings = (msg.data || []).filter(p => {
      const label = (p.label || "");
      return label.startsWith("ingest:") || label.startsWith("ring:") || label.startsWith("ring-audio:");
    });

    if (rings.length) {
      for (const p of rings) producerIds.add(p.producerId);
      log("[ms] found producers:", rings.map(r => r.label).join(", "));
    } else {
      log("[ms] no ring producers yet");
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

    if (!remoteStream) remoteStream = new MediaStream();
    remoteStream.addTrack(consumer.track);
    remoteVideo.srcObject = remoteStream;

    ws.send(JSON.stringify({ type: "resume", data: { consumerId } }));
    tryStartPlayback();
    // unmute after first track arrives (user can mute/unmute in UI)
    remoteVideo.muted = false;

    log("[ms] consuming", kind, "consumerId=", consumerId);
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
    setLiveUi(false);
    setPill(pillTalk, "warn");
    setRingStatus("Disconnected", "Live ingest stopped.");
    log("[server] ingestStopped");
  }

  if (msg.type === "talkStatus") {
    // optional: you can show talk state here
    log("[talk]", JSON.stringify(msg.data || {}));
  }

  if (msg.type === "error") {
    log("[ws] ERROR:", msg.error);
    setRingStatus("ERROR", msg.error);
  }
};

/** ---------- UI events ---------- */
tabLive.onclick = () => setTab(tabLive);
tabHistory.onclick = () => setTab(tabHistory);
tabLogs.onclick = () => setTab(tabLogs);

btnClearLogs.onclick = () => { logEl.textContent = ""; };
btnCopyLogs.onclick = async () => {
  try {
    await navigator.clipboard.writeText(logEl.textContent || "");
    setRingStatus("Copied logs to clipboard");
  } catch {
    setRingStatus("Copy failed (clipboard permission)");
  }
};

btnMute.onclick = () => { remoteVideo.muted = true; setRingStatus("Muted live audio"); };
btnUnmute.onclick = () => { remoteVideo.muted = false; setRingStatus("Unmuted live audio"); };

btnLoadCameras.onclick = async () => {
  try { await loadRingCameras(); }
  catch (e) { setRingStatus("ERROR loading cameras", e.message || String(e)); }
};

cameraSelect.onchange = async () => {
  selectedCameraId = cameraSelect.value || "";
  btnConnect.disabled = !selectedCameraId || isLive;
  btnLoadHistory.disabled = !selectedCameraId;

  // reset talk availability until live is on
  btnTalk.disabled = true;
  setPill(pillTalk, "warn");

  if (!selectedCameraId) {
    setRingStatus("Select a camera");
    return;
  }

  setRingStatus(`Selected camera ${selectedCameraId}`, "Ready to connect.");
};

btnConnect.onclick = async () => {
  try {
    if (!selectedCameraId) throw new Error("Select a camera first");

    setTab(tabLive);
    setRingStatus("Connecting…", "Starting live ingest + consuming producers…");
    setPill(pillLive, "warn");

    resetRemoteObjects();
    await unlockPlayback();

    // stop previous session
    await stopRingLive().catch(() => { });

    // start new
    const started = await startRingLive(selectedCameraId);
    log("[ring] live started:", JSON.stringify(started));

    // consume
    await autoConsumeIngest();
    tryStartPlayback();

    setLiveUi(true);
    btnTalk.disabled = false;
    setRingStatus("Live connected", "Hold to Talk enabled (if device supports two-way).");
  } catch (e) {
    setLiveUi(false);
    setRingStatus("Connect ERROR", e.message || String(e));
    setPill(pillLive, "bad");
  }
};

btnDisconnect.onclick = async () => {
  try {
    setRingStatus("Disconnecting…");
    await stopRingLive();
  } finally {
    resetRemoteObjects();
    setLiveUi(false);
    btnTalk.disabled = true;
    setPill(pillTalk, "warn");
    setRingStatus("Disconnected");
  }
};

btnTalk.onpointerdown = async (e) => {
  e.preventDefault();
  if (btnTalk.disabled || isHolding) return;
  isHolding = true;
  btnTalk.textContent = "🎙 Talking…";
  btnTalk.style.opacity = "0.85";
  try { btnTalk.setPointerCapture?.(e.pointerId); } catch { }

  try {
    await startMic();
  } catch (err) {
    setPill(pillTalk, "bad");
    setRingStatus("Talk ERROR", err.message || String(err));
    isHolding = false;
    btnTalk.textContent = "🎙 Hold to Talk";
    btnTalk.style.opacity = "1";
  }
};

async function endHold() {
  if (!isHolding) return;
  isHolding = false;
  try { await stopMic(); } catch { }
  btnTalk.textContent = "🎙 Hold to Talk";
  btnTalk.style.opacity = "1";
}
btnTalk.onpointerup = (e) => { e.preventDefault(); endHold(); };
btnTalk.onpointercancel = (e) => { e.preventDefault(); endHold(); };
btnTalk.onpointerleave = (e) => { e.preventDefault(); endHold(); };

btnLoadHistory.onclick = async () => {
  const cameraId = selectedCameraId;
  if (!cameraId) return;

  setTab(tabHistory);
  historyMeta.textContent = "Loading…";
  playbackMeta.textContent = "—";

  try {
    const limit = Number(historyLimitEl.value || 25);
    const data = await loadHistory(cameraId, limit);
    historyCache = data;

    updateHistoryCounts(data);
    buildHistoryRows(cameraId, data);

    setRingStatus("History loaded", `${data?.counts?.recorded || 0} recorded • ${data?.counts?.activity || 0} activity`);
  } catch (e) {
    historyMeta.textContent = "Error";
    setRingStatus("History ERROR", e.message || String(e));
  }
};

historySearchEl.oninput = () => {
  if (!historyCache || !selectedCameraId) return;
  buildHistoryRows(selectedCameraId, historyCache);
};
historyRecordedOnlyEl.onchange = () => {
  if (!historyCache || !selectedCameraId) return;
  buildHistoryRows(selectedCameraId, historyCache);
};

/** ---------- Initial state ---------- */
setTab(tabLive);
setPill(pillWs, "warn");
setPill(pillLive, "warn");
setPill(pillTalk, "warn");
setRingStatus("Ready", "Load cameras to begin.");
btnConnect.disabled = true;
btnDisconnect.disabled = true;
btnTalk.disabled = true;
btnLoadHistory.disabled = true;


