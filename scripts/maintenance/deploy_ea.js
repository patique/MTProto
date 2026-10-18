const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const terminals = [
  '0C6969FB85EC87584D7E2B230E548391',
  '12CEF7F8ACCF785454858E03481B3930',
  '9B50BE0885389C8C06074A19CCFEB573',
  'E2324ECEF25C65C6B755A51F1CF36F86'
];

const src = 'C:/telegram-mtproto/EA_ICT_NWOG_NDOG.mq5';

terminals.forEach(t => {
  const dest = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', t, 'MQL5', 'Experts', 'EA_ICT_NWOG_NDOG.mq5');
  fs.copyFileSync(src, dest);
  console.log('Copied source to:', dest);
});

const compileTarget = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', 'E2324ECEF25C65C6B755A51F1CF36F86', 'MQL5', 'Experts', 'EA_ICT_NWOG_NDOG.mq5');
const logTarget = 'C:/telegram-mtproto/compile_ea.log';
const compilerPath = 'C:\\Program Files\\FTMO_1\\MetaEditor64.exe';

console.log('Compiling target:', compileTarget);
try {
  execSync(`"${compilerPath}" /compile:"${compileTarget}" /log:"${logTarget}"`);
} catch (e) {
  console.log('Compiler exited with status');
}

const ex5Source = compileTarget.replace('.mq5', '.ex5');
if (fs.existsSync(ex5Source)) {
  console.log('SUCCESS! EX5 compiled:', ex5Source);
  terminals.forEach(t => {
    const destEx5 = path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal', t, 'MQL5', 'Experts', 'EA_ICT_NWOG_NDOG.ex5');
    fs.copyFileSync(ex5Source, destEx5);
    console.log('Deployed EX5 to:', destEx5);
  });
  fs.copyFileSync(ex5Source, 'C:/telegram-mtproto/EA_ICT_NWOG_NDOG.ex5');
} else {
  console.error('EX5 was not found! Check log.');
}
