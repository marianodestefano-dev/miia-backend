'use strict';

/**
 * MIIA - Contact Spam Detector (T230)
 * P2.5 ROADMAP: anti-spam alertas contactos desconocidos.
 * 1 alerta por contacto nuevo, no spam continuo.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const SPAM_SIGNALS = Object.freeze([
  'repeated_messages', 'rapid_fire', 'identical_content', 'suspicious_links',
  'unsolicited_media', 'keyword_match', 'unknown_number',
]);

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RAPID_FIRE_THRESHOLD = 10;
const RAPID_FIRE_WINDOW_MS = 60 * 1000;
const SIMILARITY_THRESHOLD = 0.90;

const SPAM_KEYWORDS = Object.freeze([
  'ganaste', 'premio', 'gratis', 'oferta limitada', 'click aqui', 'urgente',
  'forex', 'criptomoneda', 'inversion garantizada', 'gana dinero',
]);

function isValidSignal(signal) {
  return SPAM_SIGNALS.includes(signal);
}

function detectKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  var lower = text.toLowerCase();
  return SPAM_KEYWORDS.filter(function(kw) { return lower.includes(kw); });
}

function detectRapidFire(messages, windowMs) {
  if (!Array.isArray(messages) || messages.length < RAPID_FIRE_THRESHOLD) return false;
  var win = windowMs || RAPID_FIRE_WINDOW_MS;
  var now = Date.now();
  var recent = messages.filter(function(m) {
    return m.timestamp && (now - new Date(m.timestamp).getTime()) < win;
  });
  return recent.length >= RAPID_FIRE_THRESHOLD;
}

function computeSimilarity(a, b) {
  if (!a || !b) return 0;
  var sa = String(a).toLowerCase().trim();
  var sb = String(b).toLowerCase().trim();
  if (sa === sb) return 1;
  var longer = sa.length > sb.length ? sa : sb;
  var shorter = sa.length <= sb.length ? sa : sb;
  if (longer.length === 0) return 1;
  var common = 0;
  for (var i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) common++;
  }
  return common / longer.length;
}

function detectIdenticalContent(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return false;
  var texts = messages.map(function(m) { return String(m.text || m.body || '').toLowerCase().trim(); });
  for (var i = 1; i < texts.length; i++) {
    if (computeSimilarity(texts[i], texts[0]) >= SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

function analyzeContact(phone, messages, opts) {
  if (!phone) throw new Error('phone requerido');
  var signals = [];
  var severity = 'low';
  var reasons = [];
  if (opts && opts.isUnknown) {
    signals.push('unknown_number');
    reasons.push('Numero desconocido');
  }
  if (detectRapidFire(messages)) {
    signals.push('rapid_fire');
    reasons.push('Mensajes en rafaga: ' + messages.length + ' en menos de 1 minuto');
    severity = 'high';
  }
  if (detectIdenticalContent(messages)) {
    signals.push('identical_content');
    reasons.push('Contenido identico o muy similar repetido');
    severity = severity === 'high' ? 'high' : 'medium';
  }
  var lastText = messages && messages.length > 0 ? (messages[messages.length - 1].text || '') : '';
  var kws = detectKeywords(lastText);
  if (kws.length > 0) {
    signals.push('keyword_match');
    reasons.push('Keywords spam detectados: ' + kws.join(', '));
    severity = 'high';
  }
  var isSpam = signals.length >= 2 || severity === 'high';
  return {
    phone,
    isSpam,
    signals,
    severity,
    reasons,
    analyzedAt: new Date().toISOString(),
  };
}

async function shouldSendAlert(uid, phone) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  try {
    var docId = phone.replace(/\D/g, '').slice(-10);
    var snap = await db().collection('tenants').doc(uid).collection('spam_alerts').doc(docId).get();
    if (!snap || !snap.exists) return true;
    var data = snap.data();
    if (!data.lastAlertAt) return true;
    var elapsed = Date.now() - new Date(data.lastAlertAt).getTime();
    return elapsed >= ALERT_COOLDOWN_MS;
  } catch (e) {
    console.error('[SPAM_DETECTOR] Error chequeando cooldown: ' + e.message);
    return true;
  }
}

async function recordAlertSent(uid, phone, analysis) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var docId = phone.replace(/\D/g, '').slice(-10);
  await db().collection('tenants').doc(uid).collection('spam_alerts').doc(docId).set({
    phone,
    lastAlertAt: new Date().toISOString(),
    lastAnalysis: analysis,
    alertCount: 1,
  }, { merge: true });
  console.log('[SPAM_DETECTOR] Alerta registrada uid=' + uid + ' phone=' + phone);
}

async function checkAndAlert(uid, phone, messages, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!phone) throw new Error('phone requerido');
  var analysis = analyzeContact(phone, messages || [], opts);
  if (!analysis.isSpam) return { alerted: false, analysis };
  var canAlert = await shouldSendAlert(uid, phone);
  if (!canAlert) return { alerted: false, reason: 'cooldown activo', analysis };
  await recordAlertSent(uid, phone, analysis);
  return { alerted: true, analysis };
}

function buildSpamAlertMessage(phone, analysis) {
  var sev = { low: 'INFO', medium: 'AVISO', high: 'ALERTA' }[analysis.severity] || 'AVISO';
  var lines = ['[' + sev + '] Actividad sospechosa detectada en contacto ' + phone + ':'];
  analysis.reasons.forEach(function(r) { lines.push('  - ' + r); });
  lines.push('Revisa la conversacion en tu dashboard MIIA.');
  return lines.join('\n');
}

module.exports = {
  analyzeContact,
  shouldSendAlert,
  recordAlertSent,
  checkAndAlert,
  buildSpamAlertMessage,
  detectKeywords,
  detectRapidFire,
  detectIdenticalContent,
  computeSimilarity,
  isValidSignal,
  SPAM_SIGNALS,
  SPAM_KEYWORDS,
  ALERT_COOLDOWN_MS,
  RAPID_FIRE_THRESHOLD,
  SIMILARITY_THRESHOLD,
  __setFirestoreForTests,
};
