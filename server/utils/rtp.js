// server/utils/rtp.js
function toBuffer(x) {
  if (!x) return null;
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof Uint8Array) return Buffer.from(x);
  if (x.buffer && x.byteLength != null) {
    return Buffer.from(x.buffer, x.byteOffset ?? 0, x.byteLength);
  }
  return null;
}

function buildRtpPacketBytes(evt) {
  const h = evt?.header;
  const payload = toBuffer(evt?.payload);
  if (!h || !payload) return null;

  const version = (h.version ?? 2) & 0x03;
  const padding = 0;
  const extension = 0;
  const csrcLength = 0;

  const headerLen = 12;
  const headerBuf = Buffer.alloc(headerLen);

  const b0 =
    (version << 6) |
    (padding << 5) |
    (extension << 4) |
    (csrcLength & 0x0f);

  const b1 = ((h.marker ? 1 : 0) << 7) | (h.payloadType & 0x7f);

  headerBuf[0] = b0;
  headerBuf[1] = b1;
  headerBuf.writeUInt16BE(h.sequenceNumber & 0xffff, 2);
  headerBuf.writeUInt32BE(h.timestamp >>> 0, 4);
  headerBuf.writeUInt32BE(h.ssrc >>> 0, 8);

  return Buffer.concat([headerBuf, payload]);
}

let printedKeys = false;

function getRawRtpBytes(evt) {
  if (!evt) return null;

  if (!printedKeys) {
    printedKeys = true;
    console.log("[ring] evt keys:", Object.keys(evt));
    console.log("[ring] header keys:", Object.keys(evt.header || {}));
    console.log("[ring] has raw packet fields:", {
      packet: Buffer.isBuffer(evt.packet),
      raw: Buffer.isBuffer(evt.raw),
    });
  }

  if (Buffer.isBuffer(evt.packet)) return evt.packet;
  if (Buffer.isBuffer(evt.raw)) return evt.raw;

  return buildRtpPacketBytes(evt);
}

module.exports = { toBuffer, buildRtpPacketBytes, getRawRtpBytes };
