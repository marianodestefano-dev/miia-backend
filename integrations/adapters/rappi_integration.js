/**
 * Rappi/PedidosYa Integration — Deep links para delivery + sugerencia de almuerzo.
 * NO requiere API — usa deep links + IA para sugerir.
 * Proactivo: "Son las 12, ¿pido tu almuerzo?" con deep link.
 * Firestore prefs: miia_interests/rappi → { enabled, preferredApp: "rappi"|"pedidosya", lunchTime: "12:00", favoriteOrders: [], city }
 */
const BaseIntegration = require('../base_integration');

class RappiIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'rappi',
      displayName: 'Delivery (Rappi/PedidosYa)',
      emoji: '🛵',
      checkIntervalMs: 3600000
    });
    this._lastSuggestionDate = null;
  }

  static getDeepLink(app, city) {
    switch (app) {
      case 'rappi':
        return 'https://www.rappi.com/';
      case 'pedidosya':
        return 'https://www.pedidosya.com/';
      case 'ifood':
        return 'https://www.ifood.com.br/';
      default:
        return 'https://www.rappi.com/';
    }
  }

  async check(prefs, ctx) {
    if (!prefs.enabled) return [];

    const tz = prefs.timezone || 'America/Bogota';
    const localNow = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const h = localNow.getHours();
    const m = localNow.getMinutes();
    const todayStr = localNow.toISOString().split('T')[0];

    if (this._lastSuggestionDate === todayStr) return [];

    const lunchHour = parseInt(prefs.lunchTime?.split(':')[0]) || 12;
    // Sugerir 30 min antes del almuerzo
    if (h !== lunchHour || m > 30) return [];

    this._lastSuggestionDate = todayStr;

    const app = prefs.preferredApp || 'rappi';
    const appName = app.charAt(0).toUpperCase() + app.slice(1);
    const link = RappiIntegration.getDeepLink(app, prefs.city);

    const favorites = prefs.favoriteOrders?.length > 0
      ? `\nTus favoritos: ${prefs.favoriteOrders.slice(0, 3).join(', ')}`
      : '';

    return [{
      message: `🛵 ¡Son las ${lunchHour}! ¿Pedimos almuerzo por ${appName}?${favorites}\n${link}`,
      priority: 'low'
    }];
  }
}

module.exports = RappiIntegration;
