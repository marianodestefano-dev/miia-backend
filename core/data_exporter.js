'use strict';

/**
 * MIIA - Data Exporter (T207)
 * Exporta contactos y conversaciones del owner en CSV o JSON.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const EXPORT_FORMATS = Object.freeze(['csv', 'json']);
const MAX_EXPORT_CONTACTS = 10000;
const CSV_FIELDS_CONTACTS = Object.freeze(['phone', 'name', 'email', 'tags', 'lastContact', 'score', 'notes']);
const CSV_FIELDS_CONVERSATIONS = Object.freeze(['phone', 'role', 'text', 'timestamp', 'direction']);

function _escapeCSV(val) {
  var s = val !== undefined && val !== null ? String(val) : '';
  return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function contactsToCSV(contacts) {
  if (!Array.isArray(contacts)) throw new Error('contacts debe ser array');
  var header = CSV_FIELDS_CONTACTS.join(',');
  var rows = contacts.map(function(c) {
    return CSV_FIELDS_CONTACTS.map(function(f) {
      var val = f === 'tags' && Array.isArray(c[f]) ? c[f].join('|') : (c[f] !== undefined ? c[f] : '');
      return _escapeCSV(val);
    }).join(',');
  });
  return [header].concat(rows).join('\n');
}

function conversationsToCSV(conversations) {
  if (!Array.isArray(conversations)) throw new Error('conversations debe ser array');
  var header = CSV_FIELDS_CONVERSATIONS.join(',');
  var rows = conversations.map(function(m) {
    return CSV_FIELDS_CONVERSATIONS.map(function(f) {
      return _escapeCSV(m[f] !== undefined ? m[f] : '');
    }).join(',');
  });
  return [header].concat(rows).join('\n');
}

async function exportContacts(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  var format = (opts && opts.format) ? opts.format : 'csv';
  if (!EXPORT_FORMATS.includes(format)) throw new Error('formato invalido: ' + format);
  try {
    var snap = await db().collection('tenants').doc(uid).collection('contacts').get();
    var contacts = [];
    snap.forEach(function(doc) {
      var d = doc.data();
      contacts.push({ phone: doc.id, ...d });
    });
    if (contacts.length > MAX_EXPORT_CONTACTS) contacts = contacts.slice(0, MAX_EXPORT_CONTACTS);
    if (format === 'csv') {
      return { format: 'csv', data: contactsToCSV(contacts), count: contacts.length };
    }
    return { format: 'json', data: JSON.stringify(contacts), count: contacts.length };
  } catch (e) {
    console.error('[DATA_EXPORTER] Error exportando contactos: ' + e.message);
    return { format, data: format === 'csv' ? contactsToCSV([]) : '[]', count: 0 };
  }
}

async function exportConversations(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  var format = (opts && opts.format) ? opts.format : 'csv';
  if (!EXPORT_FORMATS.includes(format)) throw new Error('formato invalido: ' + format);
  var phone = opts && opts.phone;
  try {
    var coll = phone
      ? db().collection('tenants').doc(uid).collection('conversations').doc(phone.replace('+', '')).collection('messages')
      : db().collection('tenants').doc(uid).collection('conversations');
    var snap = await coll.get();
    var messages = [];
    snap.forEach(function(doc) { messages.push(doc.data()); });
    messages.sort(function(a, b) { return new Date(a.timestamp || 0) - new Date(b.timestamp || 0); });
    if (format === 'csv') {
      return { format: 'csv', data: conversationsToCSV(messages), count: messages.length };
    }
    return { format: 'json', data: JSON.stringify(messages), count: messages.length };
  } catch (e) {
    console.error('[DATA_EXPORTER] Error exportando conversaciones: ' + e.message);
    return { format, data: format === 'csv' ? conversationsToCSV([]) : '[]', count: 0 };
  }
}

function generateExportManifest(uid, exports) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(exports)) throw new Error('exports debe ser array');
  var totalRecords = exports.reduce(function(sum, e) { return sum + (e.count || 0); }, 0);
  return {
    uid,
    generatedAt: new Date().toISOString(),
    exports,
    totalRecords,
    formats: EXPORT_FORMATS,
    maxContacts: MAX_EXPORT_CONTACTS,
  };
}

module.exports = {
  contactsToCSV,
  conversationsToCSV,
  exportContacts,
  exportConversations,
  generateExportManifest,
  EXPORT_FORMATS,
  CSV_FIELDS_CONTACTS,
  CSV_FIELDS_CONVERSATIONS,
  MAX_EXPORT_CONTACTS,
  __setFirestoreForTests,
};
