const tulind = require('tulind');

// Timeframe constants
const TIMEFRAMES = {
  SHORT: '15m',
  MEDIUM: '1h',
  LONG: '4h'
};

async function getMultiTimeframeData(symbol) {
  const [short, medium, long] = await Promise.all([
    bybit.getHistoricalPrices(symbol, TIMEFRAMES.SHORT, 100),
    bybit.getHistoricalPrices(symbol, TIMEFRAMES.MEDIUM, 100),
    bybit.getHistoricalPrices(symbol, TIMEFRAMES.LONG, 100)
  ]);
  return { short, medium, long };
}

async function calculateRSI(prices, period = 14) {
  const results = await tulind.indicators.rsi.indicator([prices], [period]);
  return results[0];
}

async function calculateBollingerBands(prices, period = 20, stddev = 2) {
  const results = await tulind.indicators.bbands.indicator(
    [prices],
    [period, stddev]
  );
  return {
    upper: results[0],
    middle: results[1],
    lower: results[2]
  };
}

function getTrendConsensus(indicators) {
  let score = 0;
  
  // MACD
  if (indicators.macd.signal === 'bullish') score += 1;
  if (indicators.macd.signal === 'bearish') score -= 1;
  
  // Price vs EMA
  if (indicators.price > indicators.ema) score += 0.5;
  else score -= 0.5;
  
  // RSI
  if (indicators.rsi > 60) score += 0.5;
  else if (indicators.rsi < 40) score -= 0.5;
  
  // Bollinger Bands
  if (indicators.price > indicators.bbands.upper) score -= 0.3; // Overbought
  if (indicators.price < indicators.bbands.lower) score += 0.3; // Oversold
  
  return score > 0.5 ? 'bullish' : score < -0.5 ? 'bearish' : 'neutral';
}

module.exports = {
  TIMEFRAMES,
  getMultiTimeframeData,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateBollingerBands,
  getCurrentSignal,
  getTrendConsensus
};
