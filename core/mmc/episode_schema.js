'use strict';

/**
 * MMC — Schema episodio v0.3 completo + Lesson{} (spec 13 v0.3 §CAPA 2).
 *
 * Decision A.3: schema progresivo. Campos v0.3 son nullable por default
 * en docs nuevos. Docs viejos sin esos campos se "upgradean" lazy via
 * upgradeEpisodeSchema() al leerlos.
 *
 * Path canonico (A.1): users/{uid}/miia_memory/{episodeId}.
 */

const crypto = require('crypto');

const VALID_STATUSES = Object.freeze(['open', 'closed', 'distilled', 'graduated']);
const TONO_PERMITIDO = Object.freeze(['neutro', 'positivo', 'negativo', 'urgente', 'calido', 'frio']);
const TIPO_CADENCIA = Object.freeze(['reparacion', 'convergencia', 'divergencia', 'escalada', 'aplanamiento']);
const CADENCE_CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
const LESSON_SOURCE = Object.freeze(['nightly_distill', 'owner_explicit', 'graduated_from_prior']);
const LESSON_CONFIDENCE = Object.freeze(['low', 'medium', 'high']);

// Default TTL para episodios: 180 dias (cleanup nocturno si no graduated)
const DEFAULT_EXPIRES_DAYS = 180;

/**
 * Genera el schema completo v0.3 de un episodio nuevo con defaults.
 * @param {object} input - { episodeId, ownerUid, contactPhone, startedAt, messageIds }
 * @returns {object} doc episodio v0.3 completo
 */
function buildNewEpisodeV03(input) {
  if (!input || !input.episodeId) throw new Error('episodeId_requerido');
  if (!input.ownerUid) throw new Error('ownerUid_requerido');
  if (!input.contactPhone) throw new Error('contactPhone_requerido');
  const now = typeof input.startedAt === 'number' ? input.startedAt : Date.now();
  const expiresAt = now + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000;
  return {
    // Identificacion
    episodeId: input.episodeId,
    ownerUid: input.ownerUid,
    contactPhone: input.contactPhone,
    startedAt: now,
    endedAt: null,
    durationMinutes: 0,
    messageIds: Array.isArray(input.messageIds) ? input.messageIds.slice() : [],
    status: 'open',

    // Contenido destilado (Fase 2 NIGHTLY-BRAIN)
    topic: null,
    summary: null,
    resumen: null,
    tono: null,
    lecciones: [],
    tags: [],
    idiomaDetectado: null,
    tonadaDetectada: null,

    // Cadencia (solo post-bootstrap + cadenceConfidence>=medium)
    expectativa: null,
    desvioTension: null,
    resolucion: null,
    sensacion: null,
    tipo: null,
    cadenceConfidence: null,

    // Embedding
    vector: null,
    embeddingModel: null,

    // Telemetria
    lastRetrievedAt: null,
    retrievalCount: 0,
    lastInjectedAt: null,
    injectionCount: 0,

    // Ciclo de vida
    expiresAt,
    contradicted: false,
    graduatedAt: null,

    // Derecho al olvido
    deletedByOwnerAt: null,
    deletionReason: null,

    // Distillation lock (C-450)
    distilling: false,
  };
}

/**
 * "Upgrade" lazy: completa campos faltantes con defaults en docs antiguos.
 * No modifica Firestore; retorna una copia upgradeada del doc.
 * @param {object} doc - doc episodio leido de Firestore
 * @returns {object}
 */
function upgradeEpisodeSchema(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('doc_invalido');
  const now = Date.now();
  const startedAt = typeof doc.startedAt === 'number' ? doc.startedAt : now;
  const upgraded = { ...doc };
  // Campos identidad (no tocar si existen)
  if (upgraded.episodeId === undefined) upgraded.episodeId = null;
  if (upgraded.ownerUid === undefined) upgraded.ownerUid = null;
  if (upgraded.contactPhone === undefined) upgraded.contactPhone = null;
  if (upgraded.startedAt === undefined) upgraded.startedAt = now;
  if (upgraded.endedAt === undefined) upgraded.endedAt = null;
  if (typeof upgraded.durationMinutes !== 'number') upgraded.durationMinutes = 0;
  if (!Array.isArray(upgraded.messageIds)) upgraded.messageIds = [];
  if (!upgraded.status) upgraded.status = 'open';

  // Destilacion
  if (upgraded.topic === undefined) upgraded.topic = null;
  if (upgraded.summary === undefined) upgraded.summary = null;
  if (upgraded.resumen === undefined) upgraded.resumen = upgraded.summary || null;
  if (upgraded.tono === undefined) upgraded.tono = null;
  if (!Array.isArray(upgraded.lecciones)) upgraded.lecciones = [];
  if (!Array.isArray(upgraded.tags)) upgraded.tags = [];
  if (upgraded.idiomaDetectado === undefined) upgraded.idiomaDetectado = null;
  if (upgraded.tonadaDetectada === undefined) upgraded.tonadaDetectada = null;

  // Cadencia
  if (upgraded.expectativa === undefined) upgraded.expectativa = null;
  if (upgraded.desvioTension === undefined) upgraded.desvioTension = null;
  if (upgraded.resolucion === undefined) upgraded.resolucion = null;
  if (upgraded.sensacion === undefined) upgraded.sensacion = null;
  if (upgraded.tipo === undefined) upgraded.tipo = null;
  if (upgraded.cadenceConfidence === undefined) upgraded.cadenceConfidence = null;

  // Embedding
  if (upgraded.vector === undefined) upgraded.vector = null;
  if (upgraded.embeddingModel === undefined) upgraded.embeddingModel = null;

  // Telemetria
  if (upgraded.lastRetrievedAt === undefined) upgraded.lastRetrievedAt = null;
  if (typeof upgraded.retrievalCount !== 'number') upgraded.retrievalCount = 0;
  if (upgraded.lastInjectedAt === undefined) upgraded.lastInjectedAt = null;
  if (typeof upgraded.injectionCount !== 'number') upgraded.injectionCount = 0;

  // Ciclo
  if (typeof upgraded.expiresAt !== 'number') {
    upgraded.expiresAt = startedAt + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000;
  }
  if (typeof upgraded.contradicted !== 'boolean') upgraded.contradicted = false;
  if (upgraded.graduatedAt === undefined) upgraded.graduatedAt = null;

  // Derecho al olvido
  if (upgraded.deletedByOwnerAt === undefined) upgraded.deletedByOwnerAt = null;
  if (upgraded.deletionReason === undefined) upgraded.deletionReason = null;

  if (typeof upgraded.distilling !== 'boolean') upgraded.distilling = false;

  return upgraded;
}

/**
 * Crea una Lesson{} nueva con defaults.
 * @param {object} input - { text, confidence, source }
 * @returns {object} Lesson{}
 */
function buildLesson(input) {
  if (!input || typeof input !== 'object') throw new Error('input_requerido');
  if (typeof input.text !== 'string' || input.text.trim().length === 0) {
    throw new Error('text_requerido');
  }
  const confidence = LESSON_CONFIDENCE.includes(input.confidence) ? input.confidence : 'low';
  const source = LESSON_SOURCE.includes(input.source) ? input.source : 'nightly_distill';
  return {
    id: 'lsn_' + crypto.randomBytes(8).toString('hex'),
    text: input.text.trim().slice(0, 500),
    confidence,
    source,
    createdAt: new Date().toISOString(),
    lastCitedAt: null,
    citationCount: 0,
    citationEpisodes: [],
    contradicted: false,
    deletedByOwnerAt: null,
    graduatedAt: null,
  };
}

/**
 * Valida que una Lesson{} tenga la shape correcta.
 * @param {object} lesson
 * @returns {boolean}
 */
function isValidLesson(lesson) {
  if (!lesson || typeof lesson !== 'object') return false;
  if (typeof lesson.id !== 'string') return false;
  if (typeof lesson.text !== 'string' || lesson.text.length === 0) return false;
  if (!LESSON_CONFIDENCE.includes(lesson.confidence)) return false;
  if (!LESSON_SOURCE.includes(lesson.source)) return false;
  return true;
}

/**
 * Valida que una sensacion{} tenga shape correcta.
 * @param {object|null} s
 */
function isValidSensacion(s) {
  if (s === null) return true;
  if (!s || typeof s !== 'object') return false;
  if (s.before !== null && typeof s.before !== 'string') return false;
  if (s.after !== null && typeof s.after !== 'string') return false;
  if (s.delta !== null && typeof s.delta !== 'string') return false;
  return true;
}

module.exports = {
  buildNewEpisodeV03,
  upgradeEpisodeSchema,
  buildLesson,
  isValidLesson,
  isValidSensacion,
  VALID_STATUSES,
  TONO_PERMITIDO,
  TIPO_CADENCIA,
  CADENCE_CONFIDENCE,
  LESSON_SOURCE,
  LESSON_CONFIDENCE,
  DEFAULT_EXPIRES_DAYS,
};
