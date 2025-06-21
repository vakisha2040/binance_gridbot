const config = require('./config.json');
let pricePrecision = config.pricePrecision; // Default for DOGEUSDT or as per config
let priceStep = config.tickSize; // Default for DOGEUSDT or as per config

function fetchPrecision(config = {}) {
  // Use config values if present, else fall back to DOGEUSDT defaults
  if (typeof config.tickSize === 'number') priceStep = config.tickSize;
  if (typeof config.tickSize === 'number') pricePrecision = getPrecisionFromStep(config.tickSize);
  // If config explicitly provides pricePrecision, use it (optional)
  if (typeof config.pricePrecision === 'number') pricePrecision = config.pricePrecision;
  // Optional log
  console.log(`✅ Precision set: step=${priceStep}, digits=${pricePrecision}`);
}

// Helper to infer number of digits from step size
function getPrecisionFromStep(step) {
  if (typeof step !== 'number') return 4;
  const stepString = step.toString();
  if (stepString.includes('.')) {
    return stepString.split('.')[1].length;
  }
  return 0;
}

function toPrecision(price) {
  return parseFloat(price.toFixed(pricePrecision));
}

function calculateNextPrice(entry, level, side, gridSpacing) {
  const direction = side === 'Buy' ? -1 : 1;
  const rawPrice = entry + direction * gridSpacing * level;
  return toPrecision(rawPrice);
}

function calculateStopLoss(entry, side, gridSpacing) {
  const direction = side === 'Buy' ? -1 : 1;
  const rawPrice = entry + direction * (gridSpacing / 2);
  return toPrecision(rawPrice);
}

module.exports = {
  fetchPrecision,
  toPrecision,
  calculateNextPrice,
  calculateStopLoss,
};
