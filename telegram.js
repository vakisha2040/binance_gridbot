const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const config = require('./config.json');
const { startBot, stopBot, setSendMessage, manualCloseMainTrade } = require('./bot');
const state = require('./state');
const CONFIG_PATH = './config.json';

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const ADMIN_ID = "6822395868";

function isAdmin(obj) {
  if (obj && obj.id && obj.id.toString() === ADMIN_ID) return true;
  if (obj && obj.from && obj.from.id && obj.from.id.toString() === ADMIN_ID) return true;
  if (obj && obj.message && obj.message.from && obj.message.from.id.toString() === ADMIN_ID) return true;
  return false;
}

function getInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '▶️ Start', callback_data: 'start_bot' },
          { text: '⏹ Stop', callback_data: 'stop_bot' }
        ],
        [
          { text: '🛑 Stop Main Trade', callback_data: 'stop_main_trade' }
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

function sendMessage(msg) {
  bot.sendMessage(ADMIN_ID, msg);
}

// Inject sendMessage into core/bot.js (dependency injection)
setSendMessage(sendMessage);

bot.onText(/\/(start|menu)/, (msg) => {
  bot.sendMessage(msg.chat.id, '⚙️ Grid Bot Control Panel', getInlineKeyboard());
});

// Safe wrapper for answering callback queries
async function safeAnswerCallbackQuery(id, opts = {}) {
  try {
    await bot.answerCallbackQuery(id, opts);
  } catch (err) {
    if (
      err.response &&
      err.response.statusCode === 400 &&
      err.response.body &&
      (
        err.response.body.description?.includes('query is too old') ||
        err.response.body.description?.includes('response timeout expired') ||
        err.response.body.description?.includes('query ID is invalid')
      )
    ) {
      // Expected Telegram behavior, ignore
      console.warn(`Telegram callbackQuery warning: ${err.response.body.description}`);
    } else {
      console.error('Telegram callbackQuery error:', err);
    }
  }
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (!isAdmin(query.from)) {
    await safeAnswerCallbackQuery(query.id);
    return bot.sendMessage(chatId, '❌ You are not authorized to perform this action.');
  }

  if (action === 'start_bot') {
    await safeAnswerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '✅ Starting bot...');
    await startBot(config);
  }

  if (action === 'stop_bot') {
    await safeAnswerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '🛑 Stopping bot...');
    await stopBot();
  }

  if (action === 'stop_main_trade') {
    await safeAnswerCallbackQuery(query.id);
    await bot.sendMessage(chatId, '🛑 Closing main trade...');
    await manualCloseMainTrade();
    await bot.sendMessage(chatId, '✅ Main trade closed.');
  }

  if (action === 'view_config') {
    await safeAnswerCallbackQuery(query.id);
    const cfg = fs.readFileSync(CONFIG_PATH, 'utf8');
    await bot.sendMessage(chatId, `📄 Current Config:\n\n<pre>${cfg}</pre>`, { parse_mode: 'HTML' });
  }

  if (action === 'update_config') {
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
      // Remove this handler after first valid message
      bot.removeListener('message', messageHandler);
    };

    // Attach the message handler
    bot.on('message', messageHandler);
  }

  if (action === 'trade_status') {
    const status = getTradeStatusMessage();
    await safeAnswerCallbackQuery(query.id);
    await bot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
  }
});

// Returns a status message for all active trades
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
