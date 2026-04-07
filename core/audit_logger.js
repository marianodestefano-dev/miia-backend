// ════════════════════════════════════════════════════════════════════════════
// MIIA — Audit Logger (P4.1)
// (c) 2024-2026 Mariano De Stefano. All rights reserved.
// ════════════════════════════════════════════════════════════════════════════
// Registra CADA acceso a datos de usuario para transparencia total.
// Quién accedió, qué vio, cuándo. Debounced para no saturar Firestore.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
let _db = null;
function db() { if (!_db) _db = admin.firestore(); return _db; }

// Buffer en memoria: { uid: [ { type, actor, resource, timestamp, ip } ] }
const buffer = {};
const FLUSH_INTERVAL = 120_000; // 2 min

// Tipos de acceso
const ACCESS_TYPES = {
  VIEW_DASHBOARD: 'view_dashboard',
  VIEW_CONTACTS: 'view_contacts',
  VIEW_TRAINING: 'view_training',
  VIEW_DOCUMENTS: 'view_documents',
  EXPORT_DATA: 'export_data',
  DELETE_ACCOUNT: 'delete_account',
  MODIFY_BUSINESS: 'modify_business',
  MODIFY_CONTACT: 'modify_contact',
  MODIFY_SLOT: 'modify_slot',
  MODIFY_AI_CONFIG: 'modify_ai_config',
  VIEW_PRIVACY_REPORT: 'view_privacy_report',
  ADMIN_ACCESS: 'admin_access',
  AGENT_ACCESS: 'agent_access',
  API_ACCESS: 'api_access',
  NUMBER_MIGRATION: 'number_migration',
  WHATSAPP_SESSION: 'whatsapp_session'
};

/**
 * Registra un acceso en el buffer.
 * @param {string} ownerUid - UID del owner cuyos datos se accedieron
 * @param {{ type: string, actor: string, actorRole: string, resource: string, details?: string, ip?: string }} entry
 */
function logAccess(ownerUid, entry) {
  if (!ownerUid || !entry.type) return;
  if (!buffer[ownerUid]) buffer[ownerUid] = [];
  buffer[ownerUid].push({
    type: entry.type,
    actor: entry.actor || 'system',
    actorRole: entry.actorRole || 'system',
    resource: entry.resource || '',
    details: entry.details || '',
    ip: entry.ip || '',
    timestamp: new Date().toISOString()
  });
  console.log(`[AUDIT] 📋 ${entry.type} por ${entry.actor || 'system'} → ${ownerUid} (${entry.resource || ''})`);
}

/**
 * Flush buffer a Firestore.
 */
async function flush() {
  const uids = Object.keys(buffer);
  if (uids.length === 0) return;

  let totalWrites = 0;
  for (const uid of uids) {
    const entries = buffer[uid];
    if (!entries || entries.length === 0) continue;

    const batch = db().batch();
    for (const entry of entries) {
      const ref = db().collection('users').doc(uid).collection('audit_logs').doc();
      batch.set(ref, entry);
      totalWrites++;
    }

    try {
      await batch.commit();
    } catch (e) {
      console.error(`[AUDIT] ❌ Flush error for ${uid}:`, e.message);
    }

    delete buffer[uid];
  }

  if (totalWrites > 0) {
    console.log(`[AUDIT] ✅ Flushed ${totalWrites} audit entries`);
  }
}

/**
 * Obtiene logs de acceso de un owner (paginado).
 * @param {string} ownerUid
 * @param {{ limit?: number, offset?: number, type?: string }} opts
 */
async function getAccessLogs(ownerUid, opts = {}) {
  try {
    let query = db().collection('users').doc(ownerUid)
      .collection('audit_logs')
      .orderBy('timestamp', 'desc');

    if (opts.type) {
      query = query.where('type', '==', opts.type);
    }

    query = query.limit(opts.limit || 50);

    const snap = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Si falla por index, intentar sin orderBy
    try {
      const snap = await db().collection('users').doc(ownerUid)
        .collection('audit_logs').limit(opts.limit || 50).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e2) {
      console.error(`[AUDIT] ❌ getAccessLogs error:`, e2.message);
      return [];
    }
  }
}

/**
 * Resumen de accesos agrupado por tipo y actor.
 */
async function getAccessSummary(ownerUid, periodDays = 30) {
  const logs = await getAccessLogs(ownerUid, { limit: 500 });
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - periodDays);
  const cutoffStr = cutoff.toISOString();

  const filtered = logs.filter(l => l.timestamp >= cutoffStr);

  // Agrupar por tipo
  const byType = {};
  const byActor = {};
  for (const log of filtered) {
    byType[log.type] = (byType[log.type] || 0) + 1;
    const actor = log.actor || 'system';
    if (!byActor[actor]) byActor[actor] = { count: 0, role: log.actorRole || 'unknown', lastAccess: log.timestamp };
    byActor[actor].count++;
    if (log.timestamp > byActor[actor].lastAccess) byActor[actor].lastAccess = log.timestamp;
  }

  return {
    totalAccesses: filtered.length,
    periodDays,
    byType,
    byActor,
    lastAccess: filtered[0]?.timestamp || null
  };
}

/**
 * Express middleware para registrar accesos a endpoints de tenant.
 */
function auditMiddleware(accessType) {
  return (req, res, next) => {
    const uid = req.params.uid;
    if (uid) {
      logAccess(uid, {
        type: accessType,
        actor: req.headers['x-user-uid'] || req.params.uid || 'api',
        actorRole: req.headers['x-user-role'] || 'owner',
        resource: req.originalUrl || req.path,
        ip: req.ip || req.connection?.remoteAddress || ''
      });
    }
    next();
  };
}

// Auto-flush cada 2 min
let _flushTimer = null;
function startAutoFlush() {
  if (_flushTimer) return;
  _flushTimer = setInterval(flush, FLUSH_INTERVAL);
  console.log('[AUDIT] 🟢 Auto-flush iniciado (cada 2min)');
}

function stopAutoFlush() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
}

module.exports = {
  ACCESS_TYPES,
  logAccess,
  flush,
  getAccessLogs,
  getAccessSummary,
  auditMiddleware,
  startAutoFlush,
  stopAutoFlush
};
