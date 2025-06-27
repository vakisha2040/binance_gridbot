const axios = require('axios');
const config = require('./config.json');

let latestPrice = undefined;
let listeners = [];
let pollingInterval = null;
/*
async function pollPrice() {
  try {
    const endpoint = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${config.symbol}`;
    const res = await axios.get(endpoint);

    const tickerArr = res.data && res.data.result && res.data.result.list;
    if (Array.isArray(tickerArr) && tickerArr.length > 0 && tickerArr[0].bidPrice) {
      latestPrice = parseFloat(tickerArr[0].bidPrice);
      listeners.forEach(fn => fn(latestPrice));
    } else {
      console.error('[PriceFeed] No data returned from Bybit for symbol', config.symbol, res.data);
    }
  } catch (err) {
    console.error('[PriceFeed] HTTP polling error:', err.message);
  }
}
*/
async function pollPrice() {
  try {
    const endpoint = `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${config.symbol}`;
    const res = await axios.get(endpoint);
    const tickerArr = res.data.result.list;
    if (Array.isArray(tickerArr) && tickerArr.length > 0) {
      console.log('[PriceFeed] Bybit ticker object:', tickerArr[0]);
      if (tickerArr[0].bidPrice) {
        latestPrice = parseFloat(tickerArr[0].bidPrice);
        listeners.forEach(fn => fn(latestPrice));
      } else {
        console.error('[PriceFeed] bidPrice missing in ticker for', config.symbol, tickerArr[0]);
      }
    } else {
      console.error('[PriceFeed] No data returned from Bybit for symbol', config.symbol, res.data);
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
  if (typeof latestPrice === 'number' && !isNaN(latestPrice)) callback(latestPrice);
}

function getCurrentPrice() {
  return latestPrice;
}

function waitForFirstPrice() {
  return new Promise(resolve => {
    if (typeof latestPrice === 'number' && !isNaN(latestPrice)) return resolve(latestPrice);
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
