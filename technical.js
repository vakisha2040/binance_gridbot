//npm install ccxt technicalindicators tulind

const { EMA, RSI, MACD, BollingerBands } = require('technicalindicators');
const tulind = require('tulind');

module.exports = {
  TIMEFRAMES: {
    SHORT: '15m',
    MEDIUM: '1h',
    LONG: '4h'
  },

  async getHistoricalData(exchange, symbol, timeframe, limit) {
    try {
      const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      return candles.map(c => ({
        time: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5]
      }));
    } catch (err) {
      console.error('Error fetching historical data:', err);
      return [];
    }
  },

  calculateEMA(prices, period) {
    return EMA.calculate({ period, values: prices });
  },

  calculateRSI(prices, period = 14) {
    return RSI.calculate({ values: prices, period });
  },

  calculateMACD(prices) {
    return MACD.calculate({
      values: prices,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
  },

  calculateBBands(prices, period = 20, stdDev = 2) {
    return BollingerBands.calculate({
      values: prices,
      period,
      stdDev
    });
  },

  async getMultiTimeframeAnalysis(exchange, symbol) {
    const [short, medium, long] = await Promise.all([
      this.getHistoricalData(exchange, symbol, this.TIMEFRAMES.SHORT, 100),
      this.getHistoricalData(exchange, symbol, this.TIMEFRAMES.MEDIUM, 100),
      this.getHistoricalData(exchange, symbol, this.TIMEFRAMES.LONG, 100)
    ]);

    const closes = tf => tf.map(c => c.close);
    
    return {
      short: {
        candles: short,
        ema21: this.calculateEMA(closes(short), 21),
        rsi: this.calculateRSI(closes(short)),
        macd: this.calculateMACD(closes(short)),
        bbands: this.calculateBBands(closes(short))
      },
      medium: {
        candles: medium,
        ema50: this.calculateEMA(closes(medium), 50),
        macd: this.calculateMACD(closes(medium))
      },
      long: {
        candles: long,
        ema200: this.calculateEMA(closes(long), 200)
      }
    };
  },

  getTrendDirection(analysis) {
    // Score trend strength
    let score = 0;
    
    // Short-term indicators
    const lastShort = {
      price: analysis.short.candles.slice(-1)[0].close,
      ema: analysis.short.ema21.slice(-1)[0],
      rsi: analysis.short.rsi.slice(-1)[0],
      macd: analysis.short.macd.slice(-1)[0].histogram,
      bbUpper: analysis.short.bbands.slice(-1)[0].upper,
      bbLower: analysis.short.bbands.slice(-1)[0].lower
    };

    // Medium-term
    const lastMedium = {
      price: analysis.medium.candles.slice(-1)[0].close,
      ema: analysis.medium.ema50.slice(-1)[0]
    };

    // Long-term
    const lastLong = {
      price: analysis.long.candles.slice(-1)[0].close,
      ema: analysis.long.ema200.slice(-1)[0]
    };

    // Scoring
    if (lastShort.price > lastShort.ema) score += 1;
    if (lastMedium.price > lastMedium.ema) score += 1;
    if (lastLong.price > lastLong.ema) score += 0.5;
    
    if (lastShort.macd > 0) score += 0.5;
    if (lastShort.rsi > 50) score += 0.3;
    
    // Final determination
    if (score >= 2.5) return 'strong-bullish';
    if (score >= 1.8) return 'bullish';
    if (score <= -2.5) return 'strong-bearish';
    if (score <= -1.8) return 'bearish';
    return 'neutral';
  }
};
