const axios = require('axios');
const config = require('./config.json');

const SYMBOL = config.symbol || "SOLUSDT";
const INTERVAL = '1m';
const LIMIT = 100;

let currentPosition = null; // 'LONG', 'SHORT', or null

async function fetchCandles(symbol = SYMBOL) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(c => ({
    openTime: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    time: new Date(c[0]).toLocaleTimeString()
  }));
}
 function getIntradaySignal(candles) {
  if (candles.length < 11) return 'WAIT';

  const recent10 = candles.slice(-11, -1); // Previous 10 candles
  const last = candles[candles.length - 1];

  const high10 = Math.max(...recent10.map(c => c.high));
  const low10 = Math.min(...recent10.map(c => c.low));

  // Debug
  console.log(`Last: ${last.close}, H10: ${high10}, L10: ${low10}`);

  if (last.close >= high10) {
    console.log(`📈 BUY at ${last.close} on ${last.time}`);
    return 'BUY';
  }

  if (last.close <= low10) {
    console.log(`📉 SELL at ${last.close} on ${last.time}`);
    return 'SELL';
  }

  return 'WAIT';
}
async function analyze() {
  const candles = await fetchCandles();
  const signal = getIntradaySignal(candles);
  console.log(`[${new Date().toLocaleString()}] 📊 Signal: ${signal}`);
  
  return signal;
}

// Run every 5 minutes
setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}, 5000); // Poll every 5 minutes

module.exports = { analyze };

/*
usage

const { analyze } = require('./tradingBot');

(async () => {
  let signal = await analyze();
  console.log("Signal received:", signal);
})();
*/
