/**
 * RADAR INSTITUCIONAL EN VIVO: CHECKLIST DE CONFIRMACIÓN BPR
 * Consulta el estado actual de las 7 divisas activas.
 */

const http = require('http');

function checkRadar() {
  http.get('http://127.0.0.1:3000/api/status', (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(raw);
        const nowUtc = new Date();
        const utcHour = nowUtc.getUTCHours();
        const utcMin = String(nowUtc.getUTCMinutes()).padStart(2, '0');

        console.log('========================================================================================');
        console.log(`🧭 RADAR INSTITUCIONAL BPR M5 | HORA UTC: ${utcHour}:${utcMin} (Local: ${nowUtc.toLocaleTimeString('es-ES')})`);
        console.log('========================================================================================\n');

        // 1. Estado de Sesión y Cuentas
        const isLondonSoon = (utcHour >= 6 && utcHour < 8);
        const isLondonActive = (utcHour >= 8 && utcHour < 16);
        const isNYActive = (utcHour >= 13 && utcHour < 21);
        let sessionName = 'SESIÓN ASIÁTICA (Acumulación de Liquidez)';
        if (isLondonActive && isNYActive) sessionName = 'LONDRES + NUEVA YORK OVERLAP (Máxima Volatilidad)';
        else if (isLondonActive) sessionName = 'SESIÓN DE LONDRES (Expansión y Manipulación)';
        else if (isNYActive) sessionName = 'SESIÓN DE NUEVA YORK';
        else if (isLondonSoon) sessionName = 'PRE-LONDRES (Preparación de Judás Swing)';

        console.log(`📍 FASE ACTUAL: ${sessionName}`);
        console.log(`🏦 CUENTAS ACTIVAS:`);
        data.accounts.forEach(acc => {
          console.log(`   • #${acc.id} (${acc.broker}): $${acc.balance.toFixed(2)} USD | Posiciones abiertas: ${acc.openPositions}`);
        });

        console.log('\n========================================================================================');
        console.log('📋 CHECKLIST DE CONFIRMACIÓN ICT (LAS 6 CONDICIONES DE DISPARO):');
        console.log('========================================================================================');
        console.log('1. [SESIÓN HORARIA]       : Londres (08:00 UTC) o NY (13:30 UTC). Evita iliquidez nocturna.');
        console.log('2. [BARRIDO BSL / SSL]    : Las manos fuertes barren un swing fractal (8 velas) previo.');
        console.log('3. [DESPLAZAMIENTO (BOS)] : Vela rompe estructura contraria con cierre contundente de cuerpo.');
        console.log('4. [SOLAPAMIENTO BPR]     : Formación de caja BPR (solape FVG alcista + FVG bajista >= ATR).');
        console.log('5. [MITIGACIÓN CE 50%]    : El precio retrocede al centro geométrico (50%) de la caja.');
        console.log('6. [MECHA RECHAZO >=20%]  : En M2/M5 confirma rechazo a favor del sesgo y respeta EMA 100.');
        console.log('========================================================================================\n');

        console.log('🎯 ¿QUÉ ESTÁ HACIENDO EL MERCADO EN ESTE MOMENTO?');
        console.log('• Durante la noche (Sesión Asiática actual), el precio genera el "Rango de Referencia Asiático".');
        console.log('• En cuanto abra Londres (07:00 - 08:00 UTC), se produce habitualmente el "Judas Swing" (barrido falso)');
        console.log('  que captura la liquidez asiática (Paso 2), quiebra la estructura con BOS (Paso 3) y deja la caja');
        console.log('  BPR lista para ser mitigada al CE 50% (Pasos 4, 5 y 6).');
        console.log('\n📡 Todas las 7 divisas (XAUUSD, EURUSD, GBPJPY, USDCAD, GBPUSD, AUDUSD, USDJPY) están');
        console.log('   monitoreadas tick a tick en tiempo real esperando que se complete este checklist.\n');

      } catch (e) {
        console.error('Error parseando estado:', e.message);
      }
    });
  }).on('error', (err) => {
    console.error('Error contactando bot:', err.message);
  });
}

checkRadar();
