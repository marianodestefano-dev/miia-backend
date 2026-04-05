/**
 * Gym/Ejercicio Integration — Rutinas personalizadas + motivación.
 * API: Gemini (genera rutinas) + Nutritionix (tracking nutricional, futuro)
 * Proactivo: recordatorio de ejercicio a la hora configurada.
 * DISCLAIMER: MIIA no es profesional médico. Siempre consultar con un profesional.
 * Firestore prefs: miia_interests/gym → { enabled, exerciseTime: "07:00", level: "intermedio", goals, injuries, gymNearby }
 */
const BaseIntegration = require('../base_integration');

class GymIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'gym',
      displayName: 'Ejercicio & Salud',
      emoji: '💪',
      checkIntervalMs: 3600000
    });
    this._lastRoutineDate = null;
  }

  async check(prefs, ctx) {
    if (!prefs.enabled) return [];

    const { generateAIContent } = this._deps;
    if (!generateAIContent) return [];

    const tz = prefs.timezone || 'America/Bogota';
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const h = localNow.getHours();
    const todayStr = localNow.toISOString().split('T')[0];
    const dayOfWeek = localNow.toLocaleDateString('es-ES', { weekday: 'long', timeZone: tz });

    if (this._lastRoutineDate === todayStr) return [];
    const exerciseHour = parseInt(prefs.exerciseTime?.split(':')[0]) || 7;
    if (h < exerciseHour - 1 || h > exerciseHour + 1) return [];

    this._lastRoutineDate = todayStr;

    try {
      const level = prefs.level || 'intermedio';
      const goals = prefs.goals ? `\nObjetivos: ${prefs.goals}` : '';
      const injuries = prefs.injuries ? `\nLesiones/limitaciones: ${prefs.injuries}` : '';

      const prompt = `Sos MIIA, asistente personal. Generá una rutina de ejercicio para hoy (${dayOfWeek}). Nivel: ${level}.${goals}${injuries}
Formato: nombre del ejercicio + series x repeticiones. Máximo 6 ejercicios. Incluí calentamiento (1 línea) y estiramiento (1 línea).
IMPORTANTE: Al final agregá: "⚠️ _Recordá que no soy profesional médico. Consultá con tu médico antes de iniciar cualquier rutina._"
Máximo 12 líneas total. Sé motivadora pero profesional.`;

      const response = await generateAIContent(prompt);
      if (response && response.length > 10) {
        return [{
          message: `💪 *Rutina del día — ${dayOfWeek}*\n${response}`,
          priority: 'low'
        }];
      }
    } catch (e) {
      this._error('Error generando rutina', e);
    }

    return [];
  }
}

module.exports = GymIntegration;
