'use strict';

/**
 * MIIA RESERVATIONS INTEGRATION — Sistema de búsqueda y gestión de reservas.
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Fase R1 (MVP):
 *   - Buscar negocios via Gemini google_search
 *   - Guardar/leer favoritos del owner
 *   - CRUD de reservas en Firestore
 *   - Tags: [BUSCAR_RESERVA:], [RESERVAR:], [CANCELAR_RESERVA:], [RATING_RESERVA:]
 *
 * Fase R2 (Red inter-MIIA):
 *   - Negocios que usan MIIA se registran en miia_network
 *   - Al buscar, primero se consulta la red MIIA (prioridad sobre Google)
 *   - Si el negocio destino está en MIIA → reserva automática vía WhatsApp
 *   - Tag: [RESERVAR_MIIA:bizPhone|date|time|partySize|notes]
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

const admin = require('firebase-admin');
const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const RESERVATION_TYPES = ['restaurant', 'doctor', 'salon', 'dentist', 'mechanic', 'hotel', 'spa', 'gym', 'other'];
const RESERVATION_STATUS = ['searching', 'pending', 'confirmed', 'cancelled', 'completed'];

// ═══════════════════════════════════════════════════════════════
// R2: RED INTER-MIIA — Negocios que usan MIIA pueden reservar entre sí
// ═══════════════════════════════════════════════════════════════

/**
 * Registrar un negocio en la red MIIA (se llama cuando un owner activa reservas).
 * Colección: miia_network/{bizPhone}
 */
async function registerInMiiaNetwork(uid, businessData) {
  const phone = (businessData.phone || '').replace(/[^0-9]/g, '');
  if (!phone) {
    console.warn(`[MIIA-NETWORK] ⚠️ No se puede registrar sin teléfono`);
    return null;
  }

  const networkDoc = {
    ownerUid: uid,
    name: businessData.name || '',
    type: businessData.type || 'other',
    address: businessData.address || '',
    city: businessData.city || '',
    country: businessData.country || '',
    phone,
    description: businessData.description || '',
    acceptsReservations: businessData.acceptsReservations !== false,
    autoConfirm: businessData.autoConfirm || false,
    maxPartySize: businessData.maxPartySize || 20,
    hours: businessData.hours || '',
    tags: businessData.tags || [],
    rating: businessData.rating || 0,
    ratingCount: businessData.ratingCount || 0,
    active: true,
    registeredAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('miia_network').doc(phone).set(networkDoc, { merge: true });
  console.log(`[MIIA-NETWORK] ✅ Negocio registrado en red MIIA: ${networkDoc.name} (${phone})`);
  return { networkId: phone, ...networkDoc };
}

/**
 * Eliminar un negocio de la red MIIA.
 */
async function unregisterFromMiiaNetwork(phone) {
  const cleanPhone = (phone || '').replace(/[^0-9]/g, '');
  if (!cleanPhone) return;

  await db.collection('miia_network').doc(cleanPhone).update({
    active: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[MIIA-NETWORK] 🔴 Negocio desregistrado: ${cleanPhone}`);
}

/**
 * Buscar negocios dentro de la red MIIA primero (prioridad sobre Google).
 * @param {object} params - { type, zone, city, country }
 * @returns {Array<{name, address, phone, rating, type, isMiia: true}>}
 */
async function searchMiiaNetwork(params) {
  const { type, city, country } = params;

  let query = db.collection('miia_network')
    .where('active', '==', true)
    .where('acceptsReservations', '==', true);

  if (type && type !== 'other') {
    query = query.where('type', '==', type);
  }

  // Firestore no soporta OR queries complejas, así que filtramos ciudad/país en memoria
  const snap = await query.limit(50).get();
  let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Filtrar por ciudad/país si están disponibles
  if (city) {
    const cityLower = city.toLowerCase();
    const cityResults = results.filter(r =>
      (r.city || '').toLowerCase().includes(cityLower) ||
      (r.address || '').toLowerCase().includes(cityLower)
    );
    // Si hay resultados en la ciudad, priorizar esos
    if (cityResults.length > 0) results = cityResults;
  }
  if (country) {
    const countryLower = country.toLowerCase();
    results = results.filter(r =>
      !r.country || r.country.toLowerCase().includes(countryLower)
    );
  }

  // Marcar como negocios MIIA y formatear
  const formatted = results.slice(0, 5).map(r => ({
    name: r.name,
    address: r.address,
    phone: r.phone,
    rating: r.rating || 0,
    hours: r.hours,
    type: r.type,
    description: r.description,
    isMiia: true, // ← Flag clave para el tag interceptor
    autoConfirm: r.autoConfirm || false,
    ownerUid: r.ownerUid,
  }));

  console.log(`[MIIA-NETWORK] 🔍 Búsqueda en red: ${type || 'all'} en ${city || 'anywhere'} → ${formatted.length} resultados MIIA`);
  return formatted;
}

/**
 * Enviar solicitud de reserva inter-MIIA al negocio destino.
 * El negocio destino la recibe como mensaje de WhatsApp en su self-chat.
 * @param {object} params - { fromOwnerName, bizPhone, date, time, partySize, notes, fromPhone }
 * @param {function} sendMessageFn - función para enviar mensaje WhatsApp (ej: safeSendMessage)
 * @returns {object} { sent, reservationRequest }
 */
async function sendInterMiiaReservation(params, sendMessageFn) {
  const { fromOwnerName, bizPhone, date, time, partySize, notes, fromPhone } = params;

  if (!bizPhone || !sendMessageFn) {
    console.error(`[MIIA-NETWORK] ❌ sendInterMiiaReservation: falta bizPhone o sendMessageFn`);
    return { sent: false, error: 'Parámetros incompletos' };
  }

  // Verificar que el negocio está en la red MIIA
  const cleanPhone = bizPhone.replace(/[^0-9]/g, '');
  const networkDoc = await db.collection('miia_network').doc(cleanPhone).get();

  if (!networkDoc.exists || !networkDoc.data().active) {
    console.warn(`[MIIA-NETWORK] ⚠️ Negocio ${cleanPhone} no está activo en red MIIA`);
    return { sent: false, error: 'Negocio no disponible en red MIIA' };
  }

  const bizData = networkDoc.data();
  const jid = `${cleanPhone}@s.whatsapp.net`;

  // Mensaje que el negocio destino recibe (su MIIA lo procesará como lead)
  const reservationMessage = `Hola! Quiero hacer una reserva:\n` +
    `📅 Fecha: ${date}\n` +
    `🕐 Hora: ${time}\n` +
    `👥 Personas: ${partySize || 1}\n` +
    `${notes ? `📝 Nota: ${notes}\n` : ''}` +
    `Mi nombre: ${fromOwnerName || 'Cliente MIIA'}\n` +
    `📱 Mi número: ${fromPhone || 'No disponible'}`;

  try {
    await sendMessageFn(jid, reservationMessage, { skipDelay: true });
    console.log(`[MIIA-NETWORK] ✅ Reserva inter-MIIA enviada a ${bizData.name} (${cleanPhone})`);

    // Guardar solicitud en la red
    await db.collection('miia_network').doc(cleanPhone)
      .collection('reservation_requests').add({
        fromPhone: fromPhone || '',
        fromName: fromOwnerName || '',
        date,
        time,
        partySize: parseInt(partySize) || 1,
        notes: notes || '',
        status: bizData.autoConfirm ? 'confirmed' : 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    return {
      sent: true,
      autoConfirm: bizData.autoConfirm,
      businessName: bizData.name,
    };
  } catch (err) {
    console.error(`[MIIA-NETWORK] ❌ Error enviando reserva inter-MIIA a ${cleanPhone}:`, err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Obtener solicitudes de reserva recibidas por un negocio.
 */
async function getReceivedReservations(bizPhone, status) {
  const cleanPhone = (bizPhone || '').replace(/[^0-9]/g, '');
  if (!cleanPhone) return [];

  let query = db.collection('miia_network').doc(cleanPhone)
    .collection('reservation_requests');

  if (status) {
    query = query.where('status', '==', status);
  }

  query = query.orderBy('createdAt', 'desc').limit(20);
  const snap = await query.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Actualizar estado de una solicitud de reserva recibida.
 */
async function updateReceivedReservation(bizPhone, requestId, status) {
  const cleanPhone = (bizPhone || '').replace(/[^0-9]/g, '');
  await db.collection('miia_network').doc(cleanPhone)
    .collection('reservation_requests').doc(requestId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  console.log(`[MIIA-NETWORK] 📝 Solicitud ${requestId} → ${status}`);
}

// ═══════════════════════════════════════════════════════════════
// BÚSQUEDA COMBINADA — Red MIIA primero, luego Google
// ═══════════════════════════════════════════════════════════════

/**
 * Busca negocios: primero en red MIIA, luego complementa con Google.
 * Los resultados MIIA aparecen primero con badge "🤖 MIIA".
 */
async function searchBusinessesCombined(params, aiGateway) {
  const results = [];

  // 1. Buscar en red MIIA primero
  try {
    const miiaResults = await searchMiiaNetwork(params);
    if (miiaResults.length > 0) {
      results.push(...miiaResults);
      console.log(`[RESERVATIONS] 🤖 ${miiaResults.length} negocios MIIA encontrados`);
    }
  } catch (err) {
    console.warn(`[RESERVATIONS] ⚠️ Error buscando en red MIIA:`, err.message);
  }

  // 2. Si no hay suficientes resultados MIIA, complementar con Google
  if (results.length < 3) {
    try {
      const googleResults = await searchBusinesses(params, aiGateway);
      // No duplicar (filtrar por phone)
      const existingPhones = new Set(results.map(r => (r.phone || '').replace(/[^0-9]/g, '')));
      for (const gr of googleResults) {
        const grPhone = (gr.phone || '').replace(/[^0-9]/g, '');
        if (!existingPhones.has(grPhone)) {
          results.push({ ...gr, isMiia: false });
        }
      }
    } catch (err) {
      console.warn(`[RESERVATIONS] ⚠️ Error buscando en Google:`, err.message);
    }
  }

  return results.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════
// BUSCAR NEGOCIOS — Via Gemini google_search (gratis)
// ═══════════════════════════════════════════════════════════════

/**
 * Busca negocios usando Gemini con google_search grounding.
 * @param {object} params - { type, zone, date, time, partySize, ownerCity, ownerCountry }
 * @param {object} aiGateway - AI gateway para llamar a Gemini
 * @returns {Array<{name, address, phone, rating, hours, type, distance}>}
 */
async function searchBusinesses(params, aiGateway) {
  const { type, zone, date, time, partySize, ownerCity, ownerCountry } = params;

  const locationStr = zone
    ? `en ${zone}, ${ownerCity || ''}, ${ownerCountry || ''}`
    : `en ${ownerCity || 'la ciudad'}, ${ownerCountry || ''}`;

  const partySizeStr = partySize ? ` para ${partySize} personas` : '';
  const dateStr = date ? ` el ${date}` : ' hoy';
  const timeStr = time ? ` a las ${time}` : '';

  const searchPrompt = `Buscar ${type || 'negocio'}${partySizeStr} ${locationStr}${dateStr}${timeStr}.

IMPORTANTE: Devolvé los resultados en formato JSON estricto. Array de objetos con estos campos:
- name: nombre del negocio
- address: dirección completa
- phone: teléfono (formato internacional si posible)
- rating: rating de Google (número)
- hours: horarios relevantes para ${date || 'hoy'}
- type: tipo de negocio
- priceLevel: "$" a "$$$$" si disponible

Máximo 5 resultados, ordenados por rating y relevancia.
Responder SOLO con el JSON array, sin texto adicional.`;

  try {
    const result = await aiGateway.smartCall(
      aiGateway.CONTEXTS?.GENERAL || 'general',
      searchPrompt,
      {}, // uses default provider
      { enableSearch: true }
    );

    const text = result?.text || '';
    console.log(`[RESERVATIONS] 🔍 Búsqueda: "${type}" ${locationStr} — respuesta: ${text.length} chars`);

    // Parsear JSON de la respuesta
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const businesses = JSON.parse(jsonMatch[0]);
        console.log(`[RESERVATIONS] ✅ ${businesses.length} negocios encontrados para "${type}" ${locationStr}`);
        return businesses.slice(0, 5);
      } catch (parseErr) {
        console.error(`[RESERVATIONS] ❌ JSON parse error:`, parseErr.message);
      }
    }

    // Fallback: devolver texto crudo como un solo resultado
    console.warn(`[RESERVATIONS] ⚠️ No se pudo parsear JSON, devolviendo texto crudo`);
    return [{ name: 'Resultados de búsqueda', address: text.substring(0, 500), phone: '', rating: 0, hours: '', type: type || 'other' }];
  } catch (err) {
    console.error(`[RESERVATIONS] ❌ Error en búsqueda:`, err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// CRUD RESERVAS — Firestore
// ═══════════════════════════════════════════════════════════════

/**
 * Crear una reserva nueva.
 */
async function createReservation(uid, data) {
  const reservation = {
    type: data.type || 'other',
    businessName: data.businessName || '',
    businessPhone: data.businessPhone || '',
    businessAddress: data.businessAddress || '',
    date: data.date || new Date().toISOString(),
    time: data.time || '',
    partySize: data.partySize || 1,
    status: data.status || 'pending',
    notes: data.notes || '',
    source: data.source || 'manual',
    googlePlaceId: data.googlePlaceId || null,
    rating: data.rating || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    confirmedAt: null,
    agendaEventId: data.agendaEventId || null,
  };

  const ref = await db.collection('users').doc(uid)
    .collection('miia_reservations').add(reservation);

  console.log(`[RESERVATIONS] ✅ Reserva creada: ${ref.id} — ${reservation.businessName} ${reservation.date} ${reservation.time}`);
  return { reservationId: ref.id, ...reservation };
}

/**
 * Obtener reservas del owner (con filtros opcionales).
 */
async function getReservations(uid, filters = {}) {
  let query = db.collection('users').doc(uid).collection('miia_reservations');

  if (filters.status) {
    query = query.where('status', '==', filters.status);
  }
  if (filters.type) {
    query = query.where('type', '==', filters.type);
  }

  query = query.orderBy('createdAt', 'desc').limit(filters.limit || 20);

  const snap = await query.get();
  const reservations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`[RESERVATIONS] 📋 ${reservations.length} reservas obtenidas para ${uid}`);
  return reservations;
}

/**
 * Actualizar estado de una reserva.
 */
async function updateReservation(uid, reservationId, updates) {
  const ref = db.collection('users').doc(uid)
    .collection('miia_reservations').doc(reservationId);

  const doc = await ref.get();
  if (!doc.exists) {
    throw new Error(`Reserva ${reservationId} no existe`);
  }

  const updateData = { ...updates, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (updates.status === 'confirmed') {
    updateData.confirmedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  await ref.update(updateData);
  console.log(`[RESERVATIONS] 📝 Reserva ${reservationId} actualizada: ${JSON.stringify(updates)}`);
  return { reservationId, ...updateData };
}

/**
 * Cancelar una reserva.
 */
async function cancelReservation(uid, reservationId) {
  return updateReservation(uid, reservationId, { status: 'cancelled' });
}

// ═══════════════════════════════════════════════════════════════
// FAVORITOS — Negocios preferidos del owner
// ═══════════════════════════════════════════════════════════════

/**
 * Guardar/actualizar un negocio como favorito.
 */
async function saveFavorite(uid, businessPhone, data) {
  const docId = businessPhone.replace(/[^0-9]/g, '') || `fav_${Date.now()}`;
  const favorite = {
    name: data.name || '',
    type: data.type || 'other',
    address: data.address || '',
    phone: businessPhone,
    lastVisit: data.lastVisit || new Date().toISOString(),
    visitCount: admin.firestore.FieldValue.increment(1),
    notes: data.notes || '',
    rating: data.rating || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db.collection('users').doc(uid)
    .collection('miia_favorites').doc(docId).set(favorite, { merge: true });

  console.log(`[RESERVATIONS] ⭐ Favorito guardado: ${data.name} (${docId})`);
  return { favoriteId: docId, ...favorite };
}

/**
 * Obtener favoritos del owner.
 */
async function getFavorites(uid, type) {
  let query = db.collection('users').doc(uid).collection('miia_favorites');
  if (type) {
    query = query.where('type', '==', type);
  }
  query = query.orderBy('lastVisit', 'desc').limit(20);

  const snap = await query.get();
  const favorites = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  console.log(`[RESERVATIONS] ⭐ ${favorites.length} favoritos obtenidos${type ? ` (tipo: ${type})` : ''}`);
  return favorites;
}

/**
 * Calificar un negocio (rating personal del owner).
 */
async function rateReservation(uid, reservationId, rating) {
  if (rating < 1 || rating > 5) throw new Error('Rating debe ser 1-5');

  // Actualizar la reserva
  const resRef = db.collection('users').doc(uid)
    .collection('miia_reservations').doc(reservationId);
  const resDoc = await resRef.get();

  if (!resDoc.exists) throw new Error(`Reserva ${reservationId} no existe`);

  const resData = resDoc.data();
  await resRef.update({
    personalRating: rating,
    status: 'completed',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Actualizar favorito con el rating
  if (resData.businessPhone) {
    const favDocId = resData.businessPhone.replace(/[^0-9]/g, '');
    await db.collection('users').doc(uid)
      .collection('miia_favorites').doc(favDocId).set({
        name: resData.businessName,
        type: resData.type,
        address: resData.businessAddress,
        phone: resData.businessPhone,
        rating,
        lastVisit: resData.date,
        visitCount: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  }

  console.log(`[RESERVATIONS] ⭐ Rating ${rating}/5 para reserva ${reservationId} (${resData.businessName})`);
  return { reservationId, rating, businessName: resData.businessName };
}

// ═══════════════════════════════════════════════════════════════
// R3: FAVORITOS INTELIGENTES + RATING POST-RESERVA
// ═══════════════════════════════════════════════════════════════

/**
 * R3: Buscar el favorito más probable cuando el owner dice "lo de siempre".
 * Analiza tipo de negocio, frecuencia de visitas, y hora del día.
 * @param {string} uid
 * @param {string} hint - Pista del owner ("lo de siempre", "el de siempre", etc.)
 * @param {string} type - Tipo de negocio si fue mencionado
 * @returns {object|null} Favorito más probable
 */
async function smartFavoriteLookup(uid, hint, type) {
  const favorites = await getFavorites(uid, type);
  if (favorites.length === 0) return null;

  // Si solo hay un favorito del tipo → es ese
  if (favorites.length === 1) {
    console.log(`[RESERVATIONS-R3] ⭐ "Lo de siempre" → único favorito: ${favorites[0].name}`);
    return favorites[0];
  }

  // Ordenar por visitCount (más visitado primero)
  favorites.sort((a, b) => {
    const countA = typeof a.visitCount === 'number' ? a.visitCount : 0;
    const countB = typeof b.visitCount === 'number' ? b.visitCount : 0;
    return countB - countA;
  });

  // Si el hint incluye parte del nombre, filtrar
  if (hint && hint.length > 3) {
    const hintLower = hint.toLowerCase();
    const nameMatch = favorites.find(f =>
      (f.name || '').toLowerCase().includes(hintLower)
    );
    if (nameMatch) {
      console.log(`[RESERVATIONS-R3] ⭐ "Lo de siempre" + hint "${hint}" → ${nameMatch.name}`);
      return nameMatch;
    }
  }

  // Devolver el más visitado
  console.log(`[RESERVATIONS-R3] ⭐ "Lo de siempre" → más frecuente: ${favorites[0].name} (${favorites[0].visitCount || 1} visitas)`);
  return favorites[0];
}

/**
 * R3: Obtener reservas pendientes de rating (completadas sin calificar).
 * Esto permite que MIIA pregunte proactivamente "¿cómo te fue?".
 * @param {string} uid
 * @returns {Array} Reservas que necesitan rating
 */
async function getReservationsPendingRating(uid) {
  const snap = await db.collection('users').doc(uid)
    .collection('miia_reservations')
    .where('status', '==', 'confirmed')
    .orderBy('date', 'asc')
    .limit(10)
    .get();

  const now = new Date();
  const pendingRating = [];

  for (const doc of snap.docs) {
    const data = { id: doc.id, ...doc.data() };
    // Solo incluir si la fecha ya pasó y no tiene rating
    if (data.date && !data.personalRating) {
      const reservationDate = new Date(data.date);
      // Si la reserva fue ayer o antes → pedir rating
      if (reservationDate < now) {
        pendingRating.push(data);
      }
    }
  }

  console.log(`[RESERVATIONS-R3] 📊 ${pendingRating.length} reservas pendientes de rating`);
  return pendingRating;
}

/**
 * R3: Obtener historial de visitas a un negocio específico.
 */
async function getVisitHistory(uid, businessPhone) {
  const cleanPhone = (businessPhone || '').replace(/[^0-9]/g, '');
  if (!cleanPhone) return [];

  const snap = await db.collection('users').doc(uid)
    .collection('miia_reservations')
    .where('businessPhone', '==', cleanPhone)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ═══════════════════════════════════════════════════════════════
// FORMATEO — Resultados legibles para WhatsApp
// ═══════════════════════════════════════════════════════════════

/**
 * Formatea resultados de búsqueda para mostrar al owner.
 */
function formatSearchResults(businesses) {
  if (!businesses || businesses.length === 0) {
    return 'No encontré opciones. ¿Querés que busque con otros criterios?';
  }

  const lines = businesses.map((b, i) => {
    const miiaBadge = b.isMiia ? ' 🤖 *MIIA*' : '';
    const miiaNote = b.isMiia ? '\n   ✨ Reserva automática disponible' : '';
    const stars = b.rating ? '⭐'.repeat(Math.min(Math.round(b.rating), 5)) : '';
    const price = b.priceLevel ? ` (${b.priceLevel})` : '';
    const phone = b.phone ? `📞 ${b.phone}` : '';
    return `*${i + 1}. ${b.name}*${miiaBadge}${price}\n   ${stars} ${b.rating || '?'}/5\n   📍 ${b.address || 'Sin dirección'}\n   ${phone}${b.hours ? `\n   🕐 ${b.hours}` : ''}${miiaNote}`;
  });

  return `🔍 *Opciones encontradas:*\n\n${lines.join('\n\n')}\n\n¿Cuál te gusta? Decime el número y gestiono la reserva.${businesses.some(b => b.isMiia) ? '\n\n🤖 Los marcados con MIIA aceptan reservas automáticas.' : ''}`;
}

/**
 * Formatea una reserva para mostrar al owner.
 */
function formatReservation(res) {
  const statusEmoji = {
    searching: '🔍', pending: '⏳', confirmed: '✅', cancelled: '❌', completed: '🏁'
  };
  const emoji = statusEmoji[res.status] || '📋';
  return `${emoji} *${res.businessName}*\n   📅 ${res.date} a las ${res.time}\n   📍 ${res.businessAddress}\n   👥 ${res.partySize} persona(s)\n   Estado: ${res.status}${res.notes ? `\n   📝 ${res.notes}` : ''}`;
}

// ═══════════════════════════════════════════════════════════════
// TAG DETECTION — Parsea tags de reservas desde mensajes de IA
// ═══════════════════════════════════════════════════════════════

const RESERVATION_TAG_PATTERNS = {
  BUSCAR_RESERVA: /\[BUSCAR_RESERVA:([^\]]+)\]/,
  RESERVAR: /\[RESERVAR:([^\]]+)\]/,
  RESERVAR_MIIA: /\[RESERVAR_MIIA:([^\]]+)\]/,
  CANCELAR_RESERVA: /\[CANCELAR_RESERVA:([^\]]+)\]/,
  RATING_RESERVA: /\[RATING_RESERVA:([^\]]+)\]/,
};

/**
 * Detecta tags de reservas en un mensaje de IA.
 */
function detectReservationTags(message) {
  if (!message) return [];
  const found = [];
  for (const [tag, pattern] of Object.entries(RESERVATION_TAG_PATTERNS)) {
    const match = message.match(pattern);
    if (match) {
      found.push({ tag, params: match[1].split('|').map(p => p.trim()) });
    }
  }
  return found;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Search
  searchBusinesses,
  searchBusinessesCombined,
  formatSearchResults,

  // CRUD
  createReservation,
  getReservations,
  updateReservation,
  cancelReservation,

  // Favorites
  saveFavorite,
  getFavorites,

  // Rating
  rateReservation,

  // Format
  formatReservation,

  // Tags
  detectReservationTags,
  RESERVATION_TAG_PATTERNS,

  // R2: Red inter-MIIA
  registerInMiiaNetwork,
  unregisterFromMiiaNetwork,
  searchMiiaNetwork,
  sendInterMiiaReservation,
  getReceivedReservations,
  updateReceivedReservation,

  // R3: Favoritos inteligentes + rating
  smartFavoriteLookup,
  getReservationsPendingRating,
  getVisitHistory,

  // Constants
  RESERVATION_TYPES,
  RESERVATION_STATUS,
};
