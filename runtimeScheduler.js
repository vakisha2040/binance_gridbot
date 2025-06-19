const fs = require('fs');
const path = require('path');
const { getDynamicConfig, extractFeatures } = require('./predictConfig');
const { fetchCandles } = require('./fetchCandles');
const defaultConfig = require('./config.json');

// Ensure log directory exists
const logDir = path.join(__dirname, '../logs/config');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Format differences between current and predicted config
function formatDiff(oldConfig, newConfig) {
  const changes = Object.entries(newConfig).filter(
    ([key, value]) => Math.abs(value - (oldConfig[key] ?? 0)) > 0.1
  );

  if (changes.length === 0) return '⚙️ No config changes detected.';

  return (
    '📈 Config updated by ML:\n' +
    changes
      .map(
        ([key, newVal]) =>
          `🔧 ${key}:\n   ➤ Default: ${defaultConfig[key]}\n   ➤ New:     ${newVal.toFixed(2)}`
      )
      .join('\n')
  );
}

// Schedule periodic config updates
function scheduleDynamicConfigUpdates(config, sendMessage, intervalMs = 30 * 60 * 1000) {
  async function updateConfig() {
    try {
      const candles = await fetchCandles('BTCUSDT', '5m', 50); // Use your actual symbol + interval
      const dynamicConfig = await getDynamicConfig(candles);
      const features = extractFeatures(candles);

      // Log to file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = path.join(logDir, `config-${timestamp}.json`);

      const logEntry = {
        timestamp: new Date().toISOString(),
        config: dynamicConfig,
        featuresUsed: features,
        latestPrice: candles[candles.length - 1].close,
        inputs: candles,
      };

      fs.writeFileSync(logPath, JSON.stringify(logEntry, null, 2));

      // Apply config to runtime
      const diffReport = formatDiff(config, dynamicConfig);
      Object.assign(config, dynamicConfig);

      sendMessage?.(diffReport);
    } catch (err) {
      console.error('❌ Failed to update config dynamically:', err.message);
      sendMessage?.(`⚠️ ML config update failed: ${err.message}`);
    }
  }

  // Run immediately on start
  updateConfig();

  // Schedule periodic updates
  return setInterval(updateConfig, intervalMs);
}

module.exports = { scheduleDynamicConfigUpdates };
