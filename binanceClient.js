require('dotenv').config();
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
      futures: true // Enable futures API
    });

    this.hedgeModeEnabled = false;
    this.leverageSet = false;
  }

  setSendMessage(fn) {
    this.sendMessage = fn;
  }

  // ================ CORE TRADING METHODS ================ //

  /**
   * Enable hedge mode and set leverage if not already done
   */
  async initializeAccount() {
    try {
      await this._verifyHedgeMode();
      await this._verifyLeverage();
      return true;
    } catch (e) {
      this.logger.error('Account initialization failed', e);
      this.sendMessage?.(`❌ Account initialization failed: ${e.message}`);
      throw e;
    }
  }

  async openMainTrade(side, qty) {
    try {
      side = this._validateSide(side);
      await this.initializeAccount();

      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side,
        type: 'MARKET',
        quantity: this._formatQuantity(qty),
        positionSide
      });

      this.logger.info(`Main ${positionSide} opened: ${side} ${qty}`);
      this.sendMessage?.(`📈 Main ${positionSide} opened: ${side} ${qty} @ ${order.avgPrice || 'market'}`);
      return order;
    } catch (e) {
      this._handleOrderError('open main trade', e);
      throw e;
    }
  }

  async closeMainTrade(side, qty) {
    try {
      side = this._validateSide(side);
      await this.initializeAccount();

      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      const position = await this._getPosition(positionSide);
      if (!position) return null;

      const closeQty = Math.min(position.quantity, qty);
      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: this._formatQuantity(closeQty),
        positionSide,
        reduceOnly: true
      });

      this.logger.info(`Main ${positionSide} closed: ${closeSide} ${closeQty}`);
      this.sendMessage?.(`✅ Main ${positionSide} closed: ${closeSide} ${closeQty} @ ${order.avgPrice || 'market'}`);
      return order;
    } catch (e) {
      this._handleOrderError('close main trade', e);
      throw e;
    }
  }

  async openHedgeTrade(side, qty) {
    try {
      side = this._validateSide(side);
      await this.initializeAccount();

      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side,
        type: 'MARKET',
        quantity: this._formatQuantity(qty),
        positionSide
      });

      this.logger.info(`Hedge ${positionSide} opened: ${side} ${qty}`);
      this.sendMessage?.(`🛡️ Hedge ${positionSide} opened: ${side} ${qty} @ ${order.avgPrice || 'market'}`);
      return order;
    } catch (e) {
      this._handleOrderError('open hedge trade', e);
      throw e;
    }
  }

  async closeHedgeTrade(side, qty) {
    try {
      side = this._validateSide(side);
      await this.initializeAccount();

      const positionSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

      const position = await this._getPosition(positionSide);
      if (!position) return null;

      const closeQty = Math.min(position.quantity, qty);
      const order = await this.client.futuresOrder({
        symbol: this.config.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: this._formatQuantity(closeQty),
        positionSide,
        reduceOnly: true
      });

      this.logger.info(`Hedge ${positionSide} closed: ${closeSide} ${closeQty}`);
      this.sendMessage?.(`❌ Hedge ${positionSide} closed: ${closeSide} ${closeQty} @ ${order.avgPrice || 'market'}`);
      return order;
    } catch (e) {
      this._handleOrderError('close hedge trade', e);
      throw e;
    }
  }

  // ================ UTILITY METHODS ================ //

  async cancelAllOrders(symbol = this.config.symbol) {
    try {
      await this.client.futuresCancelAllOpenOrders({ symbol });
      this.logger.info(`All orders canceled for ${symbol}`);
      this.sendMessage?.(`🧹 All orders canceled for ${symbol}`);
      return true;
    } catch (e) {
      this.logger.error('Failed to cancel orders', e);
      this.sendMessage?.(`❌ Failed to cancel orders: ${e.message}`);
      throw e;
    }
  }

  async getPositionInfo(positionSide) {
    try {
      const positions = await this.client.futuresPositionRisk();
      const pos = positions.find(p => 
        p.symbol === this.config.symbol && 
        p.positionSide === positionSide
      );
      
      if (!pos || Number(pos.positionAmt) === 0) return null;
      
      return {
        side: pos.positionSide,
        quantity: Math.abs(Number(pos.positionAmt)),
        entryPrice: Number(pos.entryPrice),
        leverage: Number(pos.leverage),
        pnl: Number(pos.unRealizedProfit)
      };
    } catch (e) {
      this.logger.error('Failed to get position info', e);
      throw e;
    }
  }

  async getCurrentPrice() {
    try {
      const ticker = await this.client.futuresPrices({ symbol: this.config.symbol });
      return Number(ticker[this.config.symbol]);
    } catch (e) {
      this.logger.error('Failed to get current price', e);
      throw e;
    }
  }

  // ================ PRIVATE METHODS ================ //

  async _verifyHedgeMode() {
    if (this.hedgeModeEnabled) return true;
    
    const mode = await this.client.futuresPositionMode();
    if (mode.dualSidePosition) {
      this.hedgeModeEnabled = true;
      return true;
    }

    await this.client.futuresPositionModeChange({ dualSidePosition: true });
    this.hedgeModeEnabled = true;
    this.logger.info('Hedge mode enabled');
    return true;
  }

  async _verifyLeverage() {
    if (this.leverageSet) return true;
    
    await this.client.futuresLeverage({
      symbol: this.config.symbol,
      leverage: this.config.leverage || 10
    });
    
    this.leverageSet = true;
    this.logger.info(`Leverage set to ${this.config.leverage}x`);
    return true;
  }

  async _getPosition(positionSide) {
    const position = await this.getPositionInfo(positionSide);
    if (!position) {
      this.logger.info(`No ${positionSide} position found`);
      this.sendMessage?.(`ℹ️ No ${positionSide} position found`);
      return null;
    }
    return position;
  }

  _validateSide(side) {
    side = String(side).toUpperCase();
    if (!['BUY', 'SELL'].includes(side)) {
      throw new Error(`Invalid side: ${side}. Must be BUY or SELL`);
    }
    return side;
  }

  _formatQuantity(qty) {
    // Adjust quantity based on symbol precision if needed
    return Number(qty).toFixed(this.config.quantityPrecision || 3);
  }

  _handleOrderError(context, error) {
    this.logger.error(`Failed to ${context}`, error);
    this.sendMessage?.(`❌ Failed to ${context}: ${error.message}`);
    
    // Handle specific Binance error codes
    if (error.code === -2021) {
      this.sendMessage?.('⚠️ Order would immediately trigger - adjust parameters');
    }
  }
}

module.exports = new BinanceClient();
