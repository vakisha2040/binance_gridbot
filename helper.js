// helper.js
const config = require('./config.json');
let pricePrecision = config.pricePrecision;
let priceStep = config.tickSize;
let boundaryUpdateCount = 0; // Track boundary updates for rate limiting

function fetchPrecision(config = {}) {
  if (typeof config.tickSize === 'number') priceStep = config.tickSize;
  if (typeof config.tickSize === 'number') pricePrecision = getPrecisionFromStep(config.tickSize);
  if (typeof config.pricePrecision === 'number') pricePrecision = config.pricePrecision;
  console.log(`✅ Precision set: step=${priceStep}, digits=${pricePrecision}`);
}

function getPrecisionFromStep(step) {
  if (typeof step !== 'number') return 4;
  const stepString = step.toString();
  return stepString.includes('.') ? stepString.split('.')[1].length : 0;
}

function toPrecision(price) {
  return parseFloat(price.toFixed(pricePrecision));
}

function calculateNextPrice(entry, level, side, gridSpacing) {
  const direction = side === 'Buy' ? -1 : 1;
  return toPrecision(entry + direction * gridSpacing * level);
}

function calculateStopLoss(entry, side, gridSpacing) {
  const direction = side === 'Buy' ? -1 : 1;
  return toPrecision(entry + direction * (gridSpacing / 2));
}

// New boundary calculation functions
function calculateTrailingBoundary(currentPrice, lastBoundary, side, spacing) {
  const buffer = spacing * 0.3; // 30% buffer to prevent whipsaw
  if (side === 'Buy') {
    return toPrecision(Math.min(currentPrice - spacing, lastBoundary - buffer));
  } else {
    return toPrecision(Math.max(currentPrice + spacing, lastBoundary + buffer));
  }
}

function shouldUpdateBoundary(currentPrice, lastBoundary, side, spacing) {
  const minMove = spacing * 0.5; // Only move after 50% of spacing
  if (side === 'Buy') {
    return (currentPrice - lastBoundary) >= minMove;
  } else {
    return (lastBoundary - currentPrice) >= minMove;
  }
}

function formatBoundaryMessage(side, newBoundary, priceChange) {
  boundaryUpdateCount++;
  if (boundaryUpdateCount % 3 !== 0) return null; // Only message every 3 updates
  
  return `🔄 ${side} Boundary Updated\n` +
         `▫️ New Level: ${newBoundary}\n` +
         `▫️ Price Change: ${toPrecision(priceChange)}`;
}

module.exports = {
  fetchPrecision,
  toPrecision,
  calculateNextPrice,
  calculateStopLoss,
  calculateTrailingBoundary,
  shouldUpdateBoundary,
  formatBoundaryMessage
};
