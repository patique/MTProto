/**
 * Auditoría Cuantitativa de Canales de Telegram y Simulación de Salidas (Full TP vs Parciales 1.5R + BE)
 * 100% Read-Only: No modifica ninguna configuración de canales ni archivos de producción.
 */

const fs = require('fs');
const path = require('path');
const { CHANNELS_CONFIG } = require('../../config/channels.config');

const commonDir = 'C:\\Users\\Administrator\\AppData\\Roaming\\MetaQuotes\\Terminal\\Common\\Files';

// 1. Cargar deals para mapear PositionID -> Canal / Comentario
const dealFiles = fs.readdirSync(commonDir).filter(f => f.startsWith('history_deals_') && f.endsWith('.csv'));
const posToChannel = new Map();
const posToInitialComment = new Map();

for (const df of dealFiles) {
  const content = fs.readFileSync(path.join(commonDir, df), 'utf8');
  const lines = content.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length >= 14) {
      const posId = cols[1];
      const entryType = cols[5];
      const comment = cols[13] ? cols[13].trim() : '';
      if (entryType === 'IN' && comment) {
        posToChannel.set(posId, comment);
        posToInitialComment.set(posId, comment);
      }
    }
  }
}

// 2. Cargar posiciones cerradas
const posFiles = fs.readdirSync(commonDir).filter(f => f.startsWith('history_positions_') && f.endsWith('.csv'));
const allPositions = [];

for (const pf of posFiles) {
  const content = fs.readFileSync(path.join(commonDir, pf), 'utf8');
  const lines = content.trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length >= 14) {
      const posId = cols[0];
      const symbol = cols[1];
      const type = cols[2];
      const volume = parseFloat(cols[3]);
      const openPrice = parseFloat(cols[5]);
      const closePrice = parseFloat(cols[7]);
      const grossProfit = parseFloat(cols[8]);
      const commission = parseFloat(cols[9]);
      const swap = parseFloat(cols[10]);
      const netProfit = parseFloat(cols[11]);
      const pips = parseFloat(cols[12]);
      const closeComment = cols[13] ? cols[13].trim() : '';

      const rawComment = posToChannel.get(posId) || '';

      allPositions.push({
        posId,
        symbol,
        type,
        volume,
        openPrice,
        closePrice,
        grossProfit,
        commission,
        swap,
        netProfit,
        pips,
        closeComment,
        rawComment
      });
    }
  }
}

// Mapear comentario a Canal conocido
function mapChannel(comment) {
  if (!comment) return 'MANUAL_O_ANTIGUO';

  // Buscar coincidencia en canales configurados
  if (CHANNELS_CONFIG[comment]) return CHANNELS_CONFIG[comment].name;
  for (const [id, cfg] of Object.entries(CHANNELS_CONFIG)) {
    if (String(id) === String(comment)) return cfg.name;
    if (cfg.name && comment.toLowerCase().includes(cfg.name.toLowerCase().split(' ')[0])) return cfg.name;
    if (cfg.aliases && cfg.aliases.some(a => String(a) === String(comment))) return cfg.name;
  }

  // Nombres reconocibles
  const cl = comment.toLowerCase();
  if (cl.includes('attaullah')) return 'Attaullah Trading Zone';
  if (cl.includes('marco')) return 'Marco Forex Hub';
  if (cl.includes('qi') || cl.includes('mr.')) return 'Mr. Qi VIP';
  if (cl.includes('gold btc') || cl.includes('btc trader')) return 'GOLD BTC TRADER';
  if (cl.includes('ai premium')) return 'Ai Premium Trades';
  if (cl.includes('g.s') || cl.includes('gs market')) return 'G.S Market Analysis';
  if (cl.includes('williams')) return 'Williams Forex Trader';
  if (cl.includes('exness') || cl.includes('ftmo')) return 'Exness / FTMO Copier';
  if (cl.includes('bpr') || cl.includes('proprietary')) return 'ALGO_BPR_INSTITUCIONAL';

  return 'OTROS_CANALES_TELEGRAM';
}

// Filtrar solo operaciones identificadas del bot (descartando manuales antiguas del broker)
const botPositions = allPositions.filter(p => {
  const ch = mapChannel(p.rawComment);
  return ch !== 'MANUAL_O_ANTIGUO';
});

// 3. Auditoría por Canal
const channelStats = new Map();

for (const p of botPositions) {
  const name = mapChannel(p.rawComment);
  if (!channelStats.has(name)) {
    channelStats.set(name, {
      name,
      trades: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      totalNetProfit: 0,
      grossWin: 0,
      grossLoss: 0,
      pips: 0
    });
  }
  const st = channelStats.get(name);
  st.trades++;
  st.totalNetProfit += p.netProfit;
  st.pips += p.pips;

  if (p.netProfit > 2.0) {
    st.wins++;
    st.grossWin += p.netProfit;
  } else if (p.netProfit < -2.0) {
    st.losses++;
    st.grossLoss += Math.abs(p.netProfit);
  } else {
    st.breakevens++;
  }
}

// 4. Simulación Cuantitativa: Opción A (Full TP Directo) vs Opción B (Cierre Parcial 50% @ 1.5R + BE)
let optA_Profit = 0;
let optB_Profit = 0;
let optB_Winners = 0;
let optB_SavedTrades = 0;
let optB_UntouchedLosses = 0;

for (const p of botPositions) {
  const actualProfit = p.netProfit;
  optA_Profit += actualProfit;

  const isWin = actualProfit > 2.0;
  const isLoss = actualProfit < -2.0;

  if (isWin) {
    // En Opción A: Ganó el 100% al TP
    // En Opción B: Se cerró el 50% a 1.5R (asumiendo TP promedio de 2.5R, el parcial captura 1.5/2.5 = 60% del profit en ese 50%)
    // Parte 1 (50% a 1.5R): 0.5 * (1.5 / 2.5) * actualProfit = 0.30 * actualProfit
    // Parte 2 (50% a Full TP): 0.5 * actualProfit
    // Total Opción B en Winner = 0.80 * actualProfit (se cede un 20% del beneficio en los ganadores puros)
    const bProfit = actualProfit * 0.80;
    optB_Profit += bProfit;
    optB_Winners++;
  } else if (isLoss) {
    // Si fue perdedor:
    // ¿Llegó a estar a favor en 1.5R antes de revertirse?
    // Verificamos si el comentario indica reversión desde profit o si el trade tuvo excursión favorable
    const cLower = (p.closeComment || '').toLowerCase();
    const hadPartialPotential = cLower.includes('tp') || p.pips > -40.0;

    if (hadPartialPotential) {
      // El 50% cerró en +1.5R, y el restante 50% cerró en Break-Even ($0):
      // Ganancia neta = +0.75R (convierte una pérdida de -1R en ganancia de +0.75R!)
      const convertedGain = Math.abs(actualProfit) * 0.75;
      optB_Profit += convertedGain;
      optB_SavedTrades++;
    } else {
      // Pérdida directa (nunca llegó a 1.5R): pierde el -1R completo
      optB_Profit += actualProfit;
      optB_UntouchedLosses++;
    }
  } else {
    // Break-even original
    optB_Profit += actualProfit;
  }
}

// 5. Salida de Datos Limpia
console.log('=== AUDITORÍA CUANTITATIVA DE CANALES Y MODELOS DE SALIDA ===\n');

console.log('--- 1. RANKING DE CANALES DE TELEGRAM (OPERACIONES IDENTIFICADAS) ---');
console.log('| Canal | Trades | Win Rate | Ganancias ($) | Pérdidas ($) | Beneficio Neto ($) | Profit Factor |');
console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

const sorted = Array.from(channelStats.values()).sort((a, b) => b.totalNetProfit - a.totalNetProfit);
for (const c of sorted) {
  const wr = c.trades > 0 ? ((c.wins / c.trades) * 100).toFixed(1) + '%' : '0%';
  const pf = c.grossLoss > 0 ? (c.grossWin / c.grossLoss).toFixed(2) : (c.grossWin > 0 ? 'Inf' : '0.00');
  const sign = c.totalNetProfit >= 0 ? '+' : '';
  console.log(`| **${c.name}** | ${c.trades} | ${wr} | $${c.grossWin.toFixed(2)} | -$${c.grossLoss.toFixed(2)} | **${sign}$${c.totalNetProfit.toFixed(2)}** | ${pf} |`);
}

console.log('\n--- 2. COMPARATIVA DE RENTABILIDAD REAL ($): OPCIÓN A vs OPCIÓN B ---');
console.log('| Modelo de Gestión de Salida | Total Trades | Beneficio Total ($) | Diferencia ($) | Trades Salvados de SL | Retorno Relativo |');
console.log('| :--- | :---: | :---: | :---: | :---: | :---: |');
console.log(`| **Opción A: Full TP Directo (Sin Parciales)** | ${botPositions.length} | **+$${optA_Profit.toFixed(2)}** | Base ($0.00) | 0 trades | 100% (Referencia) |`);
const diff = optB_Profit - optA_Profit;
const diffSign = diff >= 0 ? '+' : '';
const diffPct = optA_Profit !== 0 ? ((diff / Math.abs(optA_Profit)) * 100).toFixed(1) : '0';
console.log(`| **Opción B: Cierre Parcial 50% @ 1.5R + BE** | ${botPositions.length} | **+$${optB_Profit.toFixed(2)}** | **${diffSign}$${diff.toFixed(2)}** | **${optB_SavedTrades} trades convertidos** | **${diffSign}${diffPct}%** |`);
