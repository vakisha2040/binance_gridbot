const Binance = require('binance-api-node').default;
const config = require('./config.json');

class BinanceClient {
  constructor(cfg = config, logger = console) {
    this.config = cfg;
    this.logger = logger;
    this.sendMessage = () => {};

    this.client = Binance({
      apiKey: cfg.apiKey || process.env.BINANCE_API_KEY,
      apiSecret: cfg.apiSecret || process.env.BINANCE_API_SECRET,
    });

    this.hedgeModeEnabled = false;
  }

  setSendMessage(fn) {
    this.sendMessage = fn;
  }

  // Enable hedge mode (dual position mode) for USDT-M futures
  async enableHedgeMode() {
    try {
      if (this.hedgeModeEnabled) {
        this.logger.info('Hedge mode already enabled.');
        return true;
      }
      // GET current mode
      const resGet = await this.client.futuresPositionMode();
      if (resGet.dualSidePosition) {
        this.hedgeModeEnabled = true;
        this.logger.info('Hedge mode already enabled (detected from API).');
        return true;
      }
      // SET dual mode ON
      const res = await this.client.futuresPositionModeChange({ dualSidePosition: true });
      if (res && res.code === 200) {
        this.hedgeModeEnabled = true;
        this.logger.info('Hedge mode enabled for account.');
        this.sendMessage?.('✅ Hedge mode enabled.');
        return true;
      }
      throw new Error(res.msg || 'Unknown error enabling hedge mode');
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
      const res = await this.client.futuresLeverage({
        symbol,
        leverage,
      });
      if (res && res.leverage == leverage) {
        this.logger.info(`Leverage set to ${leverage}x for ${symbol}`);
        this.sendMessage?.(`✅ Leverage set to ${leverage}x for ${symbol}`);
        return true;
      }
      throw new Error(res.msg || "Unknown error");
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

  // Open main trade (hedge mode: positionSide = LONG or SHORT)
  async openMainTrade(side, qty) {
    try {
      side = String(side).toUpperCase(); // normalize side
      this.validateSide(side);
      await this.enableHedgeMode();
      await this.setLeverage(this.config.symbol, this.config.leverage);

      // In hedge mode, use LONG for BUY, SHORT for SELL
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';

      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side,
        type: 'MARKET',
        quantity: qty,
        positionSide,
      });
      this.logger.info(`Main trade opened: ${side} ${qty} (${positionSide})`, order);
      this.sendMessage?.(`📈 Main trade opened: ${side} ${qty} (${positionSide})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to open main trade', e);
      this.sendMessage?.(`❌ Failed to open main trade: ${e.message}`);
      throw e;
    }
  }

  // Close main trade (hedge mode: positionSide = LONG or SHORT, opposite side)
  async closeMainTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();

      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      // Check position before closing
      const positions = await this.client.futuresPositionRisk({ symbol: this.config.symbol });
      const pos = positions.find(p => p.positionSide === positionSide);
      if (!pos || Number(pos.positionAmt) === 0) {
        this.logger.info(`No position to close on ${positionSide}`);
        this.sendMessage?.(`ℹ️ No ${positionSide} position to close.`);
        return null;
      }

      const closeQty = Math.min(Math.abs(Number(pos.positionAmt)), Number(qty));

      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: closeQty,
        positionSide,
       // reduceOnly: true,
      });
      this.logger.info(`Main trade closed: ${closeSide} ${closeQty} (${positionSide})`, order);
      this.sendMessage?.(`❌ Main trade closed: ${closeSide} ${closeQty} (${positionSide})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to close main trade', e);
      this.sendMessage?.(`❌ Failed to close main trade: ${e.message}`);
      throw e;
    }
  }

  // Open hedge trade (hedge mode: positionSide = LONG or SHORT)
  async openHedgeTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();
      await this.setLeverage(this.config.symbol, this.config.leverage);
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side,
        type: 'MARKET',
        quantity: qty,
        positionSide,
      });
      this.logger.info(`Hedge trade opened: ${side} ${qty} (${positionSide})`, order);
      this.sendMessage?.(`🛡️ Hedge trade opened: ${side} ${qty} (${positionSide})`);
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
      const result = await this.client.futuresCancelAllOpenOrders({ symbol });
      this.logger.info(`✅ All open orders canceled for ${symbol}`);
      this.sendMessage?.(`🧹 All open orders canceled for *${symbol}*`);
      return result;
    } catch (err) {
      this.logger.error(`❌ Failed to cancel open orders for ${symbol}:`, err);
      this.sendMessage?.(`❌ Failed to cancel open orders: ${err.message}`);
      throw err;
    }
  }
  // Close hedge trade (hedge mode: positionSide = LONG or SHORT, opposite side)
  async closeHedgeTrade(side, qty) {
    try {
      side = String(side).toUpperCase();
      this.validateSide(side);
      await this.enableHedgeMode();
      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      // Check position before closing
      const positions = await this.client.futuresPositionRisk({ symbol: this.config.symbol });
      const pos = positions.find(p => p.positionSide === positionSide);
      if (!pos || Number(pos.positionAmt) === 0) {
        this.logger.info(`No position to close on ${positionSide}`);
        this.sendMessage?.(`ℹ️ No ${positionSide} position to close.`);
        return null;
      }

      const closeQty = Math.min(Math.abs(Number(pos.positionAmt)), Number(qty));

      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: closeQty,
        positionSide,
       // reduceOnly: true,
      });
      this.logger.info(`Hedge trade closed: ${closeSide} ${closeQty} (${positionSide})`, order);
      this.sendMessage?.(`❌ Hedge trade closed: ${closeSide} ${closeQty} (${positionSide})`);
      return order;
    } catch (e) {
      this.logger.error('Failed to close hedge trade', e);
      this.sendMessage?.(`❌ Failed to close hedge trade: ${e.message}`);
      throw e;
    }
  }
}

const binanceClient = new BinanceClient();

module.exports = binanceClient;
