'use strict';

/**
 * #7 Migracion paths owners/ -> users/ (firma Mariano 2026-05-12).
 * Verifica dual-write transitorio en mmc_engine.captureEpisode.
 */

const { captureEpisode, __setFirestoreForTests } = require('../core/mmc_engine');

function makeDualDb() {
  const ownersWrites = [];
  const usersWrites = [];
  const collectionFn = jest.fn((name) => ({
    doc: jest.fn((uid) => ({
      collection: jest.fn((subName) => ({
        doc: jest.fn((docId) => ({
          set: jest.fn((data, opts) => {
            if (name === 'owners') ownersWrites.push({ uid, subName, docId, data, opts });
            else if (name === 'users') usersWrites.push({ uid, subName, docId, data, opts });
            return Promise.resolve({});
          }),
        })),
      })),
    })),
  }));
  return {
    db: { collection: collectionFn },
    ownersWrites,
    usersWrites,
  };
}

describe('#7 dual-write owners/ -> users/', () => {
  beforeEach(() => {
    __setFirestoreForTests(null);
    delete process.env.MMC_DUAL_WRITE;
  });

  test('captureEpisode escribe a AMBOS paths (owners + users) por default', async () => {
    const { db, ownersWrites, usersWrites } = makeDualDb();
    __setFirestoreForTests(db);
    await captureEpisode('uid12345', '+573054169969', [{ text: 'hola' }], {});
    expect(ownersWrites.length).toBe(1);
    expect(usersWrites.length).toBe(1);
    expect(ownersWrites[0].subName).toBe('miia_memory');
    expect(usersWrites[0].subName).toBe('miia_memory');
    expect(ownersWrites[0].docId).toBe(usersWrites[0].docId); // mismo episodeId
  });

  test('MMC_DUAL_WRITE=false desactiva el espejo a users/', async () => {
    process.env.MMC_DUAL_WRITE = 'false';
    // Re-require para que tome la env nueva
    jest.resetModules();
    const fresh = require('../core/mmc_engine');
    const { db, ownersWrites, usersWrites } = makeDualDb();
    fresh.__setFirestoreForTests(db);
    await fresh.captureEpisode('uid12345', '+573054169969', [{ text: 'X' }], {});
    expect(ownersWrites.length).toBe(1);
    expect(usersWrites.length).toBe(0); // sin espejo
    delete process.env.MMC_DUAL_WRITE;
    jest.resetModules();
  });
});
