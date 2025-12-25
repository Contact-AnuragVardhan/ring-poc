// server/state/ingestState.js
module.exports = {
  plainTransport: null,
  videoProducer: null,
  ffmpeg: null,
  rtpPort: null,
  ssrc: 22222222,
  payloadType: 102,
  sipSession: null,
  liveCall: null,
  label: null,
  rtpInPort: null,
  rtpSock: null,
  sdpPath: null,
  ringPt: null,
  ringSsrc: null,
  __videoSub: null,
  bytesTimer: null,

  // audio receive path (Ring -> Browser)
  audioTransport: null,
  audioProducer: null,
  audioFfmpeg: null,

  audioPayloadType: 111, // opus
  audioSsrc: 33333333,

  ringAudioPt: null,
  ringAudioSsrc: null,
  audioRtpInPort: null,
  audioRtpSock: null,
  audioSdpPath: null,
  __audioSub: null,
};
