/**
 * News Integration — Noticias proactivas para MIIA.
 * API: Gemini google_search (gratis, noticias en tiempo real)
 * Briefing matutino: resumen de noticias del día por sector/país.
 * Firestore prefs: miia_interests/news → { enabled, topics: ["salud","tecnología"], country: "CO", language: "es" }
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */
const BaseIntegration = require('../base_integration');

class NewsIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'news',
      displayName: 'Noticias',
      emoji: '📰',
      checkIntervalMs: 28800000 // 8 horas
    });
  }

  async check(prefs, ctx) {
    if (!prefs?.enabled) return [];
    return this._generateNewsSummary(prefs, ctx);
  }

  /**
   * Llamada directa desde morning_briefing.
   */
  async checkDirect(ctx) {
    // Leer prefs de Firestore
    let prefs = null;
    if (ctx.admin && ctx.ownerUid) {
      prefs = await this.getPrefs(ctx.admin, ctx.ownerUid);
    }

    // Default prefs si no hay configuradas
    if (!prefs) {
      prefs = { topics: ['tecnología', 'negocios', 'inteligencia artificial'], country: 'AR', language: 'es' };
    }

    return this._generateNewsSummary(prefs, ctx);
  }

  async _generateNewsSummary(prefs, ctx) {
    const { generateAIContent } = this._deps;
    if (!generateAIContent) {
      this._error('generateAIContent no disponible');
      return [];
    }

    try {
      const topics = prefs.topics?.join(', ') || 'tecnología, negocios, actualidad';
      const country = prefs.country || 'AR';
      const today = new Date().toLocaleDateString('es-AR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

      const countryNames = {
        AR: 'Argentina', CO: 'Colombia', MX: 'México', ES: 'España',
        CL: 'Chile', PE: 'Perú', UY: 'Uruguay', PY: 'Paraguay', BR: 'Brasil'
      };
      const countryName = countryNames[country] || country;

      const prompt = `Sos MIIA, asistente personal argentino. Buscá las noticias más importantes de HOY ${today} relevantes para alguien en ${countryName}.

Temas de interés: ${topics}

Formato:
- 5 noticias máximo, las más relevantes
- Cada noticia: 1 emoji + título + resumen de 1 línea
- Al final: 1 línea de comentario tipo "amigo" (informal, argentino)

Máximo 12 líneas total. Mensaje de WhatsApp casual.
Usá google_search para encontrar noticias REALES de HOY.`;

      const response = await generateAIContent(prompt, { enableSearch: true });

      if (response && response.length > 30) {
        this._log(`Resumen de noticias generado (${response.length} chars)`);

        if (ctx.admin && ctx.ownerUid) {
          await this.savePrefs(ctx.admin, ctx.ownerUid, { lastCheck: new Date().toISOString() });
        }

        return [{
          message: `📰 *Noticias del día — ${today}*\n\n${response}`,
          priority: 'medium'
        }];
      }
    } catch (e) {
      this._error('Error generando resumen de noticias', e);
    }

    return [];
  }
}

module.exports = NewsIntegration;
