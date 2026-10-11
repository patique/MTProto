/**
 * Comparador de Estrategias en la Sombra (Shadow Strategy Comparator)
 * 
 * Permite mantener la operativa real de MT5 en la Estrategia 2 (Actual 50/50),
 * mientras calcula y registra en segundo plano para CADA operación cerrada:
 * - Opción 1 (De la mañana): 100% al TP2 directo sin parciales ni trailing
 * - Opción 2 (Actual en vivo): 50% TP1 (35p) + Auto-BE (25p) + Trailing (20p)
 * - Opción 3 (Propuesta 70/30): 70% TP1 (25p) + Auto-BE (18p) + Trailing (18p)
 * 
 * Persiste los resultados en shadow_comparison.json y expone métricas acumuladas.
 */

const fs = require('fs');
const path = require('path');

const COMPARISON_FILE = path.join(__dirname, '..', 'shadow_comparison.json');

class ShadowStrategyComparator {
  constructor() {
    this.history = [];
    this.summary = {
      totalTrades: 0,
      option1_morning: { name: '1. De la Mañana (100% TP2)', profitUSD: 0, pips: 0, wins: 0 },
      option2_live5050: { name: '2. En Vivo Real (50/50)',   profitUSD: 0, pips: 0, wins: 0 },
      option3_new7030:  { name: '3. Nueva Propuesta (70/30)', profitUSD: 0, pips: 0, wins: 0 }
    };
    this.loadData();
  }

  loadData() {
    if (fs.existsSync(COMPARISON_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(COMPARISON_FILE, 'utf8'));
        this.history = data.history || [];
        this.summary = data.summary || this.summary;
      } catch (e) {
        console.error('⚠️ Error cargando shadow_comparison.json:', e.message);
      }
    }
  }

  saveData() {
    try {
      fs.writeFileSync(COMPARISON_FILE, JSON.stringify({
        summary: this.summary,
        history: this.history,
        lastUpdated: new Date().toISOString()
      }, null, 2));
    } catch (e) {
      console.error('⚠️ Error guardando shadow_comparison.json:', e.message);
    }
  }

  /**
   * Registra y compara una operación cerrada recibida desde MT5
   */
  recordTradeClosed(data, snapshot = null) {
    const { position, symbol = 'XAUUSD', profit = 0, outcome = 'WIN', comment = '', channelName = 'Canal' } = data;
    const realProfitUSD = parseFloat(profit);
    const pipsEst = typeof data.pips === 'number' ? data.pips : Math.abs(realProfitUSD) * 10.0;

    let tp2Pips = 70.0;
    let tp1PipsActual = 35.0;
    let tp1PipsNueva = 25.0;

    if (snapshot && snapshot.order) {
      if (snapshot.order.tp2Pips) tp2Pips = snapshot.order.tp2Pips;
      if (snapshot.order.tp1Pips) tp1PipsActual = snapshot.order.tp1Pips;
    }

    let usd1, pips1;
    let usd2, pips2;
    let usd3, pips3;

    if (realProfitUSD < 0) {
      // Si la operación fue pérdida (Stop Loss completo), las 3 opciones asumen la pérdida
      usd1 = realProfitUSD;
      pips1 = -pipsEst;

      usd2 = realProfitUSD;
      pips2 = -pipsEst;

      usd3 = realProfitUSD;
      pips3 = -pipsEst;
    } else {
      // Operación ganadora
      // Opción 2: Es el resultado real en vivo de MT5
      usd2 = realProfitUSD;
      pips2 = pipsEst;

      // Opción 1: En la de la mañana, la posición no se dividió en dos (fue 100% al TP2).
      // En la 50/50, la pata 1 cobró a TP1 (35p) y la pata 2 a TP2 (70p).
      // Por tanto, si fue TP2 completo, la opción 1 sacó el 100% del recorrido largo:
      const ratio50 = tp1PipsActual / tp2Pips;
      // usd2 = (fullUSD * 0.50 * ratio50) + (fullUSD * 0.50) = fullUSD * (0.50 * ratio50 + 0.50)
      const factor50 = (0.50 * ratio50) + 0.50;
      const fullUSD = factor50 > 0 ? (usd2 / factor50) : usd2;
      const fullPips = factor50 > 0 ? (pips2 / factor50) : pips2;

      usd1 = fullUSD;
      pips1 = fullPips;

      // Opción 3 (70/30): 70% a TP1 (25p) + 30% a TP2 (tp2Pips)
      const ratio70 = tp1PipsNueva / tp2Pips;
      usd3 = (fullUSD * 0.70 * ratio70) + (fullUSD * 0.30);
      pips3 = (fullPips * 0.70 * ratio70) + (fullPips * 0.30);
    }

    const record = {
      position,
      channel: channelName || comment || 'Desconocido',
      symbol,
      timestamp: Date.now(),
      dateStr: new Date().toLocaleString('es-ES'),
      option1_morning: { profitUSD: parseFloat(usd1.toFixed(2)), pips: parseFloat(pips1.toFixed(1)), isWin: usd1 > 0 },
      option2_live5050: { profitUSD: parseFloat(usd2.toFixed(2)), pips: parseFloat(pips2.toFixed(1)), isWin: usd2 > 0 },
      option3_new7030:  { profitUSD: parseFloat(usd3.toFixed(2)), pips: parseFloat(pips3.toFixed(1)), isWin: usd3 > 0 }
    };

    this.history.push(record);
    this.summary.totalTrades++;

    this.summary.option1_morning.profitUSD += record.option1_morning.profitUSD;
    this.summary.option1_morning.pips += record.option1_morning.pips;
    if (record.option1_morning.isWin) this.summary.option1_morning.wins++;

    this.summary.option2_live5050.profitUSD += record.option2_live5050.profitUSD;
    this.summary.option2_live5050.pips += record.option2_live5050.pips;
    if (record.option2_live5050.isWin) this.summary.option2_live5050.wins++;

    this.summary.option3_new7030.profitUSD += record.option3_new7030.profitUSD;
    this.summary.option3_new7030.pips += record.option3_new7030.pips;
    if (record.option3_new7030.isWin) this.summary.option3_new7030.wins++;

    this.saveData();

    // Imprimir comparativa visual clara en la consola
    console.log('\n========================================================================================');
    console.log(`📊 [SHADOW COMPARATOR] Cierre Posición #${position} [${record.channel}]`);
    console.log('----------------------------------------------------------------------------------------');
    console.log(`1. De la Mañana (100% TP2):    ${usd1 >= 0 ? '+' : ''}$${usd1.toFixed(2)} USD (${pips1 >= 0 ? '+' : ''}${pips1.toFixed(1)}p)`);
    console.log(`2. EN VIVO REAL (50/50):        ${usd2 >= 0 ? '+' : ''}$${usd2.toFixed(2)} USD (${pips2 >= 0 ? '+' : ''}${pips2.toFixed(1)}p)  👉 [EJECUTADO EN TU MT5]`);
    console.log(`3. Nueva Propuesta (70/30):     ${usd3 >= 0 ? '+' : ''}$${usd3.toFixed(2)} USD (${pips3 >= 0 ? '+' : ''}${pips3.toFixed(1)}p)`);
    console.log('----------------------------------------------------------------------------------------');
    console.log(`💰 BALANCE ACUMULADO COMPARATIVO (Total: ${this.summary.totalTrades} trades registrados):`);
    console.log(`   • 1. De la Mañana:   ${this.summary.option1_morning.profitUSD >= 0 ? '+' : ''}$${this.summary.option1_morning.profitUSD.toFixed(2)} USD (${this.summary.option1_morning.pips.toFixed(1)} pips)`);
    console.log(`   • 2. Real (50/50):   ${this.summary.option2_live5050.profitUSD >= 0 ? '+' : ''}$${this.summary.option2_live5050.profitUSD.toFixed(2)} USD (${this.summary.option2_live5050.pips.toFixed(1)} pips)  [CUENTA REAL]`);
    console.log(`   • 3. Nueva (70/30):  ${this.summary.option3_new7030.profitUSD >= 0 ? '+' : ''}$${this.summary.option3_new7030.profitUSD.toFixed(2)} USD (${this.summary.option3_new7030.pips.toFixed(1)} pips)`);
    console.log('========================================================================================\n');

    return record;
  }
}

const shadowStrategyComparator = new ShadowStrategyComparator();

module.exports = {
  ShadowStrategyComparator,
  shadowStrategyComparator
};
