'use strict';
/**
 * R15-A — context_toggle.test.js
 * 100% branch coverage: PUT / GET / POST undo
 */

const express = require('express');

// ── Firestore mock ────────────────────────────────────────────────────────────
let mockDocData = null;
let mockDocExists = false;
let mockGetThrows = false;
let mockSetThrows = false;
let mockSnapDocs = [];

function makeRef() {
  return {
    get: () => {
      if (mockGetThrows) return Promise.reject(new Error('GET-FAIL'));
      return Promise.resolve({
        exists: mockDocExists,
        data: () => mockDocData,
      });
    },
    set: (_data, _opts) => {
      if (mockSetThrows) return Promise.reject(new Error('SET-FAIL'));
      return Promise.resolve();
    },
  };
}

const mockFs = {
  collection: () => ({
    doc: () => ({
      collection: () => ({
        doc: () => makeRef(),
        get: () => {
          if (mockGetThrows) return Promise.reject(new Error('GET-FAIL'));
          return Promise.resolve({
            forEach: (fn) => mockSnapDocs.forEach(fn),
          });
        },
      }),
    }),
  }),
};

// ── Module setup ──────────────────────────────────────────────────────────────
const createRoutes = require('../routes/context_toggle');
const { VALID_CONTEXTS, UNDO_WINDOW_MS } = require('../routes/context_toggle');
createRoutes.__setFirestoreForTests(mockFs);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes({}));
  return app;
}

const request = require('supertest');

beforeEach(() => {
  mockDocData = null;
  mockDocExists = false;
  mockGetThrows = false;
  mockSetThrows = false;
  mockSnapDocs = [];
});

// ── PUT / ─────────────────────────────────────────────────────────────────────
describe('PUT / — context-toggle', () => {
  test('400 si falta uid', async () => {
    const r = await request(buildApp()).put('/').send({ context: 'leads', enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });

  test('400 si falta context', async () => {
    const r = await request(buildApp()).put('/').send({ uid: 'u1', enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('context_required');
  });

  test('400 si context invalido', async () => {
    const r = await request(buildApp()).put('/').send({ uid: 'u1', context: 'invalid', enabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('context_invalido');
    expect(r.body.valid).toEqual(VALID_CONTEXTS);
  });

  test('400 si enabled no es boolean (string)', async () => {
    const r = await request(buildApp()).put('/').send({ uid: 'u1', context: 'leads', enabled: 'si' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('enabled_debe_ser_boolean');
  });

  test('400 si enabled no es boolean (null)', async () => {
    const r = await request(buildApp()).put('/').send({ uid: 'u1', context: 'leads', enabled: null });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('enabled_debe_ser_boolean');
  });

  test('200 activa contexto nuevo (snap !exists -> prevEnabled=false)', async () => {
    mockDocExists = false;
    const r = await request(buildApp()).put('/').send({ uid: 'uid-test-1', context: 'leads', enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.enabled).toBe(true);
    expect(r.body.context).toBe('leads');
    expect(r.body.undoUntil).toBeTruthy();
  });

  test('200 activa contexto existente (snap exists -> prevEnabled se lee)', async () => {
    mockDocExists = true;
    mockDocData = { enabled: false, updatedAt: '2026-05-01T00:00:00.000Z' };
    const r = await request(buildApp()).put('/').send({ uid: 'uid-test-1', context: 'selfchat', enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('200 desactiva contexto (enabled=false)', async () => {
    mockDocExists = true;
    mockDocData = { enabled: true };
    const r = await request(buildApp()).put('/').send({ uid: 'uid-test-1', context: 'familia', enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
  });

  test('todos los VALID_CONTEXTS aceptados', async () => {
    for (const ctx of VALID_CONTEXTS) {
      const r = await request(buildApp()).put('/').send({ uid: 'u1', context: ctx, enabled: false });
      expect(r.status).toBe(200);
    }
  });

  test('500 si Firestore set falla', async () => {
    mockDocExists = false;
    mockSetThrows = true;
    const r = await request(buildApp()).put('/').send({ uid: 'uid-test-1', context: 'equipo', enabled: true });
    expect(r.status).toBe(500);
  });

  test('500 si Firestore get falla en PUT', async () => {
    mockGetThrows = true;
    const r = await request(buildApp()).put('/').send({ uid: 'uid-test-1', context: 'clientes', enabled: true });
    expect(r.status).toBe(500);
  });

  test('400 uid_required sin body (cubre req.body || {} linea 28)', async () => {
    const r = await request(buildApp()).put('/');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });
});

// ── GET / ─────────────────────────────────────────────────────────────────────
describe('GET / — leer todos los contextos', () => {
  test('400 si falta uid', async () => {
    const r = await request(buildApp()).get('/');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });

  test('200 retorna defaults si no hay documentos', async () => {
    mockSnapDocs = [];
    const r = await request(buildApp()).get('/').query({ uid: 'u1' });
    expect(r.status).toBe(200);
    expect(r.body.uid).toBe('u1');
    for (const ctx of VALID_CONTEXTS) {
      expect(r.body.contexts[ctx].enabled).toBe(false);
    }
  });

  test('200 retorna estados con docs existentes', async () => {
    mockSnapDocs = [
      { id: 'leads', data: () => ({ enabled: true, updatedAt: '2026-05-12T00:00:00Z', undoUntil: null }) },
      { id: 'selfchat', data: () => ({ enabled: true, updatedAt: '2026-05-12T00:00:00Z', undoUntil: '2026-05-12T01:00:00Z' }) },
    ];
    const r = await request(buildApp()).get('/').query({ uid: 'u1' });
    expect(r.status).toBe(200);
    expect(r.body.contexts.leads.enabled).toBe(true);
    expect(r.body.contexts.selfchat.enabled).toBe(true);
    expect(r.body.contexts.familia.enabled).toBe(false);
  });

  test('doc con id fuera de VALID_CONTEXTS es ignorado', async () => {
    mockSnapDocs = [
      { id: 'desconocido', data: () => ({ enabled: true }) },
    ];
    const r = await request(buildApp()).get('/').query({ uid: 'u1' });
    expect(r.status).toBe(200);
    expect(r.body.contexts['desconocido']).toBeUndefined();
  });

  test('doc sin updatedAt -> null (cubre data.updatedAt || null linea 82)', async () => {
    mockSnapDocs = [
      { id: 'leads', data: () => ({ enabled: true }) },
    ];
    const r = await request(buildApp()).get('/').query({ uid: 'u1' });
    expect(r.status).toBe(200);
    expect(r.body.contexts.leads.updatedAt).toBeNull();
    expect(r.body.contexts.leads.undoUntil).toBeNull();
  });

  test('500 si Firestore get falla', async () => {
    mockGetThrows = true;
    const r = await request(buildApp()).get('/').query({ uid: 'u1' });
    expect(r.status).toBe(500);
  });
});

// ── POST /undo ────────────────────────────────────────────────────────────────
describe('POST /undo — revertir toggle', () => {
  test('400 si falta uid', async () => {
    const r = await request(buildApp()).post('/undo').send({ context: 'leads' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });

  test('400 si falta context', async () => {
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('context_required');
  });

  test('400 si context invalido', async () => {
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'bad' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('context_invalido');
  });

  test('404 si doc no existe', async () => {
    mockDocExists = false;
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'leads' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('contexto_no_encontrado');
  });

  test('409 si ventana de undo expirada', async () => {
    mockDocExists = true;
    mockDocData = {
      enabled: true,
      previousEnabled: false,
      undoUntil: new Date(Date.now() - 1000).toISOString(),
    };
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'leads' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ventana_undo_expirada');
  });

  test('409 si undoUntil es null (no hay ventana)', async () => {
    mockDocExists = true;
    mockDocData = {
      enabled: true,
      previousEnabled: false,
      undoUntil: null,
    };
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'leads' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ventana_undo_expirada');
  });

  test('200 revierte dentro de la ventana (previousEnabled=false)', async () => {
    mockDocExists = true;
    mockDocData = {
      enabled: true,
      previousEnabled: false,
      undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
    };
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'leads' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.undone).toBe(true);
    expect(r.body.enabled).toBe(false);
  });

  test('200 revierte dentro de la ventana (previousEnabled=true)', async () => {
    mockDocExists = true;
    mockDocData = {
      enabled: false,
      previousEnabled: true,
      undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
    };
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'selfchat' });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
  });

  test('500 si Firestore get falla en undo', async () => {
    mockGetThrows = true;
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'leads' });
    expect(r.status).toBe(500);
  });

  test('500 si Firestore set falla en undo', async () => {
    mockDocExists = true;
    mockSetThrows = true;
    mockDocData = {
      enabled: true,
      previousEnabled: false,
      undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
    };
    const r = await request(buildApp()).post('/undo').send({ uid: 'u1', context: 'leads' });
    expect(r.status).toBe(500);
  });

  test('400 uid_required sin body (cubre req.body || {} linea 96)', async () => {
    const r = await request(buildApp()).post('/undo');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────
describe('VALID_CONTEXTS + UNDO_WINDOW_MS exportados', () => {
  test('VALID_CONTEXTS tiene 5 elementos', () => {
    expect(VALID_CONTEXTS).toHaveLength(5);
    expect(VALID_CONTEXTS).toContain('leads');
    expect(VALID_CONTEXTS).toContain('selfchat');
  });

  test('UNDO_WINDOW_MS es 10 minutos', () => {
    expect(UNDO_WINDOW_MS).toBe(600000);
  });
});
