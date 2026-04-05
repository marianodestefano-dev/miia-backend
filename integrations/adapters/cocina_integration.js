/**
 * Cocina Integration — Recetas basadas en foto de ingredientes (Gemini Vision) + sugerencias.
 * API: Gemini Vision (foto→ingredientes) + Gemini (generar receta)
 * NO proactivo por defecto — se activa cuando el owner manda foto de ingredientes.
 * Proactivo: sugerencia diaria a la hora del almuerzo si está habilitado.
 * Firestore prefs: miia_interests/cocina → { enabled, lunchTime: "12:00", dietRestrictions, favoriteRecipes[] }
 */
const BaseIntegration = require('../base_integration');

class CocinaIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'cocina',
      displayName: 'Cocina Inteligente',
      emoji: '🍳',
      checkIntervalMs: 3600000 // 1 hora — chequea si es hora del almuerzo
    });
    this._lastSuggestionDate = null;
  }

  async check(prefs, ctx) {
    if (!prefs.enabled) return [];

    // Sugerencia proactiva: una vez al día cerca de la hora de almuerzo
    const { generateAIContent } = this._deps;
    if (!generateAIContent) return [];

    const tz = prefs.timezone || 'America/Bogota';
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const h = localNow.getHours();
    const todayStr = localNow.toISOString().split('T')[0];

    // Solo sugerir 1 vez al día, entre 11:00 y 13:00
    if (this._lastSuggestionDate === todayStr) return [];
    const lunchHour = parseInt(prefs.lunchTime?.split(':')[0]) || 12;
    if (h < lunchHour - 1 || h > lunchHour + 1) return [];

    this._lastSuggestionDate = todayStr;

    try {
      const restrictions = prefs.dietRestrictions ? `\nRestricciones: ${prefs.dietRestrictions}` : '';
      const favorites = prefs.favoriteRecipes?.length > 0 ? `\nRecetas favoritas: ${prefs.favoriteRecipes.join(', ')}` : '';
      const prompt = `Sos MIIA, asistente personal. Sugerí UNA receta rápida y rica para el almuerzo de hoy. Máximo 3 líneas. Sé creativa pero realista. Incluí tiempo de preparación.${restrictions}${favorites}\nFormato: nombre de receta + ingredientes principales + tiempo.`;

      const response = await generateAIContent(prompt);
      if (response && response.length > 10) {
        return [{
          message: `🍳 *Sugerencia para el almuerzo*\n${response}`,
          priority: 'low'
        }];
      }
    } catch (e) {
      this._error('Error generando sugerencia', e);
    }

    return [];
  }

  /**
   * Analizar foto de ingredientes — llamado desde message handler cuando detecta imagen + contexto cocina.
   * @param {Buffer} imageBuffer
   * @param {string} mimeType
   * @param {Object} prefs
   * @returns {string} Receta sugerida
   */
  async analyzePhoto(imageBuffer, mimeType, prefs = {}) {
    const { generateAIContent } = this._deps;
    if (!generateAIContent) throw new Error('generateAIContent no disponible');

    // Gemini Vision: base64 de la imagen + prompt
    const base64 = imageBuffer.toString('base64');
    const restrictions = prefs.dietRestrictions ? `\nRestricciones dietéticas: ${prefs.dietRestrictions}` : '';

    // Usamos el endpoint multimodal de Gemini
    const prompt = `Analizá esta foto de ingredientes y sugerí 2-3 recetas que se puedan hacer con lo que ves. Para cada receta: nombre, pasos resumidos (máx 4), tiempo estimado.${restrictions}\nSé concisa, máximo 15 líneas total.`;

    // La llamada real a Gemini Vision se hace desde server.js con el contenido multimodal
    // Aquí devolvemos el prompt para que server.js lo ejecute
    return { prompt, imageBase64: base64, mimeType };
  }
}

module.exports = CocinaIntegration;
