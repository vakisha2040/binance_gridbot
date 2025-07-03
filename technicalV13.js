// technical.js - Advanced Technical Analysis with 2-out-of-3 Signal Confirmation
const axios = require('axios');
const { EMA, MACD } = require('technicalindicators');
const config = require('./config.json');

const SYMBOL = config.symbol;
const LIMIT = 100;

async function fetchCloses(interval) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL.toUpperCase()}&interval=${interval}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(c => parseFloat(c[4])); // Close prices only
}

function getEmaSignal(closes, fastPeriod = 3, slowPeriod = 9) {
  if (closes.length < slowPeriod) return null;

  const emaFast = EMA.calculate({ period: fastPeriod, values: closes });
  const emaSlow = EMA.calculate({ period: slowPeriod, values: closes });

  const latestFast = emaFast[emaFast.length - 1];
  const latestSlow = emaSlow[emaSlow.length - 1];

  if (latestFast > latestSlow) return 'BULLISH';
  if (latestFast < latestSlow) return 'BEARISH';
  return 'NEUTRAL';
}

function getMacdSignal(closes) {
  if (closes.length < 26) return null;

  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 6,
    slowPeriod: 13,
    signalPeriod: 5,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const latest = macd[macd.length - 1];
  if (!latest) return null;

  if (latest.MACD > latest.signal) return 'BULLISH';
  if (latest.MACD < latest.signal) return 'BEARISH';
  return 'NEUTRAL';
}

async function analyze() {
  const [closes3m, closes5m, closes15m] = await Promise.all([
    fetchCloses('3m'),
    fetchCloses('5m'),
    fetchCloses('15m'),
  ]);

  const emaSignal3m = getEmaSignal(closes3m);
  const emaSignal5m = getEmaSignal(closes5m);
  const macdSignal15m = getMacdSignal(closes15m);

  console.log(`📊 3m EMA: ${emaSignal3m}, 5m EMA: ${emaSignal5m}, 15m MACD: ${macdSignal15m}`);

  const signals = [emaSignal3m, emaSignal5m, macdSignal15m];

  const bullishCount = signals.filter(s => s === 'BULLISH').length;
  const bearishCount = signals.filter(s => s === 'BEARISH').length;

  if (bullishCount >= 2) return 'BUY';
  if (bearishCount >= 2) return 'SELL';

  return 'WAIT';
}

// Run every 2 seconds
setInterval(async () => {
  try {
    const signal = await analyze();
    console.log('📉 Final Decision:', signal);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}, 2000);

module.exports = { analyze };
