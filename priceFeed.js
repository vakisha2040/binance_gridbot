const axios = require('axios');
const config = require('./config.json');

let latestPrice = 0;
let listeners = [];
let pollingInterval = null;

// Bitget API: https://www.bitget.com/api-doc/contract/market/Get-Ticker
async function pollPrice() {
  try {
    const endpoint = `https://api.bitget.com/api/mix/v1/market/ticker`;
    const params = {
      symbol: config.symbol, // e.g., BTCUSDT_UMCBL
      productType: 'umcbl'   // lowercase for USDT-Margined Futures
    };

    const res = await axios.get(endpoint, { params });
    const ticker = res.data?.data;

    if (ticker && ticker.bidPx) {
      latestPrice = parseFloat(ticker.bidPx);
      listeners.forEach(fn => fn(latestPrice));
    }
  } catch (err) {
    console.error('[PriceFeed] Bitget polling error:', err.message);
  }
}

function startPolling(intervalMs = 2000) {
  if (pollingInterval) clearInterval(pollingInterval);
  pollPrice(); // immediate
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
  onPrice,
  getCurrentPrice,
  waitForFirstPrice,
  startPolling,
  stopPolling
};
