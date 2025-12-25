// server\server-ingest.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const { initMediasoup } = require("./mediasoup/init");
const { attachSignaling } = require("./ws/signaling");
const { attachRingRoutes } = require("./routes/ringRoutes");
const { attachIngestRoutes } = require("./routes/ingestRoutes");

async function main() {
  const app = express();
  app.use(express.static("public"));
  app.use(express.json());

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  // init mediasoup once
  const ms = await initMediasoup();

  // REST routes
  attachRingRoutes(app, ms);
  attachIngestRoutes(app, ms);

  // WebSocket signaling
  attachSignaling(wss, ms);

  server.listen(3000, () => {
    console.log("Open ingest UI: http://localhost:3000/ingest.html");
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
