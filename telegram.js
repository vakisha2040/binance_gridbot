const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const config = require('../config/config.json');
const { startBot, stopBot, setSendMessage, manualCloseMainTrade, resetBotState } = require('../core/bot');
const state = require('../core/state');
const CONFIG_PATH = './config/config.json';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const ADMIN_ID = "6822395868";

// Utility: check if user is admin
function isAdmin(obj) {
  if (obj?.id?.toString() === ADMIN_ID) return true;
  if (obj?.from?.id?.toString() === ADMIN_ID) return true;
  if (obj?.message?.from?.id?.toString() === ADMIN_ID) return true;
  return false;
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
          { text: '🛑 Stop Main Trade', callback_data: 'stop_main_trade' },
          { text: '♻️ Reset Bot', callback_data: 'reset_bot' }
        ],
        [
          { text: '📄 View Config', callback_data: 'view_config' },
          { text: '✏️ Update Config', callback_data: 'update_config' }
        ],
        [
          { text: '📊 Trade Status', callback_data: 'trade_status' }
        ]
      ]
    }
  };
}

// Inject message sending function into core bot
function sendMessage(msg) {
  bot.sendMessage(ADMIN_ID, msg);
}
setSendMessage(sendMessage);

// Start command or menu
bot.onText(/\/(start|menu)/, (msg) => {
  bot.sendMessage(msg.chat.id, '⚙️ Grid Bot Control Panel', getInlineKeyboard());
});

// Answer safe to prevent query timeout issues
async function safeAnswerCallbackQuery(id, opts = {}) {
  try {
    await bot.answerCallbackQuery(id, opts);
  } catch (err) {
    if (
      err.response?.statusCode === 400 &&
      err.response.body?.description?.match(/query.*(expired|timeout|invalid)/i)
    ) {
      console.warn(`Telegram callback warning: ${err.response.body.description}`);
    } else {
      console.error('Telegram callback error:', err);
    }
  }
}

// Main handler for Telegram buttons
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (!isAdmin(query.from)) {
    await safeAnswerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '❌ You are not authorized to perform this action.');
  }

  switch (action) {
    case 'start_bot':
      await safeAnswerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '✅ Starting bot...');
      await startBot(config);
      break;

    case 'stop_bot':
      await safeAnswerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '🛑 Stopping bot...');
      await stopBot();
      break;

    case 'stop_main_trade':
      await safeAnswerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '🛑 Closing main trade...');
      await manualCloseMainTrade();
      await bot.sendMessage(chatId, '✅ Main trade closed.');
      break;

    case 'reset_bot':
      await safeAnswerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '♻️ Resetting bot state...');
      await resetBotState();
      await bot.sendMessage(chatId, '✅ Bot state reset. Use ▶️ Start to resume.');
      break;

    case 'view_config':
      await safeAnswerCallbackQuery(query.id);
      const cfg = fs.readFileSync(CONFIG_PATH, 'utf8');
      await bot.sendMessage(chatId, `📄 Current Config:\n\n<pre>${cfg}</pre>`, { parse_mode: 'HTML' });
      break;

    case 'update_config':
      await safeAnswerCallbackQuery(query.id);
      await bot.sendMessage(chatId, '✏️ Send the new config JSON to update:');

      const messageHandler = (newMsg) => {
        if (!isAdmin(newMsg) || newMsg.chat.id !== chatId) return;

        try {
          const newCfg = JSON.parse(newMsg.text);
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(newCfg, null, 2));
          bot.sendMessage(chatId, '✅ Config updated.');
        } catch (err) {
          bot.sendMessage(chatId, '❌ Invalid JSON format. Update failed.');
        }

        bot.removeListener('message', messageHandler);
      };

      bot.on('message', messageHandler);
      break;

    case 'trade_status':
      await safeAnswerCallbackQuery(query.id);
      const status = getTradeStatusMessage();
      await bot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
      break;
  }
});

// Generate trade status summary
function getTradeStatusMessage() {
  const main = state.getMainTrade();
  const hedge = state.getHedgeTrade();
  let msg = "*Active Trades:*\n";
  if (main) {
    msg += `\n*Main Trade*\nSide: ${main.side}\nEntry: ${main.entry}\nGrid Level: ${main.level}\n`;
  }
  if (hedge) {
    msg += `\n*Hedge Trade*\nSide: ${hedge.side}\nEntry: ${hedge.entry}\nGrid Level: ${hedge.level}\n`;
  }
  if (!main && !hedge) {
    msg += "_No active trades._";
  }
  return msg;
}

module.exports = {
  sendMessage,
  bot
};
