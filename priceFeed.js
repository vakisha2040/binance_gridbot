const axios = require('axios');
const config = require('./config.json');

let latestPrice = 0;
let listeners = [];
let pollingInterval = null;

// Bybit endpoint for latest price (ticker book ticker, USDT Perpetual)
async function pollPrice() {
  try {
    // Bybit USDT Perpetual API endpoint for best bid/ask price
    // Example: https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT
    const endpoint = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${config.symbol}`;
    const res = await axios.get(endpoint);
    const tickerArr = res.data.result.list;
    if (Array.isArray(tickerArr) && tickerArr.length > 0 && tickerArr[0].bidPrice) {
      latestPrice = parseFloat(tickerArr[0].bidPrice);
      listeners.forEach(fn => fn(latestPrice));
    }
  } catch (err) {
    console.error('[PriceFeed] HTTP polling error:', err.message);
  }
}

function startPolling(intervalMs = 2000) {
  if (pollingInterval) clearInterval(pollingInterval);
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

// Helper: wait for the first price to be set (returns a Promise)
function waitForFirstPrice() {
  return new Promise(resolve => {
    if (latestPrice) return resolve(latestPrice);
    onPrice(resolve);
  });
}

module.exports = {
  onPrice,
  getCurrentPrice,
  waitForFirstPrice,
  startPolling,
  stopPolling
};
