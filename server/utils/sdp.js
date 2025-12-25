// server/utils/sdp.js
function writeRtpSdp({ ip, port, payloadType }) {
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=RingRtp",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=video ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} H264/90000`,
    "a=recvonly",
    "",
  ].join("\n");
}

function audioRtpMapLine(pt) {
  if (pt === 0) return "a=rtpmap:0 PCMU/8000";
  if (pt === 8) return "a=rtpmap:8 PCMA/8000";
  return `a=rtpmap:${pt} opus/48000/2`;
}

function writeAudioRtpSdp({ ip, port, payloadType }) {
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=RingAudioRtp",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${payloadType}`,
    audioRtpMapLine(payloadType),
    "a=recvonly",
    "",
  ].join("\n");
}

function writeOpusInputSdp({ ip, port, payloadType, channels = 2, clockRate = 48000 }) {
  return [
    "v=0",
    `o=- 0 0 IN IP4 ${ip}`,
    "s=MicRtp",
    `c=IN IP4 ${ip}`,
    "t=0 0",
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/${clockRate}/${channels}`,
    "a=recvonly",
    "",
  ].join("\n");
}

module.exports = {
  writeRtpSdp,
  writeAudioRtpSdp,
  audioRtpMapLine,
  writeOpusInputSdp,
};
