const {
  calculateNextPrice,
  calculateStopLoss,
  fetchPrecision,
  toPrecision,
} = require('./helper');

const {
  getCurrentPrice,
  waitForFirstPrice,
  startPolling,
  stopPolling
} = require('./priceFeed');

const bybit = require('./binanceClient');
const config = require('./config.json');
const state = require('./state');

const { clearBoundary, loadBoundary, saveBoundary } = require('./persistence');

let sendMessage = () => {};
function setSendMessage(fn) {
  sendMessage = fn;
  bybit.setSendMessage(sendMessage); // inject after assignment
}

// -- Load boundary state on startup
let { trailingBoundary, boundaries } = loadBoundary();
if (!boundaries) boundaries = { top: null, bottom: null };
let lastHedgeClosePrice = null;
let hedgeCooldownUntil = 0; // 🚫 Prevent immediate re-entry 

// for new hedge boundary update
let lastBoundaryUpdateTime = 0;
const BOUNDARY_UPDATE_INTERVAL = 30 * 1000; // 30 seconds
let lastSetBoundary = null;
const HBP = config.hedgeBreakthroughPrice; 
let preKillStartTime = null; // used before killTrigger is armed
let lastKillResetTime = 0; // Global
// This start supports persisted
// state to state.json

let hedgeOpeningInProgress = false;

function getGridSpacing(level) {
  if (level === 0) return config.zeroLevelSpacing;
  return config.gridSpacing; // fallback for compatibility
}

async function startBot() {
  fetchPrecision(config);
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  sendMessage('🤖 Bot started');

  const mainTrade = state.getMainTrade();
  const hedgeTrade = state.getHedgeTrade();

  if (mainTrade) {
    sendMessage(`📦 Resuming main trade: ${mainTrade.side} from ${mainTrade.entry} at level ${mainTrade.level}`);
    await initializeHedgePromotionBoundary();
  } else {
    await initializeBoundaries();
  }

  if (hedgeTrade) {
    sendMessage(`🛡️ Resuming hedge trade: ${hedgeTrade.side} from ${hedgeTrade.entry} at level ${hedgeTrade.level}`);
  }

  monitorPrice();
}

// this is used for clearing state
async function resetBot() {
  state.clearMainTrade();
  state.clearHedgeTrade();
  state.stopBot();
  state.saveState();
  clearBoundary();
  sendMessage('♻️ Persistent state cleared.');
  await initializeBoundaries();
  try {
    await bybit.cancelAllOrders();
  } catch (e) {
    console.error('❌ Error canceling orders during reset:', e.message);
  }
}

function stopBot() {
  stopPolling();
  state.stopBot();
  sendMessage('🛑 Bot stopped');
}

// Persist boundary changes
function persistBoundaries() {
  saveBoundary({ trailingBoundary, boundaries });
}

async function initializeBoundaries() {
  const price = getCurrentPrice();
  if (!price) {
    sendMessage('⚠️ Unable to get current price to set boundaries.');
    return;
  }
  boundaries.top = toPrecision(price + config.tradeEntrySpacing);
  boundaries.bottom = toPrecision(price - config.tradeEntrySpacing);
  persistBoundaries();
  sendMessage(`🔲 Boundaries set: Top ${boundaries.top}, Bottom ${boundaries.bottom}`);
}


async function monitorPrice() {
  while (state.isRunning()) {
    const price = getCurrentPrice();
    if (!price) {
      await delay(1000);
      continue;
    }
// of no main or hedge check for boundarycross
    if (!state.getMainTrade() && !state.getHedgeTrade()) {
      if (price >= boundaries.top) {
        await openMainTrade('Buy', price);
      } else if (price <= boundaries.bottom) {
        await openMainTrade('Sell', price);
      }
      await delay(1000);
      continue;
    }
//update maintrade logic
    if (state.getMainTrade()) {
      await handleMainTrade(price);
    }

    if (state.getHedgeTrade()) {
      await handleHedgeTrade(price);
     await killHedge();
    }

    // 🔄 Dynamic trailing hedge boundary update (with throttling)
    const now = Date.now();
    if (
      state.getMainTrade() &&
      !state.getHedgeTrade() &&
      lastHedgeClosePrice &&
      Math.abs(price - lastHedgeClosePrice) > (config.trailingBoundary || 100) &&
      now - lastBoundaryUpdateTime > BOUNDARY_UPDATE_INTERVAL
    ) {
      setImmediateHedgeBoundary(price);
      lastBoundaryUpdateTime = now;
    }

    await delay(1000);
  }
}

                             
async function openMainTrade(side, entryPrice) {
  try {
    await bybit.openMainTrade(side, config.orderSize);
    state.setMainTrade({
      side,
      entry: entryPrice,
      level: 0,
      hedge: false,
      gridLevels: [],
      stopLoss: null,
      breakthroughPrice: null, // will be set if promoted from hedge
    });
    sendMessage(`📈 Main trade opened: ${side} at ${entryPrice}`);
    await initializeBoundaries();
  } catch (e) {
    sendMessage(`❌ Failed to open main trade: ${e.message}`);
  }
}

// TRAILING STOP LOGIC: updates stop loss only at new grid levels
async function handleMainTrade(price) { const mainTrade = state.getMainTrade(); if (!mainTrade) return;
const direction = mainTrade.side === 'Buy' ? 1 : -1; 
const currentLevel = mainTrade.level;
const nextLevelPrice = toPrecision( mainTrade.entry + direction * getGridSpacing(currentLevel) * (currentLevel + 1) 
);

if (
(mainTrade.side === 'Buy' && price >= nextLevelPrice) || (mainTrade.side === 'Sell' && price <= nextLevelPrice) 
) { 
const previousLevel = currentLevel; mainTrade.level += 1;
sendMessage(`📊 Main trade reached level ${mainTrade.level} at ${price}`);

if (mainTrade.level >= 1) {
  const prevLevelPrice = mainTrade.entry + direction * getGridSpacing(previousLevel) * previousLevel;
  const currLevelPrice = mainTrade.entry + direction * getGridSpacing(mainTrade.level) * mainTrade.level;

  mainTrade.stopLoss = toPrecision(prevLevelPrice + config.gridStopLossPercent * (currLevelPrice - prevLevelPrice));
  sendMessage(`🔒 Main trade stop loss updated to ${mainTrade.stopLoss}`);
}
}
if (mainTrade.level >= 1 && mainTrade.stopLoss !== null) { 
if (mainTrade.breakthroughPrice !== undefined && mainTrade.breakthroughPrice !== null) { 
if ((mainTrade.side === 'Buy' && price > mainTrade.breakthroughPrice) || (mainTrade.side === 'Sell' && price < mainTrade.breakthroughPrice)) {
sendMessage(🚦 Breakthrough price (${mainTrade.breakthroughPrice}) crossed. Stoploss is now active.); mainTrade.breakthroughPrice = null;
} else { 
return;
} 
} 
if ( (mainTrade.side === 'Buy' && price <= mainTrade.stopLoss) || (mainTrade.side === 'Sell' && price >= mainTrade.stopLoss) ) { 
await closeMainTrade(price, false); return; 
} 
}

if ( !state.getHedgeTrade() && !hedgeOpeningInProgress && Date.now() > hedgeCooldownUntil && mainTrade.level === 0 && ( (mainTrade.side === 'Buy' && price <= boundaries.bottom) || (mainTrade.side === 'Sell' && price >= boundaries.top) ) ) { hedgeOpeningInProgress = true; 
await openHedgeTrade(mainTrade.side === 'Buy' ? 'Sell' : 'Buy', price); hedgeOpeningInProgress = false; 
}
}


async function closeMainTrade(price, manual = false) {
  try {
    const mainTrade = state.getMainTrade();
    if (!mainTrade) return;
    await bybit.closeMainTrade(mainTrade.side, config.orderSize);
    sendMessage(`❌ Main trade closed at ${price}${manual ? " (manual)" : ""}`);
    state.clearMainTrade();

    // If a hedge trade is active, promote it to main
    if (state.getHedgeTrade()) {
      promoteHedgeToMain();
    } else {
      await initializeBoundaries();
    }
  } catch (e) {
    sendMessage(`❌ Failed to close main trade: ${e.message}`);
  }
}

// Function to initialize hedge promotion boundary using tradeEntrySpacing
function initializeHedgePromotionBoundary() {
  const mainTrade = state.getMainTrade();
  const price = getCurrentPrice();
  if (!mainTrade || !price) {
    sendMessage('⚠️ Unable to get current price or trade info for boundaries.');
    return;
  }
  if (mainTrade.side === 'Buy') {
    boundaries.bottom = toPrecision(price - config.tradeEntrySpacing);
    boundaries.top = null;
    persistBoundaries();
    sendMessage(`🔲 (Hedge->Main) Bottom boundary set: ${boundaries.bottom}`);
  } else if (mainTrade.side === 'Sell') {
    boundaries.top = toPrecision(price + config.tradeEntrySpacing);
    boundaries.bottom = null;
    persistBoundaries();
    sendMessage(`🔲 (Hedge->Main) Top boundary set: ${boundaries.top}`);
  }
}

// Promote a hedge trade to main and reset boundaries appropriately
function promoteHedgeToMain() {
  const hedge = state.getHedgeTrade();
  if (!hedge) return;
  hedge.level = 0;
  hedge.hedge = false;
  hedge.stopLoss = null;
  hedge.killZoneTouched = false;      // 🔄 Reset kill tracking
  hedge.openTimestamp = null;         // 🔄 Reset kill tracking timer

  state.setMainTrade(hedge);
  state.clearHedgeTrade();
  sendMessage('🔁 Hedge trade promoted to main trade. Grid reset and stop loss cleared.');
  initializeHedgePromotionBoundary();
} 
  

//for hedge trade opening twice
async function openHedgeTrade(side, entryPrice) {
  if (state.getHedgeTrade()) {
    sendMessage(`⚠️ Attempt to open duplicate hedge ignored.`);
    return;
  }

  try {
    let breakthroughPrice = null;
    if (side === 'Buy') {
      breakthroughPrice = toPrecision(entryPrice + 0.5 * config.zeroLevelSpacing);
    } else {
      breakthroughPrice = toPrecision(entryPrice - 0.5 * config.zeroLevelSpacing);
    }

    await bybit.openHedgeTrade(side, config.orderSize);

    state.setHedgeTrade({
      side,
      entry: entryPrice,
      level: 0,
      hedge: true,
      gridLevels: [],
      stopLoss: null,
      breakthroughPrice,
      timestamp: Date.now(),
    });

    sendMessage(`🛡️ Hedge trade opened: ${side} at ${entryPrice} (Breakthrough: ${breakthroughPrice})`);
  } catch (e) {
    sendMessage(`❌ Failed to open hedge trade: ${e.message}`);
  }
}

// TRAILING STOP LOGIC for hedge as for main trade
async function handleHedgeTrade(price) {
  const hedgeTrade = state.getHedgeTrade();
  if (!hedgeTrade) return;

  const direction = hedgeTrade.side === 'Buy' ? 1 : -1;
  const currentLevel = hedgeTrade.level;
  const nextLevelPrice = toPrecision(
  hedgeTrade.entry + direction * getGridSpacing(currentLevel) * (currentLevel + 1)
);

  // --- GRID ADVANCE & TRAILING STOP LOGIC ---
  if (
    (hedgeTrade.side === 'Buy' && price >= nextLevelPrice) ||
    (hedgeTrade.side === 'Sell' && price <= nextLevelPrice)
  ) {
    const previousLevel = currentLevel;
    hedgeTrade.level += 1;
    sendMessage(`📊 Hedge trade reached level ${hedgeTrade.level} at ${price}`);

    if (hedgeTrade.level >= 1) {
      // Trailing stop: midpoint between prev and current grid level
      
     const prevLevelPrice = hedgeTrade.entry + direction * getGridSpacing(previousLevel) * previousLevel;
const currLevelPrice = hedgeTrade.entry + direction * getGridSpacing(hedgeTrade.level) * hedgeTrade.level;

      
      hedgeTrade.stopLoss = toPrecision(prevLevelPrice + config.gridStopLossPercent * (currLevelPrice - prevLevelPrice));
      sendMessage(`🔒 Hedge trade stop loss updated to ${hedgeTrade.stopLoss}`);
    }
  }

  // --- STOP LOSS CHECK ---
  if (hedgeTrade.level >= 1 && hedgeTrade.stopLoss !== null) {
    if (
      (hedgeTrade.side === 'Buy' && price <= hedgeTrade.stopLoss) ||
      (hedgeTrade.side === 'Sell' && price >= hedgeTrade.stopLoss)
    ) {
      await closeHedgeTrade(price);
      return;
    }
  }
}

//close hedge after 60 secs if price move against it


async function killHedge() {
  const hedge = state.getHedgeTrade();
  if (!hedge) return;

  const now = Date.now();
  const currentPrice = getCurrentPrice();
  if (!currentPrice) return;

  const isBuy = hedge.side === 'Buy';
  const entry = hedge.entry;
  const spacing = config.hedgeKillSpacing || 100;
  const cooldown = (config.hedgeKillCooldown || 60) * 1000;
  const resetMultiplier = config.hedgeKillResetMultiplier || 1.5;
  const returnTrigger = spacing + HBP;
  const killTriggerPrice = isBuy ? entry + spacing : entry - spacing;
  const returnTargetPrice = isBuy ? entry + returnTrigger : entry - returnTrigger;

  if (!hedge.killTriggered && (
      (isBuy && currentPrice >= killTriggerPrice) ||
      (!isBuy && currentPrice <= killTriggerPrice)
  )) {
    hedge.killTriggered = true;
    hedge.killTriggerTime = now;
  //  sendMessage(`💣 Hedge kill trigger armed for ${hedge.side} at ${entry} — waiting for return to ${returnTargetPrice}`);
    return;
  }

  if (hedge.killTriggered) {
    if (now - (hedge.killTriggerTime || 0) >= cooldown) {
      const shouldKill =
        (isBuy && currentPrice <= returnTargetPrice) ||
        (!isBuy && currentPrice >= returnTargetPrice);

      if (shouldKill) {
        sendMessage(`✅ Hedge kill condition met — closing hedge at ${currentPrice}`);
        await closeHedgeTrade(currentPrice);
        lastBoundaryUpdateTime = now;
        return;
      }
    }

    const resetSpacing = spacing * resetMultiplier;
    if (
      (isBuy && currentPrice >= entry + resetSpacing + HBP) ||
      (!isBuy && currentPrice <= entry - resetSpacing - HBP)
    ) {
      hedge.killTriggered = false;
      hedge.killTriggerTime = null;
   //   sendMessage(`♻️ Hedge kill trigger reset — price moved too far from entry (${entry})`);
    }
  }
}


async function closeHedgeTrade(price, manual = false) { 
try { 
const hedgeTrade = state.getHedgeTrade(); if (!hedgeTrade) { 
sendMessage(⚠️ No hedge trade to close.); return; 
} 
await bybit.closeHedgeTrade(hedgeTrade.side, config.orderSize); 
sendMessage(❌ Hedge trade closed at ${price}${manual ? " (manual or kill)" : ""}); 
lastHedgeClosePrice = price; 
state.clearHedgeTrade(); hedgeCooldownUntil = Date.now() + (config.hedgeReentryCooldown || 30000); // ⏳ Wait before re-entry setImmediateHedgeBoundary(price); 
} catch (e) { 
sendMessage(❌ Failed to close hedge trade: ${e.message}); 
} 
}



//timing boundary calculation with spacing
function setImmediateHedgeBoundary(price) {
  const now = Date.now();
  const minMove = config.minHedgeBoundaryMove || 20;
  const throttle = config.hedgeBoundaryUpdateInterval || 30000;

  if (now - lastBoundaryUpdateTime < throttle) return; // throttle updates
  lastBoundaryUpdateTime = now;

  const mainTrade = state.getMainTrade();
  if (!mainTrade) return;

  const trailingBoundary = config.trailingBoundary || 200;
  const maxHedgeTrailDistance = config.maxHedgeTrailDistance || 200;
  const lastClose = lastHedgeClosePrice || price;

  const newBoundary = calculateTrailingHedgeOpenPrice(
    lastClose,
    price,
    config.tradeEntrySpacing,
    trailingBoundary,
    maxHedgeTrailDistance,
    mainTrade.side
  );

  const distance = Math.abs(price - lastClose);
  const moveEnough = (prev, next) => Math.abs(prev - next) >= minMove;

  if (mainTrade.side === 'Buy') {
    if (!boundaries.bottom || (newBoundary > boundaries.bottom && moveEnough(boundaries.bottom, newBoundary))) {
      boundaries.bottom = newBoundary;
      boundaries.top = null;
      sendMessage(
        `🟦 New bottom hedge boundary set\n` +
        `🔹 Main trade side: Buy\n` +
        `📉 Last hedge close: ${lastClose}\n` +
        `📈 Current price: ${price}\n` +
        `📏 Distance moved: ${toPrecision(distance)}\n` +
        `🎯 New bottom boundary: ${boundaries.bottom}`
      );
      persistBoundaries();
    }
  } else if (mainTrade.side === 'Sell') {
    if (!boundaries.top || (newBoundary < boundaries.top && moveEnough(boundaries.top, newBoundary))) {
      boundaries.top = newBoundary;
      boundaries.bottom = null;
      sendMessage(
        `🟥 New top hedge boundary set\n` +
        `🔸 Main trade side: Sell\n` +
        `📉 Last hedge close: ${lastClose}\n` +
        `📈 Current price: ${price}\n` +
        `📏 Distance moved: ${toPrecision(distance)}\n` +
        `🎯 New top boundary: ${boundaries.top}`
      );
      persistBoundaries();
    }
  }
}







   function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function manualCloseMainTrade() {
  const price = getCurrentPrice();
  if (!price || !state.getMainTrade()) return;
  await closeMainTrade(price, true);
}

async function manualCloseHedgeTrade() {
  const price = getCurrentPrice();
  if (!price || !state.getHedgeTrade()) return;
  await closeHedgeTrade(price, true);
}


async function manualSellMainTrade() {
   fetchPrecision(config);
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  sendMessage('🤖 Bot started');

  
  let price;

  // Retry until we get a valid price
  while (true) {
    price = getCurrentPrice();
    if (typeof price === 'number' && !isNaN(price)) break;

    sendMessage('⏳ Waiting for valid price to place Sell trade...');
    await delay(1000); // Retry every second
  }

  // Only place a trade if there's no active main or hedge trade
  if (!state.getMainTrade() && !state.getHedgeTrade()) {
    await openMainTrade('Sell', price);
    await monitorPrice();
  } else {
    sendMessage('⚠️ Trade not placed: Main or Hedge already active.');
  }
}

async function manualBuyMainTrade() {
    fetchPrecision(config);
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  sendMessage('🤖 Bot started');

  
  
  let price;

  // Retry until we get a valid price
  while (true) {
    price = getCurrentPrice();
    if (typeof price === 'number' && !isNaN(price)) break;

    sendMessage('⏳ Waiting for valid price to place Sell trade...');
    await delay(1000); // Retry every second
  }

  // Only place a trade if there's no active main or hedge trade
  if (!state.getMainTrade() && !state.getHedgeTrade()) {
    await openMainTrade('Buy', price);
    await monitorPrice();
  } else {
    sendMessage('⚠️ Trade not placed: Main or Hedge already active.');
  }
}


module.exports = {
  startBot,
  stopBot,
  setSendMessage,
  openMainTrade,
  openHedgeTrade,
  closeMainTrade,
  closeHedgeTrade,
  manualCloseMainTrade,
  manualCloseHedgeTrade,
  manualBuyMainTrade,
manualSellMainTrade,
  promoteHedgeToMain,
  resetBot,
};
