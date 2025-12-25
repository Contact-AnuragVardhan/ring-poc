// server/routes/ringRoutes.js
const {
  listCameras,
  startRingToRtp,
  getCameraCapabilities,
  getCameraRecording,
} = require("../ring-control");

const { withSwitchLock } = require("../utils/async");
const ingest = require("../state/ingestState");

const { stopIngest, startLiveRingToMediasoup } = require("../services/ingestService");
const { startAudio, subscribeRingAudioRtp } = require("../services/ringAudioService");

function attachRingRoutes(app, ms) {
  const { router } = ms;

  app.get("/api/ring/cameras", async (req, res) => {
    try {
      const cams = await listCameras();
      res.json({
        ok: true,
        cameras: cams.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          type: c.deviceType,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // start live -> Ring -> FFmpeg -> mediasoup
  app.post("/api/ring/cameras/:id/live/start", async (req, res) => {
    return withSwitchLock(async () => {
      try {
        const cameraId = req.params.id;

        // stop previous ingest if running
        await stopIngest();

        // start live ingest
        const { started, videoProducer } = await startLiveRingToMediasoup(router, {
          cameraId,
          startRingToRtp,
        });

        // start audio producer (mediasoup side)
        await startAudio(router, cameraId);

        // subscribe ring audio packets if available
        if (started.liveCall) {
          await subscribeRingAudioRtp(cameraId);
        }

        res.json({ ok: true, cameraId, name: started.name, producerId: videoProducer.id });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    });
  });

  app.get("/api/ring/cameras/:id/capabilities", async (req, res) => {
    try {
      const caps = await getCameraCapabilities(req.params.id);
      res.json({ ok: true, caps });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // HISTORY (your original logic kept in-place)
  app.get("/api/ring/cameras/:id/history", async (req, res) => {
    try {
      const cameraId = req.params.id;

      const cams = await listCameras();
      const cam = cams.find((c) => String(c.id) === String(cameraId));
      if (!cam) return res.status(404).json({ ok: false, error: "Camera not found" });

      if (typeof cam.getEvents !== "function") {
        return res.status(400).json({ ok: false, error: "This camera object does not support getEvents()" });
      }

      const limit = Math.min(Number(req.query.limit || 25), 100);
      const kind = req.query.kind;
      const since = req.query.since ? new Date(String(req.query.since)) : null;
      const until = req.query.until ? new Date(String(req.query.until)) : null;

      let resp = await cam.getEvents({ limit }).catch(async () => cam.getEvents());

      let events =
        Array.isArray(resp) ? resp :
          Array.isArray(resp?.events) ? resp.events :
            Array.isArray(resp?.items) ? resp.items :
              [];

      if (kind) {
        const k = String(kind).toLowerCase();
        events = events.filter((e) => {
          const t = String(e?.kind || e?.type || e?.eventType || "").toLowerCase();
          return t.includes(k);
        });
      }

      if (since || until) {
        events = events.filter((e) => {
          const ts = e?.created_at || e?.createdAt || e?.timestamp || e?.occurred_at || e?.answered_at;
          const d = ts ? new Date(ts) : null;
          if (!d || Number.isNaN(d.getTime())) return false;
          if (since && d < since) return false;
          if (until && d > until) return false;
          return true;
        });
      }

      const recorded = [];
      const activity = [];
      events = events.slice(0, limit);

      for (const e of events) {
        const raw = e?.raw || e;

        const dingIdStr =
          raw?.ding_id_str ||
          e?.ding_id_str ||
          e?.dingIdStr ||
          raw?.event_id ||
          String(raw?.ding_id || e?.ding_id || e?.dingId || e?.id || "");

        const dingId =
          raw?.ding_id ??
          e?.ding_id ??
          e?.dingId ??
          e?.id ??
          null;

        const createdAt =
          raw?.created_at ||
          e?.created_at ||
          e?.createdAt ||
          e?.timestamp ||
          null;

        const eventKind =
          raw?.kind ||
          e?.kind ||
          raw?.event_type ||
          e?.eventType ||
          e?.type ||
          "event";

        const recordedFlag = raw?.recorded === true || e?.recorded === true;
        const recordingStatus = raw?.recording_status ?? e?.recording_status ?? null;

        const playable = recordedFlag === true && recordingStatus === "ready";

        const slim = {
          id: dingIdStr || String(dingId || ""),
          dingIdStr,
          dingId,
          kind: eventKind,
          created_at: createdAt,
          doorbot_id: e?.doorbot_id ?? e?.doorbotId ?? null,
          answered: e?.answered,
          hasRecording: playable,
          recorded: recordedFlag,
          recording_status: recordingStatus,
          raw: raw,
        };
        if (playable) recorded.push(slim);
        else activity.push(slim);
      }

      res.json({
        ok: true,
        cameraId,
        counts: {
          recorded: recorded.length,
          activity: activity.length,
          total: recorded.length + activity.length
        },
        recorded,
        activity,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get("/api/ring/cameras/:id/recordings/:eventId", async (req, res) => {
    try {
      const cameraId = req.params.id;
      const eventId = String(req.params.eventId || "").trim();

      if (!eventId) return res.status(400).send("Missing eventId");

      // guard (your original)
      try {
        const cams = await listCameras();
        const cam = cams.find((c) => String(c.id) === String(cameraId));
        if (cam && typeof cam.getEvents === "function") {
          const resp = await cam.getEvents({ limit: 50 }).catch(async () => cam.getEvents());
          const events =
            Array.isArray(resp) ? resp :
              Array.isArray(resp?.events) ? resp.events :
                Array.isArray(resp?.items) ? resp.items :
                  [];

          const found = events.find((e) => {
            const raw = e?.raw || e;
            const did = raw?.ding_id_str || e?.ding_id_str || e?.dingIdStr || String(raw?.ding_id || e?.ding_id || "");
            return String(did) === eventId || String(raw?.ding_id || e?.ding_id || "") === eventId;
          });

          if (found) {
            const raw = found?.raw || found;
            const recordedFlag = raw?.recorded === true || found?.recorded === true;
            const recordingStatus = raw?.recording_status ?? found?.recording_status ?? null;
            const playable = recordedFlag === true && recordingStatus === "ready";
            if (!playable) {
              return res.status(404).send("This event has no recording (recorded=false or recording_status!=ready).");
            }
          }
        }
      } catch {}

      const rec = await getCameraRecording(cameraId, eventId);

      if (rec.type === "url") return res.redirect(302, rec.url);

      res.setHeader("Content-Type", "video/mp4");

      rec.stream.on("error", (err) => {
        console.log("[ring] recording stream error:", err?.message || err);
        try { res.end(); } catch {}
      });

      rec.stream.pipe(res);
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.toLowerCase().includes("not found")) {
        return res.status(404).send("Recording not found for this event. (Usually: not recorded, not ready, or no subscription.)");
      }
      res.status(500).send(msg);
    }
  });
}

module.exports = { attachRingRoutes };
