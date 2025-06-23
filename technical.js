const axios = require('axios');
const { EMA, MACD } = require('technicalindicators');
const config = require('./config.json');

const SYMBOL = config.symbol;
const LIMIT = 100;

async function fetchCloses(interval) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL.toUpperCase()}&interval=${interval}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(c => parseFloat(c[4])); // close prices only
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
  const [closes1m, closes3m, closes5m] = await Promise.all([
    fetchCloses('1m'),
    fetchCloses('3m'),
    fetchCloses('5m'),
  ]);

  const emaSignal1m = getEmaSignal(closes1m);
  const emaSignal3m = getEmaSignal(closes3m);
  const macdSignal5m = getMacdSignal(closes5m);

  console.log(`📊 1m EMA: ${emaSignal1m}, 3m EMA: ${emaSignal3m}, 5m MACD: ${macdSignal5m}`);

  // Only confirm trade if ALL agree
  if (
    emaSignal1m === 'BULLISH' &&
    emaSignal3m === 'BULLISH' &&
    macdSignal5m === 'BULLISH'
  ) return 'BUY';

  if (
    emaSignal1m === 'BEARISH' &&
    emaSignal3m === 'BEARISH' &&
    macdSignal5m === 'BEARISH'
  ) return 'SELL';

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
