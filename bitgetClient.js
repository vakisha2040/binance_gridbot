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

  async setLeverage(symbol, leverage, holdSide = 'long') {
    try {
      const res = await this.request('POST', '/api/mix/v1/account/setLeverage', {}, {
        symbol,
        marginCoin: this.config.marginCoin,
        marginMode: this.config.marginMode || 'crossed',
        leverage: String(leverage),
      });

      const label = (this.config.marginMode || 'crossed').toLowerCase();
      this.logger.info(`✅ Leverage set to ${leverage}x (${label}) for ${symbol} (${holdSide})`);
      this.sendMessage?.(`✅ Leverage set to ${leverage}x (${label}) for ${symbol} (${holdSide})`);
      return true;
    } catch (e) {
      this.logger.error('❌ Failed to set leverage', e);
      this.sendMessage?.(`❌ Failed to set leverage: ${e.message}`);
      return false;
    }
  }

  async placeOrder(_ignoredSide, qty, tradeSide = 'open', positionSide = 'long') {
    try {
      let side;
      if (tradeSide === 'open') {
        side = positionSide === 'long' ? 'buy' : 'sell';
      } else if (tradeSide === 'close') {
        side = positionSide === 'long' ? 'sell' : 'buy';
      } else {
        throw new Error(`Invalid tradeSide: ${tradeSide}`);
      }

      const res = await this.request('POST', '/api/mix/v1/order/placeOrder', {}, {
        symbol: this.config.symbol,
        marginCoin: this.config.marginCoin,
        marginMode: this.config.marginMode || 'crossed',
        size: String(qty),
        side,
        tradeSide,
        orderType: 'market',
        force: 'gtc',
      });

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
      const res = await this.request('POST', '/api/mix/v1/order/cancel-all-orders', {}, {
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

  async openMainTrade(direction, qty) {
    const positionSide = direction.toUpperCase() === 'BUY' ? 'long' : 'short';
    const success = await this.setLeverage(this.config.symbol, this.config.leverage, positionSide);
    if (!success) throw new Error('Leverage setup failed');
    return this.placeOrder('', qty, 'open', positionSide);
  }

  async closeMainTrade(direction, qty) {
    const positionSide = direction.toUpperCase() === 'BUY' ? 'long' : 'short';
    return this.placeOrder('', qty, 'close', positionSide);
  }

  async openHedgeTrade(direction, qty) {
    return this.openMainTrade(direction, qty);
  }

  async closeHedgeTrade(direction, qty) {
    return this.closeMainTrade(direction, qty);
  }
}

const bitgetClient = new BitgetClient();
module.exports = bitgetClient;
