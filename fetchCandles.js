const axios = require('axios');

async function fetchCandles(symbol = 'BTCUSDT', interval = '5m', limit = 50) {
  const res = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol, interval, limit }
  });
  return res.data.map(c => ({
    open: +c[1],
    high: +c[2],
    low: +c[3],
    close: +c[4],
    volume: +c[5],
  }));
}

module.exports = { fetchCandles };
