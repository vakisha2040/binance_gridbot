const {
  calculateNextPrice,
  calculateStopLoss,
  fetchPrecision,
  toPrecision,
} = require('./helper');

//require('./telegram'); // ✅ This will start the Telegram bot
const {
  getCurrentPrice,
  waitForFirstPrice,
  startPolling,
  stopPolling
} = require('./priceFeed');

let extremeBoundary = null; // Tracks most aggressive boundary level
let lastBoundaryUpdateTime = 0;
const BOUNDARY_UPDATE_COOLDOWN = 5000; // 3 seconds minimum between updates
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
let lastClose = null;
let lastHedgeClosePrice = null;
let hedgeCooldownUntil = 0;
let sentReadyTrigger = false;
let sentKillTrigger = false;
//let lastBoundaryUpdateTime = 0;
const BOUNDARY_UPDATE_INTERVAL = 50 * 1000;
let lastSetBoundary = null;
const HBP = config.hedgeBreakthroughPrice; 
let preKillStartTime = null;
let lastKillResetTime = 0; 
let hedgeOpeningInProgress = false;
let boundaryLocked = false;

const { analyze } = require('./technical');

function getGridSpacing(level) {
  if (level === 0) return config.zeroLevelSpacing;
  return config.gridSpacing;
}


async function initializeFreshBoundaries() {
  boundaryLocked = true;   
  const price = getCurrentPrice();
  if (!price) {
    sendMessage('⚠️ Price unavailable - boundary reset delayed');
    return;
  } 
  
  const spacing = config.freshBoundarySpacing;

 
  boundaries = {
    top: toPrecision(price + spacing),
    bottom: toPrecision(price - spacing)
  };
  
  boundaries.top = toPrecision(price + spacing);
  boundaries.bottom = toPrecision(price - spacing);
  saveBoundary({ trailingBoundary, boundaries });
 
  sendMessage(
    `🎯 New Trade Zones Ready\n` +
    `┌───────────────┬───────────────┐\n` +
    `│    BUY ZONE   │   SELL ZONE   │\n` +
    `│  ≤ ${boundaries.top} │  ≥ ${boundaries.bottom} │\n` +
    `└───────────────┴───────────────┘\n` +
    `Current Price: ${price}`
  );
  

//await checkForNewTradeOpportunity(price); // Immediate check
}

async function checkForNewTradeOpportunity(price) {
 
  if (state.getMainTrade() || state.getHedgeTrade() || Date.now() < hedgeCooldownUntil) 
    return;

  const signal =  await analyze();
 
  if (signal === 'BUY') {
    const spacing = config.freshBoundarySpacing;


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
   await openMainTrade("Buy", price);
  } 
  else if (signal === 'SELL') {
    const spacing = config.freshBoundarySpacing;


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
   await openMainTrade("Sell", price);
  }
  else {
  console.log(signal)
//  const initialSide = config.initialTradeSide || 'Buy';
  //  await openMainTrade(initialSide, price);

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

  await initializeFreshBoundaries();
 /*   

const signal =  await analyze(); // 'BUY', 'SELL', or 'WAIT'

  if (signal === 'BUY') {
  //  openMainTrade("Buy", price);
    sendMessage(` 🕐 Signal is BUY, Placing Buy order...`);
  } 
  else if (signal === 'SELL') {
  //  openMainTrade("Sell", price);
    sendMessage(` 🕐 Signal is SELL, Placing sell order...`);
  } 
  else {
  
   // const initialSide = config.initialTradeSide || 'Buy';
  //  await openMainTrade(initialSide, price);

  }
*/
    
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
    const spacing = config.tradeEntrySpacing;
    if (mainTrade.side === 'Buy') {
      boundaries.bottom = toPrecision(price - spacing);
      boundaries.top = null;
      sendMessage(`🔵 Buy main trade - bottom boundary set at ${boundaries.bottom} (current: ${price})`);
    } else {
      boundaries.top = toPrecision(price + spacing);
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

      // 1. HEDGE TRADE OPENING LOGIC ===========================================
      if (!hedgeTrade && !hedgeOpeningInProgress && !inCooldown) {
        // For Buy main trades (need Sell hedge)
        if (mainTrade?.side === 'Buy' && boundaries.bottom) {
          const effectiveBoundary = boundaries.bottom + (config.boundaryTolerance);
          
          if (price <= effectiveBoundary) {
            hedgeOpeningInProgress = true;
         /*
            sendMessage(
              `⚠️ PRICE CROSSED BOUNDARY\n` +
              `▫️ Main Trade: Buy @ ${mainTrade.entry}\n` +
              `▫️ Boundary: ${boundaries.bottom} (effective: ${effectiveBoundary})\n` +
              `▫️ Current: ${price}\n` +
              `🛡️ Attempting Sell hedge...`
            );
            

            try {
              await openHedgeTrade('Sell', price);
              //sendMessage(`✅ Sell hedge opened at ${price}`);
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
          const effectiveBoundary = boundaries.top - (config.boundaryTolerance);
          
          if (price >= effectiveBoundary) {
            hedgeOpeningInProgress = true;
          /*
            sendMessage(
              `⚠️ PRICE CROSSED BOUNDARY\n` +
              `▫️ Main Trade: Sell @ ${mainTrade.entry}\n` +
              `▫️ Boundary: ${boundaries.top} (effective: ${effectiveBoundary})\n` +
              `▫️ Current: ${price}\n` +
              `🛡️ Attempting Buy hedge...`
            );
            */

            try {
              await openHedgeTrade('Buy', price);
              //sendMessage(`✅ Buy hedge opened at ${price}`);
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
        if (!hedgeTrade && !boundaryLocked) {
          const currentBoundary = mainTrade.side === 'Buy' ? boundaries.bottom : boundaries.top;
          if (currentBoundary) {
            const priceFromBoundary = mainTrade.side === 'Buy' 
              ? price - currentBoundary
              : currentBoundary - price;

            // Trail if price moved favorably beyond threshold
            if (priceFromBoundary > (config.trailingThreshold)) {
            if (mainTrade && !hedgeTrade && !boundaryLocked) {
  await setImmediateHedgeBoundary(price, true, mainTrade);
}
            }

            // Emergency boundary update if price moved too far
            const emergencyThreshold = (config.zeroLevelSpacing * 2);
            if (priceFromBoundary > emergencyThreshold) {
            //  sendMessage(`🚨 EMERGENCY BOUNDARY UPDATE (moved ${priceFromBoundary} from boundary)`);
              if (mainTrade && !hedgeTrade && !boundaryLocked) {
  await setImmediateHedgeBoundary(price, true, mainTrade);
}
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
  /*
    if (!boundaries.top && !boundaries.bottom) {
      await initializeFreshBoundaries();
    } else {
   await  initializeFreshBoundaries();
  }
*/
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
  
  }
}
      

      // 5. COOLDOWN MANAGEMENT ===============================================
      if (inCooldown && now >= hedgeCooldownUntil - 1000) {
        sendMessage("🔄 Hedge cooldown period ending soon");
      }

      // 6. PERIODIC BOUNDARY CHECK ===========================================
      if (now - lastBoundaryUpdateTime > BOUNDARY_UPDATE_INTERVAL) {
        if (mainTrade && !hedgeTrade && !boundaryLocked) {
   await setImmediateHedgeBoundary(price, true, mainTrade);
}
        lastBoundaryUpdateTime = now;
      }

      await delay(config.monitorInterval || 1000);

    } catch (e) {
      sendMessage(`‼️ CRITICAL MONITOR ERROR: ${e.message}\n${e.stack}`);
      await delay(2000); // Prevent tight error loops
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
    lastBoundaryUpdateTime = 0;
    let extremeBoundary = null; // Tracks the most aggressive boundary level
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
    let lastClose = null;
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
   let lastClose = boundaries.bottom;
    saveBoundary({ trailingBoundary, boundaries });
    sendMessage(`🔲 (Hedge->Main) Bottom boundary set: ${boundaries.bottom}`);
  } else if (mainTrade.side === 'Sell') {
    boundaries.top = toPrecision(price + config.newBoundarySpacing);
    boundaries.bottom = null;
    let lastClose = boundaries.top;
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
  lastClose = price;
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
      //  sendMessage(`⚠️ Cannot open Sell hedge when price (${entryPrice}) is above bottom boundary (${boundaries.bottom})`);
        return;
      }
    } else if (mainTrade.side === 'Sell') {
      if (side === 'Buy' && (!boundaries.top || entryPrice < boundaries.top)) {
      //  sendMessage(`⚠️ Cannot open Buy hedge when price (${entryPrice}) is below top boundary (${boundaries.top})`);
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
    lastClose = price;
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
      }, (config.hedgeCooldownPeriod ) + 1000);
    } else {
      await initializeNewHedgeBoundaries();
    }

  } catch (e) {
    sendMessage(`❌ Failed to close hedge trade: ${e.message}`);
  }
}



function checkAndTrailBoundaries(price) {
  if (!state.getMainTrade() || state.getHedgeTrade()) return;

  const mainTrade = state.getMainTrade();
  const currentBoundary = mainTrade.side === 'Buy' ? boundaries.bottom : boundaries.top;
  
  if (!currentBoundary) {
   //await setImmediateHedgeBoundary(price, true);
    return;
  }

  // Calculate distance from current boundary
  const distance = mainTrade.side === 'Buy' 
    ? price - currentBoundary
    : currentBoundary - price;

  // Trail if price has moved favorably
  if (distance > (config.trailingThreshold || 50)) {
  // await setImmediateHedgeBoundary(price);
  }
}




async function initializeNewHedgeBoundaries() {
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
      let lastClose = boundaries.bottom;
      sendMessage(`🔵 For buy main trade - New hedge bottom boundary set at ${boundaries.bottom} (current: ${price})`);
    } else {
      boundaries.top = toPrecision(price + config.newBoundarySpacing);
      boundaries.bottom = null;
      let lastClose = boundaries.top;
      sendMessage(`🔴 For sell main trade - New hedge top boundary set at ${boundaries.top} (current: ${price})`);
    }
  } else {
   // boundaries.top = toPrecision(price + config.tradeEntrySpacing);
    //boundaries.bottom = toPrecision(price - config.tradeEntrySpacing);
    sendMessage(`⚪ No main trade - boundaries set at ${boundaries.bottom}-${boundaries.top} (current: ${price})`);
  }

  saveBoundary({ trailingBoundary, boundaries });
//await setImmediateHedgeBoundary(price, true);
}

/*
async function setImmediateHedgeBoundary(price, force = false) {
    const mainTrade = state.getMainTrade();
    if (!mainTrade || (!force && boundaryLocked)) return;

    // Throttle boundary updates
    const now = Date.now();
 //   if (!force && now - lastBoundaryUpdateTime < BOUNDARY_UPDATE_COOLDOWN) {
 //       return;
//    }

    // Get current boundary value
    const currentBoundary = mainTrade.side === 'Buy' 
        ? boundaries.bottom 
        : boundaries.top;

    // Check minimum move threshold (configurable, default $0.10)
    const minMove = config.boundaryStickyness || 0.10;
    if (currentBoundary && Math.abs(price - currentBoundary) < minMove) {
        return;
    }

    // Calculate proposed new boundary
    const proposedBoundary = calculateTrailingHedgeOpenPrice(
        currentBoundary || lastHedgeClosePrice,
        price,
        mainTrade.side
    );

    // Apply one-way trailing
    let boundaryUpdated = false;
    if (mainTrade.side === 'Buy') {
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

    // Save and notify if updated
    if (boundaryUpdated) {
        lastBoundaryUpdateTime = now;
        saveBoundary({ trailingBoundary, boundaries });

        sendMessage(
            `🔄 Boundary Updated (${mainTrade.side} Main Trade)\n` +
            `🟥  Direction: ${mainTrade.side === 'Buy' ? 'UP' : 'DOWN'}\n` +
            `📉  Previous: ${currentBoundary?.toFixed(3) || 'None'}\n` +
            `🎯 New: ${extremeBoundary.toFixed(3)}\n` +
            `📈 Price: ${price.toFixed(3)}\n` +
            `📏 Next update in ${BOUNDARY_UPDATE_COOLDOWN/1000}s`
        );
    }
}




//new updated for trailing 

async function setImmediateHedgeBoundary(price, force = false) {
    const mainTrade = state.getMainTrade();
    if (!mainTrade || (boundaryLocked && !force)) return;

    const currentBoundary = mainTrade.side === 'Buy' 
        ? boundaries.bottom 
        : boundaries.top;

    const minMove = config.boundaryStickyness || 0.10;
    if (currentBoundary && Math.abs(price - currentBoundary) < minMove) {
        return;
    }

    // Uncomment and fix cooldown check
    const now = Date.now();
    const cooldown = force
        ? (config.boundaryUpdateInterval || 9000)
        : Math.max(
            config.boundaryUpdateInterval || 9000,
            config.hedgeBoundaryUpdateInterval || 9000
        );

    if (now - lastBoundaryUpdateTime < cooldown && !force) {
        return;
    }

    lastBoundaryUpdateTime = now;

    const lastClose = lastHedgeClosePrice || mainTrade.entry;
    const proposedBoundary = calculateTrailingHedgeOpenPrice(
        lastClose,
        price,
        mainTrade.side
    );

    let boundaryUpdated = false;
    const trailingBoundary = proposedBoundary; // Define trailingBoundary

    if (mainTrade.side === 'Buy') {
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
        const direction = mainTrade.side === 'Buy' ? 'up' : 'down';
        sendMessage(
            `🔄 One-way boundary trailed ${direction}\n` +
            `🟥 Type: ${mainTrade.side} Main Trade\n` +
            `📉 Last close: ${toPrecision(lastClose)}\n` +
            `📈 Current price: ${toPrecision(price)}\n` +
            `🎯 New boundary: ${toPrecision(extremeBoundary)}\n` +
            `🚨 Mode: ${force ? 'FORCED' : 'auto'}\n` +
            `📏 Next update in ${cooldown/1000}s`
        );
    }
}

*/


// Pass mainTrade as parameter to setImmediateHedgeBoundary for guaranteed sync

async function setImmediateHedgeBoundary(price, force = false, mainTradeArg = null) {
    // Use provided mainTrade if given, else get fresh from state
    const mainTrade = mainTradeArg || state.getMainTrade();
    if (!mainTrade) {
        //sendMessage(`[DEBUG] No mainTrade, skipping boundary update. Current mainTrade: ${JSON.stringify(state.getMainTrade())}`);
        return;
    }
    if (boundaryLocked && !force) {
       // sendMessage("[DEBUG] Boundary is locked and not forced");
        return;
    }

    const currentBoundary = mainTrade.side === 'Buy' ? boundaries.bottom : boundaries.top;
    const minMove = config.boundaryStickyness ;
    const distance = Math.abs(price - currentBoundary);

 //   sendMessage(`[DEBUG] price=${price} currentBoundary=${currentBoundary} distance=${distance} minMove=${minMove}`);

    if (currentBoundary && distance < minMove) {
     //   sendMessage("[DEBUG] Not enough movement to update boundary");
        return;
    }

    const now = Date.now();
    const cooldown = force
        ? (config.boundaryUpdateInterval || 9000)
        : Math.max(
            config.boundaryUpdateInterval || 9000,
            config.hedgeBoundaryUpdateInterval || 9000
        );

    if (now - lastBoundaryUpdateTime < cooldown && !force) {
       // sendMessage(`[DEBUG] Cooldown not passed (${now - lastBoundaryUpdateTime}ms < ${cooldown}ms)`);
        return;
    }

    lastBoundaryUpdateTime = now;

  //  const lastClose = lastHedgeClosePrice || mainTrade.entry;
   let lastClose = mainTrade.side === 'Buy' 
        ? boundaries.bottom 
        : boundaries.top;
    
  const proposedBoundary = calculateTrailingHedgeOpenPrice(
        lastClose,
        price,
        mainTrade.side
    );

    let boundaryUpdated = false;
    const trailingBoundary = proposedBoundary;

 //   sendMessage(`[DEBUG] side=${mainTrade.side} extremeBoundary=${extremeBoundary} proposedBoundary=${proposedBoundary}`);

    if (mainTrade.side === 'Buy') {
        if (!extremeBoundary || proposedBoundary > extremeBoundary) {
            extremeBoundary = proposedBoundary;
            boundaries.bottom = extremeBoundary;
            boundaries.top = null;
            boundaryUpdated = true;
      //      sendMessage("[DEBUG] Buy: boundary updated");
        } else {
     //       sendMessage("[DEBUG] Buy: proposed boundary not more extreme");
        }
    } else {
        if (!extremeBoundary || proposedBoundary < extremeBoundary) {
            extremeBoundary = proposedBoundary;
            boundaries.top = extremeBoundary;
            boundaries.bottom = null;
            boundaryUpdated = true;
          //  sendMessage("[DEBUG] Sell: boundary updated");
        } else {
        //    sendMessage("[DEBUG] Sell: proposed boundary not more extreme");
        }
    }

    if (boundaryUpdated) {
        await saveBoundary({ trailingBoundary, boundaries });
        const direction = mainTrade.side === 'Buy' ? 'up' : 'down';
        sendMessage(
            `🔄 One-way boundary trailed ${direction}\n` +
            `🟥 Type: ${mainTrade.side} Main Trade\n` +
            `📉 Last close: ${toPrecision(lastClose)}\n` +
            `📈 Current price: ${toPrecision(price)}\n` +
            `🎯 New boundary: ${toPrecision(extremeBoundary)}\n` +
            `🚨 Mode: ${force ? 'FORCED' : 'auto'}\n` +
            `📏 Next update in ${cooldown/1000}s`
        );
    }
}


/*
function calculateTrailingHedgeOpenPrice(lastReferencePrice, currentPrice, mainTradeSide) {
    const distance = Math.abs(currentPrice - lastReferencePrice);
    let newBoundary;

    // Default grid spacing for small moves
    if (distance <= (config.trailingThreshold || 0.4)) {
        return toPrecision(
            mainTradeSide === 'Buy'
                ? lastReferencePrice - config.newBoundarySpacing
                : lastReferencePrice + config.newBoundarySpacing,
            config.pricePrecision
        );
    }

    // Trailing adjustment for significant moves
    const rawAdjustment = 0.5 * (currentPrice - lastReferencePrice);
    const cappedAdjustment = Math.sign(rawAdjustment) * Math.min(
        Math.abs(rawAdjustment),
        config.maxHedgeTrailDistance || 0.5
    );

    return toPrecision(
        lastReferencePrice + cappedAdjustment,
        config.pricePrecision
    );
}
*/

   function calculateTrailingHedgeOpenPrice(lastReferencePrice, currentPrice, mainTradeSide) {
    const distance = Math.abs(currentPrice - lastReferencePrice);

    // For small moves, always move boundary DOWN regardless of side
    if (distance <= (config.trailingThreshold )) {
        return toPrecision(
            lastReferencePrice - config.newBoundarySpacing,
            config.pricePrecision
        );
    }

    // For significant moves, trail boundary toward price, capped by maxHedgeTrailDistance
    const rawAdjustment = 0.5 * (currentPrice - lastReferencePrice);
    const cappedAdjustment = Math.sign(rawAdjustment) * Math.min(
        Math.abs(rawAdjustment),
        config.maxHedgeTrailDistance
    );
/*
    // Debugging output for tracing calculation
    sendMessage(
      `[DEBUG] lastReferencePrice=${lastReferencePrice}, currentPrice=${currentPrice}, mainTradeSide=${mainTradeSide}, ` +
      `distance=${distance}, rawAdjustment=${rawAdjustment}, cappedAdjustment=${cappedAdjustment}, ` +
      `proposedBoundary=${lastReferencePrice + cappedAdjustment}, pricePrecision=${config.pricePrecision}, newBoundarySpacing=${config.newBoundarySpacing}, maxHedgeTrailDistance=${config.maxHedgeTrailDistance}, trailingThreshold=${config.trailingThreshold}`
    );
    */

    return toPrecision(
        lastReferencePrice + cappedAdjustment,
        config.pricePrecision
    );
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
