const axios = require('axios');
const config = require('./config.json');

// Price tracking
let latestPrice = 0;
let listeners = [];
let pollingInterval = null;

// Candlestick data storage
let candleData = {
  '15m': [],
  '1h': [],
  '4h': []
};
const MAX_CANDLES = 200; // Keep last 200 candles per timeframe

// Binance API endpoints
const ENDPOINTS = {
  ticker: `https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${config.symbol}`,
  candles: (timeframe, limit) => 
    `https://fapi.binance.com/fapi/v1/klines?symbol=${config.symbol}&interval=${timeframe}&limit=${limit}`
};

// Main polling function
async function pollPrice() {
  try {
    // 1. Get latest price
    const tickerRes = await axios.get(ENDPOINTS.ticker);
    if (tickerRes.data?.bidPrice) {
      latestPrice = parseFloat(tickerRes.data.bidPrice);
      listeners.forEach(fn => fn(latestPrice));
    }

    // 2. Update candle data (once per minute to avoid rate limits)
    if (Date.now() % 60000 < 2000) { // Roughly once per minute
      await updateAllCandleData();
    }
  } catch (err) {
    console.error('[PriceFeed] Polling error:', err.message);
  }
}

// Fetch and update candle data for all timeframes
async function updateAllCandleData() {
  try {
    await Promise.all([
      updateCandleData('15m'),
      updateCandleData('1h'),
      updateCandleData('4h')
    ]);
  } catch (err) {
    console.error('[PriceFeed] Candle update error:', err.message);
  }
}

// Fetch candles for specific timeframe
async function updateCandleData(timeframe) {
  try {
    const res = await axios.get(ENDPOINTS.candles(timeframe, MAX_CANDLES));
    candleData[timeframe] = res.data.map(candle => ({
      time: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5])
    })).slice(-MAX_CANDLES); // Ensure we don't exceed max
  } catch (err) {
    console.error(`[PriceFeed] Failed to update ${timeframe} candles:`, err.message);
    throw err;
  }
}

// Get candles for technical analysis
function getCandles(timeframe) {
  if (!candleData[timeframe] || candleData[timeframe].length === 0) {
    throw new Error(`No ${timeframe} candle data available`);
  }
  return [...candleData[timeframe]]; // Return copy
}

// Get closes array for indicators
function getCloses(timeframe) {
  return getCandles(timeframe).map(c => c.close);
}

// Initialize with historical data
async function initialize() {
  try {
    await updateAllCandleData();
    console.log('[PriceFeed] Initial candle data loaded');
  } catch (err) {
    console.error('[PriceFeed] Initialization failed:', err);
    throw err;
  }
}

// Existing price feed functions remain the same
function startPolling(intervalMs = 2000) {
  if (pollingInterval) clearInterval(pollingInterval);
  initialize(); // Load historical data
  pollPrice(); // immediate initial fetch
  pollingInterval = setInterval(pollPrice, intervalMs);
}

function stopPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = null;
}

function onPrice(callback) {
  listeners.push(callback);
  if (latestPrice) callback(latestPrice);
}

function getCurrentPrice() {
  return latestPrice;
}

function waitForFirstPrice() {
  return new Promise(resolve => {
    if (latestPrice) return resolve(latestPrice);
    onPrice(resolve);
  });
}

module.exports = {
  // Price feed functions
  onPrice,
  getCurrentPrice,
  waitForFirstPrice,
  startPolling,
  stopPolling,
  
  // New candle data functions
  getCandles,
  getCloses,
  initialize
};
