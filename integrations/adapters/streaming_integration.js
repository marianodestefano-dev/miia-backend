/**
 * Streaming Integration (Netflix/HBO/Prime) — Recomendaciones basadas en gustos.
 * API: Gemini google_search (busca estrenos y recomendaciones)
 * Proactivo: sugerencia semanal de qué ver.
 * Firestore prefs: miia_interests/streaming → { enabled, services: ["netflix","prime","hbo"], genres: ["sci-fi","thriller"], lastRecommendation }
 */
const BaseIntegration = require('../base_integration');

class StreamingIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'streaming',
      displayName: 'Streaming (Netflix/HBO/Prime)',
      emoji: '🎬',
      checkIntervalMs: 21600000 // 6 horas
    });
  }

  async check(prefs, ctx) {
    if (!prefs.enabled) return [];

    const { generateAIContent } = this._deps;
    if (!generateAIContent) return [];

    // Solo recomendar 1 vez por semana (o si nunca se recomendó)
    const lastRec = prefs.lastRecommendation ? new Date(prefs.lastRecommendation) : new Date(0);
    const daysSinceLastRec = (Date.now() - lastRec.getTime()) / 86400000;
    if (daysSinceLastRec < 7) return [];

    try {
      const services = prefs.services?.join(', ') || 'Netflix, Amazon Prime, HBO Max';
      const genres = prefs.genres?.join(', ') || 'variados';
      const today = new Date().toISOString().split('T')[0];

      const prompt = `Sos MIIA, asistente personal. Buscá los estrenos más recientes y populares en ${services} (a ${today}). Géneros preferidos: ${genres}.
Recomendá 3 títulos: nombre + plataforma + por qué lo recomendás (1 línea c/u). Máximo 8 líneas total.
Usá google_search para encontrar estrenos reales y actuales.`;

      const response = await generateAIContent(prompt, { enableSearch: true });
      if (response && response.length > 10) {
        // Actualizar lastRecommendation
        if (ctx.admin && ctx.ownerUid) {
          await this.savePrefs(ctx.admin, ctx.ownerUid, { lastRecommendation: new Date().toISOString() });
        }

        return [{
          message: `🎬 *Recomendaciones de la semana*\n${response}`,
          priority: 'low'
        }];
      }
    } catch (e) {
      this._error('Error generando recomendaciones', e);
    }

    return [];
  }
}

module.exports = StreamingIntegration;
