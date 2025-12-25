// server/utils/ws.js
const WebSocket = require("ws");

function send(ws, msg) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  } catch {}
}

function broadcast(peersMap, msg) {
  for (const p of peersMap.values()) send(p.ws, msg);
}

function randId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

module.exports = { send, broadcast, randId };
