async function getHistoricalPrices(limit = 50) {
  try {
    const candles = await this.client.candles({
      symbol: this.symbol,
      interval: '15m', // Or use config.timeframe
      limit
    });
    return candles;
  } catch (err) {
    console.error('Error fetching historical data:', err);
    return [];
  }
}




async function analyzeMarketConditions() {
  const { short, medium, long } = await getMultiTimeframeData(config.symbol);
  
  // Short-term indicators
  const shortIndicators = {
    ema: await calculateEMA(short.closes, 21),
    macd: await calculateMACD(short.closes),
    rsi: await calculateRSI(short.closes),
    bbands: await calculateBollingerBands(short.closes)
  };
  
  // Medium-term trend
  const mediumIndicators = {
    ema: await calculateEMA(medium.closes, 50),
    macd: await calculateMACD(medium.closes, 26, 52, 9)
  };
  
  // Long-term trend
  const longIndicators = {
    ema: await calculateEMA(long.closes, 200),
    macd: await calculateMACD(long.closes, 50, 100, 18)
  };
  
  return {
    short: {
      ...shortIndicators,
      trend: getTrendConsensus({
        ...shortIndicators,
        price: short.closes[short.closes.length - 1]
      })
    },
    medium: {
      ...mediumIndicators,
      trend: mediumIndicators.ema.slice(-1)[0] < medium.closes.slice(-1)[0] ? 
             'bullish' : 'bearish'
    },
    long: {
      ...longIndicators,
      trend: longIndicators.ema.slice(-1)[0] < long.closes.slice(-1)[0] ?
             'bullish' : 'bearish'
    }
  };
}
