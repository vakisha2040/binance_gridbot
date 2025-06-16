const axios = require('axios');
const config = require('./config.json');

let latestPrice = 0;
let listeners = [];
let pollingInterval = null;

// Binance endpoint for latest price (ticker book ticker, USDT-M futures)
async function pollPrice() {
  try {
    // Binance USDT-M Futures API endpoint for bookTicker
    // Example: https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=DOGEUSDT
    const endpoint = `https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${config.symbol}`;
    const res = await axios.get(endpoint);
    const ticker = res.data;
    if (ticker && ticker.bidPrice) {
      latestPrice = parseFloat(ticker.bidPrice);
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
