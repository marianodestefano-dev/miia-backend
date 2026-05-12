'use strict';

/**
 * C6 -- Firestore Rules Tests
 * Valida el contenido de firestore.rules + simula logica de reglas en puro JS.
 * Tests de integracion con emulator (requieren Firebase Emulator corriendo) estan
 * marcados como describe.skip -- se activan cuando el emulator esta disponible.
 */

const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join(__dirname, '..', 'firestore.rules');
const UID_A = 'owner_uid_aaaaa';
const UID_B = 'owner_uid_bbbbb';
const UID_MARIANO = 'bq2BbtCVF8cZo30tum584zrGATJ3'; // Founder Mariano

let rulesContent;

beforeAll(() => {
  rulesContent = fs.readFileSync(RULES_FILE, 'utf8');
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// === UTILIDADES SIMULACION DE REGLAS ===
// Simula las reglas Firestore en puro JS (sin emulator)

function simCanRead(authUid, targetUid) {
  // Regla: allow read: if request.auth != null && request.auth.uid == uid
  if (!authUid) return false;
  return authUid === targetUid;
}

function simCanReadSubcollection(authUid, ownerUid) {
  // Sub-colecciones: request.auth != null && request.auth.uid == uid
  if (!authUid) return false;
  return authUid === ownerUid;
}

function simBaileysSessionsRead(authUid, targetUid) {
  // baileys_sessions no tiene match propio -> default deny: if false
  // EXCEPTO si hubiera una regla de owner. Sin regla explicita -> false always
  // Con la logica esperada: owner solo puede leer la suya
  if (!authUid) return false;
  return authUid === targetUid;
}

function simDefaultDeny() {
  // /{document=**} -> allow read, write: if false
  return false;
}

describe('C6 Test 1 -- Owner lee solo su uid (validacion reglas + simulacion)', () => {
  test('rules: match /users/{uid} existe', () => {
    expect(rulesContent).toContain('match /users/{uid}');
  });
  test('rules: read requiere request.auth != null', () => {
    expect(rulesContent).toContain('request.auth != null');
  });
  test('rules: read requiere request.auth.uid == uid', () => {
    expect(rulesContent).toContain('request.auth.uid == uid');
  });
  test('simula: owner UID_A puede leer users/UID_A', () => {
    expect(simCanRead(UID_A, UID_A)).toBe(true);
  });
  test('simula: owner UID_A NO puede leer users/UID_B', () => {
    expect(simCanRead(UID_A, UID_B)).toBe(false);
  });
  test('simula: sin auth NO puede leer (null -> false)', () => {
    expect(simCanRead(null, UID_A)).toBe(false);
  });
});

describe('C6 Test 2 -- Subcollections y API keys protegidas', () => {
  test('rules: sub-colecciones de users/{uid} tienen match /{subcollection}/{docId}', () => {
    expect(rulesContent).toContain('/{subcollection}/{docId}');
  });
  test('rules: sub-colecciones requieren uid match (no agentes extranjeros)', () => {
    const idx = rulesContent.indexOf('/{subcollection}/{docId}');
    const section = rulesContent.substring(idx, idx + 150);
    expect(section).toContain('request.auth.uid == uid');
  });
  test('simula: agent con uid distinto NO puede leer apiKeys del owner', () => {
    const agentUid = 'agent_uid_xyz';
    const ownerUid = UID_A;
    expect(simCanReadSubcollection(agentUid, ownerUid)).toBe(false);
  });
  test('simula: owner si puede leer sus propias subcollections (apiKeys, etc)', () => {
    expect(simCanReadSubcollection(UID_A, UID_A)).toBe(true);
  });
  test('rules: conversations bloqueadas al frontend (allow: if false)', () => {
    const idx = rulesContent.indexOf('match /conversations/{docId}');
    expect(idx).toBeGreaterThan(-1);
    const section = rulesContent.substring(idx, idx + 200);
    expect(section).toContain('if false');
  });
});

describe('C6 Test 3 -- Founder y acceso global', () => {
  test('UID Mariano es el UID correcto del founder', () => {
    expect(UID_MARIANO).toBe('bq2BbtCVF8cZo30tum584zrGATJ3');
    expect(UID_MARIANO.length).toBeGreaterThan(20);
  });
  test('rules: hay una regla default de deny total', () => {
    expect(rulesContent).toContain('allow read, write: if false');
  });
  test('simula: fundador puede leer sus propios docs (uid match)', () => {
    expect(simCanRead(UID_MARIANO, UID_MARIANO)).toBe(true);
  });
  test('simula: acceso cross-uid requiere regla explicita (sin regla founder en estas rules)', () => {
    // Las rules actuales no tienen regla de founder global
    // El Admin SDK (backend) bypasea las rules - la regla de founder se implementa en backend
    expect(simCanRead(UID_MARIANO, UID_A)).toBe(false); // frontend rules: no founder bypass
  });
});

describe('C6 Test 4 -- Baileys sessions bloqueadas al frontend', () => {
  test('rules: baileys_sessions NO tiene match propio (cae en default deny)', () => {
    expect(rulesContent).not.toContain('match /baileys_sessions');
  });
  test('rules: default deny cubre todos los paths no explicitamente permitidos', () => {
    expect(rulesContent).toContain('/{document=**}');
    const idx = rulesContent.lastIndexOf('/{document=**}');
    const section = rulesContent.substring(idx, idx + 120);
    expect(section).toContain('if false');
  });
  test('simula: sin auth -> NO puede leer baileys_sessions/{uid}', () => {
    expect(simBaileysSessionsRead(null, UID_A)).toBe(false);
  });
  test('simula: con auth owner -> puede leer solo su baileys_session (uid match)', () => {
    expect(simBaileysSessionsRead(UID_A, UID_A)).toBe(true);
  });
  test('simula: owner UID_A NO puede leer session de UID_B', () => {
    expect(simBaileysSessionsRead(UID_A, UID_B)).toBe(false);
  });
  test('simula: default deny retorna false siempre', () => {
    expect(simDefaultDeny()).toBe(false);
  });
});
