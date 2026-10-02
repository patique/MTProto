/**
 * Analizador de Huella Digital y Patrones de Entrada de Canales
 * Procesa los snapshots de mercado y extrae las reglas implícitas que usan los canales
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOTS_FILE = path.join(__dirname, '..', '..', 'market_snapshots.json');

function analyzeFingerprints() {
  if (!fs.existsSync(SNAPSHOTS_FILE)) {
    console.log('No se encontró market_snapshots.json');
    return;
  }

  const data = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf-8'));
  console.log(`\n========================================================================================`);
  console.log(`🔬 ANÁLISIS CUANTITATIVO DE HUELLA DIGITAL DE LOS CANALES (${data.length} OPERACIONES REGISTRADAS)`);
  console.log(`========================================================================================\n`);

  // 1. Distribución por Sesión
  const sessionCounts = {};
  const hourCounts = {};
  const channelStats = {};

  let totalSLPips = 0;
  let totalTP2Pips = 0;
  let slCount = 0;
  let tpCount = 0;
  let buyCount = 0;
  let sellCount = 0;
  const roundDistances = [];
  const rsiValues = { buy: [], sell: [] };
  const rangePositions = { buy: [], sell: [] };

  data.forEach(s => {
    // Sesión
    sessionCounts[s.session] = (sessionCounts[s.session] || 0) + 1;

    // Hora UTC
    const date = new Date(s.timestamp);
    const hour = date.getUTCHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;

    // Dirección
    if (s.order.action.includes('BUY')) buyCount++;
    if (s.order.action.includes('SELL')) sellCount++;

    // Canal
    const ch = s.channel.name || 'Desconocido';
    if (!channelStats[ch]) {
      channelStats[ch] = { count: 0, buys: 0, sells: 0, sls: [], tps: [] };
    }
    channelStats[ch].count++;
    if (s.order.action.includes('BUY')) channelStats[ch].buys++;
    if (s.order.action.includes('SELL')) channelStats[ch].sells++;
    if (s.order.slPips) channelStats[ch].sls.push(s.order.slPips);
    if (s.order.tp2Pips) channelStats[ch].tps.push(s.order.tp2Pips);

    // SL y TP
    if (s.order.slPips) {
      totalSLPips += s.order.slPips;
      slCount++;
    }
    if (s.order.tp2Pips) {
      totalTP2Pips += s.order.tp2Pips;
      tpCount++;
    }

    // Números redondos
    if (s.order.entry) {
      const entry = s.order.entry;
      const dec = entry - Math.floor(entry);
      // Distancia al .00 más cercano
      const distToRound = Math.min(dec, 1 - dec) * 100; // en pips
      roundDistances.push(distToRound);
    }

    // RSI y Posición en Rango 24h
    if (s.marketSnapshot) {
      if (s.marketSnapshot.rsi15m) {
        if (s.order.action.includes('BUY')) rsiValues.buy.push(s.marketSnapshot.rsi15m);
        else rsiValues.sell.push(s.marketSnapshot.rsi15m);
      }
      if (s.marketSnapshot.positionIn24hRangePercent !== undefined) {
        if (s.order.action.includes('BUY')) rangePositions.buy.push(s.marketSnapshot.positionIn24hRangePercent);
        else rangePositions.sell.push(s.marketSnapshot.positionIn24hRangePercent);
      }
    }
  });

  console.log(`📍 1. DISTRIBUCIÓN POR SESIÓN Y HORARIOS:`);
  console.log(`----------------------------------------------------------------------------------------`);
  for (const [sess, count] of Object.entries(sessionCounts)) {
    const pct = ((count / data.length) * 100).toFixed(1);
    console.log(`   • Sesión ${sess.padEnd(12)}: ${count.toString().padStart(2)} trades (${pct}%)`);
  }

  console.log(`\n⏰ Horas punta (UTC):`);
  const sortedHours = Object.entries(hourCounts).sort((a, b) => b[1] - a[1]);
  sortedHours.slice(0, 5).forEach(([h, cnt]) => {
    console.log(`   • ${h.padStart(2, '0')}:00 UTC  -> ${cnt} señales`);
  });

  console.log(`\n🎯 2. DIRECCIÓN Y GESTIÓN DE RIESGO TÍPICA:`);
  console.log(`----------------------------------------------------------------------------------------`);
  console.log(`   • Dirección: BUY: ${buyCount} (${((buyCount/data.length)*100).toFixed(1)}%) | SELL: ${sellCount} (${((sellCount/data.length)*100).toFixed(1)}%)`);
  const avgSL = slCount > 0 ? (totalSLPips / slCount).toFixed(1) : 'N/A';
  const avgTP = tpCount > 0 ? (totalTP2Pips / tpCount).toFixed(1) : 'N/A';
  console.log(`   • SL Promedio: ${avgSL} pips (~$${(avgSL * 0.1).toFixed(1)} en 0.01)`);
  console.log(`   • TP2 Promedio: ${avgTP} pips (~$${(avgTP * 0.1).toFixed(1)} en 0.01)`);

  const avgRoundDist = roundDistances.length ? (roundDistances.reduce((a,b)=>a+b, 0) / roundDistances.length).toFixed(1) : 'N/A';
  const nearRoundCount = roundDistances.filter(d => d <= 15).length;
  console.log(`   • Distancia media al .00: ${avgRoundDist} pips (El ${((nearRoundCount/roundDistances.length)*100).toFixed(1)}% entra a menos de 15 pips de un nivel .00)`);

  console.log(`\n📊 3. ESTADÍSTICAS TÉCNICAS AL ENTRAR (RSI & RANGO 24H):`);
  console.log(`----------------------------------------------------------------------------------------`);
  const avgRsiBuy = rsiValues.buy.length ? (rsiValues.buy.reduce((a,b)=>a+b,0)/rsiValues.buy.length).toFixed(1) : 'N/A';
  const avgRsiSell = rsiValues.sell.length ? (rsiValues.sell.reduce((a,b)=>a+b,0)/rsiValues.sell.length).toFixed(1) : 'N/A';
  console.log(`   • RSI 15m medio en COMPRAS: ${avgRsiBuy} (Filtro habitual: sobreventa o retroceso < 45)`);
  console.log(`   • RSI 15m medio en VENTAS:  ${avgRsiSell} (Filtro habitual: sobrecompra o retroceso > 55)`);

  const avgPosBuy = rangePositions.buy.length ? (rangePositions.buy.reduce((a,b)=>a+b,0)/rangePositions.buy.length).toFixed(1) : 'N/A';
  const avgPosSell = rangePositions.sell.length ? (rangePositions.sell.reduce((a,b)=>a+b,0)/rangePositions.sell.length).toFixed(1) : 'N/A';
  console.log(`   • Posición en Rango 24h (Compras): ${avgPosBuy}% del rango (compran en tercio inferior)`);
  console.log(`   • Posición en Rango 24h (Ventas):  ${avgPosSell}% del rango (venden en tercio superior)`);

  console.log(`\n🏆 4. PERFIL POR CANAL:`);
  console.log(`----------------------------------------------------------------------------------------`);
  for (const [name, stats] of Object.entries(channelStats)) {
    const avgChSL = stats.sls.length ? (stats.sls.reduce((a,b)=>a+b,0)/stats.sls.length).toFixed(1) : 'N/A';
    const avgChTP = stats.tps.length ? (stats.tps.reduce((a,b)=>a+b,0)/stats.tps.length).toFixed(1) : 'N/A';
    console.log(`   • ${name.padEnd(30)}: ${stats.count} ops | BUY: ${stats.buys} SELL: ${stats.sells} | SL medio: ${avgChSL}p | TP medio: ${avgChTP}p`);
  }
  console.log(`========================================================================================\n`);
}

analyzeFingerprints();
