/**
 * CONTACT_CLASSIFICATION_CACHE.JS — TTL-aware cache para ctx.contactTypes
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Cierra bug §6.19 CLAUDE.md: cache ctx.contactTypes[phone] bypaseaba
 * classifyContact() → bloqueo precautorio NO aplicaba en contactos clasificados
 * antes del deploy de protecciones nuevas (incidente bot Coordinadora 2026-04-14).
 *
 * Doctrina: protecciones nuevas NUNCA deben ser bypasables por caché pre-existente.
 * Entries sin meta (legacy/migration) se tratan como stale → re-classify en primer touch.
 * Entries con timestamp > TTL_DAYS → se invalidan y fuerzan re-classify.
 *
 * Fix aplicado: C-434 §A (inline TMH) + T79 extracción a módulo reutilizable.
 */

'use strict';

const TTL_DAYS = 30;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Verifica si la clasificación de un contacto en ctx debe considerarse stale
 * y forzar re-classify vía classifyContact().
 *
 * Casos stale:
 *  (1) ctx.contactTypesMeta no inicializada → instancia nueva sin meta histórica
 *  (2) Sin timestamp para el phone → entry legacy pre-fix o migration sin meta
 *  (3) Timestamp > TTL_DAYS → expirado
 *
 * @param {object} ctx - contexto tenant (tiene .contactTypesMeta)
 * @param {string} phone - phone JID completo (ej: "57316...@s.whatsapp.net")
 * @returns {boolean}
 */
function isContactTypeStale(ctx, phone) {
  if (!ctx || !ctx.contactTypesMeta) return true;
  const ts = ctx.contactTypesMeta[phone];
  if (!ts || typeof ts !== 'number') return true;
  return (Date.now() - ts) > TTL_MS;
}

/**
 * Registra el timestamp actual para un phone en ctx.contactTypesMeta.
 * Llamar SIEMPRE después de clasificar con éxito (cache fresh).
 *
 * @param {object} ctx - contexto tenant
 * @param {string} phone - phone JID completo
 */
function recordContactTypeFresh(ctx, phone) {
  if (!ctx) return;
  if (!ctx.contactTypesMeta) ctx.contactTypesMeta = {};
  ctx.contactTypesMeta[phone] = Date.now();
}

/**
 * Elimina entries stale de ctx.contactTypesMeta (housekeeping periódico).
 * No elimina ctx.contactTypes — solo la meta de timestamps.
 * El type real se limpiará en el próximo handleTenantMessage al detectar stale.
 *
 * @param {object} ctx - contexto tenant
 * @returns {number} cantidad de entries purgadas
 */
function purgeStaleContactTypes(ctx) {
  if (!ctx || !ctx.contactTypesMeta) return 0;
  const now = Date.now();
  let purged = 0;
  for (const phone of Object.keys(ctx.contactTypesMeta)) {
    const ts = ctx.contactTypesMeta[phone];
    if (!ts || typeof ts !== 'number' || (now - ts) > TTL_MS) {
      delete ctx.contactTypesMeta[phone];
      purged++;
    }
  }
  if (purged > 0) {
    console.log(`[contact_classification_cache] purged ${purged} stale entries`);
  }
  return purged;
}

module.exports = {
  TTL_DAYS,
  TTL_MS,
  isContactTypeStale,
  recordContactTypeFresh,
  purgeStaleContactTypes,
};
