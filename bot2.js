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

// This start supports persisted
// state to state.json
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

    // If no open main or hedge, check for boundary cross to open main trade
    if (!state.getMainTrade() && !state.getHedgeTrade()) {
      if (price >= boundaries.top) {
        await openMainTrade('Buy', price);
      } else if (price <= boundaries.bottom) {
        await openMainTrade('Sell', price);
      }
      await delay(1000);
      continue;
    }

    // Update main trade logic
    if (state.getMainTrade()) {
      await handleMainTrade(price);
    }

    // Update hedge trade logic
    if (state.getHedgeTrade()) {
      await handleHedgeTrade(price);
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
async function handleMainTrade(price) {
  const mainTrade = state.getMainTrade();
  if (!mainTrade) return;

  const direction = mainTrade.side === 'Buy' ? 1 : -1;
  const currentLevel = mainTrade.level;
  const nextLevelPrice = toPrecision(mainTrade.entry + direction * config.gridSpacing * (currentLevel + 1));

  // --- GRID ADVANCE & TRAILING STOP LOGIC ---
  if (
    (mainTrade.side === 'Buy' && price >= nextLevelPrice) ||
    (mainTrade.side === 'Sell' && price <= nextLevelPrice)
  ) {
    const previousLevel = currentLevel;
    mainTrade.level += 1;
    sendMessage(`📊 Main trade reached level ${mainTrade.level} at ${price}`);

    if (mainTrade.level >= 1) {
      // Trailing stop: midpoint between prev and current grid level
      const prevLevelPrice = mainTrade.entry + direction * config.gridSpacing * previousLevel;
      const currLevelPrice = mainTrade.entry + direction * config.gridSpacing * mainTrade.level;
      mainTrade.stopLoss = toPrecision(prevLevelPrice + config.gridStopLossPercent * (currLevelPrice - prevLevelPrice));
      sendMessage(`🔒 Main trade stop loss updated to ${mainTrade.stopLoss}`);
    }
  }

  // --- STOP LOSS CHECK WITH BREAKTHROUGH LOGIC ---
  if (mainTrade.level >= 1 && mainTrade.stopLoss !== null) {
    if (mainTrade.breakthroughPrice !== undefined && mainTrade.breakthroughPrice !== null) {
      // For Buy: wait until price > breakthroughPrice; For Sell: price < breakthroughPrice
      if ((mainTrade.side === 'Buy' && price > mainTrade.breakthroughPrice) ||
          (mainTrade.side === 'Sell' && price < mainTrade.breakthroughPrice)) {
        // Breakthrough achieved, clear so stoploss is active from now on
        sendMessage(`🚦 Breakthrough price (${mainTrade.breakthroughPrice}) crossed. Stoploss is now active.`);
        mainTrade.breakthroughPrice = null;
      } else {
        // Still waiting for breakthrough, skip stoploss logic
        return;
      }
    }
    // Now stoploss logic is normal
    if (
      (mainTrade.side === 'Buy' && price <= mainTrade.stopLoss) ||
      (mainTrade.side === 'Sell' && price >= mainTrade.stopLoss)
    ) {
      await closeMainTrade(price, false);
      return;
    }
  }

  // --- HEDGE LOGIC ---
  // For Buy main trade, open hedge if price drops to bottom boundary.
  // For Sell main trade, open hedge if price rises to top boundary.
  if (
    !state.getHedgeTrade() &&
    mainTrade.level === 0 &&
    (
      (mainTrade.side === 'Buy' && price <= boundaries.bottom) ||
      (mainTrade.side === 'Sell' && price >= boundaries.top)
    )
  ) {
    await openHedgeTrade(mainTrade.side === 'Buy' ? 'Sell' : 'Buy', price);
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
  // breakthroughPrice is kept as-is for new main
  state.setMainTrade(hedge);
  state.clearHedgeTrade();
  sendMessage('🔁 Hedge trade promoted to main trade. Grid reset and stop loss cleared.');
  initializeHedgePromotionBoundary();
}

async function openHedgeTrade(side, entryPrice) {
  try {
    // Calculate breakthrough price
    let breakthroughPrice = null;
    if (side === 'Buy') {
      breakthroughPrice = toPrecision(entryPrice + 0.5 * config.gridSpacing);
    } else {
      breakthroughPrice = toPrecision(entryPrice - 0.5 * config.gridSpacing);
    }
    await bybit.openHedgeTrade(side, config.orderSize);
    state.setHedgeTrade({
      side,
      entry: entryPrice,
      level: 0,
      hedge: true,
      gridLevels: [],
      stopLoss: null,
      breakthroughPrice, // Store breakthrough price
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
  const nextLevelPrice = toPrecision(hedgeTrade.entry + direction * config.gridSpacing * (currentLevel + 1));

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
      const prevLevelPrice = hedgeTrade.entry + direction * config.gridSpacing * previousLevel;
      const currLevelPrice = hedgeTrade.entry + direction * config.gridSpacing * hedgeTrade.level;
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

async function closeHedgeTrade(price) {
  try {
    const hedgeTrade = state.getHedgeTrade();
    if (!hedgeTrade) return;
    await bybit.closeHedgeTrade(hedgeTrade.side, config.orderSize);
    sendMessage(`❌ Hedge trade closed at ${price}`);
    lastHedgeClosePrice = price;
    state.clearHedgeTrade();

    // Immediately reset the boundary for the next hedge (no cooldown)
    setImmediateHedgeBoundary(price);

  } catch (e) {
    sendMessage(`❌ Failed to close hedge trade: ${e.message}`);
  }
}

// New: Calculate trailing hedge open price and set boundaries accordingly
function calculateTrailingHedgeOpenPrice(lastClose, currentPrice, gridSpacing, trailingBoundary, maxHedgeTrailDistance, mainTradeSide) {
  const distance = Math.abs(currentPrice - lastClose);

  let newOpenPrice;
  if (distance > trailingBoundary) {
    newOpenPrice = lastClose + 0.5 * (currentPrice - lastClose);
    // Clamp within maxHedgeTrailDistance if configured
    if (maxHedgeTrailDistance && Math.abs(newOpenPrice - lastClose) > maxHedgeTrailDistance) {
      if (currentPrice > lastClose)
        newOpenPrice = lastClose + maxHedgeTrailDistance;
      else
        newOpenPrice = lastClose - maxHedgeTrailDistance;
    }
    sendMessage(
      `⚡️ Hedge boundary adjusted for sharp move:\n` +
      `Last hedge close: ${lastClose}, Current price: ${currentPrice}, Distance: ${distance}, New hedge open price: ${newOpenPrice}`
    );
  } else {
    newOpenPrice = mainTradeSide === 'Buy'
      ? lastClose - gridSpacing
      : lastClose + gridSpacing;
    sendMessage(
      `🔲 Hedge boundary (default grid): Last hedge close: ${lastClose}, New hedge open price: ${newOpenPrice}`
    );
  }
  return toPrecision(newOpenPrice);
}

function setImmediateHedgeBoundary(price) {
  const mainTrade = state.getMainTrade();
  if (!mainTrade) return;
  trailingBoundary = config.trailingBoundary || 200;
  const maxHedgeTrailDistance = config.maxHedgeTrailDistance || 300;
  let newBoundary;

  // Use last hedge close for calculation
  const lastClose = lastHedgeClosePrice || price;

  if (mainTrade.side === 'Buy') {
    // For Buy, boundary is below price
    newBoundary = calculateTrailingHedgeOpenPrice(
      lastClose,
      price,
      config.tradeEntrySpacing,
      trailingBoundary,
      maxHedgeTrailDistance,
      mainTrade.side
    );
    boundaries.bottom = newBoundary;
    boundaries.top = null;
    sendMessage(`🟦 New bottom boundary for next hedge: ${boundaries.bottom}`);
  } else if (mainTrade.side === 'Sell') {
    newBoundary = calculateTrailingHedgeOpenPrice(
      lastClose,
      price,
      config.tradeEntrySpacing,
      trailingBoundary,
      maxHedgeTrailDistance,
      mainTrade.side
    );
    boundaries.top = newBoundary;
    boundaries.bottom = null;
    sendMessage(`🟥 New top boundary for next hedge: ${boundaries.top}`);
  }
  persistBoundaries();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function manualCloseMainTrade() {
  const price = getCurrentPrice();
  if (!price || !state.getMainTrade()) return;
  await closeMainTrade(price, true);
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
  promoteHedgeToMain,
  resetBot,
};
