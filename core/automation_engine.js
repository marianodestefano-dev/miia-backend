'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const TRIGGER_TYPES = Object.freeze([
  'lead_received', 'appointment_completed', 'appointment_cancelled',
  'payment_received', 'payment_overdue', 'subscription_expiring',
  'loyalty_tier_up', 'survey_submitted', 'coupon_redeemed',
  'crm_stage_changed', 'inactivity_30d', 'first_purchase',
  'abandoned_cart', 'new_referral', 'custom',
]);

const ACTION_TYPES = Object.freeze([
  'send_whatsapp', 'send_email', 'send_notification',
  'start_campaign', 'send_coupon', 'add_loyalty_points',
  'update_crm_stage', 'add_crm_tag', 'set_follow_up',
  'webhook_call', 'create_task', 'custom',
]);

const CONDITION_OPERATORS = Object.freeze(['==', '!=', '>', '<', '>=', '<=', 'contains', 'not_contains', 'in', 'not_in']);
const RULE_STATUSES = Object.freeze(['active', 'paused', 'draft', 'archived']);

const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 5;
const MAX_RULE_NAME = 100;
const MAX_EXECUTIONS_PER_QUERY = 500;
const COOLDOWN_MS_DEFAULT = 3600000; // 1 hora entre ejecuciones por contacto

function isValidTrigger(t) { return TRIGGER_TYPES.includes(t); }
function isValidAction(a) { return ACTION_TYPES.includes(a); }
function isValidOperator(o) { return CONDITION_OPERATORS.includes(o); }
function isValidStatus(s) { return RULE_STATUSES.includes(s); }

function buildRuleId(uid, name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
  return uid.slice(0, 8) + '_rule_' + slug + '_' + Math.random().toString(36).slice(2, 5);
}

function buildCondition(data) {
  data = data || {};
  return {
    field: typeof data.field === 'string' ? data.field.trim().slice(0, 100) : '',
    operator: isValidOperator(data.operator) ? data.operator : '==',
    value: data.value !== undefined ? data.value : null,
  };
}

function buildActionRecord(data) {
  data = data || {};
  return {
    type: isValidAction(data.type) ? data.type : 'send_notification',
    params: data.params && typeof data.params === 'object' ? { ...data.params } : {},
    delayMs: typeof data.delayMs === 'number' ? Math.max(0, data.delayMs) : 0,
  };
}

function buildAutomationRule(uid, data) {
  data = data || {};
  const now = Date.now();
  const name = typeof data.name === 'string' ? data.name.trim().slice(0, MAX_RULE_NAME) : 'Regla ' + now.toString(36);
  const conditions = Array.isArray(data.conditions)
    ? data.conditions.slice(0, MAX_CONDITIONS).map(buildCondition)
    : [];
  const actions = Array.isArray(data.actions)
    ? data.actions.slice(0, MAX_ACTIONS).map(buildActionRecord)
    : [];

  return {
    ruleId: data.ruleId || buildRuleId(uid, name),
    uid,
    name,
    description: typeof data.description === 'string' ? data.description.slice(0, 500) : '',
    triggerType: isValidTrigger(data.triggerType) ? data.triggerType : 'custom',
    conditions,
    actions,
    conditionLogic: data.conditionLogic === 'OR' ? 'OR' : 'AND',
    status: isValidStatus(data.status) ? data.status : 'active',
    cooldownMs: typeof data.cooldownMs === 'number' ? Math.max(0, data.cooldownMs) : COOLDOWN_MS_DEFAULT,
    maxExecutions: typeof data.maxExecutions === 'number' ? Math.max(0, data.maxExecutions) : 0, // 0 = ilimitado
    executionCount: 0,
    lastExecutedAt: null,
    metadata: data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {},
    createdAt: now,
    updatedAt: now,
  };
}

function evaluateCondition(condition, context) {
  const { field, operator, value } = condition;
  if (!field || !context || typeof context !== 'object') return false;
  const actual = context[field];
  switch (operator) {
    case '==': return actual === value;
    case '!=': return actual !== value;
    case '>':  return typeof actual === 'number' && actual > value;
    case '<':  return typeof actual === 'number' && actual < value;
    case '>=': return typeof actual === 'number' && actual >= value;
    case '<=': return typeof actual === 'number' && actual <= value;
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(value));
      if (Array.isArray(actual)) return actual.includes(value);
      return false;
    case 'not_contains':
      if (typeof actual === 'string') return !actual.includes(String(value));
      if (Array.isArray(actual)) return !actual.includes(value);
      return true;
    case 'in':
      return Array.isArray(value) && value.includes(actual);
    case 'not_in':
      return Array.isArray(value) && !value.includes(actual);
    default:
      return false;
  }
}

function evaluateConditions(conditions, context, logic) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  if (logic === 'OR') {
    return conditions.some(c => evaluateCondition(c, context));
  }
  return conditions.every(c => evaluateCondition(c, context));
}

function shouldTrigger(rule, event, context, lastContactExecution) {
  if (!rule || rule.status !== 'active') return false;
  if (rule.triggerType !== event && rule.triggerType !== 'custom') return false;
  if (rule.maxExecutions > 0 && rule.executionCount >= rule.maxExecutions) return false;
  if (rule.cooldownMs > 0 && lastContactExecution) {
    const elapsed = Date.now() - lastContactExecution;
    if (elapsed < rule.cooldownMs) return false;
  }
  if (!evaluateConditions(rule.conditions, context, rule.conditionLogic)) return false;
  return true;
}

function recordExecution(rule) {
  const now = Date.now();
  return {
    ...rule,
    executionCount: rule.executionCount + 1,
    lastExecutedAt: now,
    updatedAt: now,
  };
}

function pauseRule(rule) {
  if (rule.status === 'archived') throw new Error('cannot_pause_archived');
  return { ...rule, status: 'paused', updatedAt: Date.now() };
}

function activateRule(rule) {
  if (rule.status === 'archived') throw new Error('cannot_activate_archived');
  return { ...rule, status: 'active', updatedAt: Date.now() };
}

function archiveRule(rule) {
  return { ...rule, status: 'archived', updatedAt: Date.now() };
}

function buildExecutionLog(uid, ruleId, data) {
  data = data || {};
  const now = Date.now();
  return {
    logId: uid.slice(0, 6) + '_exlog_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 5),
    uid,
    ruleId,
    triggerType: data.triggerType || 'custom',
    contactPhone: typeof data.contactPhone === 'string' ? data.contactPhone.trim() : null,
    triggerContext: data.triggerContext && typeof data.triggerContext === 'object' ? { ...data.triggerContext } : {},
    actionsExecuted: Array.isArray(data.actionsExecuted) ? data.actionsExecuted.slice(0, MAX_ACTIONS) : [],
    success: data.success !== false,
    errorMessage: typeof data.errorMessage === 'string' ? data.errorMessage.slice(0, 500) : null,
    durationMs: typeof data.durationMs === 'number' ? Math.max(0, data.durationMs) : 0,
    executedAt: now,
  };
}

function computeAutomationStats(logs) {
  if (!Array.isArray(logs) || logs.length === 0) {
    return { total: 0, successCount: 0, failureCount: 0, successRate: 0, byTrigger: {}, avgDurationMs: 0 };
  }
  let successCount = 0, failureCount = 0, totalDuration = 0;
  const byTrigger = {};
  for (const log of logs) {
    if (log.success) successCount++;
    else failureCount++;
    totalDuration += log.durationMs || 0;
    byTrigger[log.triggerType] = (byTrigger[log.triggerType] || 0) + 1;
  }
  const successRate = Math.round(successCount / logs.length * 100 * 100) / 100;
  const avgDurationMs = Math.round(totalDuration / logs.length);
  return { total: logs.length, successCount, failureCount, successRate, byTrigger, avgDurationMs };
}

function buildAutomationSummaryText(rule) {
  if (!rule) return 'Regla no encontrada.';
  const statusIcon = rule.status === 'active' ? '\u{2705}' : rule.status === 'paused' ? '\u{23F8}\u{FE0F}' : '\u{1F4CA}';
  const lines = [];
  lines.push(statusIcon + ' *' + rule.name + '* (' + rule.status + ')');
  lines.push('Trigger: ' + rule.triggerType);
  lines.push('Condiciones: ' + rule.conditions.length + ' (' + rule.conditionLogic + ')');
  lines.push('Acciones: ' + rule.actions.map(a => a.type).join(', '));
  lines.push('Ejecuciones: ' + rule.executionCount + (rule.maxExecutions > 0 ? '/' + rule.maxExecutions : ''));
  lines.push('Cooldown: ' + (rule.cooldownMs / 3600000).toFixed(1) + 'h');
  if (rule.lastExecutedAt) lines.push('Ultima ejecucion: ' + new Date(rule.lastExecutedAt).toISOString().slice(0, 10));
  return lines.join('\n');
}

// ─── Firestore CRUD ──────────────────────────────────────────────────────────

async function saveAutomationRule(uid, rule) {
  console.log('[AUTOMATION] Guardando regla uid=' + uid + ' ruleId=' + rule.ruleId + ' status=' + rule.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('automation_rules').doc(rule.ruleId)
      .set(rule, { merge: false });
    return rule.ruleId;
  } catch (err) {
    console.error('[AUTOMATION] Error guardando regla:', err.message);
    throw err;
  }
}

async function getAutomationRule(uid, ruleId) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('automation_rules').doc(ruleId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[AUTOMATION] Error obteniendo regla:', err.message);
    return null;
  }
}

async function updateAutomationRule(uid, ruleId, fields) {
  const update = { ...fields, updatedAt: Date.now() };
  try {
    await db().collection('owners').doc(uid)
      .collection('automation_rules').doc(ruleId)
      .set(update, { merge: true });
    return ruleId;
  } catch (err) {
    console.error('[AUTOMATION] Error actualizando regla:', err.message);
    throw err;
  }
}

async function saveExecutionLog(uid, log) {
  console.log('[AUTOMATION] Guardando log id=' + log.logId + ' success=' + log.success);
  try {
    await db().collection('owners').doc(uid)
      .collection('automation_logs').doc(log.logId)
      .set(log, { merge: false });
    return log.logId;
  } catch (err) {
    console.error('[AUTOMATION] Error guardando log:', err.message);
    throw err;
  }
}

async function listActiveRules(uid) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('automation_rules').where('status', '==', 'active').get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[AUTOMATION] Error listando reglas activas:', err.message);
    return [];
  }
}

async function listRulesByTrigger(uid, triggerType) {
  try {
    const snap = await db().collection('owners').doc(uid)
      .collection('automation_rules').where('triggerType', '==', triggerType).get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results;
  } catch (err) {
    console.error('[AUTOMATION] Error listando reglas por trigger:', err.message);
    return [];
  }
}

async function listExecutionLogs(uid, ruleId) {
  try {
    const ref = db().collection('owners').doc(uid).collection('automation_logs');
    const snap = ruleId
      ? await ref.where('ruleId', '==', ruleId).get()
      : await ref.get();
    if (snap.empty) return [];
    const results = [];
    snap.forEach(d => results.push(d.data()));
    return results.slice(0, MAX_EXECUTIONS_PER_QUERY);
  } catch (err) {
    console.error('[AUTOMATION] Error listando logs:', err.message);
    return [];
  }
}

module.exports = {
  buildAutomationRule,
  buildCondition,
  buildActionRecord,
  evaluateCondition,
  evaluateConditions,
  shouldTrigger,
  recordExecution,
  pauseRule,
  activateRule,
  archiveRule,
  buildExecutionLog,
  computeAutomationStats,
  buildAutomationSummaryText,
  saveAutomationRule,
  getAutomationRule,
  updateAutomationRule,
  saveExecutionLog,
  listActiveRules,
  listRulesByTrigger,
  listExecutionLogs,
  TRIGGER_TYPES,
  ACTION_TYPES,
  CONDITION_OPERATORS,
  RULE_STATUSES,
  MAX_CONDITIONS,
  MAX_ACTIONS,
  COOLDOWN_MS_DEFAULT,
  __setFirestoreForTests,
};
