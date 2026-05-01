'use strict';

/**
 * MIIA - Email Handler (T174/T175)
 * MIIA recibe emails de leads y responde. Hilo unificado WhatsApp + email.
 */

let _db = null;
let _transport = null;
function __setFirestoreForTests(fs) { _db = fs; }
function __setTransportForTests(t) { _transport = t; }
function db() { return _db || require('firebase-admin').firestore(); }
function getTransport() { return _transport || { sendMail: _defaultSendMail }; }

const EMAIL_CHANNEL = 'email';
const WHATSAPP_CHANNEL = 'whatsapp';
const VALID_CHANNELS = Object.freeze([EMAIL_CHANNEL, WHATSAPP_CHANNEL]);
const MAX_EMAIL_SUBJECT_LENGTH = 200;
const MAX_EMAIL_BODY_LENGTH = 10000;

/**
 * Procesa un email entrante de un lead y lo almacena en el hilo unificado.
 * @param {string} uid - tenant
 * @param {object} email - { from, subject, body, messageId, receivedAt }
 * @returns {Promise<{threadId, messageId, stored}>}
 */
async function processIncomingEmail(uid, email) {
  if (!uid) throw new Error('uid requerido');
  if (!email || typeof email !== 'object') throw new Error('email requerido');
  if (!email.from) throw new Error('email.from requerido');
  if (!email.messageId) throw new Error('email.messageId requerido');

  const threadId = _buildThreadId(uid, email.from);
  const message = {
    messageId: email.messageId,
    channel: EMAIL_CHANNEL,
    from: email.from,
    subject: email.subject || '',
    body: (email.body || '').substring(0, MAX_EMAIL_BODY_LENGTH),
    receivedAt: email.receivedAt || new Date().toISOString(),
    direction: 'inbound',
    read: false,
  };

  try {
    await db().collection('unified_threads').doc(uid).collection('threads').doc(threadId)
      .collection('messages').doc(email.messageId).set(message);
    await db().collection('unified_threads').doc(uid).collection('threads').doc(threadId)
      .set({ threadId, uid, contactEmail: email.from, lastActivity: message.receivedAt, channels: [EMAIL_CHANNEL] }, { merge: true });
    console.log('[EMAIL] email entrante uid=' + uid.substring(0, 8) + ' from=' + email.from.substring(0, 20));
    return { threadId, messageId: email.messageId, stored: true };
  } catch (e) {
    console.error('[EMAIL] Error procesando email: ' + e.message);
    throw e;
  }
}

/**
 * Envia un email de respuesta a un lead.
 * @param {string} uid
 * @param {string} to - email del lead
 * @param {string} subject
 * @param {string} body
 * @param {object} [opts] - { from, replyTo, inReplyTo }
 * @returns {Promise<{messageId, sent}>}
 */
async function sendEmail(uid, to, subject, body, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!to || !to.includes('@')) throw new Error('to invalido (email requerido)');
  if (!subject || typeof subject !== 'string') throw new Error('subject requerido');
  if (subject.length > MAX_EMAIL_SUBJECT_LENGTH) throw new Error('subject demasiado largo');
  if (!body || typeof body !== 'string') throw new Error('body requerido');

  const from = (opts && opts.from) || process.env.MIIA_EMAIL_FROM || ('miia@' + uid.substring(0, 8) + '.miia-app.com');
  const messageId = 'miia_' + uid.substring(0, 8) + '_' + Date.now() + '@miia-app.com';

  const mailOpts = {
    from, to, subject, text: body,
    messageId, inReplyTo: opts && opts.inReplyTo,
  };

  try {
    await getTransport().sendMail(mailOpts);
    const threadId = _buildThreadId(uid, to);
    const outMsg = {
      messageId, channel: EMAIL_CHANNEL, from, to, subject,
      body: body.substring(0, MAX_EMAIL_BODY_LENGTH),
      sentAt: new Date().toISOString(), direction: 'outbound',
    };
    await db().collection('unified_threads').doc(uid).collection('threads').doc(threadId)
      .collection('messages').doc(messageId).set(outMsg);
    console.log('[EMAIL] enviado uid=' + uid.substring(0, 8) + ' to=' + to.substring(0, 20));
    return { messageId, sent: true };
  } catch (e) {
    console.error('[EMAIL] Error enviando: ' + e.message);
    throw e;
  }
}

/**
 * Obtiene el hilo unificado (email + WhatsApp) de un contacto.
 * @param {string} uid
 * @param {string} threadId
 * @returns {Promise<Array<object>>}
 */
async function getUnifiedThread(uid, threadId) {
  if (!uid) throw new Error('uid requerido');
  if (!threadId) throw new Error('threadId requerido');
  try {
    const snap = await db().collection('unified_threads').doc(uid)
      .collection('threads').doc(threadId).collection('messages').get();
    const messages = [];
    snap.forEach(doc => messages.push(doc.data()));
    messages.sort((a, b) => {
      const ta = a.receivedAt || a.sentAt || '';
      const tb = b.receivedAt || b.sentAt || '';
      return ta.localeCompare(tb);
    });
    return messages;
  } catch (e) {
    console.error('[EMAIL] Error leyendo thread: ' + e.message);
    return [];
  }
}

/**
 * Agrega un mensaje de WhatsApp al hilo unificado.
 */
async function addWhatsAppMessageToThread(uid, contactIdentifier, message) {
  if (!uid) throw new Error('uid requerido');
  if (!contactIdentifier) throw new Error('contactIdentifier requerido');
  if (!message || !message.messageId) throw new Error('message.messageId requerido');

  const threadId = _buildThreadId(uid, contactIdentifier);
  const msg = { ...message, channel: WHATSAPP_CHANNEL };

  try {
    await db().collection('unified_threads').doc(uid).collection('threads').doc(threadId)
      .collection('messages').doc(message.messageId).set(msg);
    await db().collection('unified_threads').doc(uid).collection('threads').doc(threadId)
      .set({ threadId, uid, lastActivity: msg.sentAt || msg.receivedAt || new Date().toISOString(), channels: [WHATSAPP_CHANNEL] }, { merge: true });
    return { threadId, messageId: message.messageId };
  } catch (e) {
    console.error('[EMAIL] Error addWhatsApp: ' + e.message);
    throw e;
  }
}

function _buildThreadId(uid, contactIdentifier) {
  const clean = contactIdentifier.replace(/[^a-zA-Z0-9@._+\-]/g, '_');
  return uid.substring(0, 8) + '_' + clean.substring(0, 40);
}

async function _defaultSendMail(opts) {
  const nodemailer = require('nodemailer');
  throw new Error('_defaultSendMail: configure transport via __setTransportForTests o env SMTP');
}

module.exports = {
  processIncomingEmail, sendEmail, getUnifiedThread, addWhatsAppMessageToThread,
  EMAIL_CHANNEL, WHATSAPP_CHANNEL, VALID_CHANNELS,
  MAX_EMAIL_SUBJECT_LENGTH, MAX_EMAIL_BODY_LENGTH,
  __setFirestoreForTests, __setTransportForTests,
};
