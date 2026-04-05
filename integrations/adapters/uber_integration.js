/**
 * Uber/DiDi Integration — Deep links para pedir viajes desde MIIA.
 * NO requiere API — usa deep links universales.
 * Proactivo: sugiere Uber cuando MIIA detecta que el owner tiene un evento con ubicación.
 * Firestore prefs: miia_interests/uber → { enabled, preferredApp: "uber"|"didi"|"cabify", homeAddress, workAddress }
 */
const BaseIntegration = require('../base_integration');

class UberIntegration extends BaseIntegration {
  constructor() {
    super({
      type: 'uber',
      displayName: 'Transporte (Uber/DiDi)',
      emoji: '🚗',
      checkIntervalMs: 1800000 // 30 min — chequea próximos eventos con ubicación
    });
  }

  /**
   * Generar deep link para la app de transporte.
   * @param {string} app - "uber" | "didi" | "cabify"
   * @param {Object} opts - { pickupLat, pickupLng, dropoffLat, dropoffLng, dropoffAddress }
   */
  static generateDeepLink(app, opts = {}) {
    const { pickupLat, pickupLng, dropoffLat, dropoffLng, dropoffAddress } = opts;

    switch (app) {
      case 'uber':
        let uberUrl = 'https://m.uber.com/ul/?action=setPickup&pickup=my_location';
        if (dropoffLat && dropoffLng) {
          uberUrl += `&dropoff[latitude]=${dropoffLat}&dropoff[longitude]=${dropoffLng}`;
        }
        if (dropoffAddress) {
          uberUrl += `&dropoff[formatted_address]=${encodeURIComponent(dropoffAddress)}`;
        }
        return uberUrl;

      case 'didi':
        // DiDi usa deep link universal
        return `https://d.didiglobal.com/`;

      case 'cabify':
        return `https://cabify.com/`;

      default:
        return 'https://m.uber.com/';
    }
  }

  async check(prefs, ctx) {
    if (!prefs.enabled) return [];

    // Chequear si hay eventos próximos (en los próximos 60 min) con ubicación
    const { admin } = this._deps;
    if (!admin) return [];

    try {
      const now = new Date();
      const in60min = new Date(now.getTime() + 3600000);

      const eventsSnap = await admin.firestore()
        .collection('users').doc(ctx.ownerUid)
        .collection('miia_agenda')
        .where('status', '==', 'pending')
        .where('scheduledFor', '>=', now.toISOString())
        .where('scheduledFor', '<=', in60min.toISOString())
        .limit(3)
        .get();

      if (eventsSnap.empty) return [];

      const messages = [];
      const app = prefs.preferredApp || 'uber';

      for (const doc of eventsSnap.docs) {
        const evt = doc.data();
        // Solo si el evento tiene ubicación o mencionan "ir a", "reunión en", etc.
        const hasLocation = evt.location || /\b(ir a|reunión en|cita en|consultorio|oficina)\b/i.test(evt.reason);
        if (!hasLocation) continue;

        const link = UberIntegration.generateDeepLink(app, {
          dropoffAddress: evt.location || ''
        });

        messages.push({
          message: `🚗 Tenés "${evt.reason}" pronto. ¿Pedimos un ${app.charAt(0).toUpperCase() + app.slice(1)}?\n${link}`,
          priority: 'medium'
        });
      }

      return messages;
    } catch (e) {
      this._error('Error chequeando eventos', e);
      return [];
    }
  }
}

module.exports = UberIntegration;
