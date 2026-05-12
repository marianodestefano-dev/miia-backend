'use strict';

let _bpr;

beforeAll(() => {
  jest.resetModules();
  jest.doMock('firebase-admin', () => ({ firestore: jest.fn().mockReturnValue({}) }));
  jest.doMock('../sports/f1_dashboard/f1_schema', () => ({
    paths: {
      gp: jest.fn().mockReturnValue('gp/x'),
      result: jest.fn().mockReturnValue('res/x'),
      driver: jest.fn().mockReturnValue('drv/x'),
    },
  }));
  _bpr = require('../sports/f1_dashboard/f1_notifications').buildPostRaceMessage;
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

function makeDb({
  gpExists = true, resultExists = true, scheduleEmpty = false,
  prefsDocs = [], driverExists = true, ownerPhone = '+1234',
  resultPositions = [{ driver_id: 'HAM', position: 1, points: 25 }],
  ownerDataNull = false,
} = {}) {
  const gpDoc     = { exists: gpExists,     data: () => ({ name: 'Monaco GP', date: '2025-05-25' }) };
  const resultDoc = { exists: resultExists, data: () => ({ positions: resultPositions }) };
  const driverDoc = { exists: driverExists, data: () => ({ name: 'Lewis Hamilton', team: 'Mercedes' }) };
  const ownerDoc  = ownerDataNull ? { data: () => null } : { data: () => ({ phone: ownerPhone }) };
  const docMock = jest.fn().mockImplementation((path) => {
    if (typeof path === 'string' && path.includes('results')) return { get: () => Promise.resolve(resultDoc) };
    if (typeof path === 'string' && path.includes('drivers')) return { get: () => Promise.resolve(driverDoc) };
    if (typeof path === 'string' && path.startsWith('owners/'))  return { get: () => Promise.resolve(ownerDoc) };
    return { get: () => Promise.resolve(gpDoc) };
  });
  const prefsSnap    = { size: prefsDocs.length, docs: prefsDocs };
  const scheduleSnap = { empty: scheduleEmpty, docs: scheduleEmpty ? [] : [{ data: () => ({ name: 'Spanish GP', date: '2025-06-01' }) }] };
  return {
    doc: docMock,
    collection: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(scheduleSnap) }),
    collectionGroup: jest.fn().mockReturnValue({ where: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(prefsSnap) }),
  };
}

function loadMod(dbOpts) {
  jest.resetModules();
  const db = makeDb(dbOpts);
  jest.doMock('firebase-admin', () => ({ firestore: jest.fn().mockReturnValue(db) }));
  jest.doMock('../sports/f1_dashboard/f1_schema', () => ({
    paths: { gp: jest.fn().mockReturnValue('f1_data/2025/gp/monaco'), result: jest.fn().mockReturnValue('f1_data/2025/results/monaco'), driver: jest.fn().mockReturnValue('f1_data/2025/drivers/HAM') },
  }));
  return { mod: require('../sports/f1_dashboard/f1_notifications'), db };
}

function makePref({ adopted_driver = 'HAM', uid = 'owner1' } = {}) {
  return { data: () => ({ adopted_driver, uid, notifications: true }) };
}

describe('buildPostRaceMessage -- posEmoji y nextGpName', () => {
  test('P1 => trofeo (position===1 true)', () => { expect(_bpr('H','M',1,25,'Monaco',1,250,'Spanish GP','2025-06-01')).toContain('🏆'); });
  test('P2 => position<=3 true branch (str[idx] retorna surrogate, verificar por posicion)', () => { expect(_bpr('H','M',2,18,'Monaco',2,243,'','')).toContain('terminó P2'); });
  test('P3 => position<=3 true branch idx 1 (verificar por posicion)', () => { expect(_bpr('H','M',3,15,'Monaco',3,240,'','')).toContain('terminó P3'); });
  test('P4 => auto (position<=3 false)', () => { expect(_bpr('H','M',4,12,'Monaco',4,230,'','')).toContain('🏎️'); });
  test('nextGpName truthy => linea Proximo:', () => { expect(_bpr('H','M',1,25,'Monaco',1,250,'Spanish GP','2025-06-01')).toContain('Próximo:'); });
  test('nextGpName falsy => sin Proximo:', () => { expect(_bpr('H','M',1,25,'Monaco',1,250,'','')).not.toContain('Próximo:'); });
});

describe('gpDoc.exists false', () => {
  test('!gpDoc.exists => early return {0,0,0}', async () => {
    const { mod } = loadMod({ gpExists: false });
    expect(await mod.sendPostRaceNotifications('monaco', jest.fn())).toEqual({ sent: 0, skipped: 0, errors: 0 });
  });
});

describe('resultDoc.exists false', () => {
  test('!resultDoc.exists => early return {0,0,0}', async () => {
    const { mod } = loadMod({ resultExists: false });
    expect(await mod.sendPostRaceNotifications('monaco', jest.fn())).toEqual({ sent: 0, skipped: 0, errors: 0 });
  });
});

describe('scheduleSnap.empty branches', () => {
  test('empty=true => nextGp=null => name falsy branch', async () => {
    const { mod } = loadMod({ scheduleEmpty: true, prefsDocs: [makePref()] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn().mockResolvedValue({}))).sent).toBe(1);
  });
  test('empty=false => nextGp set => name truthy branch', async () => {
    const { mod } = loadMod({ scheduleEmpty: false, prefsDocs: [makePref()] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn().mockResolvedValue({}))).sent).toBe(1);
  });
});

describe('pref guard (!adopted_driver || !uid)', () => {
  test('!adopted_driver => skipped (left side true)', async () => {
    const { mod } = loadMod({ prefsDocs: [{ data: () => ({ adopted_driver: null, uid: 'owner1' }) }] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
  test('adopted_driver ok, !uid => skipped (right side true)', async () => {
    const { mod } = loadMod({ prefsDocs: [{ data: () => ({ adopted_driver: 'HAM', uid: null }) }] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
  test('both ok => no skip (false branch)', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn().mockResolvedValue({}))).skipped).toBe(0);
  });
});

describe('driverResult branches', () => {
  test('result.positions null => ?.find nullish => skip', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()], resultPositions: null });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
  test('driver not in positions => !driverResult skip', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref({ adopted_driver: 'VER' })], resultPositions: [{ driver_id: 'HAM', position: 1, points: 25 }] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
  test('points=0 => || 0 false branch', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()], resultPositions: [{ driver_id: 'HAM', position: 8, points: 0 }] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn().mockResolvedValue({}))).sent).toBe(1);
  });
  test('points>0 => || 0 truthy branch', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()] });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn().mockResolvedValue({}))).sent).toBe(1);
  });
});

describe('driverDoc.exists false', () => {
  test('!driverDoc.exists => skipped', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()], driverExists: false });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
});

describe('phone branches', () => {
  test('ownerDoc.data() null => ?.phone undefined => !phone skip', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()], ownerDataNull: true });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
  test('phone null => !phone skip (default param ignora undefined, usar null)', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()], ownerPhone: null });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).skipped).toBe(1);
  });
  test('phone ok => sent++ (!phone false branch)', async () => {
    const send = jest.fn().mockResolvedValue({});
    const { mod } = loadMod({ prefsDocs: [makePref()], ownerPhone: '+5491112345678' });
    const r = await mod.sendPostRaceNotifications('monaco', send);
    expect(r.sent).toBe(1);
    expect(send).toHaveBeenCalledWith('+5491112345678', expect.any(String));
  });
});

describe('error catch branches', () => {
  test('inner catch (sendWaMessage throws) => errors++', async () => {
    const { mod } = loadMod({ prefsDocs: [makePref()], ownerPhone: '+1234' });
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn().mockRejectedValue(new Error('wa fail')))).errors).toBe(1);
  });
  test('outer catch (db.doc throws) => errors++', async () => {
    jest.resetModules();
    jest.doMock('firebase-admin', () => ({ firestore: jest.fn().mockReturnValue({ doc: jest.fn().mockImplementation(() => { throw new Error('db crash'); }) }) }));
    jest.doMock('../sports/f1_dashboard/f1_schema', () => ({ paths: { gp: jest.fn().mockReturnValue('gp/x'), result: jest.fn().mockReturnValue('r/x'), driver: jest.fn().mockReturnValue('d/x') } }));
    const mod = require('../sports/f1_dashboard/f1_notifications');
    expect((await mod.sendPostRaceNotifications('monaco', jest.fn())).errors).toBe(1);
  });
});
