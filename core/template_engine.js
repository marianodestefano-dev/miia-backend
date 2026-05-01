'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const TEMPLATE_TYPES = Object.freeze([
  'greeting', 'appointment_reminder', 'appointment_confirmation', 'appointment_cancellation',
  'payment_request', 'payment_confirmed', 'follow_up', 'promotional',
  'welcome', 'coupon', 'broadcast', 'custom',
]);

const TEMPLATE_CHANNELS = Object.freeze(['whatsapp', 'email', 'sms', 'push', 'all']);
const TEMPLATE_LANGUAGES = Object.freeze(['es', 'en', 'pt']);
const VARIABLE_PATTERN = /\{\{([a-zA-Z0-9_]+)\}\}/g;

const MAX_TEMPLATE_NAME_LENGTH = 100;
const MAX_BODY_LENGTH = 4096;
const MAX_VARIABLES_PER_TEMPLATE = 20;
const MAX_TEMPLATES_PER_OWNER = 200;

function isValidType(t) { return TEMPLATE_TYPES.includes(t); }
function isValidChannel(c) { return TEMPLATE_CHANNELS.includes(c); }
function isValidLanguage(l) { return TEMPLATE_LANGUAGES.includes(l); }

function extractVariables(body) {
  if (typeof body !== 'string') return [];
  const vars = new Set();
  let match;
  const re = /\{\{([a-zA-Z0-9_]+)\}\}/g;
  while ((match = re.exec(body)) !== null) {
    vars.add(match[1]);
  }
  return [...vars].slice(0, MAX_VARIABLES_PER_TEMPLATE);
}

function buildTemplateId(uid, name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  return uid.slice(0, 8) + '_tpl_' + slug;
}

function buildTemplateRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, MAX_TEMPLATE_NAME_LENGTH) : 'Plantilla';
  const templateId = data.templateId || buildTemplateId(uid, name);
  const body = typeof data.body === 'string' ? data.body.slice(0, MAX_BODY_LENGTH) : '';
  const variables = extractVariables(body);
  return {
    templateId,
    uid,
    name,
    type: isValidType(data.type) ? data.type : 'custom',
    channel: isValidChannel(data.channel) ? data.channel : 'whatsapp',
    language: isValidLanguage(data.language) ? data.language : 'es',
    body,
    variables,
    variableCount: variables.length,
    active: data.active !== false,
    usageCount: 0,
    lastUsedAt: null,
    tags: Array.isArray(data.tags) ? data.tags.filter(t => typeof t === 'string').slice(0, 10) : [],
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

function renderTemplate(template, variables) {
  if (!template || typeof template.body !== 'string') throw new Error('template invalido');
  variables = variables && typeof variables === 'object' ? variables : {};
  let rendered = template.body;
  const missing = [];
  template.variables.forEach(varName => {
    if (variables[varName] !== undefined && variables[varName] !== null) {
      rendered = rendered.replace(new RegExp('\\{\\{' + varName + '\\}\\}', 'g'), String(variables[varName]));
    } else {
      missing.push(varName);
    }
  });
  return { rendered, missing, complete: missing.length === 0 };
}

function validateTemplate(template) {
  const errors = [];
  if (!template || typeof template !== 'object') return { valid: false, errors: ['template debe ser objeto'] };
  if (!template.name || template.name.trim().length === 0) errors.push('name es obligatorio');
  if (!template.body || template.body.trim().length === 0) errors.push('body es obligatorio');
  if (template.body && template.body.length > MAX_BODY_LENGTH) errors.push('body excede MAX_BODY_LENGTH');
  if (template.variables && template.variables.length > MAX_VARIABLES_PER_TEMPLATE) {
    errors.push('demasiadas variables (max ' + MAX_VARIABLES_PER_TEMPLATE + ')');
  }
  return { valid: errors.length === 0, errors };
}

function buildTemplatePreview(template, sampleVars) {
  if (!template) return 'Plantilla no encontrada.';
  const { rendered, missing } = renderTemplate(template, sampleVars || {});
  const parts = [];
  parts.push('*' + template.name + '* (' + template.type + ' / ' + template.channel + ')');
  parts.push('---');
  parts.push(rendered);
  if (missing.length > 0) {
    parts.push('---');
    parts.push('Variables faltantes: ' + missing.join(', '));
  }
  return parts.join('\n');
}

function buildDefaultTemplates(uid) {
  return [
    buildTemplateRecord(uid, {
      name: 'Bienvenida',
      type: 'welcome',
      body: 'Hola {{nombre}}! Bienvenido/a a {{negocio}}. Estamos encantados de tenerte con nosotros. ¿En qué te puedo ayudar?',
    }),
    buildTemplateRecord(uid, {
      name: 'Recordatorio de Turno',
      type: 'appointment_reminder',
      body: 'Hola {{nombre}}! Te recordamos tu turno de {{servicio}} para el {{fecha}} a las {{hora}}. Si necesitas reprogramar, avisanos.',
    }),
    buildTemplateRecord(uid, {
      name: 'Confirmacion de Pago',
      type: 'payment_confirmed',
      body: 'Hola {{nombre}}! Confirmamos el pago de {{monto}} {{moneda}}. Referencia: {{referencia}}. Gracias!',
    }),
    buildTemplateRecord(uid, {
      name: 'Cupon de Descuento',
      type: 'coupon',
      body: 'Hola {{nombre}}! Tenes un cupon de descuento de {{descuento}}% para usar en {{negocio}}. Codigo: {{codigo}}. Valido hasta {{vencimiento}}.',
    }),
    buildTemplateRecord(uid, {
      name: 'Seguimiento',
      type: 'follow_up',
      body: 'Hola {{nombre}}! Queria saber como te fue con {{servicio}}. ¿Puedo ayudarte con algo mas?',
    }),
  ];
}

async function saveTemplate(uid, template) {
  console.log('[TEMPLATE] Guardando plantilla uid=' + uid + ' id=' + template.templateId + ' type=' + template.type);
  try {
    await db().collection('owners').doc(uid)
      .collection('templates').doc(template.templateId)
      .set(template, { merge: false });
    return template.templateId;
  } catch (err) {
    console.error('[TEMPLATE] Error guardando plantilla:', err.message);
    throw err;
  }
}

async function getTemplate(uid, templateId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('templates').doc(templateId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[TEMPLATE] Error obteniendo plantilla:', err.message);
    return null;
  }
}

async function updateTemplate(uid, templateId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  if (update.body) {
    update.variables = extractVariables(update.body);
    update.variableCount = update.variables.length;
  }
  try {
    await db().collection('owners').doc(uid)
      .collection('templates').doc(templateId)
      .set(update, { merge: true });
    return templateId;
  } catch (err) {
    console.error('[TEMPLATE] Error actualizando plantilla:', err.message);
    throw err;
  }
}

async function listTemplates(uid, opts) {
  opts = opts || {};
  try {
    let q = db().collection('owners').doc(uid).collection('templates');
    if (opts.type && isValidType(opts.type)) {
      q = q.where('type', '==', opts.type);
    }
    const snap = await q.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => {
      const rec = d.data();
      if (opts.channel && rec.channel !== opts.channel) return;
      if (opts.active !== undefined && rec.active !== opts.active) return;
      results.push(rec);
    });
    results.sort((a, b) => b.usageCount - a.usageCount);
    return results.slice(0, opts.limit || 100);
  } catch (err) {
    console.error('[TEMPLATE] Error listando plantillas:', err.message);
    return [];
  }
}

async function recordTemplateUsage(uid, templateId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('templates').doc(templateId).get();
    if (!snap.exists) return null;
    const t = snap.data();
    const update = { usageCount: (t.usageCount || 0) + 1, lastUsedAt: Date.now(), updatedAt: Date.now() };
    await db().collection('owners').doc(uid)
      .collection('templates').doc(templateId)
      .set(update, { merge: true });
    return update.usageCount;
  } catch (err) {
    console.error('[TEMPLATE] Error registrando uso:', err.message);
    return null;
  }
}

module.exports = {
  buildTemplateRecord,
  renderTemplate,
  validateTemplate,
  buildTemplatePreview,
  buildDefaultTemplates,
  extractVariables,
  saveTemplate,
  getTemplate,
  updateTemplate,
  listTemplates,
  recordTemplateUsage,
  TEMPLATE_TYPES,
  TEMPLATE_CHANNELS,
  TEMPLATE_LANGUAGES,
  MAX_TEMPLATE_NAME_LENGTH,
  MAX_BODY_LENGTH,
  MAX_VARIABLES_PER_TEMPLATE,
  __setFirestoreForTests,
};
