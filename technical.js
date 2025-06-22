const axios = require('axios');
const { EMA, MACD } = require('technicalindicators');

const SYMBOL = 'btcusdt';
const INTERVAL = '3m'; // 3-minute candles
const LIMIT = 100;

async function fetchCandleData() {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL.toUpperCase()}&interval=${INTERVAL}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(candle => parseFloat(candle[4])); // close price
}

async function analyze() {
  const closes = await fetchCandleData();
  if (closes.length < 26) {
    console.log('Not enough data for EMA/MACD calculation');
    return 'WAIT';
  }

  // === EMA signal ===
  const ema12 = EMA.calculate({ period: 12, values: closes });
  const ema26 = EMA.calculate({ period: 26, values: closes });
  const latestEma12 = ema12[ema12.length - 1];
  const latestEma26 = ema26[ema26.length - 1];

  let emaSignal = 'WAIT';
  if (latestEma12 > latestEma26) emaSignal = 'BUY';
  else if (latestEma12 < latestEma26) emaSignal = 'SELL';

  // === MACD signal ===
  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const latestMACD = macdResult[macdResult.length - 1];

  let macdSignal = 'WAIT';
  if (latestMACD && latestMACD.MACD > latestMACD.signal) macdSignal = 'BUY';
  else if (latestMACD && latestMACD.MACD < latestMACD.signal) macdSignal = 'SELL';

  console.log(`EMA: ${emaSignal}, MACD: ${macdSignal}`);

  // === Final decision: if either gives BUY or SELL ===
  if (emaSignal === 'BUY' || macdSignal === 'BUY') return 'BUY';
  if (emaSignal === 'SELL' || macdSignal === 'SELL') return 'SELL';
  return 'WAIT';
}

module.exports = { analyze };
