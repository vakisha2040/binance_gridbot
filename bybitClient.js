const { RestClientV5 } = require('bybit-api');
const config = require('./config.json');

let sendMessage = () => {};
function setSendMessage(fn) {
  sendMessage = fn;
}

class BybitClient {
  constructor(cfg = config, logger = console) {
    this.config = cfg;
    this.logger = logger;
    this.client = new RestClientV5({
      key: cfg.apiKey || process.env.BYBIT_API_KEY,
      secret: cfg.apiSecret || process.env.BYBIT_API_SECRET,
      testnet: !!cfg.testnet,
    });
  }

  static formatSide(side) {
    if (typeof side !== 'string') return side;
    return side.toUpperCase() === 'BUY' ? 'Buy'
         : side.toUpperCase() === 'SELL' ? 'Sell'
         : side;
  }

  // Set leverage for both directions (required for hedge mode)
  async setLeverage(leverage) {
    try {
      const res = await this.client.setLeverage({
        category: 'linear',
        symbol: this.config.symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage)
      });
      this.logger.log('Leverage set:', leverage, res);
      if (sendMessage) sendMessage(`Leverage set to ${leverage}x`);
      return res;
    } catch (e) {
      this.logger.error('Failed to set leverage:', e.message);
      if (sendMessage) sendMessage(`❌ Failed to set leverage: ${e.message}`);
      throw e;
    }
  }

  // Open main trade
  async openMainTrade(side) {
    const tradeSide = BybitClient.formatSide(side);
    // Always set leverage before opening trade
    await this.setLeverage(this.config.leverage || 3);
    const order = {
      category: 'linear',
      symbol: this.config.symbol,
      side: tradeSide,
      orderType: 'Market',
      qty: String(this.config.orderSize),
      positionIdx: tradeSide === 'Buy' ? 1 : 2,
      reduceOnly: false,
    };
    this.logger.log('Submitting order:', order);
    try {
      const res = await this.client.submitOrder(order);
      this.logger.log('Order payload:', order);
      this.logger.log('Main trade opened:', tradeSide, order.qty, `(positionIdx: ${order.positionIdx})`, res);
      if (sendMessage) sendMessage(`Main trade opened: ${tradeSide} ${order.qty} (positionIdx: ${order.positionIdx})`);
      return res;
    } catch (e) {
      this.logger.error('Failed to open main trade:', e.message);
      throw e;
    }
  }

  // Open hedge trade
  async openHedgeTrade(side) {
    const tradeSide = BybitClient.formatSide(side);
    // Always set leverage before opening trade
    await this.setLeverage(this.config.leverage || 3);
    const order = {
      category: 'linear',
      symbol: this.config.symbol,
      side: tradeSide,
      orderType: 'Market',
      qty: String(this.config.orderSize),
      positionIdx: tradeSide === 'Buy' ? 1 : 2,
      reduceOnly: false,
    };
    this.logger.log('Submitting hedge order:', order);
    try {
      const res = await this.client.submitOrder(order);
      this.logger.log('Hedge order payload:', order);
      this.logger.log('Hedge trade opened:', tradeSide, order.qty, `(positionIdx: ${order.positionIdx})`, res);
      if (sendMessage) sendMessage(`Hedge trade opened: ${tradeSide} ${order.qty} (positionIdx: ${order.positionIdx})`);
      return res;
    } catch (e) {
      this.logger.error('Failed to open hedge trade:', e.message);
      throw e;
    }
  }

  // Close main trade
  async closeMainTrade(side) {
    const tradeSide = BybitClient.formatSide(side);
    const order = {
      category: 'linear',
      symbol: this.config.symbol,
      side: tradeSide === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty: String(this.config.orderSize),
      positionIdx: tradeSide === 'Buy' ? 1 : 2,
      reduceOnly: true,
    };
    this.logger.log('Submitting close main trade order:', order);
    try {
      const res = await this.client.submitOrder(order);
      this.logger.log('Closed main trade:', tradeSide, order.qty, `(positionIdx: ${order.positionIdx})`, res);
      if (sendMessage) sendMessage(`Closed main trade: ${tradeSide} ${order.qty} (positionIdx: ${order.positionIdx})`);
      return res;
    } catch (e) {
      this.logger.error('Failed to close main trade:', e.message);
      throw e;
    }
  }

  // Close hedge trade
  async closeHedgeTrade(side) {
    const tradeSide = BybitClient.formatSide(side);
    const order = {
      category: 'linear',
      symbol: this.config.symbol,
      side: tradeSide === 'Buy' ? 'Sell' : 'Buy',
      orderType: 'Market',
      qty: String(this.config.orderSize),
      positionIdx: tradeSide === 'Buy' ? 1 : 2,
      reduceOnly: true,
    };
    this.logger.log('Submitting close hedge trade order:', order);
    try {
      const res = await this.client.submitOrder(order);
      this.logger.log('Closed hedge trade:', tradeSide, order.qty, `(positionIdx: ${order.positionIdx})`, res);
      if (sendMessage) sendMessage(`Closed hedge trade: ${tradeSide} ${order.qty} (positionIdx: ${order.positionIdx})`);
      return res;
    } catch (e) {
      this.logger.error('Failed to close hedge trade:', e.message);
      throw e;
    }
  }

  setSendMessage(fn) {
    setSendMessage(fn);
  }
}

module.exports = new BybitClient();
module.exports.setSendMessage = setSendMessage;
