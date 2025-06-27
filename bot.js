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

const bybit = require('./bybitClient');
const config = require('./config.json');
const state = require('./state');
const { clearBoundary, loadBoundary, saveBoundary } = require('./persistence');
const { analyze } = require('./technical');

let sendMessage = () => {};
function setSendMessage(fn) {
  sendMessage = fn;
  bybit.setSendMessage(sendMessage);
}

// Trade boundary state
let { trailingBoundary, boundaries } = loadBoundary();
if (!boundaries) boundaries = { top: null, bottom: null };
let lastBoundaryUpdateTime = 0;
const BOUNDARY_UPDATE_INTERVAL = 50 * 1000;
let boundaryLocked = false;
let hedgeOpeningInProgress = false;
let hedgeCooldownUntil = 0;
let extremeBoundary = null;

function getGridSpacing(level) {
  return level === 0 ? config.zeroLevelSpacing : config.gridSpacing;
}

async function initializeFreshBoundaries() {
  boundaryLocked = false;
  const price = getCurrentPrice();
  if (!price) {
    sendMessage('⚠️ Price unavailable - boundary reset delayed');
    return;
  }
  await checkForNewTradeOpportunity(price);
}

async function checkForNewTradeOpportunity(price) {
  if (state.getMainTrade() || state.getHedgeTrade() || Date.now() < hedgeCooldownUntil) return;
  const signal = await analyze();

  if (signal === 'BUY' || signal === 'SELL') {
    const spacing = config.tradeEntrySpacing;
    boundaries = {
      top: toPrecision(price + spacing),
      bottom: toPrecision(price - spacing)
    };
    saveBoundary({ trailingBoundary, boundaries });
    sendMessage(
      `🎯 New Trade Zones Ready\n` +
      `┌───────────────┬───────────────┐\n` +
      `│    BUY ZONE   │   SELL ZONE   │\n` +
      `│  ≤ ${boundaries.bottom} │  ≥ ${boundaries.top} │\n` +
      `└───────────────┴───────────────┘\n` +
      `Current Price: ${price}`
    );
    await openMainTrade(signal);
  } else {
    console.log(signal);
  }
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
  } else if (hedgeTrade) {
    sendMessage(`🛡️ Found existing hedge trade - promoting to main`);
    promoteHedgeToMain();
  } else {
    const price = getCurrentPrice();
    if (!price) {
      sendMessage("⚠️ Unable to fetch price for main trade on startup.");
      return;
    }
    const signal = await analyze();
    if (signal === 'BUY' || signal === 'SELL') {
    //  sendMessage(`🕐 Signal is ${signal}, Placing ${signal} order...`);
    // / await openMainTrade(signal);
    }
  }

  monitorPrice();
}

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

async function initializeBoundaries() {
  const price = getCurrentPrice();
  if (!price) {
    sendMessage('⚠️ Unable to get current price to set boundaries.');
    return;
  }
  const mainTrade = state.getMainTrade();
  if (mainTrade) {
    if (mainTrade.side === 'BUY') {
      boundaries.bottom = toPrecision(price - config.newBoundarySpacing);
      boundaries.top = null;
      sendMessage(`🔵 Buy main trade - bottom boundary set at ${boundaries.bottom} (current: ${price})`);
    } else {
      boundaries.top = toPrecision(price + config.newBoundarySpacing);
      boundaries.bottom = null;
      sendMessage(`🔴 Sell main trade - top boundary set at ${boundaries.top} (current: ${price})`);
    }
  } else {
    boundaries.top = toPrecision(price + config.tradeEntrySpacing);
    boundaries.bottom = toPrecision(price - config.tradeEntrySpacing);
    sendMessage(`⚪ No main trade - boundaries set at ${boundaries.bottom}-${boundaries.top} (current: ${price})`);
  }
  saveBoundary({ trailingBoundary, boundaries });
}

async function monitorPrice() {
  while (state.isRunning()) {
    try {
      const price = getCurrentPrice();
      if (!price) {
        await delay(2000);
        continue;
      }

      const mainTrade = state.getMainTrade();
      const hedgeTrade = state.getHedgeTrade();
      const inCooldown = Date.now() < hedgeCooldownUntil;
      const now = Date.now();

      // Hedge trade opening logic
      if (!hedgeTrade && !hedgeOpeningInProgress && !inCooldown) {
        if (mainTrade?.side === 'BUY' && boundaries.bottom) {
          const effectiveBoundary = boundaries.bottom + config.boundaryTolerance;
          if (price <= effectiveBoundary) {
            hedgeOpeningInProgress = true;
            try {
              await openHedgeTrade('SELL', price);
            } catch (e) {
              sendMessage(`❌ FAILED to open Sell hedge: ${e.message}`);
            } finally {
              hedgeOpeningInProgress = false;
            }
          }
        } else if (mainTrade?.side === 'SELL' && boundaries.top) {
          const effectiveBoundary = boundaries.top - config.boundaryTolerance;
          if (price >= effectiveBoundary) {
            hedgeOpeningInProgress = true;
            try {
              await openHedgeTrade('BUY', price);
            } catch (e) {
              sendMessage(`❌ FAILED to open Buy hedge: ${e.message}`);
            } finally {
              hedgeOpeningInProgress = false;
            }
          }
        }
      }

      if (mainTrade) {
        await handleMainTrade(price);
        if (!hedgeTrade && !boundaryLocked) {
          const currentBoundary = mainTrade.side === 'BUY' ? boundaries.bottom : boundaries.top;
          if (currentBoundary) {
            const priceFromBoundary = mainTrade.side === 'BUY'
              ? price - currentBoundary
              : currentBoundary - price;

            if (priceFromBoundary > config.trailingThreshold || priceFromBoundary > config.zeroLevelSpacing * 2) {
              await setImmediateHedgeBoundary(price, true, mainTrade);
            }
          }
        }
      }

      if (hedgeTrade) {
        await handleHedgeTrade(price);
        if (!hedgeTrade.manual) {
          await killHedge();
        }
      }

      if (!mainTrade && !hedgeTrade) {
        if (inCooldown) {
          if (now >= hedgeCooldownUntil - 5000) {
            sendMessage(`⏳ Cooldown ends in ${Math.ceil((hedgeCooldownUntil - now) / 1000)}s`);
          }
        } else {
          await initializeFreshBoundaries();
        }
      }

      if (inCooldown && now >= hedgeCooldownUntil - 1000) {
        sendMessage("🔄 Hedge cooldown period ending soon");
      }

      if (now - lastBoundaryUpdateTime > BOUNDARY_UPDATE_INTERVAL) {
        if (mainTrade && !hedgeTrade && !boundaryLocked) {
          await setImmediateHedgeBoundary(price, true, mainTrade);
        }
        lastBoundaryUpdateTime = now;
      }

      await delay(config.monitorInterval || 1000);

    } catch (e) {
      sendMessage(`‼️ CRITICAL MONITOR ERROR: ${e.message}\n${e.stack}`);
      await delay(2000);
    }
  }
}

async function openMainTrade(side, entryPrice) {
  try {
    const tradeSide = side.toUpperCase();
    await bybit.openMainTrade(tradeSide);
    state.setMainTrade({
      side: tradeSide,
      entry: entryPrice,
      level: 0,
      hedge: false,
      gridLevels: [],
      stopLoss: null,
      breakthroughPrice: null,
    });
    lastBoundaryUpdateTime = 0;
    extremeBoundary = null;
    boundaryLocked = true;
    sendMessage(`📈 Main trade opened: ${tradeSide} at ${entryPrice}`);
    await initializeBoundaries();
  } catch (e) {
    sendMessage(`❌ Failed to open main trade: ${e.message}`);
  }
}

async function handleMainTrade(price) {
  const mainTrade = state.getMainTrade();
  if (!mainTrade) return;

  const direction = mainTrade.side === 'BUY' ? 1 : -1;
  const currentLevel = mainTrade.level;
  const nextLevelPrice = toPrecision(
    mainTrade.entry + direction * getGridSpacing(currentLevel) * (currentLevel + 1)
  );

  if ((mainTrade.side === 'BUY' && price >= nextLevelPrice) ||
    (mainTrade.side === 'SELL' && price <= nextLevelPrice)) {
    const previousLevel = currentLevel;
    mainTrade.level += 1;
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
      if ((mainTrade.side === 'BUY' && price > mainTrade.breakthroughPrice) ||
        (mainTrade.side === 'SELL' && price < mainTrade.breakthroughPrice)) {
        sendMessage(`🚦 Breakthrough price (${mainTrade.breakthroughPrice}) crossed. Stoploss is now active.`);
        mainTrade.breakthroughPrice = null;
      } else {
        return;
      }
    }

    if ((mainTrade.side === 'BUY' && price <= mainTrade.stopLoss) ||
      (mainTrade.side === 'SELL' && price >= mainTrade.stopLoss)) {
      await closeMainTrade(price, false);
      return;
    }
  }

  if (!state.getHedgeTrade() && !hedgeOpeningInProgress &&
    Date.now() > hedgeCooldownUntil && mainTrade.level === 0 &&
    ((mainTrade.side === 'BUY' && price <= boundaries.bottom) ||
      (mainTrade.side === 'SELL' && price >= boundaries.top))) {
    hedgeOpeningInProgress = true;
    await openHedgeTrade(mainTrade.side === 'BUY' ? 'SELL' : 'BUY', price);
    hedgeOpeningInProgress = false;
  }
}

async function closeMainTrade(price, manual = false) {
  try {
    const mainTrade = state.getMainTrade();
    if (!mainTrade) return;

    await bybit.closeMainTrade(mainTrade.side);
    sendMessage(`✅ ${mainTrade.side} trade closed at ${price}`);

    state.clearMainTrade();

    if (state.getHedgeTrade()) {
      promoteHedgeToMain();
    } else {
      hedgeCooldownUntil = 0;
      await initializeFreshBoundaries();
    }
  } catch (e) {
    sendMessage(`❌ Close failed: ${e.message}`);
  }
}

function initializeHedgePromotionBoundary() {
  const mainTrade = state.getMainTrade();
  const price = getCurrentPrice();
  if (!mainTrade || !price) {
    sendMessage('⚠️ Unable to get current price or trade info for boundaries.');
    return;
  }
  if (mainTrade.side === 'BUY') {
    boundaries.bottom = toPrecision(price - config.newBoundarySpacing);
    boundaries.top = null;
    saveBoundary({ trailingBoundary, boundaries });
    sendMessage(`🔲 (Hedge->Main) Bottom boundary set: ${boundaries.bottom}`);
  } else if (mainTrade.side === 'SELL') {
    boundaries.top = toPrecision(price + config.newBoundarySpacing);
    boundaries.bottom = null;
    saveBoundary({ trailingBoundary, boundaries });
    sendMessage(`🔲 (Hedge->Main) Top boundary set: ${boundaries.top}`);
  }
}

function promoteHedgeToMain() {
  const hedge = state.getHedgeTrade();
  if (!hedge) return;
  hedge.level = 0;
  hedge.hedge = false;
  hedge.stopLoss = null;
  hedge.killZoneTouched = false;
  hedge.openTimestamp = null;
  state.setMainTrade(hedge);
  state.clearHedgeTrade();
  boundaryLocked = false;
  sendMessage('🔁 Hedge trade promoted to main trade. Grid reset and stop loss cleared.');
  initializeHedgePromotionBoundary();
}

async function openHedgeTrade(side, entryPrice) {
  if (state.getHedgeTrade()) {
    sendMessage(`⚠️ Attempt to open duplicate hedge ignored.`);
    return;
  }

  const mainTrade = state.getMainTrade();
  if (mainTrade) {
    if (mainTrade.side === 'BUY' && side === 'SELL' && (!boundaries.bottom || entryPrice > boundaries.bottom)) {
      return;
    } else if (mainTrade.side === 'SELL' && side === 'BUY' && (!boundaries.top || entryPrice < boundaries.top)) {
      return;
    }
  }

  try {
    let breakthroughPrice = null;
    if (side === 'BUY') {
      breakthroughPrice = toPrecision(entryPrice + 0.5 * config.zeroLevelSpacing);
    } else {
      breakthroughPrice = toPrecision(entryPrice - 0.5 * config.zeroLevelSpacing);
    }

    const hedgeSide = side.toUpperCase();
    await bybit.openHedgeTrade(hedgeSide);
    state.setHedgeTrade({
      side: hedgeSide,
      entry: entryPrice,
      level: 0,
      hedge: true,
      gridLevels: [],
      stopLoss: null,
      breakthroughPrice,
      timestamp: Date.now(),
      killTriggered: false,
      armedNotificationSent: false,
    });

    sendMessage(`🛡️ Hedge trade opened: ${hedgeSide} at ${entryPrice} (Breakthrough: ${breakthroughPrice})`);
  } catch (e) {
    sendMessage(`❌ Failed to open hedge trade: ${e.message}`);
  }
}

async function handleHedgeTrade(price) {
  const hedgeTrade = state.getHedgeTrade();
  if (!hedgeTrade) return;

  const direction = hedgeTrade.side === 'BUY' ? 1 : -1;
  const currentLevel = hedgeTrade.level;
  const nextLevelPrice = toPrecision(
    hedgeTrade.entry + direction * getGridSpacing(currentLevel) * (currentLevel + 1)
  );

  if ((hedgeTrade.side === 'BUY' && price >= nextLevelPrice) ||
    (hedgeTrade.side === 'SELL' && price <= nextLevelPrice)) {
    const previousLevel = currentLevel;
    hedgeTrade.level += 1;
    sendMessage(`📊 Hedge trade reached level ${hedgeTrade.level} at ${price}`);

    if (hedgeTrade.level >= 1) {
      const prevLevelPrice = hedgeTrade.entry + direction * getGridSpacing(previousLevel) * previousLevel;
      const currLevelPrice = hedgeTrade.entry + direction * getGridSpacing(hedgeTrade.level) * hedgeTrade.level;
      hedgeTrade.stopLoss = toPrecision(prevLevelPrice + config.gridStopLossPercent * (currLevelPrice - prevLevelPrice));
      sendMessage(`🔒 Hedge trade stop loss updated to ${hedgeTrade.stopLoss}`);
    }
  }

  if (hedgeTrade.level >= 1 && hedgeTrade.stopLoss !== null) {
    if ((hedgeTrade.side === 'BUY' && price <= hedgeTrade.stopLoss) ||
      (hedgeTrade.side === 'SELL' && price >= hedgeTrade.stopLoss)) {
      await closeHedgeTrade(price);
      return;
    }
  }
}

async function killHedge() {
  const hedge = state.getHedgeTrade();
  if (!hedge) return;
  const currentPrice = getCurrentPrice();
  if (!currentPrice) return;

  const isBuy = hedge.side === 'BUY';
  const entry = hedge.entry;
  const HBP = config.hedgeBreakthroughPrice || 100;
  const killSpacing = config.hedgeKillSpacing || 20;
  const feeAdjustedEntry = isBuy ? entry + HBP : entry - HBP;
  const killTriggerPrice = isBuy
    ? feeAdjustedEntry + killSpacing
    : feeAdjustedEntry - killSpacing;

  if (!hedge.killTriggered) {
    const shouldArm = (isBuy && currentPrice >= killTriggerPrice) ||
      (!isBuy && currentPrice <= killTriggerPrice);
    if (shouldArm) {
      hedge.killTriggered = true;
      if (!hedge.armedNotificationSent) {
        sendMessage(
          `🔒 PERMANENT Kill Trigger ARMED\n` +
          `▫️ Type: ${hedge.side} Hedge\n` +
          `▫️ Entry: ${entry} | Fees: ${HBP}\n` +
          `▫️ Trigger Level: ${killTriggerPrice}\n` +
          `▫️ Kill Zone: ${feeAdjustedEntry}\n` +
          `⚠️ Will execute when price returns to ${feeAdjustedEntry}`
        );
        hedge.armedNotificationSent = true;
      }
    }
  }

  if (hedge.killTriggered) {
    const shouldKill = (isBuy && currentPrice <= feeAdjustedEntry) ||
      (!isBuy && currentPrice >= feeAdjustedEntry);

    if (shouldKill) {
      sendMessage(
        `💀 HEDGE KILL EXECUTED\n` +
        `▫️ Type: ${hedge.side}\n` +
        `▫️ Entry: ${entry}\n` +
        `▫️ Exit: ${currentPrice}\n` +
        `▫️ Fees Recovered: ${HBP}\n` +
        `▫️ Net PnL: ${isBuy ? (currentPrice - entry - HBP) : (entry - currentPrice - HBP)}`
      );
      await closeHedgeTrade(currentPrice);
    }
  }
}

async function closeHedgeTrade(price, manual = false) {
  try {
    const hedgeTrade = state.getHedgeTrade();
    if (!hedgeTrade) return;
    await bybit.closeHedgeTrade(hedgeTrade.side);
    sendMessage(`❌ Hedge trade closed: ${hedgeTrade.side} ${config.orderSize} (${hedgeTrade.side === 'BUY' ? 'LONG' : 'SHORT'})`);
    sendMessage(`❌ Hedge trade closed at ${price}${manual ? ' (manual)' : ''}`);

    const wasKilled = hedgeTrade.killTriggered;
    state.clearHedgeTrade();
    lastBoundaryUpdateTime = Date.now();
    boundaryLocked = false;

    if (wasKilled) {
      hedgeCooldownUntil = Date.now() + (config.hedgeCooldownPeriod || 30000);
      sendMessage(`⏳ Hedge kill executed - cooldown active for ${config.hedgeCooldownPeriod || 3000} seconds`);
      boundaries.top = null;
      boundaries.bottom = null;
      saveBoundary({ trailingBoundary, boundaries });
      setTimeout(async () => {
        if (!state.getHedgeTrade() && state.getMainTrade()) {
          sendMessage(`🔄 Cooldown expired - setting up new boundary`);
          await initializeNewHedgeBoundaries();
        }
      }, (config.hedgeCooldownPeriod) + 1000);
    } else {
      await initializeNewHedgeBoundaries();
    }

  } catch (e) {
    sendMessage(`❌ Failed to close hedge trade: ${e.message}`);
  }
}

async function setImmediateHedgeBoundary(price, force = false, mainTradeArg = null) {
  const mainTrade = mainTradeArg || state.getMainTrade();
  if (!mainTrade) return;
  if (boundaryLocked && !force) return;

  const currentBoundary = mainTrade.side === 'BUY' ? boundaries.bottom : boundaries.top;
  const minMove = config.boundaryStickyness;
  const distance = Math.abs(price - currentBoundary);

  if (currentBoundary && distance < minMove) return;

  const now = Date.now();
  const cooldown = force
    ? (config.boundaryUpdateInterval || 9000)
    : Math.max(
      config.boundaryUpdateInterval || 9000,
      config.hedgeBoundaryUpdateInterval || 9000
    );

  if (now - lastBoundaryUpdateTime < cooldown && !force) return;
  lastBoundaryUpdateTime = now;

  let lastClose = mainTrade.side === 'BUY'
    ? boundaries.bottom
    : boundaries.top;

  const proposedBoundary = calculateTrailingHedgeOpenPrice(
    lastClose,
    price,
    mainTrade.side
  );

  let boundaryUpdated = false;
  const trailingBoundary = proposedBoundary;

  if (mainTrade.side === 'BUY') {
    if (!extremeBoundary || proposedBoundary > extremeBoundary) {
      extremeBoundary = proposedBoundary;
      boundaries.bottom = extremeBoundary;
      boundaries.top = null;
      boundaryUpdated = true;
    }
  } else {
    if (!extremeBoundary || proposedBoundary < extremeBoundary) {
      extremeBoundary = proposedBoundary;
      boundaries.top = extremeBoundary;
      boundaries.bottom = null;
      boundaryUpdated = true;
    }
  }

  if (boundaryUpdated) {
    await saveBoundary({ trailingBoundary, boundaries });
    const direction = mainTrade.side === 'BUY' ? 'up' : 'down';
    sendMessage(
      `🔄 One-way boundary trailed ${direction}\n` +
      `🟥 Type: ${mainTrade.side} Main Trade\n` +
      `📉 Last close: ${toPrecision(lastClose)}\n` +
      `📈 Current price: ${toPrecision(price)}\n` +
      `🎯 New boundary: ${toPrecision(extremeBoundary)}\n` +
      `🚨 Mode: ${force ? 'FORCED' : 'auto'}\n` +
      `📏 Next update in ${cooldown / 1000}s`
    );
  }
}

function calculateTrailingHedgeOpenPrice(lastReferencePrice, currentPrice, mainTradeSide) {
  const distance = Math.abs(currentPrice - lastReferencePrice);

  if (distance <= (config.trailingThreshold)) {
    return toPrecision(
      lastReferencePrice - config.newBoundarySpacing,
      config.pricePrecision
    );
  }

  const rawAdjustment = 0.5 * (currentPrice - lastReferencePrice);
  const cappedAdjustment = Math.sign(rawAdjustment) * Math.min(
    Math.abs(rawAdjustment),
    config.maxHedgeTrailDistance
  );

  return toPrecision(
    lastReferencePrice + cappedAdjustment,
    config.pricePrecision
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Manual control
async function manualCloseMainTrade() {
  const price = getCurrentPrice();
  if (!price || !state.getMainTrade()) return;
  await closeMainTrade(price);
}

async function manualCloseHedgeTrade() {
  const price = getCurrentPrice();
  if (!price || !state.getHedgeTrade()) return;
  await closeHedgeTrade(price);
}

async function manualSellMainTrade() {
  if (state.isRunning()) return;
  fetchPrecision(config);
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  sendMessage('🤖 Bot started');
  let price;
  while (true) {
    price = getCurrentPrice();
    if (typeof price === 'number' && !isNaN(price)) break;
    sendMessage('⏳ Waiting for valid price to place Sell trade...');
    await delay(1000);
  }
  if (!state.getMainTrade() && !state.getHedgeTrade()) {
    await openMainTrade('SELL', price);
    await monitorPrice();
  } else {
    sendMessage('⚠️ Trade not placed: Main or Hedge already active.');
  }
}

async function manualBuyMainTrade() {
  if (state.isRunning()) return;
  fetchPrecision(config);
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  sendMessage('🤖 Bot started');
  let price;
  while (true) {
    price = getCurrentPrice();
    if (typeof price === 'number' && !isNaN(price)) break;
    sendMessage('⏳ Waiting for valid price to place Buy trade...');
    await delay(1000);
  }
  if (!state.getMainTrade() && !state.getHedgeTrade()) {
    await openMainTrade('BUY', price);
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
