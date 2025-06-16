// index.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { bot, webhookPath } = require('./telegram');
const { startBot } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

// Parse Telegram JSON
app.use(express.json());

// Telegram webhook handler
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.send('🟢 Grid bot running via webhook!');
});

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});

// Optional: Start bot automatically on launch
if (process.env.AUTO_START === 'true') {
  startBot();
}

// Self-ping cron
cron.schedule('*/9 * * * *', async () => {
  const url = process.env.SELF_URL || `https://your-app-url.com`;
  try {
    await axios.get(url);
    console.log(`🔁 Self-ping at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('❌ Self-ping failed:', err.message);
  }
});
