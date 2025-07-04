
const WebSocket = require('ws');
const config = require('./config.json');

let latestPrice = 0;
let ws = null;
let listeners = [];
let isConnected = false;

function connectWebSocket() {
  const symbol = config.symbol.toLowerCase(); // e.g., dogeusdt
  const endpoint = `wss://fstream.binance.com/ws/${symbol}@bookTicker`;

  ws = new WebSocket(endpoint);

  ws.on('open', () => {
    console.log(`[PriceFeed] ✅ WebSocket connected for ${config.symbol}`);
    isConnected = true;
  });

  ws.on('message', (data) => {
    try {
      const ticker = JSON.parse(data);
      if (ticker && ticker.b) {
        latestPrice = parseFloat(ticker.b); // bidPrice
        listeners.forEach(fn => fn(latestPrice));
      }
    } catch (err) {
      console.error('[PriceFeed] ❌ Failed to parse message:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[PriceFeed] ❌ WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.warn('[PriceFeed] ⚠️ WebSocket closed. Reconnecting in 5s...');
    isConnected = false;
    setTimeout(connectWebSocket, 5000);
  });
}

function startPolling() {
  if (!isConnected) connectWebSocket();
}

function stopPolling() {
  if (ws) {
    ws.close();
    ws = null;
    isConnected = false;
  }
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
  startPolling,
  stopPolling,
  getCurrentPrice,
  onPrice,
  waitForFirstPrice
};




/*
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
*/
