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
if (!boundaries){
  boundaries = { top: null, bottom: null };
}
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

async function analyzeMarketConditions() {
  const { short, medium, long } = await getMultiTimeframeData(config.symbol);
  
  // Short-term indicators
  const shortIndicators = {
    ema: await calculateEMA(short.closes, 21),
    macd: await calculateMACD(short.closes),
    rsi: await calculateRSI(short.closes),
    bbands: await calculateBollingerBands(short.closes)
  };
  
  // Medium-term trend
  const mediumIndicators = {
    ema: await calculateEMA(medium.closes, 50),
    macd: await calculateMACD(medium.closes, 26, 52, 9)
  };
  
  // Long-term trend
  const longIndicators = {
    ema: await calculateEMA(long.closes, 200),
    macd: await calculateMACD(long.closes, 50, 100, 18)
  };
  
  return {
    short: {
      ...shortIndicators,
      trend: getTrendConsensus({
        ...shortIndicators,
        price: short.closes[short.closes.length - 1]
      })
    },
    medium: {
      ...mediumIndicators,
      trend: mediumIndicators.ema.slice(-1)[0] < medium.closes.slice(-1)[0] ? 
             'bullish' : 'bearish'
    },
    long: {
      ...longIndicators,
      trend: longIndicators.ema.slice(-1)[0] < long.closes.slice(-1)[0] ?
             'bullish' : 'bearish'
    }
  };
}

async function initializeFreshBoundaries() {
  boundaryLocked = false;
  const price = getCurrentPrice();
  if (!price) {
    sendMessage('⚠️ Price unavailable - boundary reset delayed');
    return;
  }

  const analysis = await analyzeMarketConditions();
  const { short, medium, long } = analysis;

  // Determine direction using multi-timeframe confirmation
  let direction;
  if (short.trend === 'bullish' && medium.trend === 'bullish') {
    direction = 'Buy';
  } else if (short.trend === 'bearish' && medium.trend === 'bearish') {
    direction = 'Sell';
  } else {
    direction = config.initialTradeSide || 'Buy'; // Fallback
  }

  // Dynamic spacing based on volatility (BBands width)
  const bbWidth = short.bbands.upper.slice(-1)[0] - short.bbands.lower.slice(-1)[0];
  const spacing = Math.min(
    Math.max(bbWidth * 0.3, config.minSpacing),
    config.maxSpacing
  );

  boundaries = {
    top: direction === 'Buy' ? null : toPrecision(price + spacing),
    bottom: direction === 'Sell' ? null : toPrecision(price - spacing)
  };

  saveBoundary({ trailingBoundary, boundaries });
  
  sendMessage(
    `🎯 Multi-Timeframe Trade Zones Ready\n` +
    `┌───────────────┬───────────────┐\n` +
    `│    BUY ZONE   │   SELL ZONE   │\n` +
    `│  ≤ ${boundaries.bottom || 'N/A'} │  ≥ ${boundaries.top || 'N/A'} │\n` +
    `└───────────────┴───────────────┘\n` +
    `📊 Short-term: ${short.trend.toUpperCase()} (RSI: ${short.rsi.slice(-1)[0].toFixed(1)})\n` +
    `📈 Medium-term: ${medium.trend.toUpperCase()}\n` +
    `📉 Long-term: ${long.trend.toUpperCase()}\n` +
    `BBands Width: ${bbWidth.toFixed(1)} | Spacing: ${spacing.toFixed(1)}`
  );

  checkForNewTradeOpportunity(price, analysis);
}

async function checkForNewTradeOpportunity(price, forceAnalysis = null) {
  if (state.getMainTrade() || state.getHedgeTrade() || Date.now() < hedgeCooldownUntil) return;

  const analysis = forceAnalysis || await analyzeMarketConditions();
  const { short, medium } = analysis;

  // Strong confirmation required for counter-trend trades
  const strongBullish = short.trend === 'bullish' && medium.trend === 'bullish';
  const strongBearish = short.trend === 'bearish' && medium.trend === 'bearish';

  if (price >= boundaries.top) {
    if (strongBullish || (config.allowCounterTrend && short.rsi.slice(-1)[0] < 60)) {
      openMainTrade("Buy", price);
    } else {
      sendMessage(
        `⚠️ Buy signal rejected - Trend mismatch\n` +
        `Short: ${short.trend} | Medium: ${medium.trend}\n` +
        `RSI: ${short.rsi.slice(-1)[0].toFixed(1)}`
      );
    }
  } 
  else if (price <= boundaries.bottom) {
    if (strongBearish || (config.allowCounterTrend && short.rsi.slice(-1)[0] > 40)) {
      openMainTrade("Sell", price);
    } else {
      sendMessage(
        `⚠️ Sell signal rejected - Trend mismatch\n` +
        `Short: ${short.trend} | Medium: ${medium.trend}\n` +
        `RSI: ${short.rsi.slice(-1)[0].toFixed(1)}`
      );
    }
  }
}


async function startBot() {
  fetchPrecision(config);
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  
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

    // Get multi-timeframe analysis
    const analysis = await analyzeMarketConditions();
    sendMessage(
      `📊 Market Analysis:\n` +
      `┌─────────────────┬───────────────┐\n` +
      `│ Timeframe       │ Trend         │\n` +
      `├─────────────────┼───────────────┤\n` +
      `│ Short (15m)     │ ${analysis.short.trend.toUpperCase().padEnd(13)}│\n` +
      `│ Medium (1h)     │ ${analysis.medium.trend.toUpperCase().padEnd(13)}│\n` +
      `│ Long (4h)       │ ${analysis.long.trend.toUpperCase().padEnd(13)}│\n` +
      `└─────────────────┴───────────────┘\n` +
      `RSI: ${analysis.short.rsi.slice(-1)[0].toFixed(1)} | ` +
      `MACD Hist: ${analysis.short.macd.histogram.slice(-1)[0].toFixed(2)}`
    );

    // Determine direction using trend consensus
    let direction;
    if (analysis.short.trend === 'bullish' && analysis.medium.trend === 'bullish') {
      direction = 'Buy';
      sendMessage(`✅ Strong bullish consensus - Starting with Buy`);
    } 
    else if (analysis.short.trend === 'bearish' && analysis.medium.trend === 'bearish') {
      direction = 'Sell';
      sendMessage(`✅ Strong bearish consensus - Starting with Sell`);
    }
    else {
      // Neutral market - use config default with caution
      direction = config.initialTradeSide || 'Buy';
      sendMessage(
        `⚠️ No clear trend - Using default ${direction} position\n` +
        `Set 'initialTradeSide' in config.json to override`
      );
    }

    await openMainTrade(direction, price);
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

  saveBoundary({ trailingBoundary, boundaries });
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

      
      // 4. NEW TRADE PREPARATION ===========================================
  
if (!mainTrade && !hedgeTrade) {
  // 1. Handle cooldown first
  if (inCooldown) {
    if (now >= hedgeCooldownUntil - 5000) {
      sendMessage(`⏳ Cooldown ends in ${Math.ceil((hedgeCooldownUntil - now)/1000)}s`);
    }
  } 
  // 2. Prepare new trading environment
  else {
    if (!boundaries.top && !boundaries.bottom) {
      await initializeFreshBoundaries();
    } else {
      checkForNewTradeOpportunity(price);
    }
  }
}

      

      // 5. COOLDOWN MANAGEMENT ===============================================
      if (inCooldown && now >= hedgeCooldownUntil - 1000) {
        sendMessage("🔄 Hedge cooldown period ending soon");
      }

      // 6. PERIODIC BOUNDARY CHECK ===========================================
      if (now - lastBoundaryUpdateTime > BOUNDARY_UPDATE_INTERVAL) {
        if (mainTrade && !hedgeTrade && !boundaryLocked) {
          setImmediateHedgeBoundary(price);
        }
        lastBoundaryUpdateTime = now;
      }

      await delay(config.monitorInterval || 1000);

    } catch (e) {
      sendMessage(`‼️ CRITICAL MONITOR ERROR: ${e.message}\n${e.stack}`);
      await delay(3000); // Prevent tight error loops
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
    sendMessage(`✅ ${mainTrade.side} trade closed at ${price}`);

    state.clearMainTrade();
    
    if (state.getHedgeTrade()) {
      promoteHedgeToMain();
    } else {
      hedgeCooldownUntil = 0;
      await initializeFreshBoundaries(); // Critical reset
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
  if (mainTrade.side === 'Buy') {
    boundaries.bottom = toPrecision(price - config.newBoundarySpacing);
    boundaries.top = null;
    saveBoundary({ trailingBoundary, boundaries });
    sendMessage(`🔲 (Hedge->Main) Bottom boundary set: ${boundaries.bottom}`);
  } else if (mainTrade.side === 'Sell') {
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
  lastHedgeClosePrice = hedge.entry;
  hedgeCooldownUntil = 0;
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
      saveBoundary({ trailingBoundary, boundaries });
      
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
    try {
        const now = Date.now();
        const mainTrade = state.getMainTrade();
        
        // 1. VALIDATION CHECKS
        if (!mainTrade || !price) {
            if (config.debug) sendMessage("⚠️ Boundary update skipped: No main trade or invalid price");
            return;
        }

        // 2. COOLDOWN & THROTTLING
        const sinceLastUpdate = now - (lastBoundaryUpdateTime || 0);
        const throttleTime = config.hedgeBoundaryUpdateInterval || 30000;
        
        if (!force) {
            if (boundaryLocked) {
                if (config.debug) sendMessage("🔒 Boundary update skipped: Boundary locked");
                return;
            }
            
            if (sinceLastUpdate < throttleTime) {
                // Only log throttling if we're close to next allowed update
                if (throttleTime - sinceLastUpdate < 10000) { // <10s remaining
                    const secondsRemaining = Math.ceil((throttleTime - sinceLastUpdate)/1000);
                    if (config.debug) sendMessage(`⏳ Boundary update throttled (${secondsRemaining}s remaining)`);
                }
                return;
            }
        }


        // 3. CALCULATE NEW BOUNDARY
        const lastClose = lastHedgeClosePrice || mainTrade.entry;
        const priceChange = Math.abs(price - lastClose);
        const minMove = config.minHedgeBoundaryMove || 20;
        
        if (!force && priceChange < minMove) {
            if (config.debug) sendMessage(`↩️ Price change (${priceChange.toFixed(1)}) < min move (${minMove})`);
            return;
        }

        // 4. DYNAMIC BOUNDARY CALCULATION
        let newBoundary, boundaryType;
        const spacing = calculateDynamicSpacing(price, mainTrade);
        
        if (mainTrade.side === 'Buy') {
            newBoundary = toPrecision(price - spacing);
            boundaryType = 'bottom';
            
            if (boundaries.bottom && newBoundary <= boundaries.bottom) {
                if (config.debug) sendMessage(`↩️ New bottom ${newBoundary} <= current ${boundaries.bottom}`);
                return;
            }
            
            boundaries.bottom = newBoundary;
            boundaries.top = null;
        } else {
            newBoundary = toPrecision(price + spacing);
            boundaryType = 'top';
            
            if (boundaries.top && newBoundary >= boundaries.top) {
                if (config.debug) sendMessage(`↩️ New top ${newBoundary} >= current ${boundaries.top}`);
                return;
            }
            
            boundaries.top = newBoundary;
            boundaries.bottom = null;
        }

        // 5. UPDATE STATE
        lastBoundaryUpdateTime = now;
        saveBoundary({ trailingBoundary, boundaries }); // Changed from persistBoundaries to saveBoundary

        // 6. CONDITIONAL LOGGING
        const shouldLog = force || (config.debug && priceChange >= minMove);
        if (shouldLog) {
            const logMessage = [
                `🔄 ${force ? 'FORCED ' : ''}Boundary Updated`,
                `▫️ Type: ${boundaryType.toUpperCase()}`,
                `▫️ Price: ${price} (Δ${priceChange.toFixed(1)})`,
                `▫️ New: ${newBoundary}`,
                `▫️ Spacing: ${spacing}`,
                `▫️ Level: ${mainTrade.level}`
            ].join('\n');
            sendMessage(logMessage);
        }

    } catch (e) {
        console.error('Boundary update error:', e);
        sendMessage(`❌ Boundary update failed: ${e.message}`);
    }
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
