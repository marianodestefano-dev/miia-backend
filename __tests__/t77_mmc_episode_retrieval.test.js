'use strict';

/**
 * T77 — episode_retrieval.js coverage + behavior tests
 */

const er = require('../core/mmc/episode_retrieval');
const episodes = require('../core/mmc/episodes');

// Mock minimo Firestore-like para los tests
function makeMockFirestore(data) {
  // data: { uid: { episodeId: episodeDoc, ... } }
  return {
    collection: (name) => ({
      doc: (uid) => ({
        collection: (subname) => ({
          where: (field, op, value) => _makeQuery(data[uid] || {}, [{ field, op, value }]),
        }),
      }),
    }),
  };
}

function _makeQuery(uidData, filters) {
  return {
    where: (field, op, value) => _makeQuery(uidData, [...filters, { field, op, value }]),
    orderBy: (field, dir) => _makeQuery(uidData, [...filters, { _orderBy: field, _dir: dir }]),
    limit: (n) => _makeQuery(uidData, [...filters, { _limit: n }]),
    get: async () => {
      const arr = Object.values(uidData);
      let filtered = arr;
      for (const f of filters) {
        if (f.field === 'contactPhone') {
          filtered = filtered.filter(d => d.contactPhone === f.value);
        } else if (f.field === 'status') {
          filtered = filtered.filter(d => d.status === f.value);
        }
      }
      // Sort orderBy startedAt desc
      const orderEntry = filters.find(f => f._orderBy);
      if (orderEntry && orderEntry._orderBy === 'startedAt') {
        filtered.sort((a, b) => orderEntry._dir === 'desc'
          ? b.startedAt - a.startedAt : a.startedAt - b.startedAt);
      }
      // Apply limit
      const limitEntry = filters.find(f => f._limit);
      if (limitEntry) filtered = filtered.slice(0, limitEntry._limit);
      return { docs: filtered.map(d => ({ data: () => d })) };
    },
  };
}

const VALID_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // 28 chars, válido
const PHONE_A = '573054169969';
const PHONE_B = '5491164431700';

beforeEach(() => {
  // Default mock: episodios variados del PHONE_A
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const episodesData = {
    [VALID_UID]: {
      ep1: {
        episodeId: 'ep1', ownerUid: VALID_UID, contactPhone: PHONE_A,
        startedAt: now - 1 * day, endedAt: now - 1 * day + 3600000,
        status: 'distilled', topic: 'Interés plan Pro', summary: 'Lead pregunto por plan Pro 5 medicos. Pidio cotizacion.',
        messageIds: ['m1', 'm2'],
      },
      ep2: {
        episodeId: 'ep2', ownerUid: VALID_UID, contactPhone: PHONE_A,
        startedAt: now - 7 * day, endedAt: now - 7 * day + 3600000,
        status: 'distilled', topic: 'Demo solicitada', summary: 'Lead pidio demo en vivo. Se programo para martes.',
        messageIds: ['m3'],
      },
      ep3: {
        episodeId: 'ep3', ownerUid: VALID_UID, contactPhone: PHONE_A,
        startedAt: now - 100 * day, endedAt: now - 100 * day + 3600000,
        status: 'distilled', topic: 'Episodio viejo', summary: 'demasiado viejo deberia filtrarse',
        messageIds: ['m4'],
      },
      ep4_open: {
        episodeId: 'ep4_open', ownerUid: VALID_UID, contactPhone: PHONE_A,
        startedAt: now - 300000, endedAt: null,
        status: 'open', topic: null, summary: null,
        messageIds: ['m5'],
      },
      ep5_other_phone: {
        episodeId: 'ep5_other_phone', ownerUid: VALID_UID, contactPhone: PHONE_B,
        startedAt: now - 2 * day, endedAt: now - 2 * day + 3600000,
        status: 'distilled', topic: 'Otro contacto', summary: 'no debe aparecer en query PHONE_A',
        messageIds: ['m6'],
      },
    },
  };
  episodes.__setFirestoreForTests(makeMockFirestore(episodesData));
});

afterEach(() => {
  episodes.__setFirestoreForTests(null);
});

describe('T77 §A — getRecentEpisodesSummary basics', () => {
  test('returns array de episodios distilled del contacto', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].topic).toBe('Interés plan Pro'); // más reciente
  });

  test('ordenados por recency (mas reciente primero)', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A);
    for (let i = 1; i < r.length; i++) {
      expect(r[i - 1].startedAt).toBeGreaterThanOrEqual(r[i].startedAt);
    }
  });

  test('filtra solo status=distilled (excluye open)', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A);
    expect(r.every(ep => ep.topic !== null)).toBe(true);
    // ep4_open no aparece
    expect(r.find(ep => ep.topic === '(sin topic)')).toBeUndefined();
  });

  test('filtra solo contactPhone solicitado', async () => {
    const rA = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A);
    const rB = await er.getRecentEpisodesSummary(VALID_UID, PHONE_B);
    expect(rA.find(ep => ep.topic === 'Otro contacto')).toBeUndefined();
    expect(rB.find(ep => ep.topic === 'Otro contacto')).toBeDefined();
  });

  test('filtra episodios > maxAgeDays (default 90 dias)', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A);
    expect(r.find(ep => ep.topic === 'Episodio viejo')).toBeUndefined();
  });

  test('respeta maxAgeDays custom', async () => {
    // maxAgeDays=2 → solo ep1 (1 dia atras)
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A, { maxAgeDays: 2 });
    expect(r.length).toBe(1);
    expect(r[0].topic).toBe('Interés plan Pro');
  });

  test('respeta maxEpisodes custom', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A, { maxEpisodes: 1 });
    expect(r.length).toBe(1);
  });

  test('ageDays calculado correctamente', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A);
    expect(r[0].ageDays).toBe(1); // ep1 hace 1 dia
    expect(r[1].ageDays).toBe(7); // ep2 hace 7 dias
  });
});

describe('T77 §B — getRecentEpisodesSummary edge cases', () => {
  test('ownerUid null tira', async () => {
    await expect(er.getRecentEpisodesSummary(null, PHONE_A)).rejects.toThrow(/ownerUid/);
  });

  test('contactPhone null tira', async () => {
    await expect(er.getRecentEpisodesSummary(VALID_UID, null)).rejects.toThrow(/contactPhone/);
  });

  test('contacto sin episodios → array vacío', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, '+99999999999');
    expect(r).toEqual([]);
  });

  test('options con valores invalidos → fallback a defaults', async () => {
    const r = await er.getRecentEpisodesSummary(VALID_UID, PHONE_A, {
      maxEpisodes: -1,
      maxAgeDays: 0,
    });
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('T77 §C — formatForPrompt', () => {
  test('array vacio → string vacio', () => {
    expect(er.formatForPrompt([])).toBe('');
    expect(er.formatForPrompt(null)).toBe('');
    expect(er.formatForPrompt(undefined)).toBe('');
  });

  test('1 episodio → bloque formateado con header', () => {
    const eps = [{
      topic: 'Test topic',
      summary: 'Test summary',
      startedAt: Date.now() - 24 * 60 * 60 * 1000,
      endedAt: Date.now() - 23 * 60 * 60 * 1000,
      ageDays: 1,
    }];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('MEMORIA EPISÓDICA');
    expect(out).toContain('Test topic');
    expect(out).toContain('Test summary');
    expect(out).toContain('ayer');
  });

  test('contactName custom aparece en header', () => {
    const eps = [{ topic: 't', summary: 's', startedAt: 0, endedAt: 0, ageDays: 0 }];
    const out = er.formatForPrompt(eps, { contactName: 'Juan Pérez' });
    expect(out).toContain('Juan Pérez');
  });

  test('ageDays 0 → "hoy"', () => {
    const eps = [{ topic: 't', summary: 's', startedAt: 0, endedAt: 0, ageDays: 0 }];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('hoy');
  });

  test('ageDays 1 → "ayer"', () => {
    const eps = [{ topic: 't', summary: 's', startedAt: 0, endedAt: 0, ageDays: 1 }];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('ayer');
  });

  test('ageDays 5 → "hace 5 días"', () => {
    const eps = [{ topic: 't', summary: 's', startedAt: 0, endedAt: 0, ageDays: 5 }];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('hace 5 días');
  });

  test('ageDays 14 → "hace 2 semana(s)"', () => {
    const eps = [{ topic: 't', summary: 's', startedAt: 0, endedAt: 0, ageDays: 14 }];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('semana');
  });

  test('ageDays 60 → "hace 2 mes(es)"', () => {
    const eps = [{ topic: 't', summary: 's', startedAt: 0, endedAt: 0, ageDays: 60 }];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('mes');
  });

  test('summary > truncate → corta con ...', () => {
    const longSummary = 'a'.repeat(1000);
    const eps = [{ topic: 't', summary: longSummary, startedAt: 0, endedAt: 0, ageDays: 0 }];
    const out = er.formatForPrompt(eps, { summaryTruncate: 100 });
    expect(out).toContain('...');
    expect(out).not.toContain('a'.repeat(200));
  });

  test('multiples episodios numerados Episodio 1, 2, 3', () => {
    const eps = [
      { topic: 't1', summary: 's1', startedAt: 0, endedAt: 0, ageDays: 1 },
      { topic: 't2', summary: 's2', startedAt: 0, endedAt: 0, ageDays: 5 },
      { topic: 't3', summary: 's3', startedAt: 0, endedAt: 0, ageDays: 30 },
    ];
    const out = er.formatForPrompt(eps);
    expect(out).toContain('Episodio 1');
    expect(out).toContain('Episodio 2');
    expect(out).toContain('Episodio 3');
  });
});

describe('T77 §D — buildEpisodicContextBlock (helper combinado)', () => {
  test('contacto con episodios → string con bloque formateado', async () => {
    const out = await er.buildEpisodicContextBlock(VALID_UID, PHONE_A);
    expect(out).toContain('MEMORIA EPISÓDICA');
    expect(out).toContain('Interés plan Pro');
  });

  test('contacto sin episodios → string vacio', async () => {
    const out = await er.buildEpisodicContextBlock(VALID_UID, '+99999');
    expect(out).toBe('');
  });

  test('contactName se pasa al format', async () => {
    const out = await er.buildEpisodicContextBlock(VALID_UID, PHONE_A, { contactName: 'María' });
    expect(out).toContain('María');
  });
});

describe('T77 §E — Constantes exportadas', () => {
  test('DEFAULT_MAX_EPISODES = 5', () => {
    expect(er.DEFAULT_MAX_EPISODES).toBe(5);
  });
  test('DEFAULT_MAX_AGE_DAYS = 90', () => {
    expect(er.DEFAULT_MAX_AGE_DAYS).toBe(90);
  });
  test('DEFAULT_SUMMARY_TRUNCATE = 500', () => {
    expect(er.DEFAULT_SUMMARY_TRUNCATE).toBe(500);
  });
});
