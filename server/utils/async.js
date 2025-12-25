// server/utils/async.js
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Simple mutex to prevent Stop+Start overlap
let _switchLock = Promise.resolve();
function withSwitchLock(fn) {
  _switchLock = _switchLock.then(fn, fn);
  return _switchLock;
}

module.exports = { delay, withSwitchLock };