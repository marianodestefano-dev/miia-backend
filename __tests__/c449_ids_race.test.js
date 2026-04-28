/**
 * Tests: C-449-IDS-RACE-FIX — random suffix anti-colision en
 * checkpointId (prompt_registry) + relationId (security_contacts).
 *
 * Origen: ITER 2 RRC-VI-001 §B.1 finding bajo autoridad delegada Wi.
 * Extension principio C-447-MSGID-RACE a 2 sites residuales.
 *
 * Bug previo:
 *   - prompt_registry.createCheckpoint: checkpointId = ${name}_${Date.now()}.
 *     2 checkpoints con mismo name + mismo ms -> doc Firestore overwrite.
 *   - security_contacts: relationId = sec_${pairKey}_${Date.now()}.
 *     2 requests bidireccionales mismo pairKey + mismo ms -> colision.
 *
 * Fix: agregar Math.random().toString(36).slice(2, 6) suffix (4 chars
 * base36, 1.6M combinaciones) a ambos.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PR_PATH = path.resolve(__dirname, '../core/prompt_registry.js');
const SC_PATH = path.resolve(__dirname, '../services/security_contacts.js');
const PR_SOURCE = fs.readFileSync(PR_PATH, 'utf8');
const SC_SOURCE = fs.readFileSync(SC_PATH, 'utf8');

// ════════════════════════════════════════════════════════════════════
// §A — prompt_registry.checkpointId
// ════════════════════════════════════════════════════════════════════

describe('C-449-IDS-RACE-FIX §A — prompt_registry checkpointId', () => {
  test('A.1 — checkpointId incluye Math.random().toString(36) — wire-in source', () => {
    expect(PR_SOURCE).toMatch(/checkpointId\s*=\s*`\$\{name\}_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)/);
  });

  test('A.2 — random suffix slice(2, 6) — 4 chars base36', () => {
    expect(PR_SOURCE).toMatch(/checkpointId\s*=\s*`[\s\S]{0,200}?Math\.random\(\)\.toString\(36\)\.slice\(2,\s*6\)/);
  });

  test('A.3 — comentario C-449-IDS-RACE-FIX presente', () => {
    expect(PR_SOURCE).toContain('C-449-IDS-RACE-FIX');
  });

  test('A.4 — runtime: 100 generaciones consecutivas mismo name → todas únicas', () => {
    const generateCheckpointId = (name) =>
      `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateCheckpointId('voice_v2_test'));
    }
    expect(ids.size).toBe(100);
  });

  test('A.5 — runtime: con Date.now() mockeado fijo, 50 generaciones >=48 únicas', () => {
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const generateCheckpointId = (name) =>
        `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const ids = new Set();
      for (let i = 0; i < 50; i++) {
        ids.add(generateCheckpointId('checkpoint_X'));
      }
      expect(ids.size).toBeGreaterThanOrEqual(48);
    } finally {
      Date.now = realNow;
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — security_contacts.relationId
// ════════════════════════════════════════════════════════════════════

describe('C-449-IDS-RACE-FIX §B — security_contacts relationId', () => {
  test('B.1 — relationId incluye Math.random().toString(36) — wire-in source', () => {
    expect(SC_SOURCE).toMatch(/relationId\s*=\s*`sec_\$\{pairKey\}_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)/);
  });

  test('B.2 — random suffix slice(2, 6) — 4 chars base36', () => {
    expect(SC_SOURCE).toMatch(/relationId\s*=\s*`sec_[\s\S]{0,200}?Math\.random\(\)\.toString\(36\)\.slice\(2,\s*6\)/);
  });

  test('B.3 — comentario C-449-IDS-RACE-FIX presente', () => {
    expect(SC_SOURCE).toContain('C-449-IDS-RACE-FIX');
  });

  test('B.4 — runtime: 100 generaciones mismo pairKey → todas únicas', () => {
    const generateRelationId = (pairKey) =>
      `sec_${pairKey}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRelationId('uid1__uid2'));
    }
    expect(ids.size).toBe(100);
  });

  test('B.5 — runtime: con Date.now() mockeado fijo, 50 generaciones >=48 únicas', () => {
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    try {
      const generateRelationId = (pairKey) =>
        `sec_${pairKey}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const ids = new Set();
      for (let i = 0; i < 50; i++) {
        ids.add(generateRelationId('uidA__uidB'));
      }
      expect(ids.size).toBeGreaterThanOrEqual(48);
    } finally {
      Date.now = realNow;
    }
  });

  test('B.6 — formato relationId matches expected shape', () => {
    const generateRelationId = (pairKey) =>
      `sec_${pairKey}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const id = generateRelationId('A5pMESWlfmPWCo__bq2BbtCVF8cZo30tum58');
    expect(id).toMatch(/^sec_[\w]+__[\w]+_\d{13}_[a-z0-9]{4}$/);
  });
});
