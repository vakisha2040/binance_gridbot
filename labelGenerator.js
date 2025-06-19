const fs = require('fs');
const ss = require('simple-statistics');
const { fetchCandles } = require('../services/fetchCandles');

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    const highLow = c.high - c.low;
    const highClose = Math.abs(c.high - prev.close);
    const lowClose = Math.abs(c.low - prev.close);
    return Math.max(highLow, highClose, lowClose);
  });
  return average(trs.slice(-period));
}

function generateLabelFromCandles(candles) {
  const ranges = candles.map(c => Math.abs(c.high - c.low));
  const closes = candles.map(c => c.close);
  const atr = calculateATR(candles, 14);
  const avgRange = average(ranges);
  const std = ss.standardDeviation(closes);

  return {
    tradeEntrySpacing: atr + avgRange * 0.5,
    gridSpacing: avgRange,
    zeroLevelSpacing: atr * 1.3,
    trailingBoundary: atr * 1.5,
    trailTriggerDistance: atr * 1.2,
    maxHedgeTrailDistance: atr * 2.0
  };
}

async function run() {
  const labels = [];
  const candles = await fetchCandles('BTCUSDT', '5m', 500); // Enough for multiple samples

  for (let i = 0; i < candles.length - 50; i += 5) {
    const slice = candles.slice(i, i + 50);
    if (slice.length < 50) break;
    const label = generateLabelFromCandles(slice);
    labels.push(label);
  }

  fs.writeFileSync('./ml/labels.json', JSON.stringify(labels, null, 2));
  console.log(`✅ Generated ${labels.length} label entries.`);
}

run();
