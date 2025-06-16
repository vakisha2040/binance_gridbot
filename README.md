# Binance Grid Bot

A Node.js-based grid trading bot for Binnance with Telegram control panel, automatic state management, and logging.

## Features

- **Grid Trading Strategy**: Fully automated grid trading for Bybit linear contracts.
- **Hedging Support**: Opens hedge trades when stop-loss is triggered.
- **Real-Time Price Feed**:
- **Telegram Bot Control**: Start/stop, view and update config, and manual trading from Telegram.
- **Persistent Logging**: All actions logged to file and optionally to Telegram.
- **Configurable**: All parameters via `config/config.json` or Telegram.

## Requirements

- Node.js v16+ (recommended)
- Binance account with API key/secret (with trading permissions)
- Telegram account (to use bot control)

## Setup

1. **Clone the repository** and install dependencies:

    ```sh
    git clone https://github.com/your-username/your-repo.git
    cd your-repo
    npm install
    ```

2. **Configure Environment Variables**

    Create a `.env` file in the root directory:

    ```env
    TELEGRAM_TOKEN=your_telegram_bot_token
    BINANCE_API_KEY=your_binnance_api_key
    BINANCE_API_SECRET=your_binnance_api_secret
    AUTO_START=false
    ```

3. **Configure Trading Parameters**

    Edit `config/config.json` to set trading symbol, grid spacing, order size, Telegram admin, etc.

4. **Start the Bot**

    ```sh
    node index.js
    ```

    Or use [pm2](https://pm2.keymetrics.io/) or similar process manager for persistent running.

## Usage

### Telegram Commands

- `/start` — Start grid bot
- `/stop` — Stop grid bot
- `/config` — View current config
- `/update {json}` — Update config (send valid JSON)
- `/trade buy` or `/trade sell` — Manually open order
- `/close` — Close all positions
- `/menu` — Show inline control panel

### Inline Control Panel

- ▶️ Start — Start bot
- ⏹ Stop — Stop bot
- 📄 View Config — Show config
- ✏️ Update Config — Prompt for new config JSON

## File Structure

```
config/
  config.json       # Trading parameters
clients/
  binnanceClient.js    # Bybit REST API client
core/
  bot.js            # Main bot logic (trading loop)
  helpers.js        # Price and precision helpers
  state.js          # State management
logs/
  bot.log           # Log file
services/
  priceFeed.js      # Bybit WebSocket price feed
  telegram.js       # Telegram bot service
utils/
  logger.js         # Logging utility
index.js            # Entry point
.env                # Environment variables
```

## Security

- **Never share your .env or config with secrets!**
- Store your API keys securely; use environment variables.
- Use a dedicated, withdrawal-disabled Binnance API key.

## Disclaimer

This project is for educational purposes only. Use at your own risk. Trading cryptocurrencies is risky, and you can lose money. The authors are not responsible for any lost funds.

---

**Happy Trading!**
