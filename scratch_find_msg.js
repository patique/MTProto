const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\Administrator\\.pm2\\logs\\trading-bot-out.log', 'utf-8');
const lines = content.split('\n');

for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes('19:30:30')) {
    console.log(lines.slice(Math.max(0, i - 2), i + 30).join('\n'));
    break;
  }
}
