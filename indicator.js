const tulind = require('tulind');

async function calculateEMA(prices, period = 21) {
  try {
    const results = await tulind.indicators.ema.indicator([prices], [period]);
    return results[0];
  } catch (err) {
    console.error('EMA calculation error:', err);
    return [];
  }
}

async function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    const results = await tulind.indicators.macd.indicator(
      [prices],
      [fastPeriod, slowPeriod, signalPeriod]
    );
    return {
      macd: results[0],
      signal: results[1],
      histogram: results[2]
    };
  } catch (err) {
    console.error('MACD calculation error:', err);
    return { macd: [], signal: [], histogram: [] };
  }
}

function getCurrentSignal(macdData) {
  if (macdData.histogram.length < 2) return 'neutral';
  
  const last = macdData.histogram[macdData.histogram.length - 1];
  const prev = macdData.histogram[macdData.histogram.length - 2];
  
  if (last > 0 && prev <= 0) return 'bullish';
  if (last < 0 && prev >= 0) return 'bearish';
  return 'neutral';
}

module.exports = {
  calculateEMA,
  calculateMACD,
  getCurrentSignal
};
