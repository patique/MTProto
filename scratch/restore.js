const fs = require('fs');
const readline = require('readline');

const fullLogPath = 'C:/Users/Administrator/.gemini/antigravity-ide/brain/4f1b86e0-1660-45ea-b797-0766ee68fd09/.system_generated/logs/transcript_full.jsonl';
const stream = fs.createReadStream(fullLogPath);
const rl = readline.createInterface({ input: stream });

rl.on('line', (line) => {
  if (line.includes('"step_index":2383') || line.includes('"step_index": 2383')) {
    try {
      const data = JSON.parse(line);
      const tc = data.tool_calls[0];
      const code = typeof tc.args.CodeContent === 'string' && tc.args.CodeContent.startsWith('"')
        ? JSON.parse(tc.args.CodeContent)
        : tc.args.CodeContent;
      fs.writeFileSync('C:/telegram-mtproto/scripts/backtest/simulate_100eur_3assets.js', code, 'utf-8');
      console.log('Restored simulate_100eur_3assets.js successfully!');
      process.exit(0);
    } catch (e) {
      console.error('Error parsing:', e.message);
    }
  }
});

rl.on('close', () => {
  console.log('Finished scanning transcript.');
});
