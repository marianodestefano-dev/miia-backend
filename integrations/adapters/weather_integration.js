/**
 * Weather Integration — Clima proactivo para MIIA.
 * API: Gemini google_search (gratis, datos en tiempo real)
 * Briefing matutino: pronóstico del día para la ciudad del owner.
 * On-demand: "¿qué clima hay?" → respuesta inmediata.
 * Firestore prefs: miia_interests/weather → { enabled, city, alertRain, morningForecast }
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */
const BaseIntegration = require('../base_integration');

class WeatherIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'weather',
      displayName: 'Clima',
      emoji: '🌤️',
      checkIntervalMs: 14400000 // 4 horas (solo corre si morning briefing lo invoca)
    });
  }

  /**
   * Check estándar del engine (cada 4h si hay prefs).
   * Genera pronóstico y devuelve mensaje para enviar al owner.
   */
  async check(prefs, ctx) {
    if (!prefs?.enabled && !prefs?.city) return [];

    const city = prefs.city;
    if (!city) {
      this._log('Sin ciudad configurada — saltando');
      return [];
    }

    return this._generateForecast(city, prefs, ctx);
  }

  /**
   * Llamada directa desde morning_briefing.checkWeather(ownerUid, city).
   * NO depende de prefs — usa la ciudad que le pasan.
   */
  async checkDirect(city, ctx) {
    if (!city) return [];
    return this._generateForecast(city, { alertRain: true, morningForecast: true }, ctx);
  }

  /**
   * Genera el pronóstico usando Gemini google_search.
   */
  async _generateForecast(city, prefs, ctx) {
    const { generateAIContent } = this._deps;
    if (!generateAIContent) {
      this._error('generateAIContent no disponible');
      return [];
    }

    try {
      const today = new Date().toLocaleDateString('es-AR', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });

      const prompt = `Sos MIIA, asistente personal argentino. Buscá el pronóstico del clima para HOY ${today} en ${city}.

Incluí:
- Temperatura actual y sensación térmica
- Máxima y mínima del día
- Probabilidad de lluvia (si hay, avisá con énfasis)
- Humedad y viento
- Recomendación breve (paraguas, abrigo, protector solar, etc.)

Formato: mensaje de WhatsApp casual, máximo 8 líneas. Emojis moderados.
${prefs.alertRain ? 'Si hay probabilidad de lluvia >30%, destacalo con ⚠️.' : ''}
Usá google_search para obtener datos REALES y ACTUALES del clima.`;

      const response = await generateAIContent(prompt, { enableSearch: true });

      if (response && response.length > 20) {
        this._log(`Pronóstico generado para ${city} (${response.length} chars)`);

        // Guardar última consulta
        if (ctx.admin && ctx.ownerUid) {
          await this.savePrefs(ctx.admin, ctx.ownerUid, {
            lastCheck: new Date().toISOString(),
            city
          });
        }

        return [{
          message: `🌤️ *Clima en ${city} — ${today}*\n\n${response}`,
          priority: 'medium'
        }];
      }

      this._log(`Respuesta vacía o muy corta para ${city}`);
    } catch (e) {
      this._error(`Error generando pronóstico para ${city}`, e);
    }

    return [];
  }
}

module.exports = WeatherIntegration;
