// server/state/peerState.js
module.exports = {
  peers: new Map(),     // peerId -> { ws, transports, consumers, producers }
  producers: new Map(), // producerId -> { producer, kind, label }
};
