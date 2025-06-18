require('dotenv').config();
const  BitgetRestClient  = require('bitget-api-node-sdk');
const config = require('./config.json');

class BitgetClient {
  constructor(cfg = config, logger = console) {
    this.config = cfg;
    this.logger = logger;
    this.sendMessage = () => {};

    this.client = new BitgetRestClient({
      apiKey: process.env.BITGET_API_KEY,
      apiSecret: process.env.BITGET_API_SECRET,
      passPhrase: process.env.BITGET_API_PASSPHRASE,
    });
  }

  setSendMessage(fn) {
    this.sendMessage = fn;
  }

  async setLeverage(symbol, leverage, holdSide = 'long') {
    try {
      const res = await this.client.mix.account.setLeverage({
        symbol,
        marginCoin: this.config.marginCoin,
        leverage: String(leverage),
        holdSide,
      });
      if (res.code === '00000') {
        this.logger.info(`Leverage set to ${leverage}x for ${symbol} (${holdSide})`);
        this.sendMessage?.(`✅ Leverage set to ${leverage}x for ${symbol} (${holdSide})`);
        return true;
      }
      throw new Error(res.msg || 'Unknown error');
    } catch (e) {
      this.logger.error('Failed to set leverage', e);
      this.sendMessage?.(`❌ Failed to set leverage: ${e.message}`);
      return false;
    }
  }

  async placeOrder(side, qty, openOrClose = 'open', positionSide = 'long') {
    try {
      const res = await this.client.mix.order.placeOrder({
        symbol: this.config.symbol,
        marginCoin: this.config.marginCoin,
        size: String(qty),
        side: side.toLowerCase(),
        orderType: 'market',
        openType: openOrClose,
        holdSide: positionSide,
      });
      if (res.code === '00000') {
        this.logger.info(`Order placed: ${side} ${qty} (${openOrClose} ${positionSide})`, res.data);
        this.sendMessage?.(`🟢 Order: ${side} ${qty} (${openOrClose} ${positionSide})`);
        return res.data;
      }
      throw new Error(res.msg || 'Unknown error');
    } catch (e) {
      this.logger.error('Order failed', e);
      this.sendMessage?.(`❌ Order failed: ${e.message}`);
      throw e;
    }
  }

  async cancelAllOrders() {
    try {
      const res = await this.client.mix.order.cancelAllOrders({
        symbol: this.config.symbol,
        marginCoin: this.config.marginCoin,
      });
      if (res.code === '00000') {
        this.logger.info(`✅ All open orders canceled for ${this.config.symbol}`);
        this.sendMessage?.(`🧹 All open orders canceled for *${this.config.symbol}*`);
        return res.data;
      }
      throw new Error(res.msg || 'Unknown error');
    } catch (e) {
      this.logger.error('Failed to cancel open orders', e);
      this.sendMessage?.(`❌ Failed to cancel open orders: ${e.message}`);
      throw e;
    }
  }

  async openMainTrade(side, qty) {
    const positionSide = side.toUpperCase() === 'BUY' ? 'long' : 'short';
    await this.setLeverage(this.config.symbol, this.config.leverage, positionSide);
    return this.placeOrder(side, qty, 'open', positionSide);
  }

  async closeMainTrade(side, qty) {
    const positionSide = side.toUpperCase() === 'BUY' ? 'long' : 'short';
    const closeSide = side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    return this.placeOrder(closeSide, qty, 'close', positionSide);
  }

  async openHedgeTrade(side, qty) {
    return this.openMainTrade(side, qty);
  }

  async closeHedgeTrade(side, qty) {
    return this.closeMainTrade(side, qty);
  }
}

const bitgetClient = new BitgetClient();

module.exports = bitgetClient;
