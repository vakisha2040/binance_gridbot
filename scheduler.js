const cron = require('node-cron');
const { exec } = require('child_process');

// Every day at 3 AM
cron.schedule('0 3 * * *', () => {
  console.log('🔁 Auto-retraining ML model...');
  exec('node ./labelGenerator.js && node ./trainModel.js', (err, stdout, stderr) => {
    if (err) return console.error('❌ Retrain failed:', stderr);
    console.log(stdout);
  });
});
