/**
 * Colector de Fotografía Técnica y Caja Negra Institucional (MarketSnapshotCollector v2)
 * 
 * Registra una telemetría exhaustiva de grado cuantitativo de cada señal entrante:
 * 1. Anatomía de la Vela en M5 (Pinbar, mechas de rechazo, tamaño de cuerpo).
 * 2. Niveles Psicológicos y Números Redondos (distancia a terminaciones .00, .50).
 * 3. Niveles Institucionales de Sesión (Asian High/Low, distancias en pips).
 * 4. Fricción Real del Broker (Spread instantáneo de MT5 y Slippage de entrada).
 * 5. Inteligencia del Canal (Texto original completo y palabras clave detectadas).
 * 6. Entorno Técnico y Noticias (RSI M15, RSI M5, ATR, Rango 24h, Calendario Económico).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { newsFilter } = require('./NewsFilter');

const SNAPSHOTS_FILE = path.join(__dirname, '..', 'market_snapshots.json');

class MarketSnapshotCollector {
  constructor() {
    this.snapshots = [];
    this.cachedCandles = [];
    this.lastCandlesFetchTime = 0;
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(SNAPSHOTS_FILE)) {
        this.snapshots = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, 'utf-8'));
      }
    } catch (e) {
      this.snapshots = [];
    }
  }

  saveData() {
    try {
      fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(this.snapshots, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ Error guardando snapshot de mercado:', e.message);
    }
  }

  getSession(dateObj = new Date()) {
    const hours = dateObj.getUTCHours();
    const minutes = dateObj.getUTCMinutes();
    const timeVal = hours + minutes / 60.0;

    if (timeVal >= 0.0 && timeVal < 7.0) return 'ASIA';
    if (timeVal >= 7.0 && timeVal < 12.0) return 'LONDON';
    if (timeVal >= 12.0 && timeVal < 16.5) return 'LONDON_NY_OVERLAP';
    if (timeVal >= 16.5 && timeVal < 21.0) return 'NEW_YORK';
    return 'OFF_SESSION';
  }

  /**
   * Obtiene velas de M5 recientes para calcular el contexto de corto plazo y anatomía de vela
   */
  async fetchRecentCandles() {
    const now = Date.now();
    // Cache de 30 segundos
    if (this.cachedCandles.length > 50 && (now - this.lastCandlesFetchTime) < 30000) {
      return this.cachedCandles;
    }

    return new Promise((resolve) => {
      const url = 'https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=5m&limit=150';
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000 }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            this.cachedCandles = data.map(c => ({
              time: parseInt(c[0]),
              open: parseFloat(c[1]),
              high: parseFloat(c[2]),
              low: parseFloat(c[3]),
              close: parseFloat(c[4]),
              vol: parseFloat(c[5])
            }));
            this.lastCandlesFetchTime = now;
            resolve(this.cachedCandles);
          } catch (e) {
            resolve(this.cachedCandles);
          }
        });
      });
      req.on('error', () => resolve(this.cachedCandles));
      req.on('timeout', () => { req.destroy(); resolve(this.cachedCandles); });
    });
  }

  /**
   * Extrae la anatomía de la última vela cerrada en M5 (Pinbar, Mechas, etc.)
   */
  analyzeCandleAnatomy(candles) {
    if (!candles || candles.length < 2) return null;
    const last = candles[candles.length - 2]; // Última vela M5 completamente cerrada
    const range = last.high - last.low;
    if (range <= 0.1) return null;

    const body = Math.abs(last.close - last.open);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;

    const upperWickRatio = parseFloat((upperWick / range).toFixed(2));
    const lowerWickRatio = parseFloat((lowerWick / range).toFixed(2));
    const bodyRatio = parseFloat((body / range).toFixed(2));

    let pattern = 'NEUTRAL';
    if (upperWickRatio >= 0.45 && last.close <= last.open) {
      pattern = 'BEARISH_REJECTION_PINBAR';
    } else if (lowerWickRatio >= 0.45 && last.close >= last.open) {
      pattern = 'BULLISH_REJECTION_PINBAR';
    } else if (bodyRatio >= 0.65) {
      pattern = last.close > last.open ? 'BULLISH_MOMENTUM' : 'BEARISH_MOMENTUM';
    } else if (bodyRatio <= 0.15) {
      pattern = 'DOJI_INDECISION';
    }

    return {
      timeStr: new Date(last.time).toLocaleTimeString('es-ES', { timeZone: 'UTC' }),
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      rangePips: parseFloat((range * 10.0).toFixed(1)),
      bodyPips: parseFloat((body * 10.0).toFixed(1)),
      upperWickPips: parseFloat((upperWick * 10.0).toFixed(1)),
      lowerWickPips: parseFloat((lowerWick * 10.0).toFixed(1)),
      upperWickRatio,
      lowerWickRatio,
      pattern
    };
  }

  /**
   * Calcula la proximidad a niveles psicológicos y números redondos institucionales
   */
  calculatePsychologicalLevels(price) {
    if (!price || isNaN(price)) return null;

    // Números redondos mayores (.00 cada $10) y medios (.50 cada $5)
    const baseRound5 = Math.round(price / 5.0) * 5.0;
    const baseRound10 = Math.round(price / 10.0) * 10.0;
    const distRound5Pips = parseFloat((Math.abs(price - baseRound5) * 10.0).toFixed(1));
    const distRound10Pips = parseFloat((Math.abs(price - baseRound10) * 10.0).toFixed(1));

    const nearestLevel = distRound5Pips <= distRound10Pips ? baseRound5 : baseRound10;
    const distancePips = Math.min(distRound5Pips, distRound10Pips);

    return {
      currentPrice: price,
      nearestRoundNumber: nearestLevel,
      distanceToRoundPips: distancePips,
      isAtRoundNumberZone: distancePips <= 2.5, // A menos de 25 pips del nivel redondo
      levelType: nearestLevel % 10 === 0 ? 'MAJOR_ROUND_10' : 'MID_ROUND_5'
    };
  }

  /**
   * Calcula el rango asiático (00:00 a 07:00 UTC) y distancias clave
   */
  calculateSessionContext(candles, currentPrice) {
    if (!candles || candles.length < 20) return null;

    const todayUTC = new Date().toISOString().split('T')[0];
    const asianCandles = candles.filter(c => {
      const d = new Date(c.time);
      const dayStr = d.toISOString().split('T')[0];
      const h = d.getUTCHours();
      return dayStr === todayUTC && h >= 0 && h < 7;
    });

    let asianHigh = null, asianLow = null;
    if (asianCandles.length > 0) {
      asianHigh = Math.max(...asianCandles.map(c => c.high));
      asianLow = Math.min(...asianCandles.map(c => c.low));
    }

    const distToAsianHigh = asianHigh ? parseFloat(((currentPrice - asianHigh) * 10.0).toFixed(1)) : null;
    const distToAsianLow = asianLow ? parseFloat(((currentPrice - asianLow) * 10.0).toFixed(1)) : null;

    // Rango 24h
    const high24h = Math.max(...candles.map(c => c.high));
    const low24h = Math.min(...candles.map(c => c.low));
    const range24h = parseFloat(((high24h - low24h) * 10.0).toFixed(1));
    const pos24h = range24h > 0 ? parseFloat((((currentPrice - low24h) / (high24h - low24h)) * 100).toFixed(1)) : 50.0;

    return {
      asianHigh,
      asianLow,
      asianRangePips: (asianHigh && asianLow) ? parseFloat(((asianHigh - asianLow) * 10.0).toFixed(1)) : null,
      distanceToAsianHighPips: distToAsianHigh,
      distanceToAsianLowPips: distToAsianLow,
      isSweepingAsianHigh: distToAsianHigh !== null && distToAsianHigh > 0 && distToAsianHigh <= 25.0,
      isSweepingAsianLow: distToAsianLow !== null && distToAsianLow < 0 && Math.abs(distToAsianLow) <= 25.0,
      high24h,
      low24h,
      range24hPips: range24h,
      positionIn24hRangePercent: pos24h
    };
  }

  /**
   * Extrae la inteligencia del texto del mensaje del canal
   */
  extractChannelIntel(rawText) {
    if (!rawText || typeof rawText !== 'string') return { rawText: '', keywords: [] };

    const upper = rawText.toUpperCase();
    const keywords = [];

    const checks = [
      { key: 'DOUBLE_TOP', regex: /DOUBLE\s*TOP|2ND\s*TOP/i },
      { key: 'DOUBLE_BOTTOM', regex: /DOUBLE\s*BOTTOM|2ND\s*BOTTOM/i },
      { key: 'REJECTION', regex: /REJECT|REJECTION|BOUNCE|RETEST/i },
      { key: 'BREAKOUT', regex: /BREAK|BREAKOUT|BROKEN/i },
      { key: 'ZONE_ENTRY', regex: /ZONE|AREA|DEMAND|SUPPLY/i },
      { key: 'MOMENTUM', regex: /FLYING|ROCKET|FAST|NOW/i },
      { key: 'HOLD_TRADE', regex: /HOLD|PATIENT|WAIT/i },
      { key: 'LAYER_GRID', regex: /ADD|LAYER|SECOND\s*ENTRY|AGAIN/i }
    ];

    checks.forEach(c => {
      if (c.regex.test(upper)) keywords.push(c.key);
    });

    return {
      rawText: rawText.slice(0, 300).replace(/\n/g, ' '),
      detectedKeywords: keywords
    };
  }

  /**
   * Captura y almacena una fotografía técnica de Grado Institucional (Caja Negra)
   */
  async captureSnapshot(signal, executionPlan, liveTick = null) {
    const now = new Date();
    const candles = await this.fetchRecentCandles();
    const currentPrice = liveTick?.bid || liveTick?.ask || signal.entry;

    const upcomingEvents = await newsFilter.getUpcomingEvents(3);
    const nextRedFolder = upcomingEvents.length > 0 ? upcomingEvents[0] : null;
    let minutesToNextNews = null;
    if (nextRedFolder) {
      minutesToNextNews = Math.round((nextRedFolder.date - now.getTime()) / 60000);
    }

    const entry = executionPlan.entryPrice || currentPrice || signal.entry;
    const sl = executionPlan.slPrice || signal.sl;
    const tp1 = signal.tp1;
    const tp2 = executionPlan.targetTP || signal.tp2;
    const isBuy = (signal.action || '').toUpperCase().includes('BUY');

    const slPips = (entry && sl) ? parseFloat((Math.abs(entry - sl) * 10.0).toFixed(1)) : null;
    const tp1Pips = (entry && tp1) ? parseFloat((Math.abs(entry - tp1) * 10.0).toFixed(1)) : null;
    const tp2Pips = (entry && tp2) ? parseFloat((Math.abs(entry - tp2) * 10.0).toFixed(1)) : null;
    const rrRatioTP2 = (slPips && tp2Pips) ? parseFloat((tp2Pips / slPips).toFixed(2)) : null;

    // 1. Fricción del Broker en el segundo exacto
    const liveSpread = (liveTick?.ask && liveTick?.bid) ? parseFloat(((liveTick.ask - liveTick.bid) * 10.0).toFixed(1)) : 3.7;
    const entrySlippage = (signal.entry && currentPrice) ? parseFloat((Math.abs(currentPrice - signal.entry) * 10.0).toFixed(1)) : 0.0;

    // 2. Niveles Psicológicos y Números Redondos
    const psychLevels = this.calculatePsychologicalLevels(currentPrice);

    // 3. Contexto de Sesión (Asia High/Low, Rango 24h)
    const sessionCtx = this.calculateSessionContext(candles, currentPrice);

    // 4. Anatomía de la Vela M5
    const candleM5 = this.analyzeCandleAnatomy(candles);

    // 5. Inteligencia del Mensaje del Canal
    const rawMsg = signal.rawText || signal.message || '';
    const channelIntel = this.extractChannelIntel(rawMsg);

    const snapshot = {
      id: `${Date.now()}_${signal.channelId || 'SIGNAL'}`,
      timestamp: Date.now(),
      utcDate: now.toISOString(),
      timeStr: now.toLocaleTimeString('es-ES', { timeZone: 'UTC' }),
      session: this.getSession(now),
      channel: {
        id: signal.channelId || 'N/A',
        name: signal.channelName || 'Canal'
      },
      order: {
        symbol: signal.symbol || 'XAUUSD',
        action: isBuy ? 'BUY' : 'SELL',
        entry,
        sl,
        tp1,
        tp2,
        tp3: signal.tp3 || null,
        slPips,
        tp1Pips,
        tp2Pips,
        rrRatioTP2,
        lotSize: executionPlan.totalLotSize || 0.01,
        isProvisionalSL: !!executionPlan.isProvisionalSL
      },
      brokerTelemetry: {
        liveBid: liveTick?.bid || null,
        liveAsk: liveTick?.ask || null,
        liveSpreadPips: liveSpread,
        entrySlippagePips: entrySlippage
      },
      psychologicalLevels: psychLevels,
      sessionContext: sessionCtx,
      candleAnatomyM5: candleM5,
      channelIntelligence: channelIntel,
      newsContext: {
        nextEvent: nextRedFolder ? nextRedFolder.title : 'Ninguna noticia cercana',
        minutesRemaining: minutesToNextNews,
        isSafeFromNews: minutesToNextNews === null || Math.abs(minutesToNextNews) > 10
      },
      outcome: {
        status: 'PENDING',
        pipsGained: 0,
        profitUSD: 0,
        durationMinutes: 0,
        resolvedAt: null
      }
    };

    this.snapshots.push(snapshot);
    this.saveData();

    console.log(`\n========================================================================================`);
    console.log(`📸 [CAJA NEGRA INSTITUCIONAL] Telemetría Completa Capturada para "${snapshot.channel.name}":`);
    console.log(`   • Orden: ${snapshot.order.action} ${snapshot.order.symbol} @ ${entry} (SL: ${slPips}p | TP1: ${tp1Pips}p | TP2: ${tp2Pips}p)`);
    console.log(`   • Nivel Redondo: ${psychLevels?.nearestRoundNumber} (a ${psychLevels?.distanceToRoundPips} pips de distancia)`);
    console.log(`   • Vela M5: ${candleM5?.pattern} (Mecha Sup: ${candleM5?.upperWickRatio * 100}% | Mecha Inf: ${candleM5?.lowerWickRatio * 100}%)`);
    console.log(`   • Sesión: ${snapshot.session} | Posición en 24h: ${sessionCtx?.positionIn24hRangePercent}% | Spread: ${liveSpread}p`);
    if (channelIntel.detectedKeywords.length > 0) {
      console.log(`   • Palabras Clave Detectadas: [${channelIntel.detectedKeywords.join(', ')}]`);
    }
    console.log(`========================================================================================\n`);

    return snapshot;
  }

  /**
   * Actualiza el resultado del trade cuando se cierra
   */
  resolveSnapshot(channelId, outcome, pips = 0, profitUSD = 0) {
    const pending = this.snapshots.slice().reverse().find(s => 
      (s.channel.id === channelId || s.channel.name === channelId) && s.outcome.status === 'PENDING'
    );
    if (pending) {
      pending.outcome.status = outcome;
      pending.outcome.pipsGained = pips;
      pending.outcome.profitUSD = profitUSD;
      pending.outcome.resolvedAt = new Date().toISOString();
      pending.outcome.durationMinutes = Math.round((Date.now() - pending.timestamp) / 60000);
      this.saveData();
      console.log(`📸 [Caja Negra Resuelta] ${pending.channel.name} -> ${outcome} (+${pips} pips, $${profitUSD} USD en ${pending.outcome.durationMinutes} min)`);
    }
  }
}

const marketSnapshotCollector = new MarketSnapshotCollector();

module.exports = {
  MarketSnapshotCollector,
  marketSnapshotCollector
};
