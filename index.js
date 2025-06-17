require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const axios = require('axios');

const { bot, webhookPath } = require('./telegram');
const { startBot } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// handles redis ping connection
/*
const options = {
  redis: "redis://red-d18nfa15pdvs73cnk6mg:6379",
};
const renderQueue = new Queue('render', options);
app.get('/healthz', async (req, res) => {
  try {
    const redisStatus = await renderQueue.checkHealth();
    if (redisStatus) {
      return res.sendStatus(200).json({ message: 'Redis connection running' });
    } else {
      return res.status(500).json({ message: 'Redis connection failed' });
    }
  } catch (err) {
    console.error('Health check failed:', err);
    return res.status(500).json({ message: 'Redis health check failed', error: err.message });
  }
})
*/

// 🧠 Important: Handle Telegram webhook updates
app.post(webhookPath, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.send('🟢 Grid bot is alive and running!');
});

// Start server
app.listen(PORT, () => {
  console.log(`🌐 Server listening on port ${PORT}`);
});

// Optional: auto-start bot
if (process.env.AUTO_START === 'true') {
  startBot();
}

// Self-ping to keep Render alive
cron.schedule('*/9 * * * *', async () => {
  const url = process.env.SELF_URL || `https://binance-gridbot.onrender.com`;
  try {
    await axios.get(url);
    console.log(`🔁 Self-ping sent at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('❌ Self-ping failed:', err.message);
  }
});
