const axios = require('axios');
const config = require('./config.json');

const SYMBOL = config.symbol;
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
  if (candles.length < 21) return 'WAIT';

  const recent20 = candles.slice(-21, -1); // previous 20 candles
  const last = candles[candles.length - 1];

  const high20 = Math.max(...recent20.map(c => c.high));
  const low20 = Math.min(...recent20.map(c => c.low));
  const high10 = Math.max(...recent20.slice(-10).map(c => c.high));
  const low10 = Math.min(...recent20.slice(-10).map(c => c.low));

  if (!currentPosition) {
    if (last.close > high20) {
      currentPosition = 'LONG';
      console.log(`📈 BUY at ${last.close} on ${last.time}`);
      return 'BUY';
    }
    if (last.close < low20) {
      currentPosition = 'SHORT';
      console.log(`📉 SELL at ${last.close} on ${last.time}`);
      return 'SELL';
    }
  } else if (currentPosition === 'LONG' && last.close < low10) {
    console.log(`🔓 CLOSE LONG at ${last.close} on ${last.time}`);
    currentPosition = null;
    return 'CLOSE_LONG';
  } else if (currentPosition === 'SHORT' && last.close > high10) {
    console.log(`🔓 CLOSE SHORT at ${last.close} on ${last.time}`);
    currentPosition = null;
    return 'CLOSE_SHORT';
  }

  return 'WAIT';
}

async function analyze() {
  const candles = await fetchCandles();
  const signal = getIntradaySignal(candles);
  console.log(`📊 Signal: ${signal}, Position: ${currentPosition}`);
    return signal;
}

// Run every 5 minutes
setInterval(async () => {
  try {
    await analyze();
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}, 300_000); // Poll every 5 minutes

module.exports = { analyze };

/*
usage

const { analyze } = require('./tradingBot');

(async () => {
  let signal = await analyze();
  console.log("Signal received:", signal);
})();
*/
