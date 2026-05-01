'use strict';

/**
 * MIIA - Contact Importer (T208)
 * Importa contactos desde CSV al tenant.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const MAX_IMPORT_CONTACTS = 5000;
const REQUIRED_FIELDS = Object.freeze(['phone']);
const ALLOWED_FIELDS = Object.freeze(['phone', 'name', 'email', 'tags', 'notes', 'score', 'language']);

function parseCSV(csvText) {
  if (typeof csvText !== 'string') throw new Error('csvText debe ser string');
  var lines = csvText.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 0) return [];
  var headers = lines[0].split(',').map(function(h) { return h.trim().replace(/^"|"$/g, ''); });
  return lines.slice(1).map(function(line) {
    var values = [];
    var current = '';
    var inQuote = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    var obj = {};
    headers.forEach(function(h, idx) { obj[h] = values[idx] !== undefined ? values[idx] : ''; });
    return obj;
  });
}

function validateContact(contact) {
  for (var i = 0; i < REQUIRED_FIELDS.length; i++) {
    var f = REQUIRED_FIELDS[i];
    if (!contact[f]) return { valid: false, reason: 'campo requerido: ' + f };
  }
  if (!/^\+?[0-9]{6,15}$/.test(String(contact.phone).replace(/[\s\-]/g, ''))) {
    return { valid: false, reason: 'phone invalido: ' + contact.phone };
  }
  return { valid: true };
}

function normalizeContact(raw) {
  var c = {};
  ALLOWED_FIELDS.forEach(function(f) {
    if (raw[f] !== undefined && raw[f] !== '') {
      if (f === 'tags') {
        c[f] = typeof raw[f] === 'string' ? raw[f].split('|').map(function(t) { return t.trim(); }).filter(Boolean) : raw[f];
      } else if (f === 'score') {
        var s = parseFloat(raw[f]);
        c[f] = isNaN(s) ? 0 : Math.min(100, Math.max(0, s));
      } else {
        c[f] = String(raw[f]).trim();
      }
    }
  });
  if (c.phone) c.phone = String(c.phone).replace(/[\s\-]/g, '');
  return c;
}

async function importContacts(uid, contacts, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(contacts)) throw new Error('contacts debe ser array');
  var overwrite = opts && opts.overwrite === true;
  var limited = contacts.slice(0, MAX_IMPORT_CONTACTS);
  var imported = 0, skipped = 0, errors = [];

  for (var i = 0; i < limited.length; i++) {
    var raw = limited[i];
    var vr = validateContact(raw);
    if (!vr.valid) {
      errors.push({ index: i, phone: raw.phone || '', reason: vr.reason });
      skipped++;
      continue;
    }
    var norm = normalizeContact(raw);
    try {
      var ref = db().collection('tenants').doc(uid).collection('contacts').doc(norm.phone);
      if (overwrite) {
        await ref.set(norm, { merge: false });
      } else {
        await ref.set(norm, { merge: true });
      }
      imported++;
    } catch (e) {
      console.error('[CONTACT_IMPORTER] Error guardando ' + norm.phone + ': ' + e.message);
      errors.push({ index: i, phone: norm.phone, reason: e.message });
      skipped++;
    }
  }

  return { imported, skipped, errors, total: limited.length };
}

async function importFromCSV(uid, csvText, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!csvText) throw new Error('csvText requerido');
  var rows = parseCSV(csvText);
  return importContacts(uid, rows, opts);
}

module.exports = {
  parseCSV,
  validateContact,
  normalizeContact,
  importContacts,
  importFromCSV,
  REQUIRED_FIELDS,
  ALLOWED_FIELDS,
  MAX_IMPORT_CONTACTS,
  __setFirestoreForTests,
};
