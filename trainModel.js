const fs = require('fs');
const tf = require('@tensorflow/tfjs-node');
const ss = require('simple-statistics');
const { fetchCandles } = require('./fetchCandles');

function extractFeatures(candles) {
  const closes = candles.map(c => c.close);
  const ranges = candles.map(c => Math.abs(c.high - c.low));

  return {
    avgRange: ss.mean(ranges),
    stdDev: ss.standardDeviation(closes),
    atr: calculateATR(candles, 14),
    ema3: calculateEMA(closes, 3),
    ema9: calculateEMA(closes, 9),
    emaDiff: calculateEMA(closes, 9) - calculateEMA(closes, 3),
  };
}

function calculateATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
  });
  return ss.mean(trs.slice(-period));
}

function calculateEMA(series, period) {
  const k = 2 / (period + 1);
  return series.reduce((ema, price, i) => (i === 0 ? price : price * k + ema * (1 - k)));
}

async function runTraining() {
  const labels = JSON.parse(fs.readFileSync('./ml/labels.json', 'utf-8'));
  const candles = await fetchCandles('BTCUSDT', '5m', 600); // use latest 600

  const featureTensor = [];
  const labelTensor = [];

  for (let i = 0; i < labels.length; i++) {
    const slice = candles.slice(i, i + 50);
    if (slice.length < 50) continue;

    const f = extractFeatures(slice);
    const input = [f.avgRange, f.stdDev, f.atr, f.ema3, f.ema9, f.emaDiff];
    const target = [
      labels[i].tradeEntrySpacing,
      labels[i].trailingBoundary,
      labels[i].maxHedgeTrailDistance,
      labels[i].trailTriggerDistance,
      labels[i].gridSpacing,
      labels[i].zeroLevelSpacing,
    ];

    featureTensor.push(input);
    labelTensor.push(target);
  }

  const xs = tf.tensor2d(featureTensor);
  const ys = tf.tensor2d(labelTensor);

  // 🧠 Define model
  const model = tf.sequential();
  model.add(tf.layers.dense({ inputShape: [6], units: 32, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 6 })); // 6 targets

  model.compile({ loss: 'meanSquaredError', optimizer: 'adam' });

  // 🏋️ Train
  await model.fit(xs, ys, {
    epochs: 100,
    batchSize: 16,
    validationSplit: 0.1,
    verbose: 1,
  });

  // 💾 Save model
  await model.save('file://ml/model');
  console.log('✅ Model saved to ml/model/');
}

runTraining().catch(console.error);
