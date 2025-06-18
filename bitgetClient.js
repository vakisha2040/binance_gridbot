require('dotenv').config();
const crypto = require('crypto');
const fetch = require('node-fetch');
const config = require('./config.json');

class BitgetClient {
  constructor(cfg = config, logger = console) {
    this.config = cfg;
    this.logger = logger;
    this.sendMessage = () => {};
    this.apiKey = process.env.BITGET_API_KEY;
    this.apiSecret = process.env.BITGET_API_SECRET;
    this.passphrase = process.env.BITGET_API_PASSPHRASE;
    this.baseURL = 'https://api.bitget.com';
  }

  sign(timestamp, method, path, body = '') {
    const payload = `${timestamp}${method}${path}${body}`;
    return crypto.createHmac('sha256', this.apiSecret).update(payload).digest('base64');
  }

  async request(method, path, params = {}, body = null) {
    const timestamp = Date.now().toString();
    const query = method === 'GET' && Object.keys(params).length
      ? `?${new URLSearchParams(params)}`
      : '';
    const fullPath = `${path}${query}`;
    const url = `${this.baseURL}${fullPath}`;
    const bodyStr = body ? JSON.stringify(body) : '';
    const signature = this.sign(timestamp, method, fullPath, bodyStr);

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'ACCESS-KEY': this.apiKey,
        'ACCESS-SIGN': signature,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': this.passphrase,
        'locale': 'en-US',
      },
      body: method !== 'GET' ? bodyStr : undefined,
    });

    const json = await res.json();
    if (json.code !== '00000') throw new Error(json.msg || 'Unknown error');
    return json.data;
  }

  setSendMessage(fn) {
    this.sendMessage = fn;
  }

  async setLeverage(symbol, leverage, positionSide = 'long') {
    try {
      const res = await this.request('POST', '/api/mix/v1/account/setLeverage', {}, {
        symbol,
        marginCoin: this.config.marginCoin,
        marginMode: this.config.marginMode || 'crossed',
        leverage: String(leverage),
      });

      this.logger.info(`✅ Leverage set to ${leverage}x (${this.config.marginMode}) for ${symbol} (${positionSide})`);
      this.sendMessage?.(`✅ Leverage set to ${leverage}x (${this.config.marginMode}) for ${symbol} (${positionSide})`);
      return true;
    } catch (e) {
      this.logger.error('❌ Failed to set leverage', e);
      this.sendMessage?.(`❌ Failed to set leverage: ${e.message}`);
      return false;
    }
  }

  async getPositionSize(positionSide = 'long') {
    try {
      const data = await this.request('GET', '/api/mix/v1/position/singlePosition', {
        symbol: this.config.symbol,
        marginCoin: this.config.marginCoin,
      });

      if (!data || !data.holdSide) return 0;

      if (positionSide === 'long' && data.holdSide.toLowerCase() === 'long') {
        return parseFloat(data.total);
      }

      if (positionSide === 'short' && data.holdSide.toLowerCase() === 'short') {
        return parseFloat(data.total);
      }

      return 0;
    } catch (e) {
      this.logger.error('❌ Failed to fetch position size', e);
      return 0;
    }
  }

  async placeOrder(_, qty, tradeSide = 'open', positionSide = 'long') {
    try {
      let side;
      if (tradeSide === 'open') {
        side = positionSide === 'long' ? 'buy' : 'sell';
      } else {
        side = positionSide === 'long' ? 'sell' : 'buy';
        const actualQty = await this.getPositionSize(positionSide);
        if (actualQty <= 0) {
          throw new Error(`No ${positionSide} position to close.`);
        }
        qty = Math.min(qty, actualQty);
      }

      const body = {
        symbol: this.config.symbol,
        marginCoin: this.config.marginCoin,
        marginMode: this.config.marginMode || 'crossed',
        size: String(qty),
        side,
        tradeSide,
        orderType: 'market',
        force: 'gtc',
        reduceOnly: tradeSide === 'close' ? 'true' : 'false',
      };

      const res = await this.request('POST', '/api/mix/v1/order/placeOrder', {}, body);

      this.logger.info(`🟢 Order placed: ${side} ${qty} (${tradeSide} ${positionSide})`, res);
      this.sendMessage?.(`🟢 Order: ${side} ${qty} (${tradeSide} ${positionSide})`);
      return res;
    } catch (e) {
      this.logger.error('❌ Order failed', e);
      this.sendMessage?.(`❌ Order failed: ${e.message}`);
      throw e;
    }
  }

  async cancelAllOrders() {
    try {
      const res = await this.request('POST', '/api/mix/v1/order/cancelAllOrders', {}, {
        symbol: this.config.symbol,
        marginCoin: this.config.marginCoin,
      });

      this.logger.info(`✅ All open orders canceled for ${this.config.symbol}`);
      this.sendMessage?.(`🧹 All open orders canceled for *${this.config.symbol}*`);
      return res;
    } catch (e) {
      this.logger.error('❌ Failed to cancel open orders', e);
      this.sendMessage?.(`❌ Failed to cancel open orders: ${e.message}`);
      throw e;
    }
  }

  async openMainTrade(side, qty) {
    const positionSide = side.toUpperCase() === 'BUY' ? 'long' : 'short';
    const success = await this.setLeverage(this.config.symbol, this.config.leverage, positionSide);
    if (!success) throw new Error('Leverage setup failed');
    return this.placeOrder(side, qty, 'open', positionSide);
  }

  async closeMainTrade(side, qty) {
    const positionSide = side.toUpperCase() === 'BUY' ? 'long' : 'short';
    return this.placeOrder(side, qty, 'close', positionSide);
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
