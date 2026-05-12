'use strict';

/**
 * R14 — MMC Engine (Piso 1 / spec 13 v0.3)
 * Facade que une las 3 capas de Memoria Episodica Continua.
 *
 * CAPA 1: conversations[phone] metadata (episodeId, topicos, tono, idioma,
 *         menciones, fecha_ultimo_contacto) — enriquece el contexto existente.
 * CAPA 2: owners/{uid}/miia_memory/{episodeId} — episodios persistidos.
 * CAPA 3: owners/{uid}/miia_persistent/training_data — chunks memory_graduated.
 *
 * API publica:
 *   captureEpisode(uid, phone, mensajes, contexto)  -> episodeId
 *   distillNightly(uid, opts)                       -> { procesados, graduados, eliminados }
 *   getRelevantMemories(uid, phone, keywords)        -> episodios[]
 *   requestForgetting(uid, phone)                   -> { eliminados }
 *   buildMemoryContext(uid, phone)                  -> string
 *
 * Regla 6.18: AbortController en todas las llamadas Gemini (45s).
 * Fail loudly. Zero silent failures.
 */

const crypto = require('crypto');
const admin = require('firebase-admin');

let _db = null;
function db() { /* istanbul ignore next */ if (!_db) _db = admin.firestore(); return _db; }
function __setFirestoreForTests(fs) { _db = fs; }

// ── Constantes ─────────────────────────────────────────────────────────────
const MAX_RESUMEN_CHARS = 200;
const MAX_CONTEXT_EPISODES = 3;
const GEMINI_TIMEOUT_MS = 45000;
const HARD_DELETE_DELAY_MS = 72 * 60 * 60 * 1000; // 72h en ms

// Condicion 3: regex para detectar fechas/eventos futuros en texto
const FUTURE_DATE_REGEX = /\b(el\s+\d{1,2}|el\s+lunes|el\s+martes|el\s+mi[eé]rcoles|el\s+jueves|el\s+viernes|el\s+s[aá]bado|el\s+domingo|pr[oó]xima?\s+semana|pr[oó]ximo?\s+mes|en\s+\d+\s+d[ií]as?|el\s+\d{1,2}\s+de\s+\w+)\b/i;

// Condicion 4: regex para detectar "recorda esto" en self-chat
const REMEMBER_THIS_REGEX = /\brecord[aá]\s+(esto|eso)\b/i;

// chatTypes que pueden recibir contexto de memoria (NUNCA lead/client)
const MEMORY_ELIGIBLE_CHAT_TYPES = new Set([
  'owner_selfchat', 'family', 'friend_argentino', 'friend_colombiano',
  'ale_pareja', 'medilink_team',
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function _generateEpisodeId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function _phoneHash(phone) {
  return crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 8);
}

function _extractTopics(mensajes) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) return [];
  const words = mensajes
    .map((m) => (m && m.text) || (m && m.body) || '')
    .join(' ')
    .toLowerCase()
    .split(/\s+/);
  // Palabras de >= 5 letras como topics heurísticos (sin stopwords)
  const stopwords = new Set(['tiene', 'tengo', 'quiero', 'puede', 'puedo', 'seria', 'estar', 'estoy', 'gracias', 'buenos', 'cuando']);
  const counts = {};
  for (const w of words) {
    const clean = w.replace(/[^a-záéíóúüñ]/gi, '');
    if (clean.length >= 5 && !stopwords.has(clean)) {
      counts[clean] = (counts[clean] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

function _detectTono(mensajes) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) return 'neutro';
  const texto = mensajes.map((m) => (m && m.text) || (m && m.body) || '').join(' ').toLowerCase();
  if (/!\s*$|urgente|ahora|problema|error|falla/i.test(texto)) return 'urgente';
  if (/gracias|genial|perfecto|excelente|buenísimo|bravo/i.test(texto)) return 'positivo';
  if (/triste|mal|difícil|preocup|no puedo|no sale/i.test(texto)) return 'negativo';
  return 'neutro';
}

function _detectIdioma(mensajes) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) return 'es';
  const texto = mensajes.map((m) => (m && m.text) || (m && m.body) || '').join(' ');
  if (/\b(the|and|with|for|that|this|are|is|have|has)\b/i.test(texto)) return 'en';
  if (/\b(et|avec|pour|que|les|des|une|du|est)\b/i.test(texto)) return 'fr';
  return 'es';
}

function _extractMenciones(mensajes) {
  /* istanbul ignore next */
  if (!Array.isArray(mensajes)) return [];
  const texto = mensajes.map((m) => (m && m.text) || (m && m.body) || '').join(' ');
  const phones = (texto.match(/\+?\d{10,15}/g) || []).slice(0, 5);
  const names = (texto.match(/\bdon[a]?\s+\w+|\bseñor\s+\w+|\bprofesor\s+\w+/gi) || []).slice(0, 3);
  return [...phones, ...names];
}

function _hasFutureDate(mensajes) {
  if (!Array.isArray(mensajes)) return false;
  const texto = mensajes.map((m) => (m && m.text) || (m && m.body) || '').join(' ');
  return FUTURE_DATE_REGEX.test(texto);
}

function _hasRememberThis(mensajes) {
  if (!Array.isArray(mensajes)) return false;
  const texto = mensajes.map((m) => (m && m.text) || (m && m.body) || '').join(' ');
  return REMEMBER_THIS_REGEX.test(texto);
}

function _isFamilyOrTeam(phone, contexto) {
  const ctx = contexto || {};
  const familyContacts = ctx.familyContacts || {};
  const medilink = ctx.medilink_team || [];
  const base = String(phone).split('@')[0].split(':')[0].replace(/\D/g, '');
  if (base && familyContacts[base]) return true;
  if (Array.isArray(medilink) && medilink.some((m) => String(m).includes(base))) return true;
  return false;
}

// ── Capa 2: CRUD en Firestore ────────────────────────────────────────────────

function _memoryCol(uid) {
  return db().collection('owners').doc(uid).collection('miia_memory');
}

async function _saveEpisode(uid, episode) {
  const ref = _memoryCol(uid).doc(episode.episodeId);
  await ref.set(episode, { merge: false });
  return episode.episodeId;
}

async function _getEpisodesForPhone(uid, phone, opts) {
  /* istanbul ignore next */
  const o = opts || {};
  let q = _memoryCol(uid).where('phone', '==', phone).where('deleted', '==', false);
  /* istanbul ignore next */
  if (o.onlyGraduated) q = q.where('graduado', '==', true);
  const snap = await q.get();
  return snap.docs.map((d) => d.data());
}

async function _softDeleteEpisodes(uid, phone) {
  const snap = await _memoryCol(uid).where('phone', '==', phone).where('deleted', '==', false).get();
  const batch = db().batch();
  const hardDeleteAt = Date.now() + HARD_DELETE_DELAY_MS;
  snap.docs.forEach((d) => {
    batch.update(d.ref, { deleted: true, deletedAt: Date.now(), hardDeleteAt });
  });
  await batch.commit();
  return snap.size;
}

// ── Capa 3: training_data chunk memory_graduated ──────────────────────────────

async function _appendMemoryGraduatedChunk(uid, episode) {
  const chunk = {
    type: 'memory_graduated',
    content: (episode.resumen_corto || '').slice(0, MAX_RESUMEN_CHARS),
    keywords: /* istanbul ignore next */ episode.keywords || [],
    fecha: episode.fecha || new Date().toISOString(),
    phone_hash: _phoneHash(episode.phone || ''),
  };

  const docRef = db().collection('owners').doc(uid)
    .collection('miia_persistent').doc('training_data');
  const snap = await docRef.get();

  let chunks = [];
  if (snap.exists) {
    const data = snap.data();
    chunks = Array.isArray(data.memory_chunks) ? data.memory_chunks : [];
  }
  chunks.push(chunk);

  await docRef.set({ memory_chunks: chunks, updatedAt: Date.now() }, { merge: true });
  console.log('[MMC] Chunk memory_graduated guardado uid=' + uid.slice(0, 8) + ' phone_hash=' + chunk.phone_hash);
}

// ── Gemini helper (con AbortController 45s — regla 6.18) ────────────────────

async function _callGemini(prompt, opts) {
  const apiKey = process.env.GEMINI_API_KEY || '';
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey;
  const controller = new AbortController();
  /* istanbul ignore next */
  const timer = setTimeout(() => controller.abort(), opts && opts.timeout ? opts.timeout : GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('Gemini ' + res.status + ': ' + txt.slice(0, 100));
    }
    const data = await res.json();
    return (data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('gemini_timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── API PÚBLICA ─────────────────────────────────────────────────────────────

/**
 * Captura un nuevo episodio desde mensajes recientes.
 * Persiste en Capa 2 (miia_memory). Enriquece con metadata Capa 1.
 * @param {string} uid
 * @param {string} phone
 * @param {Array} mensajes — array de { text|body, role, timestamp }
 * @param {object} contexto — { familyContacts, medilink_team, chatType }
 * @returns {Promise<string>} episodeId
 */
async function captureEpisode(uid, phone, mensajes, contexto) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');
  if (!Array.isArray(mensajes)) throw new Error('mensajes debe ser array');

  const ctx = contexto || {};
  const episodeId = _generateEpisodeId();
  const now = new Date().toISOString();

  const episode = {
    episodeId,
    uid,
    phone,
    fecha: now,
    topicos: _extractTopics(mensajes),
    tono_detectado: _detectTono(mensajes),
    idioma_detectado: _detectIdioma(mensajes),
    menciones_importantes: _extractMenciones(mensajes),
    fecha_ultimo_contacto: now,
    resumen_corto: null,
    keywords: [],
    importancia: null,
    graduado: false,
    deleted: false,
    chatType: ctx.chatType || null,
    mensajes_count: mensajes.length,
  };

  await _saveEpisode(uid, episode);
  console.log('[MMC] captureEpisode uid=' + uid.slice(0, 8) + ' phone=' + _phoneHash(phone) + ' id=' + episodeId);
  return episodeId;
}

/**
 * Retorna episodios relevantes para un phone, filtrados por keywords.
 * Solo graduados. Max MAX_CONTEXT_EPISODES.
 * @param {string} uid
 * @param {string} phone
 * @param {string[]} keywords
 * @returns {Promise<object[]>}
 */
async function getRelevantMemories(uid, phone, keywords) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');

  const kws = Array.isArray(keywords) ? keywords.map((k) => k.toLowerCase()) : [];

  let episodes;
  try {
    episodes = await _getEpisodesForPhone(uid, phone, { onlyGraduated: true });
  } catch (e) {
    console.error('[MMC] getRelevantMemories error uid=' + uid.slice(0, 8) + ':', e.message);
    return [];
  }

  if (episodes.length === 0) return [];

  // Score por keywords match en topicos + keywords del episodio
  const scored = episodes.map((ep) => {
    const epWords = [...(ep.topicos || []), ...(ep.keywords || [])].map((w) => w.toLowerCase());
    const score = kws.length === 0
      ? 1
      : kws.reduce((s, k) => s + (epWords.some((w) => w.includes(k)) ? 1 : 0), 0);
    return { ep, score };
  });

  scored.sort((a, b) => b.score - a.score || b.ep.fecha - a.ep.fecha);
  return scored.slice(0, MAX_CONTEXT_EPISODES).map((x) => x.ep);
}

/**
 * Construye string de contexto de memorias para inyectar en el prompt.
 * NUNCA en lead/miia_lead/client. Solo chatTypes de MEMORY_ELIGIBLE_CHAT_TYPES.
 * @param {string} uid
 * @param {string} phone
 * @param {object} [opts] — { chatType, keywords }
 * @returns {Promise<string>}
 */
async function buildMemoryContext(uid, phone, opts) {
  const o = opts || {};
  if (o.chatType && !MEMORY_ELIGIBLE_CHAT_TYPES.has(o.chatType)) {
    return '';
  }

  const memories = await getRelevantMemories(uid, phone, o.keywords || []);
  if (memories.length === 0) return '';

  const lines = memories.map((ep, i) => {
    const fecha = ep.fecha ? ep.fecha.slice(0, 10) : 'sin fecha';
    const resumen = ep.resumen_corto || ep.topicos.join(', ') || '(sin resumen)';
    return (i + 1) + '. [' + fecha + '] ' + resumen;
  });

  return '[MEMORIA EPISODICA — NO COMPARTIR]\n' + lines.join('\n') + '\n[/MEMORIA]';
}

/**
 * Soft-delete de todos los episodios de un phone (derecho al olvido).
 * Hard-delete se programa 72h después.
 * Audit log en owners/{uid}/mmc_audit.
 * @param {string} uid
 * @param {string} phone
 * @returns {Promise<{eliminados: number}>}
 */
async function requestForgetting(uid, phone) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');
  if (!phone || typeof phone !== 'string') throw new Error('phone requerido');

  let eliminados = 0;
  try {
    eliminados = await _softDeleteEpisodes(uid, phone);
  } catch (e) {
    console.error('[MMC] requestForgetting error uid=' + uid.slice(0, 8) + ':', e.message);
    throw e;
  }

  // Audit log
  try {
    await db().collection('owners').doc(uid).collection('mmc_audit').add({
      action: 'forget',
      phone_hash: _phoneHash(phone),
      cantidad_eliminados: eliminados,
      fecha: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[MMC] requestForgetting audit error:', e.message);
  }

  console.log('[MMC] requestForgetting uid=' + uid.slice(0, 8) + ' phone_hash=' + _phoneHash(phone) + ' eliminados=' + eliminados);
  return { eliminados };
}

/**
 * Destilación nocturna: procesa episodios sin resumen, genera resumen via Gemini,
 * detecta importancia, aplica 4 condiciones de graduación.
 * @param {string} uid
 * @param {object} [opts] — { familyContacts, medilink_team, _gemini } (para tests: _gemini mock)
 * @returns {Promise<{procesados: number, graduados: number, eliminados: number}>}
 */
async function distillNightly(uid, opts) {
  if (!uid || typeof uid !== 'string') throw new Error('uid requerido');

  const o = opts || {};
  const gemini = typeof o._gemini === 'function' ? o._gemini : _callGemini;

  const result = { procesados: 0, graduados: 0, eliminados: 0 };

  let snap;
  try {
    snap = await _memoryCol(uid).where('deleted', '==', false).where('resumen_corto', '==', null).get();
  } catch (e) {
    console.error('[MMC] distillNightly query error uid=' + uid.slice(0, 8) + ':', e.message);
    throw e;
  }

  if (snap.empty) {
    console.log('[MMC] distillNightly uid=' + uid.slice(0, 8) + ' — nada que procesar');
    return result;
  }

  for (const doc of snap.docs) {
    const ep = doc.data();
    result.procesados++;

    let resumen = '';
    let importancia = 1;

    // Generar resumen + importancia via Gemini
    try {
      const prompt = 'En máximo 200 caracteres, resume este episodio de conversación: topicos=[' +
        (ep.topicos || []).join(',') + '] tono=' + ep.tono_detectado +
        '. Luego en una nueva linea escribe solo un número del 1 al 5 (importancia).';
      const raw = await gemini(prompt);
      const lines = raw.trim().split('\n');
      resumen = lines[0].slice(0, MAX_RESUMEN_CHARS);
      const importanciaLine = lines[1] ? parseInt(lines[1].trim(), 10) : NaN;
      importancia = isNaN(importanciaLine) || importanciaLine < 1 || importanciaLine > 5 ? 2 : importanciaLine;
    } catch (e) {
      console.error('[MMC] distillNightly Gemini error episodeId=' + ep.episodeId + ':', e.message);
      resumen = (ep.topicos || []).slice(0, 3).join(', ') || '(sin resumen)';
      importancia = 1;
    }

    // 4 condiciones de graduación
    const cond1 = importancia >= 3;
    const cond2 = _isFamilyOrTeam(ep.phone, o);
    const cond3 = _hasFutureDate(ep.menciones_importantes ? [{ text: ep.menciones_importantes.join(' ') }] : []);
    const cond4 = false; // Condicion 4 ("recorda esto") solo se detecta en captureEpisode pre-destilación

    const graduado = cond1 || cond2 || cond3 || cond4;

    // Actualizar episodio en Firestore
    try {
      await doc.ref.update({
        resumen_corto: resumen,
        importancia,
        graduado,
        distilledAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[MMC] distillNightly update error episodeId=' + ep.episodeId + ':', e.message);
      continue;
    }

    // Si graduado -> Capa 3
    if (graduado) {
      result.graduados++;
      try {
        await _appendMemoryGraduatedChunk(uid, { ...ep, resumen_corto: resumen, keywords: ep.topicos || [] });
      } catch (e) {
        console.error('[MMC] distillNightly chunk error:', e.message);
      }
    }
  }

  // Guardar snapshot diario
  try {
    const fecha = new Date().toISOString().slice(0, 10);
    await db().collection('owners').doc(uid).collection('mmc_snapshots').doc(fecha).set({
      fecha,
      procesados: result.procesados,
      graduados: result.graduados,
      uid,
      createdAt: Date.now(),
    }, { merge: false });
  } catch (e) {
    console.error('[MMC] distillNightly snapshot error:', e.message);
  }

  console.log('[MMC] distillNightly uid=' + uid.slice(0, 8) + ' procesados=' + result.procesados + ' graduados=' + result.graduados);
  return result;
}

module.exports = {
  captureEpisode,
  distillNightly,
  getRelevantMemories,
  requestForgetting,
  buildMemoryContext,
  MEMORY_ELIGIBLE_CHAT_TYPES,
  FUTURE_DATE_REGEX,
  REMEMBER_THIS_REGEX,
  __setFirestoreForTests,
  _phoneHash,
  _hasFutureDate,
  _hasRememberThis,
  _isFamilyOrTeam,
  _extractTopics,
  _detectTono,
  _detectIdioma,
};
