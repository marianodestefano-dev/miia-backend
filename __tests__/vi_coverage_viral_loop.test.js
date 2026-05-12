'use strict';

/**
 * VI-BACKEND-COVERAGE: viral_loop.js — 100% branches
 * Usa hook __setFirestoreForTests para aislar.
 */

const { buildShareLink, trackShare, getShareStats, SHARE_CHANNELS, __setFirestoreForTests } = require('../core/viral_loop');

function makeDb(docs) {
  const setMock = jest.fn().mockResolvedValue(undefined);
  return {
    collection: () => ({
      doc: () => ({ set: setMock }),
      where: () => ({
        get: () => Promise.resolve({
          docs: docs.map(d => ({ data: () => d })),
          forEach: (cb) => docs.forEach(d => cb({ data: () => d })),
        }),
      }),
    }),
    _setMock: setMock,
  };
}

// ── buildShareLink ────────────────────────────────────────────────────────────

describe('buildShareLink', () => {
  test('uid o referralCode faltante → throw', () => {
    expect(() => buildShareLink('', 'REF1', 'whatsapp')).toThrow('uid and referralCode required');
    expect(() => buildShareLink('uid1', '', 'whatsapp')).toThrow('uid and referralCode required');
    expect(() => buildShareLink(null, 'REF1', 'whatsapp')).toThrow('uid and referralCode required');
  });

  test('whatsapp channel → wa.me URL', () => {
    const url = buildShareLink('uid1', 'REF123', 'whatsapp');
    expect(url).toContain('wa.me');
  });

  test('email channel → mailto URL', () => {
    const url = buildShareLink('uid1', 'REF123', 'email');
    expect(url).toContain('mailto:');
  });

  test('copy channel → base URL', () => {
    const url = buildShareLink('uid1', 'REF123', 'copy');
    expect(url).toContain('miia-app.com/join');
    expect(url).not.toContain('wa.me');
  });

  test('channel desconocido → base URL (fallback)', () => {
    const url = buildShareLink('uid1', 'REF123', 'sms');
    expect(url).toContain('miia-app.com/join');
  });
});

// ── trackShare ────────────────────────────────────────────────────────────────

describe('trackShare', () => {
  beforeEach(() => {
    __setFirestoreForTests(makeDb([]));
  });

  test('uid o referralCode faltante → throw', async () => {
    await expect(trackShare('', 'REF1', 'whatsapp')).rejects.toThrow('uid and referralCode required');
    await expect(trackShare('uid1', null, 'whatsapp')).rejects.toThrow('uid and referralCode required');
  });

  test('con channel → usa ese channel', async () => {
    const db = makeDb([]);
    __setFirestoreForTests(db);
    const r = await trackShare('uid1', 'REF1', 'whatsapp');
    expect(r.channel).toBe('whatsapp');
    expect(r.uid).toBe('uid1');
    expect(r.referralCode).toBe('REF1');
    expect(typeof r.id).toBe('string');
    expect(db._setMock).toHaveBeenCalled();
  });

  test('sin channel → default "copy"', async () => {
    const db = makeDb([]);
    __setFirestoreForTests(db);
    const r = await trackShare('uid1', 'REF1', null);
    expect(r.channel).toBe('copy');
  });

  test('sin channel (undefined) → default "copy"', async () => {
    const db = makeDb([]);
    __setFirestoreForTests(db);
    const r = await trackShare('uid1', 'REF1', undefined);
    expect(r.channel).toBe('copy');
  });
});

// ── getShareStats ─────────────────────────────────────────────────────────────

describe('getShareStats', () => {
  test('uid faltante → throw', async () => {
    await expect(getShareStats(null)).rejects.toThrow('uid required');
    await expect(getShareStats('')).rejects.toThrow('uid required');
  });

  test('sin shares → total=0, byChannel todos 0', async () => {
    __setFirestoreForTests(makeDb([]));
    const r = await getShareStats('uid-1');
    expect(r.uid).toBe('uid-1');
    expect(r.total).toBe(0);
    expect(r.byChannel.whatsapp).toBe(0);
    expect(r.byChannel.email).toBe(0);
    expect(r.byChannel.copy).toBe(0);
  });

  test('con shares → total y byChannel correctos', async () => {
    __setFirestoreForTests(makeDb([
      { channel: 'whatsapp', uid: 'uid-2', referralCode: 'R1' },
      { channel: 'whatsapp', uid: 'uid-2', referralCode: 'R1' },
      { channel: 'email',    uid: 'uid-2', referralCode: 'R1' },
    ]));
    const r = await getShareStats('uid-2');
    expect(r.total).toBe(3);
    expect(r.byChannel.whatsapp).toBe(2);
    expect(r.byChannel.email).toBe(1);
    expect(r.byChannel.copy).toBe(0);
  });

  test('channel desconocido → byChannel[ch] incrementa a nuevo key', async () => {
    __setFirestoreForTests(makeDb([
      { channel: 'sms', uid: 'uid-3', referralCode: 'R2' },
    ]));
    const r = await getShareStats('uid-3');
    expect(r.total).toBe(1);
    expect(r.byChannel.sms).toBe(1);
  });
});

// ── SHARE_CHANNELS ────────────────────────────────────────────────────────────

describe('SHARE_CHANNELS', () => {
  test('es un array frozen con whatsapp, email, copy', () => {
    expect(SHARE_CHANNELS).toContain('whatsapp');
    expect(SHARE_CHANNELS).toContain('email');
    expect(SHARE_CHANNELS).toContain('copy');
    expect(() => { SHARE_CHANNELS.push('sms'); }).toThrow(); // frozen
  });
});

// ── Ramas extra para 100% ─────────────────────────────────────────────────────

describe('getShareStats — snap.docs undefined (branch fallback)', () => {
  test('snap.docs undefined → total=0', async () => {
    const db = {
      collection: () => ({
        where: () => ({
          get: () => Promise.resolve({
            docs: undefined, // fuerza branch false en: snap.docs ? snap.docs.length : 0
            forEach: () => {},
          }),
        }),
      }),
    };
    __setFirestoreForTests(db);
    const r = await getShareStats('uid-nodocs');
    expect(r.total).toBe(0);
  });
});

describe('getDb() fallback a config/firebase', () => {
  test('sin _db → usa config/firebase via doMock virtual', async () => {
    jest.resetModules();
    const mockDoc = { data: () => ({ channel: 'copy', uid: 'uid-fb', referralCode: 'R0' }) };
    jest.doMock('../config/firebase', () => ({
      db: {
        collection: () => ({
          doc: () => ({ set: jest.fn().mockResolvedValue(undefined) }),
          where: () => ({
            get: () => Promise.resolve({ docs: [mockDoc], forEach: (cb) => [mockDoc].forEach(cb) }),
          }),
        }),
      },
    }), { virtual: true });
    const vl = require('../core/viral_loop');
    // _db es null en módulo fresco → getDb() usa require('../config/firebase').db
    const r = await vl.getShareStats('uid-fb');
    expect(r.total).toBe(1);
    jest.dontMock('../config/firebase');
  });
});
