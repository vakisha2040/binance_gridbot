const axios = require('axios');
const { EMA, MACD } = require('technicalindicators');

const SYMBOL = 'btcusdt';
const INTERVAL = '5m'; // e.g., 1m, 5m, 15m, etc.
const LIMIT = 100; // number of candles

async function fetchCandleData() {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL.toUpperCase()}&interval=${INTERVAL}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(candle => parseFloat(candle[4])); // close price
}

async function analyze() {
  const closes = await fetchCandleData();

  if (closes.length < 26) {
    console.log('Not enough data for EMA/MACD calculation');
    return;
  }

  const ema12 = EMA.calculate({ period: 12, values: closes });
  const ema26 = EMA.calculate({ period: 26, values: closes });

  const macdResult = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });

  const latestEma12 = ema12[ema12.length - 1];
  const latestEma26 = ema26[ema26.length - 1];
  const latestMACD = macdResult[macdResult.length - 1];

  console.log(`EMA12: ${latestEma12.toFixed(2)}, EMA26: ${latestEma26.toFixed(2)}`);
  console.log(`MACD: ${latestMACD.MACD.toFixed(2)}, Signal: ${latestMACD.signal.toFixed(2)}`);

  if (latestEma12 > latestEma26 && latestMACD.MACD > latestMACD.signal) {
    console.log('✅ BUY Signal');
    return 'BUY';
  } else if (latestEma12 < latestEma26 && latestMACD.MACD < latestMACD.signal) {
    console.log('❌ SELL Signal');
    return 'SELL';
  } else {
    console.log('⏸️ WAIT');
    return 'WAIT';
  }
}

// Run once
analyze();

module.exports = { analyze };
