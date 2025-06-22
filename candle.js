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
