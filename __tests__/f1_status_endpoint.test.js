'use strict';

/**
 * Tests para getF1Status (TEC-MIIAF1-PERMISOS-1).
 * Patron espejo de ludomiia-status pero usa monkey-patch admin.firestore.
 */

globalThis.__f1StatusState = {
  ownerExists: true,
  ownerData: {},
  subEmpty: true,
  subData: {},
  throwOnDoc: false,
  throwOnColl: false,
};

jest.mock('firebase-admin', () => {
  const firestore = () => ({
    doc: () => ({
      get: () =>
        globalThis.__f1StatusState.throwOnDoc
          ? Promise.reject(new Error('FS-DOC-ERR'))
          : Promise.resolve({
              exists: globalThis.__f1StatusState.ownerExists,
              data: () => globalThis.__f1StatusState.ownerData,
            }),
    }),
    collection: () => {
      const chain = {
        where: () => chain,
        limit: () => chain,
        get: () =>
          globalThis.__f1StatusState.throwOnColl
            ? Promise.reject(new Error('FS-COLL-ERR'))
            : Promise.resolve({
                empty: globalThis.__f1StatusState.subEmpty,
                docs: globalThis.__f1StatusState.subEmpty ? [] : [{ data: () => globalThis.__f1StatusState.subData }],
              }),
      };
      return chain;
    },
  });
  return {
    app: jest.fn(() => ({ name: 'test' })),
    firestore,
    __mocks: {},
  };
});

const { getF1Status } = require('../sports/f1_dashboard/f1_paywall');

beforeEach(() => {
  globalThis.__f1StatusState.ownerExists = true;
  globalThis.__f1StatusState.ownerData = {};
  globalThis.__f1StatusState.subEmpty = true;
  globalThis.__f1StatusState.subData = {};
  globalThis.__f1StatusState.throwOnDoc = false;
  globalThis.__f1StatusState.throwOnColl = false;
});

describe('getF1Status — TEC-MIIAF1-PERMISOS-1', () => {
  test('uid null → no_uid', async () => {
    const r = await getF1Status(null);
    expect(r.active).toBe(false);
    expect(r.source).toBe('no_uid');
  });
  test('uid undefined → no_uid', async () => {
    const r = await getF1Status();
    expect(r.source).toBe('no_uid');
  });

  test('owner !exists + sub empty → inactive', async () => {
    globalThis.__f1StatusState.ownerExists = false;
    const r = await getF1Status('u1');
    expect(r.active).toBe(false);
    expect(r.source).toBe('inactive');
  });

  test('owner.miia_subscription_active=true → miia_included', async () => {
    globalThis.__f1StatusState.ownerData = {
      miia_subscription_active: true,
      miia_subscription_expires_at: '2027-01-01',
    };
    const r = await getF1Status('u1');
    expect(r.active).toBe(true);
    expect(r.plan).toBe('miia_included');
    expect(r.expiresAt).toBe('2027-01-01');
  });

  test('miia_included sin expires_at → null', async () => {
    globalThis.__f1StatusState.ownerData = { miia_subscription_active: true };
    const r = await getF1Status('u1');
    expect(r.expiresAt).toBeNull();
  });

  test('legacy f1_active=true → standalone source=legacy_addon', async () => {
    globalThis.__f1StatusState.ownerData = { f1_active: true, f1_expires_at: '2026-12-31' };
    const r = await getF1Status('u1');
    expect(r.active).toBe(true);
    expect(r.source).toBe('legacy_addon');
    expect(r.expiresAt).toBe('2026-12-31');
  });

  test('legacy f1_active sin f1_expires_at → null', async () => {
    globalThis.__f1StatusState.ownerData = { f1_active: true };
    const r = await getF1Status('u1');
    expect(r.expiresAt).toBeNull();
  });

  test('legacy addons array contiene f1_dashboard → legacy_addons_array', async () => {
    globalThis.__f1StatusState.ownerData = { addons: ['f1_dashboard', 'other'] };
    const r = await getF1Status('u1');
    expect(r.active).toBe(true);
    expect(r.source).toBe('legacy_addons_array');
  });

  test('owner.exists pero ningun flag → check standalone vacio → inactive', async () => {
    globalThis.__f1StatusState.ownerData = { other: 'data' };
    globalThis.__f1StatusState.subEmpty = true;
    const r = await getF1Status('u1');
    expect(r.active).toBe(false);
    expect(r.source).toBe('inactive');
  });

  test('subscription standalone activa → standalone', async () => {
    globalThis.__f1StatusState.ownerExists = false;
    globalThis.__f1StatusState.subEmpty = false;
    globalThis.__f1StatusState.subData = { expires_at: '2026-11-30' };
    const r = await getF1Status('u1');
    expect(r.active).toBe(true);
    expect(r.plan).toBe('standalone');
    expect(r.source).toBe('standalone');
    expect(r.expiresAt).toBe('2026-11-30');
  });

  test('standalone sin expires_at → null', async () => {
    globalThis.__f1StatusState.ownerExists = false;
    globalThis.__f1StatusState.subEmpty = false;
    globalThis.__f1StatusState.subData = {};
    const r = await getF1Status('u1');
    expect(r.expiresAt).toBeNull();
  });

  test('standalone con sub.data() null fallback {}', async () => {
    globalThis.__f1StatusState.ownerExists = false;
    globalThis.__f1StatusState.subEmpty = false;
    globalThis.__f1StatusState.subData = null;
    const r = await getF1Status('u1');
    expect(r.active).toBe(true);
    expect(r.plan).toBe('standalone');
  });

  test('owner.data() null fallback {}', async () => {
    globalThis.__f1StatusState.ownerData = null;
    const r = await getF1Status('u1');
    expect(r.active).toBe(false);
  });

  test('error en doc.get() → source=error', async () => {
    globalThis.__f1StatusState.throwOnDoc = true;
    const r = await getF1Status('u1');
    expect(r.source).toBe('error');
    expect(r.error).toBeTruthy();
  });

  test('error en collection.get() → source=error', async () => {
    globalThis.__f1StatusState.ownerExists = false;
    globalThis.__f1StatusState.throwOnColl = true;
    const r = await getF1Status('u1');
    expect(r.source).toBe('error');
  });
});

// Test endpoint /api/f1/status via supertest
const express = require('express');
const request = require('supertest');
const createF1Routes = require('../routes/f1');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/f1', createF1Routes({ verifyToken: (req, res, next) => { req.user = { uid: 't' }; next(); } }));
  return app;
}

describe('GET /api/f1/status endpoint', () => {
  test('400 sin uid query', async () => {
    const r = await request(makeApp()).get('/api/f1/status');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('uid_required');
  });
  test('200 con uid → estado del owner', async () => {
    globalThis.__f1StatusState.ownerData = { miia_subscription_active: true };
    const r = await request(makeApp()).get('/api/f1/status?uid=u1');
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
    expect(r.body.source).toBe('miia_included');
  });
});
