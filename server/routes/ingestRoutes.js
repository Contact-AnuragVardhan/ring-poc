// server/routes/ingestRoutes.js
const ingest = require("../state/ingestState");
const { withSwitchLock } = require("../utils/async");

const { stopIngest } = require("../services/ingestService");

function attachIngestRoutes(app, ms) {
  app.post("/api/ingest/start", async (req, res) => {
    try {
      return res.status(501).json({ ok: false, error: "Sample ingest start not wired in this refactor yet." });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post("/api/ingest/stop", async (req, res) => {
    try {
      await withSwitchLock(async () => {
        await stopIngest();
      });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
}

module.exports = { attachIngestRoutes };
