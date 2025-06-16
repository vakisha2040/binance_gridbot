require('dotenv').config();
require('./telegram');
const { startBot } = require('./bot');

if (process.env.AUTO_START === 'true') {
  startBot();
}

console.log('Grid bot running. Use Telegram to control.');
