/**
 * Configuración de estrategias propietarias institucionales por activo.
 * 
 * NOTA: enabled = true para mantener el Radar y Checklist M5 activo en el Dashboard.
 * liveExecution = false para que NUNCA ejecuten órdenes en MT5 (modo solo análisis).
 * El sistema ejecuta a mercado EXCLUSIVAMENTE los canales de trading de Telegram.
 */

const PROPRIETARY_STRATEGIES = [
  {
    id: 'BPR_INSTITUTIONAL_XAUUSD',
    name: 'BPR Institutional XAUUSD M5 (R:R 1:2.0)',
    symbol: 'XAUUSD',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprXAUUSD',
    aliases: ['XAUUSD', 'XAUUSD-VIP', 'GOLD']
  },
  {
    id: 'BPR_INSTITUTIONAL_EURUSD',
    name: 'BPR Institutional EURUSD M5 (R:R 1:2.0)',
    symbol: 'EURUSD',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprEURUSD',
    aliases: ['EURUSD', 'EURUSD-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_GBPJPY',
    name: 'BPR Institutional GBPJPY M5 (R:R 1:2.0)',
    symbol: 'GBPJPY',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprGBPJPY',
    aliases: ['GBPJPY', 'GBPJPY-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_USDCAD',
    name: 'BPR Institutional USDCAD M5 (R:R 1:2.0)',
    symbol: 'USDCAD',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprUSDCAD',
    aliases: ['USDCAD', 'USDCAD-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_GBPUSD',
    name: 'BPR Institutional GBPUSD M5 (R:R 1:2.0)',
    symbol: 'GBPUSD',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprGBPUSD',
    aliases: ['GBPUSD', 'GBPUSD-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_AUDUSD',
    name: 'BPR Institutional AUDUSD M5 (R:R 1:2.0)',
    symbol: 'AUDUSD',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprAUDUSD',
    aliases: ['AUDUSD', 'AUDUSD-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_USDJPY',
    name: 'BPR Institutional USDJPY M5 (R:R 1:2.0)',
    symbol: 'USDJPY',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprUSDJPY',
    aliases: ['USDJPY', 'USDJPY-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_XAGUSD',
    name: 'BPR Institutional XAGUSD M5 (R:R 1:2.0)',
    symbol: 'XAGUSD',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprXAGUSD',
    aliases: ['XAGUSD', 'XAGUSD-VIP', 'SILVER']
  },
  {
    id: 'BPR_INSTITUTIONAL_EURJPY',
    name: 'BPR Institutional EURJPY M5 (R:R 1:2.0)',
    symbol: 'EURJPY',
    enabled: true,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprEURJPY',
    aliases: ['EURJPY', 'EURJPY-VIP']
  },
  {
    id: 'BPR_INSTITUTIONAL_BTCUSD',
    name: 'BPR Institutional BTCUSD M5 (R:R 1:2.0 | 24/7 Weekend)',
    symbol: 'BTCUSD',
    enabled: false,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprBTCUSD',
    aliases: ['BTCUSD', 'BTCUSD-VIP', 'BTCUSDT', 'BITCOIN']
  },
  {
    id: 'BPR_INSTITUTIONAL_ETHUSD',
    name: 'BPR Institutional ETHUSD M5 (R:R 1:2.0 | 24/7 Weekend)',
    symbol: 'ETHUSD',
    enabled: false,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/InstitutionalBPRStrategy',
    exportName: 'institutionalBprETHUSD',
    aliases: ['ETHUSD', 'ETHUSD-VIP', 'ETHUSDT', 'ETHEREUM']
  },
  {
    id: 'NY_SNIPER_XAUUSD',
    name: 'NY Daily Range Sniper XAUUSD (M15 Expansion + Reversal R:R 1:2.0)',
    symbol: 'XAUUSD',
    enabled: false,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/NYDailyRangeSniperStrategy',
    exportName: 'nySniperXAUUSD',
    aliases: ['XAUUSD', 'XAUUSD-VIP', 'GOLD']
  },
  {
    id: 'NY_SNIPER_NAS100',
    name: 'NY Daily Range Sniper NAS100 (M15 Wall Street Open + Reversal R:R 1:2.0)',
    symbol: 'NAS100',
    enabled: false,
    liveExecution: false,
    exitManagement: { breakEven: false, trailing: false, rrRatio: 2.0 },
    riskControls: { maxActiveTrades: 1 },
    modulePath: '../core/algorithms/NYDailyRangeSniperStrategy',
    exportName: 'nySniperNAS100',
    aliases: ['NAS100', 'NAS100-VIP', 'US100', 'USTEC', 'NDX']
  }
];

module.exports = {
  PROPRIETARY_STRATEGIES
};
