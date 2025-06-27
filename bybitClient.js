require('dotenv').config();
const { RestClientV5 } = require('bybit-api');
const config = require('./config.json');

class BybitClient {
  constructor(cfg = config, logger = console) {
    this.config = cfg;
    this.logger = logger;
    this.sendMessage = () => {};

    // Corrected: new RestClientV5, not RestClient!
    this.client = new RestClientV5({
      key: cfg.apiKey || process.env.BYBIT_API_KEY,
      secret: cfg.apiSecret || process.env.BYBIT_API_SECRET,
      testnet: !!cfg.testnet,
    });

    this.hedgeModeEnabled = false;
  }

  setSendMessage(fn) {
    this.sendMessage = fn;
  }

  // Enable hedge mode (dual position mode) for USDT Perpetual
  async enableHedgeMode() {
    try {
      if (this.hedgeModeEnabled) {
        this.logger.info('Hedge mode already enabled.');
        return true;
      }
      // Get current mode
      const resGet = await this.client.getPositionMode({ category: 'linear' });
      if (resGet && resGet.result && resGet.result.unifiedMode === 0) {
        // 0 = Hedge mode, 3 = One-way mode (see Bybit docs)
        this.hedgeModeEnabled = true;
        this.logger.info('Hedge mode already enabled (detected from API).');
        return true;
      }
      // Set hedge mode ON
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

  // Set leverage for a symbol
  async setLeverage(symbol, leverage) {
    try {
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

  // -- Utility method to validate order side --
  validateSide(side) {
    const validSides = ['BUY', 'SELL'];
    if (!validSides.includes(side)) {
      throw new Error(`Invalid side: "${side}". Must be "BUY" or "SELL".`);
    }
  }

  // Open main trade (hedge mode: positionIdx = 1 for LONG, 2 for SHORT)
  async openMainTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();
      await this.setLeverage(this.config.symbol, this.config.leverage);

      // In hedge mode, use positionIdx: 1 for LONG (BUY), 2 for SHORT (SELL)
      const positionIdx = side === 'BUY' ? 1 : 2;

      const order = await this.client.submitOrder({
        category: 'linear',
        symbol: this.config.symbol,
        side,
        orderType: 'Market',
        qty,
        positionIdx,
        reduceOnly: false,
      });
      this.logger.info(`Main trade opened: ${side} ${qty} (positionIdx: ${positionIdx})`, order);
      this.sendMessage?.(`📈 Main trade opened: ${side} ${qty} (positionIdx: ${positionIdx})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to open main trade', e);
      this.sendMessage?.(`❌ Failed to open main trade: ${e.message}`);
      throw e;
    }
  }

  // Close main trade (hedge mode: positionIdx = 1 for LONG, 2 for SHORT, opposite side)
  async closeMainTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();

      const positionIdx = side === 'BUY' ? 1 : 2;
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      // Get position before closing
      const positions = await this.client.getPositions({ category: 'linear', symbol: this.config.symbol });
      const pos = positions.result.list.find(p => Number(p.positionIdx) === positionIdx);
      if (!pos || Number(pos.size) === 0) {
        this.logger.info(`No position to close on positionIdx ${positionIdx}`);
        this.sendMessage?.(`ℹ️ No position to close (${positionIdx === 1 ? 'LONG' : 'SHORT'}).`);
        return null;
      }

      const closeQty = Math.min(Math.abs(Number(pos.size)), Number(qty));

      const order = await this.client.submitOrder({
        category: 'linear',
        symbol: this.config.symbol,
        side: closeSide,
        orderType: 'Market',
        qty: closeQty,
        positionIdx,
        reduceOnly: true,
      });
      this.logger.info(`Main trade closed: ${closeSide} ${closeQty} (positionIdx: ${positionIdx})`, order);
      this.sendMessage?.(`❌ Main trade closed: ${closeSide} ${closeQty} (positionIdx: ${positionIdx})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to close main trade', e);
      this.sendMessage?.(`❌ Failed to close main trade: ${e.message}`);
      throw e;
    }
  }

  // Open hedge trade (hedge mode: positionIdx = 1 for LONG, 2 for SHORT)
  async openHedgeTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();
      await this.setLeverage(this.config.symbol, this.config.leverage);
      const positionIdx = side === 'BUY' ? 1 : 2;
      const order = await this.client.submitOrder({
        category: 'linear',
        symbol: this.config.symbol,
        side,
        orderType: 'Market',
        qty,
        positionIdx,
        reduceOnly: false,
      });
      this.logger.info(`Hedge trade opened: ${side} ${qty} (positionIdx: ${positionIdx})`, order);
      this.sendMessage?.(`🛡️ Hedge trade opened: ${side} ${qty} (positionIdx: ${positionIdx})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to open hedge trade', e);
      this.sendMessage?.(`❌ Failed to open hedge trade: ${e.message}`);
      throw e;
    }
  }

  // Cancel all open orders for the configured symbol
  async cancelAllOrders(symbol = this.config.symbol) {
    try {
      const result = await this.client.cancelAllOrders({ category: 'linear', symbol });
      this.logger.info(`✅ All open orders canceled for ${symbol}`);
      this.sendMessage?.(`🧹 All open orders canceled for *${symbol}*`);
      return result;
    } catch (err) {
      this.logger.error(`❌ Failed to cancel open orders for ${symbol}:`, err);
      this.sendMessage?.(`❌ Failed to cancel open orders: ${err.message}`);
      throw err;
    }
  }

  // Close hedge trade (hedge mode: positionIdx = 1 for LONG, 2 for SHORT, opposite side)
  async closeHedgeTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();
      const positionIdx = side === 'BUY' ? 1 : 2;
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      // Get position before closing
      const positions = await this.client.getPositions({ category: 'linear', symbol: this.config.symbol });
      const pos = positions.result.list.find(p => Number(p.positionIdx) === positionIdx);
      if (!pos || Number(pos.size) === 0) {
        this.logger.info(`No position to close on positionIdx ${positionIdx}`);
        this.sendMessage?.(`ℹ️ No position to close (${positionIdx === 1 ? 'LONG' : 'SHORT'}).`);
        return null;
      }

      const closeQty = Math.min(Math.abs(Number(pos.size)), Number(qty));

      const order = await this.client.submitOrder({
        category: 'linear',
        symbol: this.config.symbol,
        side: closeSide,
        orderType: 'Market',
        qty: closeQty,
        positionIdx,
        reduceOnly: true,
      });
      this.logger.info(`Hedge trade closed: ${closeSide} ${closeQty} (positionIdx: ${positionIdx})`, order);
      this.sendMessage?.(`❌ Hedge trade closed: ${closeSide} ${closeQty} (positionIdx: ${positionIdx})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to close hedge trade', e);
      this.sendMessage?.(`❌ Failed to close hedge trade: ${e.message}`);
      throw e;
    }
  }
}

const bybitClient = new BybitClient();

module.exports = bybitClient;
