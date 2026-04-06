'use strict';

/**
 * TRAVEL TRACKER v1.0 — Búsqueda de vuelos, alertas de precio, info destinos
 *
 * Funcionalidades:
 * 1. Buscar vuelos: "busca vuelos BOG→EZE mayo" → Gemini google_search
 * 2. Alerta de precio: "avisame si hay vuelos BOG→EZE por menos de $200"
 * 3. Info destino: "qué necesito para viajar a Chile?" → visa, moneda, clima, etc.
 * 4. Checklist viaje: genera lista personalizada según destino + duración
 * 5. Documentos: recuerda pasaporte, visa, avisa 3 meses antes de vencimiento
 *
 * Firestore: users/{uid}/miia_travel/
 *   alerts/{id} → { origin, destination, maxPrice, currency, dates, lastCheck, status }
 *   trips/{id} → { destination, dates, checklist[], status }
 *   passport → { number, expiry, country }
 */

const admin = require('firebase-admin');

let _generateAIContent = null;
let _safeSendMessage = null;
let _getOwnerSock = null;
let _ownerUid = null;

/**
 * Inicializar travel tracker
 */
function initTravelTracker(deps) {
  _generateAIContent = deps.generateAIContent;
  _safeSendMessage = deps.safeSendMessage;
  _getOwnerSock = deps.getOwnerSock;
  _ownerUid = deps.ownerUid;
  console.log('[TRAVEL] ✅ Inicializado');
}

/**
 * Buscar vuelos con Gemini google_search
 * @param {string} origin - Ciudad/código origen
 * @param {string} destination - Ciudad/código destino
 * @param {string} dateRange - Rango de fechas ("mayo 2026", "15-20 junio")
 * @returns {Promise<string>} - Respuesta formateada con opciones de vuelos
 */
async function searchFlights(origin, destination, dateRange) {
  if (!_generateAIContent) return 'Travel tracker no inicializado';

  const prompt = `Busca vuelos de ${origin} a ${destination} para ${dateRange}.
Dame las 3-5 mejores opciones con:
- Aerolínea
- Precio (en USD y moneda local si aplica)
- Duración del vuelo
- Escalas (directo o con X escalas)
- Link o referencia para comprar

Formato limpio, sin explicaciones largas. Solo datos útiles.`;

  try {
    const result = await _generateAIContent(prompt, { enableSearch: true });
    return result || 'No encontré vuelos para esas fechas. Probá con otras fechas o destinos.';
  } catch (e) {
    console.error(`[TRAVEL] ❌ Error buscando vuelos:`, e.message);
    return 'Error buscando vuelos. Intentá de nuevo.';
  }
}

/**
 * Crear alerta de precio de vuelo
 */
async function createFlightAlert(ownerUid, origin, destination, maxPrice, currency, dateRange) {
  try {
    const alertRef = admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_travel').doc('alerts')
      .collection('items');

    const doc = await alertRef.add({
      origin,
      destination,
      maxPrice,
      currency: currency || 'USD',
      dateRange: dateRange || 'flexible',
      status: 'active',
      lastCheck: null,
      lastPrice: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[TRAVEL] ✅ Alerta creada: ${origin}→${destination} < ${maxPrice} ${currency} (ID: ${doc.id})`);
    return { success: true, alertId: doc.id };
  } catch (e) {
    console.error(`[TRAVEL] ❌ Error creando alerta:`, e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Obtener info de destino
 */
async function getDestinationInfo(destination) {
  if (!_generateAIContent) return 'Travel tracker no inicializado';

  const prompt = `Dame información práctica para viajar a ${destination}. Incluye:
1. 🛂 Visa/documentos necesarios (para colombianos y argentinos)
2. 💰 Moneda local y tipo de cambio aproximado
3. 🌡️ Clima actual/estacional
4. 🔌 Tipo de enchufe eléctrico
5. 💉 Vacunas requeridas/recomendadas
6. 🚕 Transporte desde aeropuerto al centro
7. 📱 eSIM o chip local para datos
8. ⚠️ Tips de seguridad

Sé conciso, máximo 3 líneas por punto.`;

  try {
    return await _generateAIContent(prompt, { enableSearch: true }) || 'No encontré info sobre ese destino.';
  } catch (e) {
    console.error(`[TRAVEL] ❌ Error obteniendo info destino:`, e.message);
    return 'Error buscando info del destino.';
  }
}

/**
 * Generar checklist de viaje personalizado
 */
async function generateChecklist(destination, duration, purpose) {
  if (!_generateAIContent) return 'Travel tracker no inicializado';

  const prompt = `Genera un checklist de viaje para ${destination} por ${duration || '7 días'} (${purpose || 'turismo'}).
Categorías:
- 📄 Documentos (pasaporte, seguro, reservas)
- 🧳 Equipaje esencial
- 💰 Finanzas (tarjetas, efectivo local)
- 📱 Tech (adaptadores, apps)
- 🏥 Salud (botiquín, medicamentos)
- 📋 Antes de salir (cerrar gas, avisar banco)

Formato: checkbox markdown. Sé específico para ${destination}.`;

  try {
    return await _generateAIContent(prompt, { enableSearch: true }) || 'No pude generar el checklist.';
  } catch (e) {
    console.error(`[TRAVEL] ❌ Error generando checklist:`, e.message);
    return 'Error generando checklist.';
  }
}

/**
 * Guardar/consultar pasaporte
 */
async function savePassport(ownerUid, data) {
  try {
    await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_travel').doc('passport')
      .set({
        number: data.number || null,
        expiry: data.expiry || null,
        country: data.country || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    console.log(`[TRAVEL] ✅ Pasaporte guardado (vence: ${data.expiry})`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Polling de alertas de vuelos — ejecutar diariamente
 */
async function checkFlightAlerts(ownerUid) {
  if (!_generateAIContent) return;

  try {
    const alertsSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_travel').doc('alerts')
      .collection('items')
      .where('status', '==', 'active')
      .limit(10)
      .get();

    if (alertsSnap.empty) return;

    for (const doc of alertsSnap.docs) {
      const alert = doc.data();

      // Verificar intervalo (1 check por día)
      const lastCheck = alert.lastCheck ? new Date(alert.lastCheck).getTime() : 0;
      if (Date.now() - lastCheck < 24 * 3600000) continue;

      const checkPrompt = `Busca el vuelo más barato de ${alert.origin} a ${alert.destination}${alert.dateRange !== 'flexible' ? ` para ${alert.dateRange}` : ''}.
Responde SOLO en JSON: {"cheapestPrice": 150, "currency": "USD", "airline": "Avianca", "details": "directo, 5h"}
Si no encontrás, responde: {"cheapestPrice": null}`;

      try {
        const result = await _generateAIContent(checkPrompt, { enableSearch: true });
        if (!result) continue;

        const jsonMatch = result.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) continue;
        const data = JSON.parse(jsonMatch[0]);

        await doc.ref.update({
          lastCheck: new Date().toISOString(),
          lastPrice: data.cheapestPrice
        });

        if (data.cheapestPrice && data.cheapestPrice <= alert.maxPrice) {
          // ¡Alerta! Precio por debajo del umbral
          const ownerJid = _getOwnerSock()?.user?.id;
          if (ownerJid) {
            const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
            await _safeSendMessage(ownerSelf,
              `✈️ *¡Vuelo barato encontrado!*\n🛫 ${alert.origin} → ${alert.destination}\n💰 *${data.currency} ${data.cheapestPrice}* (tu límite: ${alert.maxPrice})\n🏢 ${data.airline || 'Varias aerolíneas'}\n📋 ${data.details || ''}\n\n¿Lo reservamos? 🔥`,
              { isSelfChat: true }
            );
          }
          console.log(`[TRAVEL] ✈️ Alerta de vuelo! ${alert.origin}→${alert.destination} @ ${data.cheapestPrice} ${data.currency}`);
        }

        await new Promise(r => setTimeout(r, 3000)); // Rate limit
      } catch (checkErr) {
        console.error(`[TRAVEL] ❌ Error checking flight ${alert.origin}→${alert.destination}:`, checkErr.message);
      }
    }
  } catch (e) {
    console.error(`[TRAVEL] ❌ Error en checkFlightAlerts:`, e.message);
  }
}

/**
 * Verificar vencimiento de pasaporte — ejecutar semanalmente
 */
async function checkPassportExpiry(ownerUid) {
  try {
    const passDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_travel').doc('passport')
      .get();

    if (!passDoc.exists || !passDoc.data().expiry) return;

    const expiry = new Date(passDoc.data().expiry);
    const now = new Date();
    const monthsUntilExpiry = (expiry - now) / (30 * 24 * 3600000);

    if (monthsUntilExpiry <= 3 && monthsUntilExpiry > 0) {
      const ownerJid = _getOwnerSock()?.user?.id;
      if (ownerJid) {
        const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
        await _safeSendMessage(ownerSelf,
          `🛂 *Recordatorio de pasaporte*\nTu pasaporte vence en *${Math.round(monthsUntilExpiry)} meses* (${expiry.toLocaleDateString('es-CO')}). Muchos países requieren 6 meses de vigencia. ¡Renovalo pronto!`,
          { isSelfChat: true }
        );
      }
    }
  } catch (e) {
    console.error(`[TRAVEL] ❌ Error checking passport:`, e.message);
  }
}

module.exports = {
  initTravelTracker,
  searchFlights,
  createFlightAlert,
  getDestinationInfo,
  generateChecklist,
  savePassport,
  checkFlightAlerts,
  checkPassportExpiry
};
