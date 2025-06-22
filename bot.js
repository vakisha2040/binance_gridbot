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
  bybit.setSendMessage(sendMessage);
}

// -- Load boundary state on startup
let { trailingBoundary, boundaries } = loadBoundary();
if (!boundaries) boundaries = { top: null, bottom: null };
let lastHedgeClosePrice = null;
let hedgeCooldownUntil = 0;
let sentReadyTrigger = false;
let sentKillTrigger = false;
let lastBoundaryUpdateTime = 0;
const BOUNDARY_UPDATE_INTERVAL = 30 * 1000;
let lastSetBoundary = null;
const HBP = config.hedgeBreakthroughPrice; 
let preKillStartTime = null;
let lastKillResetTime = 0; 
let hedgeOpeningInProgress = false;
let boundaryLocked = false;

function getGridSpacing(level) {
  if (level === 0) return config.zeroLevelSpacing;
  return config.gridSpacing;
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
  } 
  else if (hedgeTrade) {
    sendMessage(`🛡️ Found existing hedge trade - promoting to main`);
    promoteHedgeToMain();
  }
  else {
    const price = getCurrentPrice();
    if (!price) {
      sendMessage("⚠️ Unable to fetch price for main trade on startup.");
      return;
    }
    
    const initialSide = config.initialTradeSide || 'Buy';
    await openMainTrade(initialSide, price);
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
    if (mainTrade.side === 'Buy') {
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

  persistBoundaries();
}


async function monitorPrice() {
  while (state.isRunning()) {
    try {
      const price = getCurrentPrice();
      if (!price) {
        await delay(1000);
        continue;
      }

      const mainTrade = state.getMainTrade();
      const hedgeTrade = state.getHedgeTrade();
      const inCooldown = Date.now() < hedgeCooldownUntil;
      const now = Date.now();

      // 1. HEDGE TRADE OPENING LOGIC ===========================================
      if (!hedgeTrade && !hedgeOpeningInProgress && !inCooldown) {
        // For Buy main trades (need Sell hedge)
        if (mainTrade?.side === 'Buy' && boundaries.bottom) {
          const effectiveBoundary = boundaries.bottom + (config.boundaryTolerance || 1.0);
          
          if (price <= effectiveBoundary) {
            hedgeOpeningInProgress = true;
            sendMessage(
              `⚠️ PRICE CROSSED BOUNDARY\n` +
              `▫️ Main Trade: Buy @ ${mainTrade.entry}\n` +
              `▫️ Boundary: ${boundaries.bottom} (effective: ${effectiveBoundary})\n` +
              `▫️ Current: ${price}\n` +
              `🛡️ Attempting Sell hedge...`
            );

            try {
              await openHedgeTrade('Sell', price);
              sendMessage(`✅ Sell hedge opened at ${price}`);
            } catch (e) {
              sendMessage(`❌ FAILED to open Sell hedge: ${e.message}`);
              // Schedule retry if still below boundary
              if (price <= effectiveBoundary) {
                const retryDelay = config.hedgeOpenRetryDelay || 5000;
                sendMessage(`⏳ Will retry hedge open in ${retryDelay/1000} sec...`);
                await delay(retryDelay);
                continue; // Jump to next iteration for retry
              }
            } finally {
              hedgeOpeningInProgress = false;
            }
          }
        }
        // For Sell main trades (need Buy hedge)
        else if (mainTrade?.side === 'Sell' && boundaries.top) {
          const effectiveBoundary = boundaries.top - (config.boundaryTolerance || 1.0);
          
          if (price >= effectiveBoundary) {
            hedgeOpeningInProgress = true;
            sendMessage(
              `⚠️ PRICE CROSSED BOUNDARY\n` +
              `▫️ Main Trade: Sell @ ${mainTrade.entry}\n` +
              `▫️ Boundary: ${boundaries.top} (effective: ${effectiveBoundary})\n` +
              `▫️ Current: ${price}\n` +
              `🛡️ Attempting Buy hedge...`
            );

            try {
              await openHedgeTrade('Buy', price);
              sendMessage(`✅ Buy hedge opened at ${price}`);
            } catch (e) {
              sendMessage(`❌ FAILED to open Buy hedge: ${e.message}`);
              if (price >= effectiveBoundary) {
                const retryDelay = config.hedgeOpenRetryDelay || 5000;
                sendMessage(`⏳ Will retry hedge open in ${retryDelay/1000} sec...`);
                await delay(retryDelay);
                continue;
              }
            } finally {
              hedgeOpeningInProgress = false;
            }
          }
        }
      }

      // 2. MAIN TRADE HANDLING ================================================
      if (mainTrade) {
        await handleMainTrade(price);

        // Price trailing for main trade
        if (!hedgeTrade && !inCooldown) {
          const currentBoundary = mainTrade.side === 'Buy' ? boundaries.bottom : boundaries.top;
          if (currentBoundary) {
            const priceFromBoundary = mainTrade.side === 'Buy' 
              ? price - currentBoundary
              : currentBoundary - price;

            // Trail if price moved favorably beyond threshold
            if (priceFromBoundary > (config.trailingThreshold || 50)) {
              setImmediateHedgeBoundary(price);
            }

            // Emergency boundary update if price moved too far
            const emergencyThreshold = (config.zeroLevelSpacing * 2);
            if (priceFromBoundary > emergencyThreshold) {
              sendMessage(`🚨 EMERGENCY BOUNDARY UPDATE (moved ${priceFromBoundary} from boundary)`);
              setImmediateHedgeBoundary(price, true);
            }
          }
        }
      }

      // 3. HEDGE TRADE HANDLING ==============================================
      if (hedgeTrade) {
        await handleHedgeTrade(price);
        
        // Check kill switch only if not in manual mode
        if (!hedgeTrade.manual) {
          await killHedge();
        }
      }

      // 4. COOLDOWN MANAGEMENT ===============================================
      if (inCooldown && now >= hedgeCooldownUntil - 1000) {
        sendMessage("🔄 Hedge cooldown period ending soon");
      }

      // 5. PERIODIC BOUNDARY CHECK ===========================================
      if (now - lastBoundaryUpdateTime > BOUNDARY_UPDATE_INTERVAL) {
        if (mainTrade && !hedgeTrade && !boundaryLocked) {
          setImmediateHedgeBoundary(price);
        }
        lastBoundaryUpdateTime = now;
      }

      await delay(config.monitorInterval || 1000);

    } catch (e) {
      sendMessage(`‼️ CRITICAL MONITOR ERROR: ${e.message}\n${e.stack}`);
      await delay(5000); // Prevent tight error loops
    }
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
      breakthroughPrice: null,
    });
    boundaryLocked = true;
    sendMessage(`📈 Main trade opened: ${side} at ${entryPrice}`);
    await initializeBoundaries();
  } catch (e) {
    sendMessage(`❌ Failed to open main trade: ${e.message}`);
  }
}

async function handleMainTrade(price) { 
  const mainTrade = state.getMainTrade(); 
  if (!mainTrade) return;
  
  const direction = mainTrade.side === 'Buy' ? 1 : -1; 
  const currentLevel = mainTrade.level;
  const nextLevelPrice = toPrecision(
    mainTrade.entry + direction * getGridSpacing(currentLevel) * (currentLevel + 1)
  );

  if ((mainTrade.side === 'Buy' && price >= nextLevelPrice) || 
      (mainTrade.side === 'Sell' && price <= nextLevelPrice)) { 
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
      if ((mainTrade.side === 'Buy' && price > mainTrade.breakthroughPrice) || 
          (mainTrade.side === 'Sell' && price < mainTrade.breakthroughPrice)) {
        sendMessage(`🚦 Breakthrough price (${mainTrade.breakthroughPrice}) crossed. Stoploss is now active.`); 
        mainTrade.breakthroughPrice = null;
      } else { 
        return;
      } 
    } 
    
    if ((mainTrade.side === 'Buy' && price <= mainTrade.stopLoss) || 
        (mainTrade.side === 'Sell' && price >= mainTrade.stopLoss)) { 
      await closeMainTrade(price, false); 
      return; 
    } 
  }

  if (!state.getHedgeTrade() && !hedgeOpeningInProgress && 
      Date.now() > hedgeCooldownUntil && mainTrade.level === 0 && 
      ((mainTrade.side === 'Buy' && price <= boundaries.bottom) || 
       (mainTrade.side === 'Sell' && price >= boundaries.top))) { 
    hedgeOpeningInProgress = true; 
    await openHedgeTrade(mainTrade.side === 'Buy' ? 'Sell' : 'Buy', price); 
    hedgeOpeningInProgress = false; 
  }
}

async function closeMainTrade(price, manual = false) {
  try {
    const mainTrade = state.getMainTrade();
    if (!mainTrade) return;
    await bybit.closeMainTrade(mainTrade.side, config.orderSize);
    sendMessage(`❌ Main trade closed at ${price}${manual ? " (manual)" : ""}`);
    state.clearMainTrade();
    
    if (state.getHedgeTrade()) {
      promoteHedgeToMain();
    } else {
      await initializeBoundaries();
    }
  } catch (e) {
    sendMessage(`❌ Failed to close main trade: ${e.message}`);
  }
}

function initializeHedgePromotionBoundary() {
  const mainTrade = state.getMainTrade();
  const price = getCurrentPrice();
  if (!mainTrade || !price) {
    sendMessage('⚠️ Unable to get current price or trade info for boundaries.');
    return;
  }
  if (mainTrade.side === 'Buy') {
    boundaries.bottom = toPrecision(price - config.newBoundarySpacing);
    boundaries.top = null;
    persistBoundaries();
    sendMessage(`🔲 (Hedge->Main) Bottom boundary set: ${boundaries.bottom}`);
  } else if (mainTrade.side === 'Sell') {
    boundaries.top = toPrecision(price + config.newBoundarySpacing);
    boundaries.bottom = null;
    persistBoundaries();
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
  lastHedgeClosePrice = hedge.entry;
  boundaryLocked = false;
  sendMessage('🔁 Hedge trade promoted to main trade. Grid reset and stop loss cleared.');
  initializeHedgePromotionBoundary();
} 

async function openHedgeTrade(side, entryPrice) {
  if (state.getHedgeTrade()) {
    sendMessage(`⚠️ Attempt to open duplicate hedge ignored.`);
    return;
  }

  // Enhanced boundary validation
  const mainTrade = state.getMainTrade();
  if (mainTrade) {
    if (mainTrade.side === 'Buy') {
      if (side === 'Sell' && (!boundaries.bottom || entryPrice > boundaries.bottom)) {
        sendMessage(`⚠️ Cannot open Sell hedge when price (${entryPrice}) is above bottom boundary (${boundaries.bottom})`);
        return;
      }
    } else if (mainTrade.side === 'Sell') {
      if (side === 'Buy' && (!boundaries.top || entryPrice < boundaries.top)) {
        sendMessage(`⚠️ Cannot open Buy hedge when price (${entryPrice}) is below top boundary (${boundaries.top})`);
        return;
      }
    }
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
      killTriggered: false,
      armedNotificationSent: false,
    });

    sendMessage(`🛡️ Hedge trade opened: ${side} at ${entryPrice} (Breakthrough: ${breakthroughPrice})`);
  } catch (e) {
    sendMessage(`❌ Failed to open hedge trade: ${e.message}`);
  }
}

async function handleHedgeTrade(price) {
  const hedgeTrade = state.getHedgeTrade();
  if (!hedgeTrade) return;

  const direction = hedgeTrade.side === 'Buy' ? 1 : -1;
  const currentLevel = hedgeTrade.level;
  const nextLevelPrice = toPrecision(
    hedgeTrade.entry + direction * getGridSpacing(currentLevel) * (currentLevel + 1)
  );

  if ((hedgeTrade.side === 'Buy' && price >= nextLevelPrice) ||
      (hedgeTrade.side === 'Sell' && price <= nextLevelPrice)) {
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
    if ((hedgeTrade.side === 'Buy' && price <= hedgeTrade.stopLoss) ||
        (hedgeTrade.side === 'Sell' && price >= hedgeTrade.stopLoss)) {
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
  
  const isBuy = hedge.side === 'Buy';
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

    await bybit.closeHedgeTrade(hedgeTrade.side, config.orderSize);
    sendMessage(`❌ Hedge trade closed: ${hedgeTrade.side} ${config.orderSize} (${hedgeTrade.side === 'Buy' ? 'LONG' : 'SHORT'})`);
    sendMessage(`❌ Hedge trade closed at ${price}${manual ? ' (manual)' : ''}`);

    const wasKilled = hedgeTrade.killTriggered;
    lastHedgeClosePrice = price;
    state.clearHedgeTrade();

    if (wasKilled) {
      hedgeCooldownUntil = Date.now() + (config.hedgeCooldownPeriod || 30000);
      sendMessage(`⏳ Hedge kill executed - cooldown active for ${config.hedgeCooldownPeriod || 30} seconds`);
      
      // Clear boundaries immediately
      boundaries.top = null;
      boundaries.bottom = null;
      persistBoundaries();
      
      // Schedule boundary setup after cooldown
      setTimeout(async () => {
        if (!state.getHedgeTrade() && state.getMainTrade()) {
          sendMessage(`🔄 Cooldown expired - setting up new boundary`);
          await setImmediateHedgeBoundary(getCurrentPrice(), true);
        }
      }, (config.hedgeCooldownPeriod || 30000) + 1000); // Extra 1s buffer
    } else {
      // Normal close - set boundary immediately
      setImmediateHedgeBoundary(price);
    }
    
    boundaryLocked = false;
  } catch (e) {
    sendMessage(`❌ Failed to close hedge trade: ${e.message}`);
  }
}


function checkAndTrailBoundaries(price) {
  if (!state.getMainTrade() || state.getHedgeTrade()) return;

  const mainTrade = state.getMainTrade();
  const currentBoundary = mainTrade.side === 'Buy' ? boundaries.bottom : boundaries.top;
  
  if (!currentBoundary) {
    setImmediateHedgeBoundary(price, true);
    return;
  }

  // Calculate distance from current boundary
  const distance = mainTrade.side === 'Buy' 
    ? price - currentBoundary
    : currentBoundary - price;

  // Trail if price has moved favorably
  if (distance > (config.trailingThreshold || 50)) {
    setImmediateHedgeBoundary(price);
  }
}

function calculateTrailingHedgeOpenPrice(
  lastClose,
  currentPrice,
  gridSpacing,
  trailingBoundary,
  maxHedgeTrailDistance,
  mainTradeSide
) {
  const distance = Math.abs(currentPrice - lastClose);
  let newOpenPrice;

  if (distance > trailingBoundary) {
    newOpenPrice = lastClose + 0.5 * (currentPrice - lastClose);

    if (maxHedgeTrailDistance && Math.abs(newOpenPrice - lastClose) > maxHedgeTrailDistance) {
      newOpenPrice = currentPrice > lastClose
        ? lastClose + maxHedgeTrailDistance
        : lastClose - maxHedgeTrailDistance;
    }

    sendMessage(
      `⚡️ Hedge boundary adjusted for sharp move:\n` +
      `Last hedge close: ${lastClose}, Current price: ${currentPrice}, Distance: ${distance}, New hedge open price: ${newOpenPrice}`
    );
  } else {
    newOpenPrice = mainTradeSide === 'Buy'
      ? lastClose - config.newBoundarySpacing
      : lastClose + config.newBoundarySpacing;

    sendMessage(
      `🔲 Hedge boundary (default grid): Last hedge close: ${lastClose}, New hedge open price: ${newOpenPrice}`
    );
  }

  return toPrecision(newOpenPrice);
}

/*
function setImmediateHedgeBoundary(price, force = false) {
  const now = Date.now();
  const throttle = config.hedgeBoundaryUpdateInterval || 30000;
  const minMove = config.minHedgeBoundaryMove || 20;

  if (!force && boundaryLocked) return;
  if (!force && now - lastBoundaryUpdateTime < throttle) return;
  lastBoundaryUpdateTime = now;

  const mainTrade = state.getMainTrade();
  if (!mainTrade) return;

  const trailingBoundary = config.trailingBoundary || 100;
  const maxHedgeTrailDistance = config.maxHedgeTrailDistance || 150;
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
    if (!boundaries.bottom || 
        (newBoundary > boundaries.bottom && moveEnough(boundaries.bottom, newBoundary))) {
      boundaries.bottom = newBoundary;
      boundaries.top = null;
      persistBoundaries();
      sendMessage(
        `🟦 New bottom hedge boundary set\n` +
        `🔹 Main trade side: Buy\n` +
        `📉 Last hedge close: ${lastClose}\n` +
        `📈 Current price: ${price}\n` +
        `📏 Distance moved: ${toPrecision(distance)}\n` +
        `🎯 New bottom boundary: ${boundaries.bottom}`
      );
    }
  } else if (mainTrade.side === 'Sell') {
    if (!boundaries.top || 
        (newBoundary < boundaries.top && moveEnough(boundaries.top, newBoundary))) {
      boundaries.top = newBoundary;
      boundaries.bottom = null;
      persistBoundaries();
      sendMessage(
        `🟥 New top hedge boundary set\n` +
        `🔸 Main trade side: Sell\n` +
        `📉 Last hedge close: ${lastClose}\n` +
        `📈 Current price: ${price}\n` +
        `📏 Distance moved: ${toPrecision(distance)}\n` +
        `🎯 New top boundary: ${boundaries.top}`
      );
    }
  }
}
*/


function setImmediateHedgeBoundary(price, force = false) {
    const now = Date.now();
    const mainTrade = state.getMainTrade();
    
    // 1. VALIDATION CHECKS
    if (!mainTrade || !price) {
        sendMessage("⚠️ Cannot set boundary: No main trade or invalid price");
        return;
    }

    // 2. COOLDOWN & THROTTLING
    const sinceLastUpdate = now - lastBoundaryUpdateTime;
    const throttleTime = config.hedgeBoundaryUpdateInterval || 30000;
    
    if (!force && (boundaryLocked || sinceLastUpdate < throttleTime)) {
        sendMessage(`↩️ Boundary update throttled (${Math.floor(sinceLastUpdate/1000)}s < ${throttleTime/1000}s)`);
        return;
    }

    // 3. CALCULATE NEW BOUNDARY
    const lastClose = lastHedgeClosePrice || mainTrade.entry;
    const priceChange = Math.abs(price - lastClose);
    const minMove = config.minHedgeBoundaryMove || 20;
    
    // Only update if price moved sufficiently or forced
    if (!force && priceChange < minMove) {
        sendMessage(`↩️ Price change (${priceChange.toFixed(1)}) < min move (${minMove}) - boundary unchanged`);
        return;
    }

    // 4. DYNAMIC BOUNDARY CALCULATION
    let newBoundary, boundaryType;
    if (mainTrade.side === 'Buy') {
        // For LONG positions, trail the BOTTOM boundary up
        const dynamicSpacing = calculateDynamicSpacing(price, mainTrade);
        newBoundary = toPrecision(price - dynamicSpacing);
        boundaryType = 'bottom';
        
        // Safety check - never move boundary down (only tighten)
        if (boundaries.bottom && newBoundary < boundaries.bottom) {
            sendMessage(`↩️ Would loosen bottom boundary (${newBoundary} < ${boundaries.bottom}) - maintaining current`);
            return;
        }
        
        boundaries.bottom = newBoundary;
        boundaries.top = null;
    } else {
        // For SHORT positions, trail the TOP boundary down
        const dynamicSpacing = calculateDynamicSpacing(price, mainTrade);
        newBoundary = toPrecision(price + dynamicSpacing);
        boundaryType = 'top';
        
        // Safety check - never move boundary up (only tighten)
        if (boundaries.top && newBoundary > boundaries.top) {
            sendMessage(`↩️ Would loosen top boundary (${newBoundary} > ${boundaries.top}) - maintaining current`);
            return;
        }
        
        boundaries.top = newBoundary;
        boundaries.bottom = null;
    }

    // 5. UPDATE STATE
    lastBoundaryUpdateTime = now;
    persistBoundaries();

    // 6. DETAILED LOGGING
    const logMessage = [
        `🔄 ${force ? 'FORCED ' : ''}Boundary Updated`,
        `▫️ Main Trade: ${mainTrade.side} @ ${mainTrade.entry}`,
        `▫️ Last Close: ${lastClose}`,
        `▫️ Current: ${price}`,
        `▫️ Change: ${priceChange.toFixed(1)}`,
        `▫️ New ${boundaryType.toUpperCase()}: ${newBoundary}`,
        `▫️ Grid Level: ${mainTrade.level}`
    ].join('\n');

    sendMessage(logMessage);
}

// Helper function for dynamic spacing calculation
function calculateDynamicSpacing(currentPrice, trade) {
    // 1. Base spacing from config
    let spacing = config.newBoundarySpacing || 100;
    
    // 2. Volatility adjustment (optional)
    if (config.volatilityAdjustment) {
        const priceChange = Math.abs(currentPrice - trade.entry);
        const volatilityFactor = Math.min(1 + (priceChange / (config.zeroLevelSpacing * 10)), 1.5);
        spacing *= volatilityFactor;
    }
    
    // 3. Grid level adjustment (optional)
    if (config.levelBasedSpacing && trade.level > 0) {
        spacing *= (1 + (trade.level * 0.05)); // 5% increase per level
    }
    
    // 4. Emergency widening (if price moved too fast)
    const emergencyMove = config.zeroLevelSpacing * 3;
    if (Math.abs(currentPrice - (lastHedgeClosePrice || trade.entry)) > emergencyMove) {
        spacing *= 1.2; // 20% wider in emergencies
        sendMessage(`🚨 Emergency boundary widening applied`);
    }
    
    return toPrecision(spacing);
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
    await openMainTrade('Sell', price);
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
