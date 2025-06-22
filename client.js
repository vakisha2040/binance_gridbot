const ccxt = require('ccxt');
const config = require('./config.json');

class BinanceClient {
  constructor() {
    this.exchange = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_API_SECRET,
      enableRateLimit: true
    });
  }

  async openMainTrade(side, size) {
    return this.exchange.createOrder(
      config.symbol,
      'market',
      side.toLowerCase(),
      size
    );
  }

  // Add other required methods...
}

module.exports = new BinanceClient();
