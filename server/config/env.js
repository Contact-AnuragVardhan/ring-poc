const LISTEN_IP = process.env.LISTEN_IP || "0.0.0.0";
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || "";
const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT || 40000);
const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT || 40100);

module.exports = {
  LISTEN_IP,
  ANNOUNCED_IP,
  RTC_MIN_PORT,
  RTC_MAX_PORT,
};
