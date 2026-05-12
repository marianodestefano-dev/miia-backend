'use strict';

const { requireRole, requireOwner, __setAdminForTests } = require('../core/require_role');

function makeAdmin({ role = 'owner', docExists = true, verifyThrows = false, uid = 'user_uid_test' } = {}) {
  return {
    auth: () => ({
      verifyIdToken: jest.fn(async () => {
        if (verifyThrows) throw new Error('invalid token');
        return { uid };
      }),
    }),
    firestore: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: docExists,
            data: () => docExists ? { role } : null,
          }),
        }),
      }),
    }),
  };
}

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res;
}
function makeReq(authHeader, params = {}) {
  return { headers: authHeader ? { authorization: authHeader } : {}, params };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  __setAdminForTests(null);
  jest.restoreAllMocks();
});

describe('C7 -- requireRole', () => {
  test('sin header Authorization -> 401 Unauthorized', async () => {
    __setAdminForTests(makeAdmin());
    const mw = requireRole('owner');
    const req = makeReq(null);
    const res = makeRes();
    await mw(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Unauthorized' }));
  });
  test('header sin Bearer prefix -> 401', async () => {
    __setAdminForTests(makeAdmin());
    const mw = requireRole('owner');
    const req = makeReq('Token abcdef');
    const res = makeRes();
    await mw(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
  test('verifyIdToken throws -> 401 con error message', async () => {
    __setAdminForTests(makeAdmin({ verifyThrows: true }));
    const mw = requireRole('owner');
    const req = makeReq('Bearer bad_token');
    const res = makeRes();
    await mw(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ detail: 'invalid token' }));
  });
  test('uidRole === role -> next() (acceso permitido)', async () => {
    __setAdminForTests(makeAdmin({ role: 'owner' }));
    const mw = requireRole('owner');
    const req = makeReq('Bearer valid_token');
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.uid).toBe('user_uid_test');
    expect(req.uidRole).toBe('owner');
  });
  test('uidRole !== role -> 403 Forbidden con required y actual', async () => {
    __setAdminForTests(makeAdmin({ role: 'agent' }));
    const mw = requireRole('owner');
    const req = makeReq('Bearer valid_token');
    const res = makeRes();
    await mw(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Forbidden', required: 'owner', actual: 'agent' }));
  });
  test('uidRole === founder -> bypass -> next() (acceso global)', async () => {
    __setAdminForTests(makeAdmin({ role: 'founder' }));
    const mw = requireRole('owner');
    const req = makeReq('Bearer valid_token');
    const res = makeRes();
    const next = jest.fn();
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.uidRole).toBe('founder');
  });
  test('ownerDoc no existe -> uidRole null -> 403', async () => {
    __setAdminForTests(makeAdmin({ docExists: false }));
    const mw = requireRole('owner');
    const req = makeReq('Bearer valid_token');
    const res = makeRes();
    await mw(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ actual: null }));
  });
});

describe('C7 -- requireOwner', () => {
  test('sin header -> 401', async () => {
    __setAdminForTests(makeAdmin());
    const req = makeReq(null);
    const res = makeRes();
    await requireOwner('uid')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
  test('header sin Bearer -> 401', async () => {
    __setAdminForTests(makeAdmin());
    const req = makeReq('Token xyz');
    const res = makeRes();
    await requireOwner('uid')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
  test('verifyIdToken throws -> 401', async () => {
    __setAdminForTests(makeAdmin({ verifyThrows: true }));
    const req = makeReq('Bearer bad');
    const res = makeRes();
    await requireOwner('uid')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
  test('uidRole=owner, uid matches param -> next()', async () => {
    __setAdminForTests(makeAdmin({ role: 'owner', uid: 'owner_uid_x' }));
    const req = makeReq('Bearer tok', { uid: 'owner_uid_x' });
    const res = makeRes();
    const next = jest.fn();
    await requireOwner('uid')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.uid).toBe('owner_uid_x');
  });
  test('uidRole=owner, uid NO coincide con param -> 403 uid mismatch', async () => {
    __setAdminForTests(makeAdmin({ role: 'owner', uid: 'owner_uid_x' }));
    const req = makeReq('Bearer tok', { uid: 'other_uid_y' });
    const res = makeRes();
    await requireOwner('uid')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ detail: 'uid mismatch' }));
  });
  test('uidRole=founder -> bypass uid check -> next()', async () => {
    __setAdminForTests(makeAdmin({ role: 'founder', uid: 'founder_uid' }));
    const req = makeReq('Bearer tok', { uid: 'some_other_uid' });
    const res = makeRes();
    const next = jest.fn();
    await requireOwner('uid')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.uidRole).toBe('founder');
  });
  test('uidRole=agent -> 403 required owner actual agent', async () => {
    __setAdminForTests(makeAdmin({ role: 'agent' }));
    const req = makeReq('Bearer tok');
    const res = makeRes();
    await requireOwner('uid')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ required: 'owner', actual: 'agent' }));
  });
  test('resourceUid undefined (param no existe) -> no mismatch check -> next()', async () => {
    __setAdminForTests(makeAdmin({ role: 'owner', uid: 'owner_uid_x' }));
    const req = makeReq('Bearer tok', {});
    const res = makeRes();
    const next = jest.fn();
    await requireOwner('uid')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
  test('ownerDoc no existe -> uidRole null -> 403', async () => {
    __setAdminForTests(makeAdmin({ docExists: false }));
    const req = makeReq('Bearer tok');
    const res = makeRes();
    await requireOwner('uid')(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ actual: null }));
  });
});
