const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const terminals = [
  '0C6969FB85EC87584D7E2B230E548391',
  '12CEF7F8ACCF785454858E03481B3930',
  '9B50BE0885389C8C06074A19CCFEB573',
  'E2324ECEF25C65C6B755A51F1CF36F86'
];

const src = 'C:/telegram-mtproto/Ind_BPR_WarriorTrader.mq5';

terminals.forEach(t => {
  const destDir = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', t, 'MQL5', 'Indicators');
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'Ind_BPR_WarriorTrader.mq5');
  fs.copyFileSync(src, dest);
  console.log('Copied source to:', dest);
});

const compileTarget = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', 'E2324ECEF25C65C6B755A51F1CF36F86', 'MQL5', 'Indicators', 'Ind_BPR_WarriorTrader.mq5');
const logTarget = 'C:/telegram-mtproto/compile_ind.log';
const compilerPath = 'C:\\Program Files\\FTMO_1\\MetaEditor64.exe';

console.log('Compiling indicator:', compileTarget);
try {
  execSync(`"${compilerPath}" /compile:"${compileTarget}" /log:"${logTarget}"`);
} catch (e) {
  console.log('Compiler completed');
}

const ex5Source = compileTarget.replace('.mq5', '.ex5');
if (fs.existsSync(ex5Source)) {
  console.log('SUCCESS! EX5 compiled:', ex5Source);
  terminals.forEach(t => {
    const destEx5 = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', t, 'MQL5', 'Indicators', 'Ind_BPR_WarriorTrader.ex5');
    fs.copyFileSync(ex5Source, destEx5);
    console.log('Deployed Indicator EX5 to:', destEx5);
  });
  fs.copyFileSync(ex5Source, 'C:/telegram-mtproto/Ind_BPR_WarriorTrader.ex5');
} else {
  console.error('EX5 was not found! Check compile_ind.log');
}
