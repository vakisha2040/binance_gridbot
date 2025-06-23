const axios = require('axios');
const { EMA, MACD } = require('technicalindicators');

const SYMBOL = 'solusdt';
const LIMIT = 100;

async function fetchCloses(interval) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL.toUpperCase()}&interval=${interval}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(c => parseFloat(c[4])); // close prices
}

function getSignal(closes) {
  if (closes.length < 26) return 'WAIT';

  const ema12 = EMA.calculate({ period: 12, values: closes });
  const ema26 = EMA.calculate({ period: 26, values: closes });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });

  const latestEma12 = ema12[ema12.length - 1];
  const latestEma26 = ema26[ema26.length - 1];
  const latestMacd = macd[macd.length - 1];

  if (!latestMacd) return 'WAIT';

  if (latestEma12 > latestEma26 && latestMacd.MACD > latestMacd.signal) return 'BUY';
  if (latestEma12 < latestEma26 && latestMacd.MACD < latestMacd.signal) return 'SELL';

  return 'WAIT';
}

async function analyze() {
  const [closes3m, closes5m, closes15m] = await Promise.all([
    fetchCloses('3m'),
    fetchCloses('5m'),
    fetchCloses('15m')
  ]);

  const signals = [
    getSignal(closes3m),
    getSignal(closes5m),
    getSignal(closes15m),
  ];

  const count = { BUY: 0, SELL: 0, WAIT: 0 };
  for (let s of signals) count[s]++;

  console.log(`3m: ${signals[0]}, 5m: ${signals[1]}, 15m: ${signals[2]}`);

  if (count.BUY >= 2) return 'BUY';
  if (count.SELL >= 2) return 'SELL';
  return 'WAIT';
}

//const { analyze } = require('./ema_macd_strategy');

setInterval(async () => {
  const signal = await analyze();
  console.log('📊 Final Decision:', signal);
}, 2000);

module.exports = { analyze };
