const axios = require('axios');
//..const { EMA, MACD } = require('technicalindicators');
//const config = require('./config.json');

//..const SYMBOL = config.symbol;
//const LIMIT = 100;



// technical.js - Advanced Technical Analysis

const Binance = require('binance-api-node').default;
const technicalindicators = require('technicalindicators');
const config = require('./config.json');

const SYMBOL = config.symbol || 'SOLUSDT';
const INTERVAL = config.analysisInterval || '5m'; // e.g. 1m, 5m, 15m, 1h, etc.
const CANDLE_LIMIT = config.analysisCandles || 100;

// If you use API keys, pass here; for public OHLCV, no need
const client = Binance({
  apiKey: config.apiKey || process.env.BINANCE_API_KEY,
  apiSecret: config.apiSecret || process.env.BINANCE_API_SECRET,
});

async function fetchCandles(symbol = SYMBOL, interval = INTERVAL, limit = CANDLE_LIMIT) {
  const klines = await client.candles({ symbol, interval, limit });
  return klines.map(k => ({
    open: parseFloat(k.open),
    high: parseFloat(k.high),
    low: parseFloat(k.low),
    close: parseFloat(k.close),
    volume: parseFloat(k.volume),
    time: k.closeTime,
  }));
}

// Calculate indicators and generate a signal
async function analyze() {
  const candles = await fetchCandles();
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // RSI
  const rsi = technicalindicators.RSI.calculate({ values: closes, period: 14 }).slice(-1)[0];
  // EMA
  const ema21 = technicalindicators.EMA.calculate({ values: closes, period: 21 }).slice(-1)[0];
  const ema50 = technicalindicators.EMA.calculate({ values: closes, period: 50 }).slice(-1)[0];
  // MACD
  const macd = technicalindicators.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const macdLast = macd.slice(-1)[0];
  // Bollinger Bands
  const bb = technicalindicators.BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  }).slice(-1)[0];

  const current = closes[closes.length - 1];

  // Decision logic
  let signal = 'WAIT';
  let reasons = [];

  // Example logic (customize as you like)
  if (rsi && rsi < 30 && current < bb.lower && ema21 > ema50 && macdLast?.MACD > macdLast?.signal) {
    signal = 'BUY';
    reasons.push('RSI oversold, price below BB, bullish EMA, and MACD cross up');
  } else if (rsi && rsi > 70 && current > bb.upper && ema21 < ema50 && macdLast?.MACD < macdLast?.signal) {
    signal = 'SELL';
    reasons.push('RSI overbought, price above BB, bearish EMA, and MACD cross down');
  } else {
    // You can add more nuanced logic here for "WAIT"
  signal = "WAIT";
    reasons.push('No strong signal: conditions not met for buy/sell');
  }

  // Optional: Log or send detailed info for debugging
  console.log(`[TA] Signal: ${signal} | RSI: ${rsi?.toFixed(2)} | EMA21: ${ema21?.toFixed(2)} | EMA50: ${ema50?.toFixed(2)} | MACD: ${macdLast?.MACD?.toFixed(2)} | MACD Signal: ${macdLast?.signal?.toFixed(2)} | BB: [${bb?.lower?.toFixed(2)}, ${bb?.upper?.toFixed(2)}] | Price: ${current?.toFixed(2)}`);

  return signal;
}

module.exports = {
  analyze,
  fetchCandles // (optional, for debugging or stats)
};



 Run every 2 seconds
setInterval(async () => {
  try {
    const signal = await analyze();
    console.log('📉 Final Decision:', signal);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}, 2000);

module.exports = { analyze };
