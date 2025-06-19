const fs = require('fs');
const ss = require('simple-statistics');
const { DecisionTreeRegression } = require('ml-cart');
const { fetchCandles } = require('./fetchCandles');

const modelJSON = JSON.parse(fs.readFileSync('./model.json', 'utf-8'));
const model = DecisionTreeRegression.load(modelJSON);

function extractFeatures(candles) {
  const ranges = candles.map(c => Math.abs(c.high - c.low));
  const closes = candles.map(c => c.close);
  const atr = calculateATR(candles, 14);
  return [
    ss.mean(ranges),
    ss.standardDeviation(closes),
    atr,
    calculateEMA(closes, 9) - calculateEMA(closes, 3)
  ];
}

function calculateATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return ss.mean(trs.slice(-period));
}

function calculateEMA(series, period) {
  const k = 2 / (period + 1);
  return series.reduce((ema, price, i) => (i === 0 ? price : price * k + ema * (1 - k)));
}

async function getDynamicConfig() {
  const candles = await fetchCandles('BTCUSDT', '5m', 50);
  const features = extractFeatures(candles);
  const [tradeEntrySpacing, gridSpacing, zeroLevelSpacing, trailingBoundary, trailTriggerDistance, maxHedgeTrailDistance] =
    model.predict([features]);

  return {
    tradeEntrySpacing,
    gridSpacing,
    zeroLevelSpacing,
    trailingBoundary,
    trailTriggerDistance,
    maxHedgeTrailDistance
  };
}

module.exports = { getDynamicConfig };
