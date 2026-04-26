'use strict';

/**
 * C-419 inspect contact_groups — endpoint admin protegido.
 *
 * Patron coherente con c406_block1b_endpoints.test.js (harness Express
 * + supertest + mock firebase-admin).
 *
 * 7 cases:
 *   case 1 — sin Authorization → 401 missing_token
 *   case 2 — user role → 403 forbidden
 *   case 3 — admin role + uid invalido → 400 uid_invalido
 *   case 4 — admin role + uid valido sin grupos → 200 total=0
 *   case 5 — admin role + uid valido con 1 grupo unico → 200 total=1, sin duplicados
 *   case 6 — admin role + uid valido con 4 grupos AMIGOS dup → 200 duplicatesByName.AMIGOS.length=4
 *   case 7 — admin role + uid valido con grupos mixtos (familia 1 + amigos 4) → solo AMIGOS en duplicatesByName
 */

const groupDocsMock = []; // mutable per-test

jest.mock('firebase-admin', () => {
  const verifyIdToken = jest.fn();
  function buildContactGroupsCollection() {
    return {
      get: async () => ({
        size: groupDocsMock.length,
        docs: groupDocsMock.map(g => ({
          id: g.docId,
          data: () => g.data,
          ref: {
            collection: () => ({
              get: async () => ({ size: g.contactsCount }),
            }),
          },
        })),
      }),
    };
  }
  const fakeFirestore = {
    collection: () => ({
      doc: () => ({
        collection: () => buildContactGroupsCollection(),
      }),
    }),
  };
  return {
    app: jest.fn(() => ({ name: 'test-app' })),
    auth: jest.fn(() => ({ verifyIdToken })),
    firestore: jest.fn(() => fakeFirestore),
    __mocks: { verifyIdToken },
  };
});

const admin = require('firebase-admin');
const express = require('express');
const request = require('supertest');
const { requireAuth, requireAdmin } = require('../core/require_role');

const UID_USER = 'user_a_uid';
const UID_ADMIN = 'admin_uid';
const UID_TARGET = 'bq2BbtCVF8cZo30tum584zrGATJ3';
const TOKEN_USER = 'token-user';
const TOKEN_ADMIN = 'token-admin';

function setupAuth() {
  admin.__mocks.verifyIdToken.mockImplementation(async (tok) => {
    if (tok === TOKEN_USER)  return { uid: UID_USER, email: 'u@test.com', role: 'user' };
    if (tok === TOKEN_ADMIN) return { uid: UID_ADMIN, email: 'admin@test.com', role: 'admin' };
    const e = new Error('invalid'); e.code = 'auth/invalid-id-token'; throw e;
  });
}

function buildApp() {
  const app = express();
  app.get('/api/admin/inspect-contact-groups/:uid', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { uid } = req.params;
      if (!uid || !/^[A-Za-z0-9]{20,30}$/.test(uid)) {
        return res.status(400).json({ error: 'uid_invalido' });
      }
      const cgRef = admin.firestore().collection('users').doc(uid).collection('contact_groups');
      const snap = await cgRef.get();
      const groups = [];
      const byName = {};
      for (const doc of snap.docs) {
        const data = doc.data();
        const name = data.name || '(sin name)';
        const sub = await doc.ref.collection('contacts').get();
        const item = {
          docId: doc.id,
          name,
          icon: data.icon || '',
          contactsCount: sub.size,
          createdAt: data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().toISOString() : null,
          source: data.source || null,
        };
        groups.push(item);
        const key = String(name).toUpperCase().trim();
        if (!byName[key]) byName[key] = [];
        byName[key].push(doc.id);
      }
      const duplicatesByName = Object.fromEntries(
        Object.entries(byName).filter(([_, ids]) => ids.length > 1)
      );
      res.json({ uid, total: snap.size, groups, duplicatesByName });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  return app;
}

beforeEach(() => {
  groupDocsMock.length = 0;
  admin.__mocks.verifyIdToken.mockReset();
  setupAuth();
  delete process.env.ADMIN_EMAILS;
});

describe('C-419 /api/admin/inspect-contact-groups/:uid', () => {
  test('case 1 — sin Authorization → 401 missing_token', async () => {
    const res = await request(buildApp()).get(`/api/admin/inspect-contact-groups/${UID_TARGET}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('missing_token');
  });

  test('case 2 — user role → 403 forbidden', async () => {
    const res = await request(buildApp())
      .get(`/api/admin/inspect-contact-groups/${UID_TARGET}`)
      .set('Authorization', `Bearer ${TOKEN_USER}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  test('case 3 — admin role + uid invalido → 400 uid_invalido', async () => {
    const res = await request(buildApp())
      .get('/api/admin/inspect-contact-groups/abc')
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('uid_invalido');
  });

  test('case 4 — admin + uid valido sin grupos → 200 total=0', async () => {
    groupDocsMock.length = 0;
    const res = await request(buildApp())
      .get(`/api/admin/inspect-contact-groups/${UID_TARGET}`)
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe(UID_TARGET);
    expect(res.body.total).toBe(0);
    expect(res.body.groups).toEqual([]);
    expect(res.body.duplicatesByName).toEqual({});
  });

  test('case 5 — admin + 1 grupo unico → 200 sin duplicados', async () => {
    groupDocsMock.push({
      docId: 'familia_1',
      data: { name: 'FAMILIA', icon: '👨‍👩‍👧', source: 'manual' },
      contactsCount: 5,
    });
    const res = await request(buildApp())
      .get(`/api/admin/inspect-contact-groups/${UID_TARGET}`)
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].name).toBe('FAMILIA');
    expect(res.body.groups[0].contactsCount).toBe(5);
    expect(res.body.duplicatesByName).toEqual({});
  });

  test('case 6 — admin + 4 grupos AMIGOS dup → duplicatesByName.AMIGOS.length=4', async () => {
    for (let i = 0; i < 4; i++) {
      groupDocsMock.push({
        docId: `amigos_${i}`,
        data: { name: 'AMIGOS', icon: '🤝', source: i === 0 ? 'manual' : null },
        contactsCount: 0,
      });
    }
    const res = await request(buildApp())
      .get(`/api/admin/inspect-contact-groups/${UID_TARGET}`)
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.groups).toHaveLength(4);
    expect(res.body.duplicatesByName.AMIGOS).toBeDefined();
    expect(res.body.duplicatesByName.AMIGOS).toHaveLength(4);
    expect(res.body.duplicatesByName.AMIGOS).toEqual(
      expect.arrayContaining(['amigos_0', 'amigos_1', 'amigos_2', 'amigos_3'])
    );
  });

  test('case 7 — admin + grupos mixtos (familia 1 + amigos 4) → solo AMIGOS en duplicatesByName', async () => {
    groupDocsMock.push({
      docId: 'familia_solo',
      data: { name: 'FAMILIA', icon: '👨‍👩‍👧', source: 'manual' },
      contactsCount: 7,
    });
    for (let i = 0; i < 4; i++) {
      groupDocsMock.push({
        docId: `amigos_${i}`,
        data: { name: 'AMIGOS', icon: '🤝' },
        contactsCount: 0,
      });
    }
    const res = await request(buildApp())
      .get(`/api/admin/inspect-contact-groups/${UID_TARGET}`)
      .set('Authorization', `Bearer ${TOKEN_ADMIN}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.duplicatesByName.FAMILIA).toBeUndefined();
    expect(res.body.duplicatesByName.AMIGOS).toHaveLength(4);
  });
});
