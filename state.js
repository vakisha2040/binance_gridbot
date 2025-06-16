//persisted file to state.json


const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

// Load state from file or use defaults
let state = {
  botRunning: false,
  mainTrade: null,
  hedgeTrade: null,
  cooldownUntil: 0
};

function loadState() {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    state = JSON.parse(data);
  } catch (err) {
    saveState(); // Write default state if file doesn't exist
  }
}

function saveState() {
    const data = {
    botRunning,
    mainTrade,
    hedgeTrade,
    cooldownUntil
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}




// Load state at startup
loadState();

// State control functions
function startBot() {
  state.botRunning = true;
  saveState();
}
function stopBot() {
  state.botRunning = false;
  saveState();
}
function isRunning() {
  return state.botRunning;
}

function setMainTrade(trade) {
  state.mainTrade = trade;
  saveState();
}
function clearMainTrade() {
  state.mainTrade = null;
  saveState();
}
function getMainTrade() {
  return state.mainTrade;
}

function setHedgeTrade(trade) {
  state.hedgeTrade = trade;
  saveState();
}
function clearHedgeTrade() {
  state.hedgeTrade = null;
  saveState();
}
function getHedgeTrade() {
  return state.hedgeTrade;
}

function setCooldown(seconds) {
  state.cooldownUntil = Date.now() + seconds * 1000;
  saveState();
}
function isCooldown() {
  return Date.now() < state.cooldownUntil;
}

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
