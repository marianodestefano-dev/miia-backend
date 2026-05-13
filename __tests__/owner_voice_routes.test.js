'use strict';

const request = require('supertest');
const express = require('express');

// Mock owner_voice_library
let mockContextsReturn = [];
let mockGetAudiosReturn = null;
let mockGetAudiosThrow = false;
let mockGetAudioReturn = null;
let mockGetAudioThrow = null;
let mockRegisterReturn = null;
let mockRegisterThrow = null;
let mockDeactivateReturn = null;
let mockDeactivateThrow = null;

jest.mock('../core/owner_voice_library', () => ({
  listAvailableContexts: jest.fn(() => mockContextsReturn),
  getAudiosForOwner: jest.fn(async () => {
    if (mockGetAudiosThrow) throw new Error('GET_AUDIOS_ERROR');
    return mockGetAudiosReturn || [];
  }),
  getAudioForContext: jest.fn(async () => {
    if (mockGetAudioThrow) throw new Error(mockGetAudioThrow);
    return mockGetAudioReturn;
  }),
  registerAudio: jest.fn(async () => {
    if (mockRegisterThrow) throw new Error(mockRegisterThrow);
    return mockRegisterReturn || { ok: true };
  }),
  deactivateAudio: jest.fn(async () => {
    if (mockDeactivateThrow) throw new Error(mockDeactivateThrow);
    return mockDeactivateReturn || { ok: true };
  }),
}));

const createOwnerVoiceRoutes = require('../routes/owner_voice');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/owner-voice', createOwnerVoiceRoutes({}));
  return app;
}

beforeEach(() => {
  mockContextsReturn = [
    { key: 'saludo_inicial_calido', label: 'X', suggestedScript: 'Y' },
  ];
  mockGetAudiosReturn = null;
  mockGetAudiosThrow = false;
  mockGetAudioReturn = null;
  mockGetAudioThrow = null;
  mockRegisterReturn = null;
  mockRegisterThrow = null;
  mockDeactivateReturn = null;
  mockDeactivateThrow = null;
});

// ── createOwnerVoiceRoutes sin opts ──────────────────────────────────────────

describe('createOwnerVoiceRoutes', () => {
  test('sin opts -> no throw', () => {
    expect(() => createOwnerVoiceRoutes()).not.toThrow();
  });
  test('opts sin requireAuth -> default next', () => {
    expect(() => createOwnerVoiceRoutes({})).not.toThrow();
  });
});

// ── GET /contexts ────────────────────────────────────────────────────────────

describe('GET /api/owner-voice/contexts', () => {
  test('200 con lista', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/contexts');
    expect(res.status).toBe(200);
    expect(res.body.contexts).toHaveLength(1);
  });
});

// ── GET /api/owner-voice?uid=X ───────────────────────────────────────────────

describe('GET /api/owner-voice', () => {
  test('400 sin uid', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  test('200 con audios', async () => {
    mockGetAudiosReturn = [{ context: 'a', fileUrl: 'u' }];
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice?uid=u1');
    expect(res.status).toBe(200);
    expect(res.body.audios).toHaveLength(1);
  });

  test('500 cuando getAudiosForOwner lanza', async () => {
    mockGetAudiosThrow = true;
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice?uid=u1');
    expect(res.status).toBe(500);
  });
});

// ── GET /api/owner-voice/:context ────────────────────────────────────────────

describe('GET /api/owner-voice/:context', () => {
  test('400 sin uid', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/saludo_inicial_calido');
    expect(res.status).toBe(400);
  });

  test('404 audio no existe', async () => {
    mockGetAudioReturn = null;
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/saludo_inicial_calido?uid=u1');
    expect(res.status).toBe(404);
  });

  test('200 audio existe', async () => {
    mockGetAudioReturn = { fileUrl: 'a.mp3', durationSec: 5 };
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/saludo_inicial_calido?uid=u1');
    expect(res.status).toBe(200);
    expect(res.body.fileUrl).toBe('a.mp3');
  });

  test('400 context invalido', async () => {
    mockGetAudioThrow = 'context_invalido: foo';
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/foo?uid=u1');
    expect(res.status).toBe(400);
  });

  test('500 otros errores', async () => {
    mockGetAudioThrow = 'firestore_dead';
    const app = buildApp();
    const res = await request(app).get('/api/owner-voice/saludo_inicial_calido?uid=u1');
    expect(res.status).toBe(500);
  });
});

// ── POST /api/owner-voice ────────────────────────────────────────────────────

describe('POST /api/owner-voice', () => {
  test('400 sin uid', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ context: 'saludo_inicial_calido', fileUrl: 'a.mp3', durationSec: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_required');
  });

  test('400 sin context', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ uid: 'u1', fileUrl: 'a.mp3', durationSec: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('context_required');
  });

  test('200 OK', async () => {
    mockRegisterReturn = { ok: true, fileUrl: 'a.mp3' };
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ uid: 'u1', context: 'saludo_inicial_calido', fileUrl: 'a.mp3', durationSec: 5, transcript: 'X' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('400 context_invalido', async () => {
    mockRegisterThrow = 'context_invalido: foo';
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ uid: 'u1', context: 'foo', fileUrl: 'a.mp3', durationSec: 5 });
    expect(res.status).toBe(400);
  });

  test('400 fileUrl_requerido', async () => {
    mockRegisterThrow = 'fileUrl_requerido';
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ uid: 'u1', context: 'saludo_inicial_calido', durationSec: 5 });
    expect(res.status).toBe(400);
  });

  test('400 duracion_excede_max', async () => {
    mockRegisterThrow = 'duracion_excede_max';
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ uid: 'u1', context: 'saludo_inicial_calido', fileUrl: 'a', durationSec: 999 });
    expect(res.status).toBe(400);
  });

  test('500 otros errores', async () => {
    mockRegisterThrow = 'firestore_dead';
    const app = buildApp();
    const res = await request(app)
      .post('/api/owner-voice/')
      .send({ uid: 'u1', context: 'saludo_inicial_calido', fileUrl: 'a', durationSec: 5 });
    expect(res.status).toBe(500);
  });
});

// ── DELETE /api/owner-voice/:context ─────────────────────────────────────────

describe('DELETE /api/owner-voice/:context', () => {
  test('400 sin uid', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/owner-voice/saludo_inicial_calido');
    expect(res.status).toBe(400);
  });

  test('200 OK deactivate', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/owner-voice/saludo_inicial_calido?uid=u1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('400 context_invalido', async () => {
    mockDeactivateThrow = 'context_invalido: foo';
    const app = buildApp();
    const res = await request(app).delete('/api/owner-voice/foo?uid=u1');
    expect(res.status).toBe(400);
  });

  test('500 otros errores', async () => {
    mockDeactivateThrow = 'firestore_dead';
    const app = buildApp();
    const res = await request(app).delete('/api/owner-voice/saludo_inicial_calido?uid=u1');
    expect(res.status).toBe(500);
  });
});
