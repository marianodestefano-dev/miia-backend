'use strict';

jest.mock('firebase-admin', () => {
  const _fb = { _state: { users: {}, docs: {} } };
  _fb.auth = () => ({
    getUserByEmail: jest.fn(async (email) => {
      const u = Object.values(_fb._state.users).find(x => x.email === email);
      if (!u) {
        const e = new Error('no user');
        e.code = 'auth/user-not-found';
        throw e;
      }
      return u;
    }),
    createUser: jest.fn(async ({ email }) => {
      const uid = 'uid_' + Math.random().toString(36).slice(2, 8);
      const u = { uid, email, emailVerified: false };
      _fb._state.users[uid] = u;
      return u;
    }),
    generateSignInWithEmailLink: jest.fn(async (email) => 'https://test.miia/magic?token=fake'),
    verifyIdToken: jest.fn(async (token) => {
      if (token === 'BAD') throw new Error('invalid');
      return { uid: token.replace(/^TOK_/, '') };
    }),
    updateUser: jest.fn(async (uid, attrs) => {
      _fb._state.users[uid] = Object.assign(_fb._state.users[uid] || { uid }, attrs);
      return _fb._state.users[uid];
    }),
  });
  _fb.firestore = () => ({
    collection: (col) => ({
      doc: (id) => ({
        get: jest.fn(async () => {
          const k = col + '/' + id;
          const data = _fb._state.docs[k];
          return { exists: !!data, data: () => data || {} };
        }),
        set: jest.fn(async (data, opts) => {
          const k = col + '/' + id;
          if (opts && opts.merge) _fb._state.docs[k] = Object.assign({}, _fb._state.docs[k] || {}, data);
          else _fb._state.docs[k] = data;
        }),
        update: jest.fn(async (data) => {
          const k = col + '/' + id;
          _fb._state.docs[k] = Object.assign({}, _fb._state.docs[k] || {}, data);
        }),
      }),
    }),
  });
  _fb.firestore.FieldValue = { delete: () => null, serverTimestamp: () => new Date() };
  return _fb;
});

// nodemailer removed -- magic link envia desde cliente Firebase

const express = require('express');
const request = require('supertest');
const admin = require('firebase-admin');

function makeApp() {
  const app = express();
  app.use('/api/auth', require('../routes/auth_magic')());
  app.use('/api/billing', require('../routes/billing')());
  app.use('/api/products', require('../routes/products')({}));
  return app;
}

beforeEach(() => {
  admin._state.users = {};
  admin._state.docs = {};
});

describe('POST /api/auth/signup-magic', () => {
  test('400 si email invalido', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'no-email' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('email invalido');
  });
  test('crea user nuevo y guarda pending_intent con plan', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'a@b.com', plan: 'monthly' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.exists).toBe(false);
    const docs = Object.entries(admin._state.docs);
    const userDoc = docs.find(([k]) => k.startsWith('users/'));
    expect(userDoc).toBeDefined();
    expect(userDoc[1].pending_intent.plan).toBe('monthly');
  });
  test('reusa user existente (created=false)', async () => {
    admin._state.users.uid_x = { uid: 'uid_x', email: 'a@b.com' };
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'a@b.com' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(false);
    expect(r.body.exists).toBe(true);
  });
  test('siempre retorna sent=true (cliente envia)', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'a@b.com' });
    expect(r.body.sent).toBe(true);
  });
  test('sin email da 400', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({});
    expect(r.status).toBe(400);
  });
  test('sin plan ni addon: no escribe pending_intent', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'x@y.z' });
    expect(r.status).toBe(200);
    const docs = Object.entries(admin._state.docs);
    expect(docs.length).toBe(0);
  });
});

describe('POST /api/auth/set-password', () => {
  test('401 sin token', async () => {
    const r = await request(makeApp()).post('/api/auth/set-password').send({ password: 'newpass' });
    expect(r.status).toBe(401);
  });
  test('400 si password < 6', async () => {
    const r = await request(makeApp()).post('/api/auth/set-password').set('Authorization', 'Bearer TOK_uid1').send({ password: 'abc' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('password_min_6');
  });
  test('400 si password ausente', async () => {
    const r = await request(makeApp()).post('/api/auth/set-password').set('Authorization', 'Bearer TOK_uid1').send({});
    expect(r.status).toBe(400);
  });
  test('200 ok actualiza password', async () => {
    admin._state.users.uid1 = { uid: 'uid1', email: 'a@b.c' };
    const r = await request(makeApp()).post('/api/auth/set-password').set('Authorization', 'Bearer TOK_uid1').send({ password: 'longpass1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
  test('500 si verifyIdToken falla', async () => {
    const r = await request(makeApp()).post('/api/auth/set-password').set('Authorization', 'Bearer BAD').send({ password: 'longpass1' });
    expect(r.status).toBe(500);
  });
});

describe('POST /api/billing/cancel', () => {
  test('401 sin token', async () => {
    const r = await request(makeApp()).post('/api/billing/cancel');
    expect(r.status).toBe(401);
  });
  test('404 si user_not_found', async () => {
    const r = await request(makeApp()).post('/api/billing/cancel').set('Authorization', 'Bearer TOK_unknown');
    expect(r.status).toBe(404);
  });
  test('200 ok cancela y retorna retains_until', async () => {
    admin._state.docs['users/uid1'] = { plan: 'monthly', plan_end_date: '2026-06-01' };
    const r = await request(makeApp()).post('/api/billing/cancel').set('Authorization', 'Bearer TOK_uid1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.retains_until).toBe('2026-06-01');
    expect(admin._state.docs['users/uid1'].payment_status).toBe('cancelled');
  });
  test('200 ok cancela sin plan_end_date previo', async () => {
    admin._state.docs['users/uid2'] = { plan: 'trial' };
    const r = await request(makeApp()).post('/api/billing/cancel').set('Authorization', 'Bearer TOK_uid2');
    expect(r.status).toBe(200);
    expect(r.body.retains_until).toBe(null);
  });
  test('500 si verifyIdToken falla', async () => {
    const r = await request(makeApp()).post('/api/billing/cancel').set('Authorization', 'Bearer BAD');
    expect(r.status).toBe(500);
  });
});

describe('GET /api/products/permissions', () => {
  test('401 sin token', async () => {
    const r = await request(makeApp()).get('/api/products/permissions');
    expect(r.status).toBe(401);
  });
  test('200 ok retorna permissions vacios para user nuevo', async () => {
    const r = await request(makeApp()).get('/api/products/permissions').set('Authorization', 'Bearer TOK_uid1');
    expect(r.status).toBe(200);
    expect(r.body.uid).toBe('uid1');
    expect(r.body.permissions).toBeDefined();
    expect(r.body.products).toEqual(['miia', 'miiadt', 'ludomiia', 'f1']);
    expect(r.body.permissions.miia.active).toBe(false);
  });
  test('500 si verifyIdToken falla', async () => {
    const r = await request(makeApp()).get('/api/products/permissions').set('Authorization', 'Bearer BAD');
    expect(r.status).toBe(500);
  });
});

describe('FINAL push 100 percent branches routes', () => {
  test('auth_magic L28+32: _findOrCreateUser rethrow non-not-found', async () => {
    // Reescribir admin.auth para getUserByEmail throw con code distinto a auth/user-not-found
    const origAuth = admin.auth;
    admin.auth = () => ({
      getUserByEmail: async () => { const e = new Error('fb-down'); e.code = 'internal'; throw e; },
      createUser: async () => ({ uid: 'x' }),
      generateSignInWithEmailLink: async () => 'link',
      verifyIdToken: async () => ({ uid: 'x' }),
      updateUser: async () => ({}),
    });
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'a@b.com' });
    expect(r.status).toBe(500);
    admin.auth = origAuth;
  });
  test('auth_magic: getUserByEmail throw sin code (e undefined-like)', async () => {
    const origAuth = admin.auth;
    admin.auth = () => ({
      getUserByEmail: async () => { throw 'string-error'; },
      createUser: async () => ({ uid: 'x' }),
      generateSignInWithEmailLink: async () => 'link',
      verifyIdToken: async () => ({ uid: 'x' }),
      updateUser: async () => ({}),
    });
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'a@b.com' });
    expect(r.status).toBe(500);
    admin.auth = origAuth;
  });
  test('billing cancel: snap.data() retorna null -> data = {}', async () => {
    // Mockear get para que retorne exists=true pero data() = null
    const origFs = admin.firestore;
    admin.firestore = () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => null }),
          update: async () => {},
        }),
      }),
    });
    admin.firestore.FieldValue = origFs.FieldValue;
    const r = await request(makeApp()).post('/api/billing/cancel').set('Authorization', 'Bearer TOK_uid1');
    expect(r.status).toBe(200);
    expect(r.body.retains_until).toBe(null);
    admin.firestore = origFs;
  });
});

describe('Addendum 100 percent auth_magic L68 plan/addon both truthy', () => {
  test('signup-magic con plan + addon -> pending_intent con ambos', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'z@y.com', plan: 'monthly', addon: 'miiadt' });
    expect(r.status).toBe(200);
    const docs = Object.entries(admin._state.docs);
    const userDoc = docs.find(([k]) => k.startsWith('users/'));
    expect(userDoc[1].pending_intent.plan).toBe('monthly');
    expect(userDoc[1].pending_intent.addon).toBe('miiadt');
  });
  test('signup-magic con solo addon -> pending_intent.plan=null', async () => {
    const r = await request(makeApp()).post('/api/auth/signup-magic').send({ email: 'q@y.com', addon: 'ludomiia' });
    expect(r.status).toBe(200);
    const docs = Object.entries(admin._state.docs);
    const userDoc = docs.find(([k]) => k.startsWith('users/'));
    expect(userDoc[1].pending_intent.addon).toBe('ludomiia');
    expect(userDoc[1].pending_intent.plan).toBe(null);
  });
});
