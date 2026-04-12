'use strict';

/**
 * BACKUP FIRESTORE — Exporta documentos críticos a JSON local
 *
 * STANDARD: Google + Amazon + NASA
 *
 * Ejecutar: node scripts/backup_firestore.js [uid]
 *
 * Exporta por cada usuario:
 *   - /users/{uid} (root doc)
 *   - /users/{uid}/miia_persistent/training_data
 *   - /users/{uid}/personal/personal_brain
 *   - /users/{uid}/miia_agenda/* (todos los eventos)
 *   - /users/{uid}/businesses/* (todos los negocios)
 *   - /users/{uid}/contact_index/* (todos los contactos)
 *   - /users/{uid}/contact_groups/* (todos los grupos)
 *
 * También exportable desde cron (server.js) con exportUserData(uid).
 *
 * SEGURIDAD: Los backups se guardan en /backups/firestore/ con fecha.
 * Los tokens OAuth NO se exportan (seguridad).
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Init Firebase si no está inicializado
if (!admin.apps.length) {
  const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(serviceAccountPath)) {
    admin.initializeApp({ credential: admin.credential.cert(require(serviceAccountPath)) });
  } else {
    console.error('❌ serviceAccountKey.json no encontrado');
    process.exit(1);
  }
}

const db = admin.firestore();
const BACKUP_DIR = path.join(__dirname, '..', 'backups', 'firestore');

// Campos sensibles que NO se exportan
const SENSITIVE_FIELDS = ['accessToken', 'refreshToken', 'aiApiKey', 'paddleSubscription'];

function sanitizeDoc(data) {
  if (!data) return data;
  const clean = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (clean[field]) clean[field] = '[REDACTED]';
  }
  return clean;
}

/**
 * Exportar todos los datos críticos de un usuario.
 * @param {string} uid - UID del usuario
 * @returns {Object} Datos exportados
 */
async function exportUserData(uid) {
  console.log(`[BACKUP] 📦 Exportando datos de ${uid}...`);
  const backup = { uid, exportedAt: new Date().toISOString(), collections: {} };

  // Root doc
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    backup.rootDoc = userDoc.exists ? sanitizeDoc(userDoc.data()) : null;
  } catch (e) { console.error(`[BACKUP] ❌ users/${uid}: ${e.message}`); }

  // Sub-collections críticas
  const subCollections = [
    'miia_persistent',
    'miia_agenda',
    'businesses',
    'contact_index',
    'contact_groups',
    'personal',
    'settings',
  ];

  for (const col of subCollections) {
    try {
      const snap = await db.collection('users').doc(uid).collection(col).get();
      const docs = {};
      snap.forEach(doc => {
        docs[doc.id] = sanitizeDoc(doc.data());
      });
      backup.collections[col] = { count: Object.keys(docs).length, docs };
      console.log(`[BACKUP] ✅ ${col}: ${Object.keys(docs).length} docs`);
    } catch (e) {
      console.error(`[BACKUP] ❌ ${col}: ${e.message}`);
      backup.collections[col] = { error: e.message };
    }
  }

  return backup;
}

/**
 * Guardar backup en disco.
 * @param {Object} backup - Datos del backup
 * @returns {string} Path del archivo guardado
 */
function saveBackup(backup) {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const date = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const filename = `backup_${backup.uid.substring(0, 8)}_${date}.json`;
  const filepath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`[BACKUP] 💾 Guardado: ${filepath} (${Math.round(fs.statSync(filepath).size / 1024)}KB)`);

  // Limpiar backups viejos (mantener últimos 10 por usuario)
  cleanOldBackups(backup.uid);

  return filepath;
}

/**
 * Eliminar backups viejos, mantener últimos 10.
 */
function cleanOldBackups(uid) {
  try {
    const prefix = `backup_${uid.substring(0, 8)}_`;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(prefix))
      .sort()
      .reverse();

    if (files.length > 10) {
      for (const f of files.slice(10)) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
        console.log(`[BACKUP] 🗑️ Eliminado backup viejo: ${f}`);
      }
    }
  } catch (e) {
    console.warn(`[BACKUP] ⚠️ Error limpiando backups viejos: ${e.message}`);
  }
}

/**
 * Exportar y guardar backup de un usuario (para uso desde cron).
 * @param {string} uid
 * @returns {Promise<string>} Path del backup
 */
async function backupUser(uid) {
  const data = await exportUserData(uid);
  return saveBackup(data);
}

/**
 * Exportar TODOS los usuarios activos.
 * @returns {Promise<string[]>} Paths de backups
 */
async function backupAllUsers() {
  console.log(`[BACKUP] 🔄 Exportando TODOS los usuarios...`);
  const paths = [];
  try {
    const usersSnap = await db.collection('users').get();
    for (const doc of usersSnap.docs) {
      try {
        const p = await backupUser(doc.id);
        paths.push(p);
      } catch (e) {
        console.error(`[BACKUP] ❌ Error exportando ${doc.id}: ${e.message}`);
      }
    }
    console.log(`[BACKUP] ✅ Backup completo: ${paths.length} usuarios exportados`);
  } catch (e) {
    console.error(`[BACKUP] ❌ Error obteniendo lista de usuarios: ${e.message}`);
  }
  return paths;
}

// ═══════════════════════════════════════════════════════════════
// CLI — node scripts/backup_firestore.js [uid|--all]
// ═══════════════════════════════════════════════════════════════

if (require.main === module) {
  const arg = process.argv[2];
  (async () => {
    try {
      if (arg === '--all') {
        await backupAllUsers();
      } else if (arg) {
        await backupUser(arg);
      } else {
        console.log('Uso: node scripts/backup_firestore.js <uid|--all>');
        console.log('  <uid>   — Backup de un usuario específico');
        console.log('  --all   — Backup de todos los usuarios');
      }
    } catch (e) {
      console.error(`❌ Error: ${e.message}`);
    }
    process.exit(0);
  })();
}

module.exports = { exportUserData, saveBackup, backupUser, backupAllUsers, BACKUP_DIR };
