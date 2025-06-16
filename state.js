let botRunning = false;
let mainTrade = null;
let hedgeTrade = null;
let cooldownUntil = 0;

function startBot() { botRunning = true; }
function stopBot() { botRunning = false; }
function isRunning() { return botRunning; }
function setMainTrade(trade) { mainTrade = trade; }
function clearMainTrade() { mainTrade = null; }
function setHedgeTrade(trade) { hedgeTrade = trade; }
function clearHedgeTrade() { hedgeTrade = null; }
function getMainTrade() { return mainTrade; }
function getHedgeTrade() { return hedgeTrade; }
function setCooldown(seconds) { cooldownUntil = Date.now() + seconds * 1000; }
function isCooldown() { return Date.now() < cooldownUntil; }

module.exports = {
  startBot,
  stopBot,
  isRunning,
  setMainTrade,
  clearMainTrade,
  getMainTrade,
  setHedgeTrade,
  clearHedgeTrade,
  getHedgeTrade,
  setCooldown,
  isCooldown,
};
