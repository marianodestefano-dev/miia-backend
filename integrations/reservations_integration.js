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
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

const admin = require('firebase-admin');
const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const RESERVATION_TYPES = ['restaurant', 'doctor', 'salon', 'dentist', 'mechanic', 'hotel', 'spa', 'gym', 'other'];
const RESERVATION_STATUS = ['searching', 'pending', 'confirmed', 'cancelled', 'completed'];

// ═════════════════════════════════════════════════════���═════════
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
    const stars = b.rating ? '⭐'.repeat(Math.min(Math.round(b.rating), 5)) : '';
    const price = b.priceLevel ? ` (${b.priceLevel})` : '';
    const phone = b.phone ? `📞 ${b.phone}` : '';
    return `*${i + 1}. ${b.name}*${price}\n   ${stars} ${b.rating || '?'}/5\n   📍 ${b.address || 'Sin dirección'}\n   ${phone}${b.hours ? `\n   🕐 ${b.hours}` : ''}`;
  });

  return `🔍 *Opciones encontradas:*\n\n${lines.join('\n\n')}\n\n¿Cuál te gusta? Decime el número y gestiono la reserva.`;
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

  // Constants
  RESERVATION_TYPES,
  RESERVATION_STATUS,
};
