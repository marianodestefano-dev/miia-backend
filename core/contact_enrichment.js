'use strict';

const CONTACT_SEGMENTS = Object.freeze([
  'vip', 'premium', 'regular', 'new', 'cold', 'at_risk', 'converted', 'inactive',
]);

const VALID_ENRICHMENT_FIELDS = Object.freeze([
  'email', 'company', 'industry', 'city', 'country',
  'notes', 'birthday', 'source', 'referral', 'website',
]);

const MAX_TAGS_PER_CONTACT = 20;
const MAX_NOTES_LENGTH = 500;
const TAG_COLLECTION = 'contact_tags';
const ENRICHMENT_COLLECTION = 'contact_enrichments';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

function isValidSegment(s) { return CONTACT_SEGMENTS.includes(s); }
function isValidTag(tag) {
  if (!tag || typeof tag !== 'string') return false;
  return /^[a-z0-9_]{1,30}$/.test(tag);
}

function computeContactSegment(opts = {}) {
  const { scoreLabel, daysSinceLastActivity, isConverted, totalPurchases } = opts;
  if (isConverted && totalPurchases >= 5) return 'vip';
  if (isConverted && totalPurchases >= 2) return 'premium';
  if (isConverted) return 'converted';
  if (typeof daysSinceLastActivity === 'number' && daysSinceLastActivity > 90) return 'inactive';
  if (typeof daysSinceLastActivity === 'number' && daysSinceLastActivity > 30) return 'cold';
  if (scoreLabel === 'Listo para cerrar' || scoreLabel === 'Caliente') return 'at_risk';
  if (typeof daysSinceLastActivity === 'number' && daysSinceLastActivity <= 7) return 'new';
  return 'regular';
}

function buildEnrichmentRecord(uid, phone, fields, opts = {}) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('fields debe ser objeto');
  const sanitized = {};
  for (const key of Object.keys(fields)) {
    if (!VALID_ENRICHMENT_FIELDS.includes(key)) continue;
    const val = fields[key];
    if (key === 'notes' && typeof val === 'string' && val.length > MAX_NOTES_LENGTH) {
      sanitized[key] = val.slice(0, MAX_NOTES_LENGTH);
    } else {
      sanitized[key] = val;
    }
  }
  const segment = opts.segment && isValidSegment(opts.segment)
    ? opts.segment
    : computeContactSegment(opts.segmentOpts || {});
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const recordId = uid.slice(0, 8) + '_' + phone.replace(/\D/g, '').slice(-8);
  return {
    recordId,
    uid,
    phone,
    segment,
    fields: sanitized,
    tags: Array.isArray(opts.tags) ? opts.tags : [],
    date,
    updatedAt: opts.updatedAt || Date.now(),
  };
}

async function saveEnrichmentRecord(uid, record) {
  if (!uid) throw new Error('uid requerido');
  if (!record || !record.recordId) throw new Error('record invalido');
  await db()
    .collection('owners').doc(uid)
    .collection(ENRICHMENT_COLLECTION).doc(record.recordId)
    .set(record, { merge: true });
  console.log('[ENRICH] Guardado uid=' + uid + ' phone=' + record.phone + ' segment=' + record.segment);
  return record.recordId;
}

async function getEnrichmentRecord(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const recordId = uid.slice(0, 8) + '_' + phone.replace(/\D/g, '').slice(-8);
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(ENRICHMENT_COLLECTION).doc(recordId)
      .get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (e) {
    console.error('[ENRICH] Error getEnrichmentRecord: ' + e.message);
    return null;
  }
}

async function getContactTags(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(TAG_COLLECTION).doc(phone.replace(/\D/g, '').slice(-10))
      .get();
    if (!snap.exists) return [];
    return snap.data().tags || [];
  } catch (e) {
    console.error('[ENRICH] Error getContactTags: ' + e.message);
    return [];
  }
}

async function addTagToContact(uid, phone, tag) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!isValidTag(tag)) throw new Error('tag invalido (solo a-z0-9_ max 30 chars)');
  const docId = phone.replace(/\D/g, '').slice(-10);
  const snap = await db()
    .collection('owners').doc(uid)
    .collection(TAG_COLLECTION).doc(docId)
    .get();
  const existing = snap.exists ? (snap.data().tags || []) : [];
  if (existing.length >= MAX_TAGS_PER_CONTACT) {
    throw new Error('max tags alcanzado para este contacto');
  }
  if (!existing.includes(tag)) existing.push(tag);
  await db()
    .collection('owners').doc(uid)
    .collection(TAG_COLLECTION).doc(docId)
    .set({ phone, tags: existing, updatedAt: Date.now() }, { merge: true });
  console.log('[ENRICH] Tag agegado uid=' + uid + ' phone=' + phone + ' tag=' + tag);
  return existing;
}

async function removeTagFromContact(uid, phone, tag) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  if (!tag) throw new Error('tag requerido');
  const docId = phone.replace(/\D/g, '').slice(-10);
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(TAG_COLLECTION).doc(docId)
      .get();
    if (!snap.exists) return [];
    const tags = (snap.data().tags || []).filter(t => t !== tag);
    await db()
      .collection('owners').doc(uid)
      .collection(TAG_COLLECTION).doc(docId)
      .set({ tags, updatedAt: Date.now() }, { merge: true });
    return tags;
  } catch (e) {
    console.error('[ENRICH] Error removeTagFromContact: ' + e.message);
    return [];
  }
}

async function searchContactsBySegment(uid, segment) {
  if (!uid) throw new Error('uid requerido');
  if (!isValidSegment(segment)) throw new Error('segment invalido');
  try {
    const snap = await db()
      .collection('owners').doc(uid)
      .collection(ENRICHMENT_COLLECTION)
      .where('segment', '==', segment)
      .get();
    const docs = [];
    snap.forEach(d => docs.push(d.data()));
    return docs;
  } catch (e) {
    console.error('[ENRICH] Error searchContactsBySegment: ' + e.message);
    return [];
  }
}

function buildEnrichmentText(record) {
  if (!record) return '';
  const segmentEmoji = {
    vip: '\u{1F451}',
    premium: '\u{1F31F}',
    regular: '\u{1F464}',
    new: '\u{1F195}',
    cold: '\u2744\uFE0F',
    at_risk: '\u26A0\uFE0F',
    converted: '\u2705',
    inactive: '\u{1F4A4}',
  };
  const emoji = segmentEmoji[record.segment] || '\u{1F464}';
  const lines = [
    emoji + ' *Contacto enriquecido*',
    '\u{1F4DE} Tel: ' + record.phone,
    '\u{1F3F7}\uFE0F Segmento: ' + record.segment,
  ];
  if (record.fields) {
    if (record.fields.company) lines.push('\u{1F3E2} Empresa: ' + record.fields.company);
    if (record.fields.city) lines.push('\u{1F4CD} Ciudad: ' + record.fields.city);
    if (record.fields.email) lines.push('\u{1F4E7} Email: ' + record.fields.email);
    if (record.fields.notes) lines.push('\u{1F4DD} Notas: ' + record.fields.notes.slice(0, 100));
  }
  if (record.tags && record.tags.length > 0) {
    lines.push('\u{1F3F7}\uFE0F Tags: ' + record.tags.join(', '));
  }
  return lines.join('\n');
}

module.exports = {
  computeContactSegment, buildEnrichmentRecord,
  saveEnrichmentRecord, getEnrichmentRecord,
  getContactTags, addTagToContact, removeTagFromContact,
  searchContactsBySegment, buildEnrichmentText,
  isValidSegment, isValidTag,
  CONTACT_SEGMENTS, VALID_ENRICHMENT_FIELDS,
  MAX_TAGS_PER_CONTACT, MAX_NOTES_LENGTH,
  __setFirestoreForTests,
};
