require('dotenv').config();
require('./telegram');
const { startBot } = require('./bot');

const express = require('express');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Basic health check route
app.get('/', (req, res) => {
  res.send('🟢 Grid bot is alive and running!');
});

// Start HTTP server (required by Render)
app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});

// Auto-start bot if configured
if (process.env.AUTO_START === 'true') {
  startBot();
}

console.log('🤖 Grid bot running. Use Telegram to control.');

// Cron job: ping Render app every 9 minutes
cron.schedule('*/9 * * * *', async () => {
  const url = process.env.SELF_URL || `https://binance-gridbot.onrender.com`;
  try {
    await axios.get(url);
    console.log(`🔁 Self-ping sent at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('❌ Self-ping failed:', err.message);
  }
});
