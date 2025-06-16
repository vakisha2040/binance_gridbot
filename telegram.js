// services/telegram.js
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config.json');
const fs = require('fs');
const state = require('./state');
const {
  startBot,
  stopBot,
  setSendMessage,
  manualCloseMainTrade,
  resetBot
} = require('./bot');

const token = process.env.TELEGRAM_TOKEN;
const webhookPath = '/telegram-webhook';
const webhookUrl = `https://binance-gridbot.onrender.com${webhookPath}`;
// ✅ Create bot instance WITHOUT polling
const bot = new TelegramBot(token, { webHook: { port: 0 } });

// ✅ Set Telegram webhook (only needed once on deploy)
bot.setWebHook(webhookUrl);

// Inject sendMessage into core logic
function sendMessage(msg) {
  bot.sendMessage(process.env.ADMIN_ID, msg);
}
setSendMessage(sendMessage);

// ✅ Inline keyboard
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

// ✅ Handle /start or /menu
bot.onText(/\/(start|menu)/, (msg) => {
  bot.sendMessage(msg.chat.id, '⚙️ Grid Bot Control Panel', getInlineKeyboard());
});

// ✅ Handle button clicks
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const action = query.data;

  if (action === 'start_bot') {
    await bot.sendMessage(chatId, '✅ Starting bot...');
    await startBot(config);
  }

  if (action === 'stop_bot') {
    await bot.sendMessage(chatId, '🛑 Stopping bot...');
    await stopBot();
  }

  if (action === 'stop_main_trade') {
    await bot.sendMessage(chatId, '🛑 Closing main trade...');
    await manualCloseMainTrade();
    await bot.sendMessage(chatId, '✅ Main trade closed.');
  }

  if (action === 'reset_bot') {
    await bot.sendMessage(chatId, '♻️ Resetting bot...');
    await stopBot();
    await resetBot();
    await startBot(config);
    await bot.sendMessage(chatId, '✅ Bot reset complete.');
  }

  if (action === 'view_config') {
    const cfg = fs.readFileSync('./config/config.json', 'utf8');
    await bot.sendMessage(chatId, `📄 Current Config:\n\n<pre>${cfg}</pre>`, { parse_mode: 'HTML' });
  }

  if (action === 'update_config') {
    await bot.sendMessage(chatId, '✏️ Send the new config JSON:');

    const handler = (newMsg) => {
      try {
        const newCfg = JSON.parse(newMsg.text);
        fs.writeFileSync('./config/config.json', JSON.stringify(newCfg, null, 2));
        bot.sendMessage(chatId, '✅ Config updated.');
      } catch {
        bot.sendMessage(chatId, '❌ Invalid JSON format.');
      }
      bot.removeListener('message', handler);
    };

    bot.on('message', handler);
  }

  if (action === 'trade_status') {
    const main = state.getMainTrade();
    const hedge = state.getHedgeTrade();
    let msg = "*Active Trades:*\n";
    if (main) {
      msg += `\n*Main Trade*\nSide: ${main.side}\nEntry: ${main.entry}\nGrid Level: ${main.level}\n`;
    }
    if (hedge) {
      msg += `\n*Hedge Trade*\nSide: ${hedge.side}\nEntry: ${hedge.entry}\nGrid Level: ${hedge.level}\n`;
    }
    if (!main && !hedge) msg += "_No active trades._";
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  }

  bot.answerCallbackQuery(query.id).catch(() => {});
});

// ✅ Export bot + webhook path
module.exports = { bot, webhookPath };
