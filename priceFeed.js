const axios = require('axios');
const config = require('./config.json');

let latestPrice = 0;
let listeners = [];
let pollingInterval = null;

// Bitget endpoint for latest futures price
async function pollPrice() {
  try {
    const endpoint = `https://api.bitget.com/api/mix/v1/market/ticker`;
    const params = {
      symbol: config.symbol,
      productType: config.productType || 'USDT-FUTURES'
    };

    const res = await axios.get(endpoint, { params });
    const ticker = res.data?.data;

    if (ticker && ticker.bidPx) {
      latestPrice = parseFloat(ticker.bidPx);
      listeners.forEach(fn => fn(latestPrice));
    }
  } catch (err) {
    console.error('[PriceFeed] Bitget HTTP polling error:', err.message);
  }
}

function startPolling(intervalMs = 2000) {
  if (pollingInterval) clearInterval(pollingInterval);
  pollPrice(); // immediate fetch
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
