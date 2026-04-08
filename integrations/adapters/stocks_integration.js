/**
 * Stocks & Crypto Integration — Alertas de precios para MIIA.
 * API: Gemini google_search (gratis, precios en tiempo real)
 * Alerta cuando precio sube/baja más del umbral configurado.
 * Firestore prefs: miia_interests/stocks → { enabled, symbols: ["AAPL","BTC-USD"], alertThreshold: 5 }
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */
const BaseIntegration = require('../base_integration');

class StocksIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'stocks',
      displayName: 'Bolsa & Crypto',
      emoji: '📈',
      checkIntervalMs: 14400000 // 4 horas
    });
  }

  async check(prefs, ctx) {
    if (!prefs?.enabled) return [];

    const symbols = prefs.symbols || [];
    if (symbols.length === 0) return [];

    const { generateAIContent } = this._deps;
    if (!generateAIContent) return [];

    try {
      const threshold = prefs.alertThreshold || 5; // % default
      const today = new Date().toLocaleDateString('es-AR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

      const prompt = `Sos MIIA, asistente personal. Buscá los precios ACTUALES de: ${symbols.join(', ')} (a ${today}).

Para cada uno:
- Precio actual
- Cambio % del día
- Cambio % de la última semana
- Si el cambio del día supera ${threshold}%, destacalo con ⚠️

Formato: mensaje de WhatsApp corto, máximo 10 líneas. Emojis: 📈 sube, 📉 baja, ➡️ estable.
Al final: 1 línea de análisis rápido (informal, tipo amigo que sabe de finanzas).
Usá google_search para datos REALES y ACTUALES.`;

      const response = await generateAIContent(prompt, { enableSearch: true });

      if (response && response.length > 20) {
        this._log(`Precios generados para ${symbols.join(', ')} (${response.length} chars)`);

        if (ctx.admin && ctx.ownerUid) {
          await this.savePrefs(ctx.admin, ctx.ownerUid, { lastCheck: new Date().toISOString() });
        }

        return [{
          message: `📈 *Mercados — ${today}*\n\n${response}`,
          priority: 'medium'
        }];
      }
    } catch (e) {
      this._error('Error chequeando precios', e);
    }

    return [];
  }
}

module.exports = StocksIntegration;
