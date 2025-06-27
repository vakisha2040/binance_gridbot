require('dotenv').config();
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
    this.sendMessage = () => {};

    this.client = new RestClientV5({
      key: cfg.apiKey || process.env.BYBIT_API_KEY,
      secret: cfg.apiSecret || process.env.BYBIT_API_SECRET,
      
    });

    this.hedgeModeEnabled = true;
  }

  setSendMessage(fn) {
    this.sendMessage = fn;
  }

  async enableHedgeMode() {
    try {
      if (this.hedgeModeEnabled) {
        this.logger.info('Hedge mode already enabled.');
        return true;
      }
      const resGet = await this.client.getPositionMode({ category: 'linear' });
      if (resGet && resGet.result && resGet.result.unifiedMode === 0) {
        this.hedgeModeEnabled = true;
        this.logger.info('Hedge mode already enabled (detected from API).');
        return true;
      }
      const res = await this.client.setPositionMode({ category: 'linear', mode: 0 });
      if (res.retCode === 0) {
        this.hedgeModeEnabled = true;
        this.logger.info('Hedge mode enabled for account.');
        this.sendMessage?.('✅ Hedge mode enabled.');
        return true;
      }
      throw new Error(res.retMsg || 'Unknown error enabling hedge mode');
    } catch (e) {
      this.logger.error('Failed to enable hedge mode', e);
      this.sendMessage?.(`❌ Failed to enable hedge mode: ${e.message}`);
      return false;
    }
  }

  async setLeverage() {
    try {
      const symbol = this.config.symbol;
      const leverage = this.config.leverage;
      if (!symbol || typeof symbol !== "string") {
        throw new Error(`Invalid symbol: ${symbol}`);
      }
      if (
        typeof leverage !== "number" ||
        isNaN(leverage) ||
        leverage < 1 ||
        leverage > 125
      ) {
        throw new Error(`Invalid leverage: ${leverage}`);
      }
      const res = await this.client.setLeverage({
        category: 'linear',
        symbol,
        buyLeverage: leverage,
        sellLeverage: leverage,
      });
      if (res && res.retCode === 0) {
        this.logger.info(`Leverage set to ${leverage}x for ${symbol}`);
        this.sendMessage?.(`✅ Leverage set to ${leverage}x for ${symbol}`);
        return true;
      }
      throw new Error(res.retMsg || "Unknown error");
    } catch (e) {
      this.logger.error("Failed to set leverage", e);
      this.sendMessage?.(`❌ Failed to set leverage: ${e.message}`);
      return false;
    }
  }

  static formatSide(side) {
    if (typeof side !== 'string') return side;
    return side.toUpperCase() === 'BUY' ? 'Buy'
         : side.toUpperCase() === 'SELL' ? 'Sell'
         : side;
  }



  // Open main trade
  async openMainTrade(side) {
    const tradeSide = BybitClient.formatSide(side);
    const order = {
      category: 'linear',
      symbol: this.config.symbol,
      side: tradeSide, // must be "Buy" or "Sell"
      orderType: 'Market',
      qty: String(this.config.orderSize),
      positionIdx: tradeSide === 'Buy' ? 1 : 2, // 1=Buy, 2=Sell in hedge mode
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
    const order = {
      category: 'linear',
      symbol: this.config.symbol,
      side: tradeSide,
      orderType: 'Market',
      qty: String(this.config.orderSize),
      positionIdx: tradeSide === 'Buy' ? 1 : 2, // 1=Buy/long, 2=Sell/short
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



  
  
  async cancelAllOrders() {
    try {
      const symbol = this.config.symbol;
      const result = await this.client.cancelAllOrders({ category: 'linear', symbol });
      this.logger.info(`✅ All open orders canceled for ${symbol}`);
      this.sendMessage?.(`🧹 All open orders canceled for *${symbol}*`);
      return result;
    } catch (err) {
      this.logger.error(`❌ Failed to cancel open orders for ${this.config.symbol}:`, err);
      this.sendMessage?.(`❌ Failed to cancel open orders: ${err.message}`);
      throw err;
    }
  }
}

const bybitClient = new BybitClient();



module.exports = bybitClient;
