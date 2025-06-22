const { EMA, RSI, MACD, BollingerBands } = require('technicalindicators');
const tulind = require('tulind');
const priceFeed = require('./priceFeed');

module.exports = {
  TIMEFRAMES: {
    SHORT: '15m',
    MEDIUM: '1h',
    LONG: '4h'
  },

  // No longer needs exchange parameter since we're using priceFeed
  async getMultiTimeframeAnalysis() {
    try {
      const [shortCloses, mediumCloses, longCloses] = await Promise.all([
        priceFeed.getCloses(this.TIMEFRAMES.SHORT),
        priceFeed.getCloses(this.TIMEFRAMES.MEDIUM),
        priceFeed.getCloses(this.TIMEFRAMES.LONG)
      ]);

      return {
        short: {
          candles: priceFeed.getCandles(this.TIMEFRAMES.SHORT),
          ema21: this.calculateEMA(shortCloses, 21),
          rsi: this.calculateRSI(shortCloses),
          macd: this.calculateMACD(shortCloses),
          bbands: this.calculateBBands(shortCloses)
        },
        medium: {
          candles: priceFeed.getCandles(this.TIMEFRAMES.MEDIUM),
          ema50: this.calculateEMA(mediumCloses, 50),
          macd: this.calculateMACD(mediumCloses)
        },
        long: {
          candles: priceFeed.getCandles(this.TIMEFRAMES.LONG),
          ema200: this.calculateEMA(longCloses, 200)
        }
      };
    } catch (err) {
      console.error('Analysis error:', err);
      throw err;
    }
  },

  // Indicator calculation methods remain the same
  calculateEMA(prices, period) {
    if (!prices || prices.length < period) {
      throw new Error(`Insufficient data for EMA ${period}`);
    }
    return EMA.calculate({ period, values: prices });
  },

  calculateRSI(prices, period = 14) {
    if (!prices || prices.length < period) {
      throw new Error(`Insufficient data for RSI ${period}`);
    }
    return RSI.calculate({ values: prices, period });
  },

  calculateMACD(prices) {
    if (!prices || prices.length < 26) {
      throw new Error('Insufficient data for MACD (need 26 periods)');
    }
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
    if (!prices || prices.length < period) {
      throw new Error(`Insufficient data for BBands ${period}`);
    }
    return BollingerBands.calculate({
      values: prices,
      period,
      stdDev
    });
  },

  // Enhanced trend detection with error handling
  getTrendDirection(analysis) {
    try {
      if (!analysis) throw new Error('No analysis data provided');
      
      // Score trend strength
      let score = 0;
      
      // Short-term indicators
      const lastShort = {
        price: analysis.short.candles.slice(-1)[0].close,
        ema: analysis.short.ema21.slice(-1)[0],
        rsi: analysis.short.rsi.slice(-1)[0],
        macd: analysis.short.macd.slice(-1)[0]?.histogram || 0,
        bbUpper: analysis.short.bbands.slice(-1)[0]?.upper || 0,
        bbLower: analysis.short.bbands.slice(-1)[0]?.lower || 0
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
    } catch (err) {
      console.error('Trend detection error:', err);
      return 'neutral'; // Fallback to neutral on error
    }
  },

  // New helper method to get all indicator values at once
  async getIndicatorSnapshot() {
    const analysis = await this.getMultiTimeframeAnalysis();
    const trend = this.getTrendDirection(analysis);
    
    return {
      trend,
      indicators: {
        short: {
          ema21: analysis.short.ema21.slice(-1)[0],
          rsi: analysis.short.rsi.slice(-1)[0],
          macd: analysis.short.macd.slice(-1)[0],
          bbands: analysis.short.bbands.slice(-1)[0]
        },
        price: analysis.short.candles.slice(-1)[0].close
      },
      time: Date.now()
    };
  }
};
