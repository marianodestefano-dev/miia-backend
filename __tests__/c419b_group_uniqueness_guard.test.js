'use strict';

/**
 * Tests: C-419b — Backend guard unicidad contact_groups por nombre.
 *
 * Origen: T8 D.5 2026-04-29 — bug activo: Mariano veia grupos dobles en
 * dashboard. POST /api/tenant/:uid/contact-groups sin check de nombre unico
 * permitia crear N grupos con el mismo nombre usando .add() Firestore.
 *
 * Fix T12 C-464: query WHERE name == nameTrimmed LIMIT 1 antes del .add().
 * Si existe → 409 Conflict con existingId. Si no existe → .add() normal.
 *
 * §A — Tests estaticos sobre source server.js (sin runtime).
 * §B — Tests runtime: mock Firestore para simular logica del guard.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

// Bloque del endpoint POST contact-groups para tests de scope
const POST_BLOCK_START = SERVER_SOURCE.indexOf('// POST /api/tenant/:uid/contact-groups — Crear grupo');
const POST_BLOCK_END = SERVER_SOURCE.indexOf('// PUT /api/tenant/:uid/contact-groups/:groupId');
const POST_BLOCK = SERVER_SOURCE.slice(POST_BLOCK_START, POST_BLOCK_END);

// ════════════════════════════════════════════════════════════════════
// §A — Verificacion estatica del guard C-419b en source server.js
// ════════════════════════════════════════════════════════════════════

describe('C-419b §A — uniqueness guard en source server.js (estatico)', () => {
  test('A.1 — comentario C-419b GUARD presente en el bloque POST', () => {
    expect(POST_BLOCK).toMatch(/C-419b GUARD/);
  });

  test('A.2 — query WHERE name == nameTrimmed presente', () => {
    expect(POST_BLOCK).toMatch(/\.where\('name',\s*'==',\s*nameTrimmed\)/);
  });

  test('A.3 — .limit(1) presente (query eficiente)', () => {
    expect(POST_BLOCK).toMatch(/\.limit\(1\)/);
  });

  test('A.4 — check existing.empty presente (ruta de rechazo)', () => {
    expect(POST_BLOCK).toMatch(/!existing\.empty/);
  });

  test('A.5 — res.status(409) presente para duplicado', () => {
    expect(POST_BLOCK).toMatch(/res\.status\(409\)/);
  });

  test('A.6 — existingId en respuesta 409 (para que frontend pueda referenciar el original)', () => {
    expect(POST_BLOCK).toMatch(/existingId/);
  });

  test('A.7 — console.warn para el caso rechazado (no error — es comportamiento esperado)', () => {
    expect(POST_BLOCK).toMatch(/console\.warn.*rechazado.*C-419b/);
  });

  test('A.8 — nameTrimmed variable usada en groupData.name (no name.trim() duplicado)', () => {
    // groupData debe usar nameTrimmed, no name.trim() de nuevo
    expect(POST_BLOCK).toMatch(/name:\s*nameTrimmed/);
  });

  test('A.9 — guard ANTES del groupData y del .add() (orden correcto)', () => {
    const guardPos = POST_BLOCK.indexOf('C-419b GUARD');
    const addPos = POST_BLOCK.indexOf('.add(groupData)');
    expect(guardPos).toBeGreaterThan(0);
    expect(addPos).toBeGreaterThan(0);
    expect(guardPos).toBeLessThan(addPos);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Tests runtime: simular logica del guard (sin Firestore real)
// ════════════════════════════════════════════════════════════════════

describe('C-419b §B — logica del guard (mock Firestore)', () => {
  // Simular la logica del guard directamente (extraida del endpoint)
  async function applyUniquenessGuard(existingGroups, newName) {
    const nameTrimmed = newName.trim();
    // Simular query Firestore WHERE name == nameTrimmed LIMIT 1
    const matches = existingGroups.filter(g => g.name === nameTrimmed);
    const existing = { empty: matches.length === 0, docs: matches.map(g => ({ id: g.id })) };
    if (!existing.empty) {
      return { status: 409, body: { error: `Ya existe un grupo con el nombre "${nameTrimmed}"`, existingId: existing.docs[0].id } };
    }
    return { status: 200, body: { success: true, id: 'new-doc-id' } };
  }

  test('B.1 — nombre nuevo (sin duplicado) → permite crear (200)', async () => {
    const existing = [{ id: 'abc', name: 'Familia' }];
    const result = await applyUniquenessGuard(existing, 'Amigos');
    expect(result.status).toBe(200);
  });

  test('B.2 — nombre duplicado exacto → rechaza con 409', async () => {
    const existing = [{ id: 'abc', name: 'Familia' }];
    const result = await applyUniquenessGuard(existing, 'Familia');
    expect(result.status).toBe(409);
    expect(result.body.existingId).toBe('abc');
  });

  test('B.3 — nombre duplicado con espacios (trim) → rechazado', async () => {
    const existing = [{ id: 'abc', name: 'Familia' }];
    const result = await applyUniquenessGuard(existing, '  Familia  ');
    expect(result.status).toBe(409);
  });

  test('B.4 — sin grupos existentes → permite crear', async () => {
    const result = await applyUniquenessGuard([], 'Primer Grupo');
    expect(result.status).toBe(200);
  });

  test('B.5 — nombre diferente en misma coleccion → permite crear', async () => {
    const existing = [
      { id: 'a', name: 'Familia' },
      { id: 'b', name: 'Amigos' },
      { id: 'c', name: 'Trabajo' },
    ];
    const result = await applyUniquenessGuard(existing, 'Nuevos Clientes');
    expect(result.status).toBe(200);
  });

  test('B.6 — 409 incluye existingId del grupo original (para UI mostrar al usuario)', async () => {
    const existing = [{ id: 'original-group-id', name: 'VIPs' }];
    const result = await applyUniquenessGuard(existing, 'VIPs');
    expect(result.body.existingId).toBe('original-group-id');
    expect(result.body.error).toContain('VIPs');
  });
});
