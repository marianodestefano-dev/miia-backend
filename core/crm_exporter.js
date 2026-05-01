'use strict';

/**
 * MIIA - CRM Exporter (T166/T167)
 * Exporta leads a CSV y envía webhooks a sistemas externos (HubSpot, Salesforce schema).
 */

let _db = null;
let _httpClient = null;
function __setFirestoreForTests(fs) { _db = fs; }
function __setHttpClientForTests(client) { _httpClient = client; }
function db() { return _db || require('firebase-admin').firestore(); }
function getHttpClient() {
  if (_httpClient) return _httpClient;
  return { post: _defaultPost };
}

const CSV_FIELDS = Object.freeze([
  'phone', 'name', 'email', 'tags', 'score', 'status',
  'firstContact', 'lastContact', 'messageCount', 'sector', 'notes',
]);

const SUPPORTED_CRM = Object.freeze(['hubspot', 'salesforce', 'generic']);
const WEBHOOK_TIMEOUT_MS = 15000;

/**
 * Exporta los contactos de un tenant a formato CSV.
 * @param {string} uid
 * @param {object} [opts] - { fields, filter }
 * @returns {Promise<{csv, rowCount, fields}>}
 */
async function exportToCsv(uid, opts) {
  if (!uid) throw new Error('uid requerido');
  const fields = (opts && opts.fields) ? opts.fields : [...CSV_FIELDS];
  const invalidFields = fields.filter(f => !CSV_FIELDS.includes(f));
  if (invalidFields.length > 0) throw new Error('campos invalidos: ' + invalidFields.join(', '));

  try {
    const contacts = await _getContacts(uid, opts && opts.filter);
    const header = fields.join(',');
    const rows = contacts.map(c => fields.map(f => _csvEscape(_getField(c, f))).join(','));
    const csv = [header, ...rows].join('\n');
    console.log('[CRM] CSV exportado uid=' + uid.substring(0, 8) + ' rows=' + contacts.length);
    return { csv, rowCount: contacts.length, fields };
  } catch (e) {
    console.error('[CRM] Error exportando CSV uid=' + uid.substring(0, 8) + ': ' + e.message);
    throw e;
  }
}

/**
 * Envía datos de un contacto a un CRM externo via webhook.
 * @param {string} uid
 * @param {object} contact
 * @param {string} crmType - 'hubspot' | 'salesforce' | 'generic'
 * @param {string} webhookUrl
 * @param {object} [opts] - { apiKey, timeout }
 * @returns {Promise<{sent, crmType, statusCode}>}
 */
async function sendToCrm(uid, contact, crmType, webhookUrl, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!contact || typeof contact !== 'object') throw new Error('contact requerido');
  if (!SUPPORTED_CRM.includes(crmType)) throw new Error('crmType invalido: ' + crmType);
  if (!webhookUrl || typeof webhookUrl !== 'string') throw new Error('webhookUrl requerido');
  if (!webhookUrl.startsWith('https://')) throw new Error('webhookUrl debe ser HTTPS');

  const payload = _buildCrmPayload(contact, crmType);
  const timeout = (opts && opts.timeout !== undefined) ? opts.timeout : WEBHOOK_TIMEOUT_MS;
  const apiKey = (opts && opts.apiKey) ? opts.apiKey : null;

  const client = getHttpClient();
  try {
    const statusCode = await client.post(webhookUrl, payload, { timeout, apiKey });
    console.log('[CRM] webhook enviado uid=' + uid.substring(0, 8) + ' crm=' + crmType + ' status=' + statusCode);
    return { sent: true, crmType, statusCode };
  } catch (e) {
    console.error('[CRM] Error enviando webhook crm=' + crmType + ': ' + e.message);
    throw e;
  }
}

/**
 * Construye el schema del payload segun el CRM destino.
 */
function _buildCrmPayload(contact, crmType) {
  if (crmType === 'hubspot') {
    return {
      properties: {
        phone: contact.phone || '',
        firstname: (contact.name || '').split(' ')[0] || '',
        lastname: (contact.name || '').split(' ').slice(1).join(' ') || '',
        email: contact.email || '',
        lead_status: contact.status || 'NEW',
        hs_lead_status: _mapToHubspot(contact.status),
      },
    };
  }
  if (crmType === 'salesforce') {
    return {
      LastName: contact.name || contact.phone || 'Lead',
      Phone: contact.phone || '',
      Email: contact.email || '',
      Status: _mapToSalesforce(contact.status),
      LeadSource: 'WhatsApp',
      Description: contact.notes || '',
    };
  }
  return { ...contact, source: 'miia', sentAt: new Date().toISOString() };
}

function _mapToHubspot(status) {
  const map = { new: 'NEW', contacted: 'CONTACTED', qualified: 'QUALIFIED', client: 'CUSTOMER' };
  return map[(status || '').toLowerCase()] || 'NEW';
}

function _mapToSalesforce(status) {
  const map = { new: 'Open - Not Contacted', contacted: 'Working - Contacted', qualified: 'Closed - Converted' };
  return map[(status || '').toLowerCase()] || 'Open - Not Contacted';
}

function _csvEscape(value) {
  const str = String(value === null || value === undefined ? '' : value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function _getField(contact, field) {
  if (field === 'tags') return (contact.tags || []).join(';');
  return contact[field] !== undefined ? contact[field] : '';
}

async function _getContacts(uid, filter) {
  const snap = await db().collection('contacts').doc(uid).collection('leads').get();
  const items = [];
  snap.forEach(doc => {
    const data = doc.data();
    if (filter && filter.status && data.status !== filter.status) return;
    if (filter && filter.minScore && (data.score || 0) < filter.minScore) return;
    items.push({ phone: doc.id, ...data });
  });
  return items;
}

async function _defaultPost(url, payload, opts) {
  const controller = new AbortController();
  let timer;
  try {
    timer = setTimeout(() => controller.abort(), opts.timeout);
    const headers = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers['Authorization'] = 'Bearer ' + opts.apiKey;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.status;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  exportToCsv, sendToCrm,
  CSV_FIELDS, SUPPORTED_CRM,
  _buildCrmPayload, _csvEscape,
  __setFirestoreForTests, __setHttpClientForTests,
};
