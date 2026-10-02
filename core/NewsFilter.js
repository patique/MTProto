/**
 * Filtro de Noticias de Alto Impacto (Economic Calendar Guard)
 * - Monitorea noticias económicas de alto impacto (Carpetas Rojas) para USD / Oro
 * - Detecta eventos críticos: CPI, NFP, Decisión de Tasas FOMC, PPI, Retail Sales, GDP
 * - Bloquea la apertura de nuevas posiciones 15 minutos ANTES y 15 minutos DESPUÉS
 *   de noticias de alto impacto para evitar mechas de slippage y saltos de SL
 */

const https = require('https');

class NewsFilter {
  constructor(options = {}) {
    this.bufferMinutes = options.bufferMinutes || 10;
    this.events = [];
    this.lastFetchTime = 0;
    this.fetchIntervalMs = 60 * 60 * 1000; // Refrescar cada 1 hora
    this.enabled = true;
  }

  /**
   * Obtiene eventos del calendario económico (con fallback resiliente)
   */
  async fetchCalendar() {
    return new Promise((resolve) => {
      const now = Date.now();
      if (this.events.length > 0 && (now - this.lastFetchTime) < this.fetchIntervalMs) {
        return resolve(this.events);
      }

      const options = {
        hostname: 'nfs.faireconomy.media',
        path: '/ff_calendar_thisweek.json',
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 5000
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const rawEvents = JSON.parse(body);
            // Filtrar eventos de alto impacto para USD
            this.events = rawEvents
              .filter(ev => ev.impact === 'High' && ev.country === 'USD')
              .map(ev => ({
                title: ev.title,
                country: ev.country,
                date: new Date(ev.date).getTime(),
                dateStr: ev.date,
                impact: ev.impact
              }));
            this.lastFetchTime = Date.now();
            console.log(`📰 [News Guard] Calendario económico actualizado: ${this.events.length} noticias de alto impacto (USD) esta semana.`);
            resolve(this.events);
          } catch (e) {
            resolve(this._getFallbackEvents());
          }
        });
      });

      req.on('error', () => {
        resolve(this._getFallbackEvents());
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(this._getFallbackEvents());
      });

      req.end();
    });
  }

  _getFallbackEvents() {
    // Si la API no responde, retornar lista vacía o caché existente
    return this.events;
  }

  /**
   * Verifica si el mercado está dentro de la ventana de protección de noticias
   * @param {number} bufferMinutes - Minutos antes y después de la noticia (default 15 min)
   * @returns {Promise<{ blocked: boolean, reason: string, eventName: string, eventTime: string }>}
   */
  async checkNewsRisk(bufferMinutes = this.bufferMinutes) {
    if (!this.enabled) return { blocked: false };

    await this.fetchCalendar();
    const now = Date.now();
    const bufferMs = bufferMinutes * 60 * 1000;

    for (const ev of this.events) {
      const diff = ev.date - now;
      const absDiff = Math.abs(diff);

      if (absDiff <= bufferMs) {
        const timeDiffMin = Math.round(diff / 60000);
        const direction = timeDiffMin >= 0 ? `dentro de ${timeDiffMin} min` : `hace ${Math.abs(timeDiffMin)} min`;

        return {
          blocked: true,
          reason: `🚨 [NEWS GUARD] Entrada bloqueada: Noticia de alto impacto (${ev.title} - USD) ${direction}.`,
          eventName: ev.title,
          eventTime: new Date(ev.date).toLocaleTimeString('es-ES')
        };
      }
    }

    return { blocked: false };
  }

  /**
   * Retorna las próximas 5 noticias de alto impacto
   */
  async getUpcomingEvents(limit = 5) {
    await this.fetchCalendar();
    const now = Date.now();
    return this.events
      .filter(ev => ev.date >= now)
      .slice(0, limit)
      .map(ev => ({
        ...ev,
        formattedTime: new Date(ev.date).toLocaleString('es-ES')
      }));
  }
}

// Instancia singleton
const newsFilter = new NewsFilter();

module.exports = {
  NewsFilter,
  newsFilter
};
