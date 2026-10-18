const fs = require('fs');
const path = require('path');

const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const vbsPath = path.join(startupDir, 'Start_PM2_Silent.vbs');

const vbsContent = [
  'WScript.Sleep 4000',
  'Set WshShell = CreateObject("WScript.Shell")',
  'appData = WshShell.ExpandEnvironmentStrings("%APPDATA%")',
  'WshShell.Run "cmd.exe /c """ & appData & "\\npm\\pm2.cmd"" resurrect", 0, False'
].join('\r\n');

fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
console.log('SUCCESS: Created autostart script at:', vbsPath);
