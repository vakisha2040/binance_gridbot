require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const config = require('./config.json');
const { startBot, stopBot, setSendMessage, manualCloseMainTrade, manualBuyMainTrade, manualSellMainTrade, manualCloseHedgeTrade, resetBot } = require('./bot');
const state = require('./state');

const app = express();
const token = process.env.TELEGRAM_TOKEN;
const WEBHOOK_URL = "https://bybit-gridbot.onrender.com";
// e.g., https://yourdomain.com or https://abc123.ngrok.io
const ADMIN_ID = "6822395868";
const CONFIG_PATH = path.resolve(__dirname, './config.json');

// Setup Telegram bot with no polling
const bot = new TelegramBot(token);
bot.setWebHook(`${WEBHOOK_URL}/bot`);

// Inject sendMessage into core/bot.js
function sendMessage(msg) {
  bot.sendMessage(ADMIN_ID, msg);
}
setSendMessage(sendMessage);

// Middleware for Telegram webhook
app.use(bodyParser.json());
app.post('/bot', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Admin check
function isAdmin(obj) {
  const id = obj?.id || obj?.from?.id || obj?.message?.from?.id;
  return id && id.toString() === ADMIN_ID;
}

// UI buttons
function getInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '▶️ Start', callback_data: 'start_bot' },
          { text: '⏹ Stop', callback_data: 'stop_bot' }
        ],
        [
         { text: '📊 Trade Status', callback_data: 'trade_status' },
          { text: '♻️ Reset Bot', callback_data: 'reset_bot'
          }
        ],
        [
          { text: '📄 View Config', callback_data: 'view_config' },
          { text: '✏️ Update Config', callback_data: 'update_config' }
        ],
        
        [
          { text: '🛑 Stop Main Trade', callback_data: 'stop_main_trade' },
          { text: '🛑 Stop Hedge Trade', callback_data: 'stop_hedge_trade' }
        ],
         [
         { text: '🟢 🔼  Buy', callback_data: 'buy_main_trade' },
          { text: '🔴🔻 Sell', callback_data: 'sell_main_trade' }
        ]
        
        
      ]
    }
  };
}

// Respond to /start or /menu
bot.onText(/\/(start|menu)/, (msg) => {
  if (!isAdmin(msg)) return;
  bot.sendMessage(msg.chat.id, '⚙️ Grid Bot Control Panel', getInlineKeyboard());
});

// Callback buttons
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  const respond = (text) => bot.sendMessage(chatId, text);
  const safeAnswer = () => bot.answerCallbackQuery(query.id).catch(() => {});

  if (!isAdmin(query.from)) {
    await safeAnswer();
    return respond('❌ Unauthorized.');
  }

  await safeAnswer();

  switch (action) {
    case 'start_bot':
      respond('✅ Starting bot...');
      startBot(config);
      break;

    case 'stop_bot':
      respond('🛑 Stopping bot...');
      stopBot();
      break;

    case 'stop_main_trade':
      respond('🛑 Closing main trade...');
      await manualCloseMainTrade();
      respond('✅ Main trade closed.');
      break;

    case 'buy_main_trade':
      respond('🔼  Buy main trade...');
      await manualBuyMainTrade();
      break;
      
      case 'sell_main_trade':
      respond('🔻 Sell main trade...');
      await manualSellMainTrade();
      break;


    case 'stop_hedge_trade':
      respond('🛑 Closing hedge trade...');
      await manualCloseHedgeTrade();
      respond('✅  Hedgetrade closed.');
     break;


    case 'reset_bot':
      respond('♻️ Resetting bot (canceling orders)...');
      await resetBot();
      respond('✅ Bot reset complete.');
      break;

    case 'view_config':
      const cfg = fs.readFileSync(CONFIG_PATH, 'utf8');
      bot.sendMessage(chatId, `📄 Current Config:\n\n<pre>${cfg}</pre>`, { parse_mode: 'HTML' });
      break;

    case 'update_config':
      respond('✏️ Send the new config JSON to update:');
      const messageHandler = (newMsg) => {
        if (!isAdmin(newMsg) || newMsg.chat.id !== chatId) return;
        try {
          const newCfg = JSON.parse(newMsg.text);
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(newCfg, null, 2));
          respond('✅ Config updated.');
        } catch {
          respond('❌ Invalid JSON format.');
        }
        bot.removeListener('message', messageHandler);
      };
      bot.on('message', messageHandler);
      break;

    case 'trade_status':
      const status = getTradeStatusMessage();
      bot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
      break;
  }
});

// Status message builder
function getTradeStatusMessage() {
  const main = state.getMainTrade();
  const hedge = state.getHedgeTrade();
  let msg = "*Active Trades:*\n";
  if (main) {
    msg += `\n*Main*\nSide: ${main.side}\nEntry: ${main.entry}\nGrid Level: ${main.level}\n`;
  }
  if (hedge) {
    msg += `\n*Hedge*\nSide: ${hedge.side}\nEntry: ${hedge.entry}\nGrid Level: ${hedge.level}\n`;
  }
  if (!main && !hedge) {
    msg += "_No active trades._";
  }
  return msg;
}
const webhookPath = '/bot';
module.exports = { bot, sendMessage, webhookPath };
