const { findChannelConfig } = require('./config/channels.config');
const AttaullahStrategy = require('./strategies/AttaullahStrategy');
const MarcoStrategy = require('./strategies/MarcoStrategy');
const DefaultStrategy = require('./strategies/DefaultStrategy');
const { SignalData } = require('./domain/models');

console.log('=== TEST 1: TELEGRAM CHANNELS ALWAYS TAKE TP3 ===');
const testCases = [
  { name: 'Attaullah Trading Zone', cls: AttaullahStrategy, id: '-1004307971022' },
  { name: 'MARCO TRADING HUB', cls: MarcoStrategy, id: '-1002157727490' },
  { name: 'Default Generic Channel', cls: DefaultStrategy, id: 'UNKNOWN' }
];

for (const tc of testCases) {
  const cfg = findChannelConfig(tc.id);
  const strat = new tc.cls(cfg);
  const signal = new SignalData({
    channelId: tc.id,
    channelName: tc.name,
    symbol: 'XAUUSD',
    action: 'BUY',
    entry: 4120,
    sl: 4110,
    tp1: 4125,
    tp2: 4130,
    tp3: 4145,
    tp4: 4160
  });
  const plan = strat.createExecutionPlan(signal, 4120, { calculateLotSize: () => 0.01 });
  const isPass = plan.targetTP === 4145 && plan.orders[0].tp === 4145;
  console.log(`${tc.name}: Plan TP = ${plan.targetTP} | Order TP = ${plan.orders[0].tp} -> ${isPass ? 'PASS ✅' : 'FAIL ❌'}`);
}

console.log('\n=== TEST 2: BPR STRATEGIES NEW R:R RATIOS ===');
const { bprStrategyMultiTF } = require('./core/algorithms/BPRInstitutionalMultiTimeframeStrategy');
const { bprStrategyEURUSD } = require('./core/algorithms/BPREurusdMultiTimeframeStrategy');

for (const tf of ['M2', 'M3', 'M5', 'M15']) {
  console.log(`XAUUSD BPR ${tf} rrRatio:`, bprStrategyMultiTF.timeframes[tf].config.rrRatio);
  console.log(`EURUSD BPR ${tf} rrRatio:`, bprStrategyEURUSD.timeframes[tf].config.rrRatio);
}
