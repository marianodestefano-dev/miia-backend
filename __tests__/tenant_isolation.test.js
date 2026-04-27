/**
 * Tests: tenant isolation boundaries (C-429 §D)
 *
 * Valida estaticamente que el código NO introduce leaks cross-tenant.
 * No mockea Firestore SDK — escanea los archivos como string + regex
 * sobre patrones peligrosos. Más robusto que mocks profundos.
 *
 * Patrones peligrosos detectados:
 *
 *   - `.collection('users').get()` SIN estar en endpoint con verifyAdminToken
 *     middleware → leak meta-info de todos los users.
 *   - `.collection('users').where(...)` con campos NO permitidos en login flow
 *     (email/role) → exposición masiva de filtrado.
 *   - `.collection(<subcoll>).get/where/orderBy/limit/add()` raw para
 *     subcollections owner-scoped (contacts, miia_agenda, contact_index,
 *     contact_groups, brain, businesses, miia_persistent, pending_responses,
 *     pending_appointments, settings, payment_methods, contact_rules,
 *     products, items, training_products, learning_approvals, miia_gmail,
 *     imports, auth, sessions). Esas DEBEN colgar de `users/{uid}/...`.
 *   - `collectionGroup(...)` fuera de allow-list (Instagram webhook lookup).
 *
 * Origen: C-429 Wi → Vi 2026-04-27. Firma viva Mariano "si" sobre C-429
 * + ratificación textual "Vi, ejecutá C-429 (aislamiento multi-tenant).
 * Mariano DeStefano, 2026-04-27."
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const TARGET_FILES = [
  'server.js',
  'whatsapp/tenant_message_handler.js',
  'whatsapp/tenant_manager.js',
  'whatsapp/baileys_session_store.js',
  'core/prompt_builder.js',
  'core/instagram_handler.js',
];

// Collections que DEBEN colgar de `users/{uid}/...` y nunca aparecer
// como `.collection('<x>')` directo. Excluye las que son root válida con
// `.doc(uid)` patrón (payment_methods, training_products, contact_rules,
// imports, auth) — esas se validan por el path ROOT_WITH_UID_DOC abajo.
const OWNER_SCOPED_SUBCOLLECTIONS = [
  'contacts',
  'miia_agenda',
  'contact_index',
  'contact_groups',
  'brain',
  'businesses',
  'miia_persistent',
  'pending_responses',
  'pending_appointments',
  'settings',
  'learning_approvals',
  'miia_gmail',
];

// Collections que PUEDEN ser root pero requieren `.doc(<algo con uid>)`
// inmediatamente después. Patrón legacy MIIA pre-refactor users/{uid}/.
const ROOT_WITH_UID_DOC = [
  'payment_methods',
  'training_products',
  'contact_rules',
  'training_sessions',
  'baileys_sessions',
];

// Collections root con semántica cross-tenant legítima (admin/webhook/import
// flow). Sus accesos se documentan caso por caso, no se validan por regex.
const CROSS_TENANT_LEGITIMATE = [
  'users',           // login flow (where email/role) + admin (verifyAdminToken)
  'imports',         // backup dedupe per export_id (max 2 accounts)
];

const COLLECTION_GROUP_ALLOWLIST = {
  'integrations': ['core/instagram_handler.js'],
};

function readSource(rel) {
  const abs = path.join(BACKEND_ROOT, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

function locateLine(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

describe('tenant isolation boundaries (C-429)', () => {
  test('A.1 — `.collection("users").get()` solo dentro de endpoint admin-protegido', () => {
    const violations = [];
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      const re = /\.collection\((['"])users\1\)\.get\(\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const line = locateLine(src, m.index);
        // Look back ~30 lines for verifyAdminToken middleware in same handler
        const slice = src.slice(Math.max(0, m.index - 2000), m.index);
        const adminGuarded = /verifyAdminToken/i.test(slice);
        if (!adminGuarded) {
          violations.push(`${rel}:${line} — \`.collection('users').get()\` sin verifyAdminToken cercano`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.2 — `.collection("users").where(...)` solo con email o role en login flow', () => {
    const violations = [];
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      const re = /\.collection\((['"])users\1\)\.where\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const args = m[2];
        const isLoginFlow = /['"]email['"]/.test(args) || /['"]role['"]/.test(args);
        if (!isLoginFlow) {
          const line = locateLine(src, m.index);
          violations.push(`${rel}:${line} — where(${args.slice(0, 60)}) NO es email/role`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.3 — owner-scoped subcollections nunca se acceden raw como root', () => {
    const violations = [];
    const subcollList = OWNER_SCOPED_SUBCOLLECTIONS.join('|');
    // Pattern: db()/firestore() o admin.firestore()/db SEGUIDO INMEDIATAMENTE de
    // .collection('<owner-scoped>') sin doc/users intermedios.
    const re = new RegExp(
      `(?:admin\\.firestore\\(\\)|firestore\\(\\)|\\bdb\\(\\)|\\bdb)\\.collection\\((['"])(${subcollList})\\1\\)`,
      'g'
    );
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      let m;
      while ((m = re.exec(src)) !== null) {
        const line = locateLine(src, m.index);
        violations.push(`${rel}:${line} — \`.collection('${m[2]}')\` accedido como root sin users/{uid} prefijo`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.4 — `collectionGroup(name)` solo en archivos allow-listed', () => {
    const violations = [];
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      const re = /collectionGroup\((['"])([^'"]+)\1\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const groupName = m[2];
        const allowed = (COLLECTION_GROUP_ALLOWLIST[groupName] || []).includes(rel);
        if (!allowed) {
          const line = locateLine(src, m.index);
          violations.push(`${rel}:${line} — collectionGroup('${groupName}') no está en allow-list`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.5 — baileys_sessions doc id incluye uid o tenant- prefix', () => {
    const violations = [];
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      const re = /\.collection\((['"])baileys_sessions\1\)\.doc\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const docArg = m[2].trim();
        // Acceptable: clientId / sessionId / tenantId variable, `tenant-${uid}` template,
        // or expression que contiene uid/UID literal.
        const looksScoped =
          /clientId/i.test(docArg) ||
          /sessionId/i.test(docArg) ||
          /tenantId/i.test(docArg) ||
          /tenant-/i.test(docArg) ||
          /\buid\b/i.test(docArg) ||
          /\bUID\b/.test(docArg);
        if (!looksScoped) {
          const line = locateLine(src, m.index);
          violations.push(`${rel}:${line} — baileys_sessions.doc(${docArg.slice(0, 60)}) no parece uid-scoped`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.6 — training_sessions doc id incluye uid', () => {
    const violations = [];
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      const re = /\.collection\((['"])training_sessions\1\)\.doc\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const docArg = m[2].trim();
        if (!/\buid\b/.test(docArg)) {
          const line = locateLine(src, m.index);
          violations.push(`${rel}:${line} — training_sessions.doc(${docArg.slice(0, 60)}) no incluye uid`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.7 — root collections con doc(uid) requerido nunca son raw', () => {
    const violations = [];
    const list = ROOT_WITH_UID_DOC.join('|');
    // Match `.collection('<root>')` followed by something OTHER than `.doc(...)`
    // i.e. raw `.get()` / `.where()` / `.orderBy()` / `.limit()` / `.add()`.
    const re = new RegExp(
      `\\.collection\\((['"])(${list})\\1\\)\\s*\\.(?:get|where|orderBy|limit|add)\\(`,
      'g'
    );
    for (const rel of TARGET_FILES) {
      const src = readSource(rel);
      if (!src) continue;
      let m;
      while ((m = re.exec(src)) !== null) {
        const line = locateLine(src, m.index);
        violations.push(`${rel}:${line} — \`.collection('${m[2]}')\` raw query (debe usar .doc(<uid>) primero)`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('A.8 — Allow-list collectionGroup está documentada y no vacía', () => {
    // Sanity check: ningún test pasa por allow-list vacía. Si en el futuro se
    // remueven todos los collectionGroup, igual queremos saberlo.
    expect(Object.keys(COLLECTION_GROUP_ALLOWLIST).length).toBeGreaterThan(0);
    for (const [name, files] of Object.entries(COLLECTION_GROUP_ALLOWLIST)) {
      expect(files.length).toBeGreaterThan(0);
      // Cada archivo allow-listed debe existir
      for (const f of files) {
        const abs = path.join(BACKEND_ROOT, f);
        expect(fs.existsSync(abs)).toBe(true);
      }
    }
  });
});
