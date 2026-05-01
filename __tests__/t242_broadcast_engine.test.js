'use strict';

const {
  buildBroadcastRecord, saveBroadcast, updateBroadcastStatus,
  getBroadcast, getBroadcasts, countTodayBroadcasts,
  filterAudience, buildBatches, personalizeMessage, buildBroadcastSummaryText,
  isValidStatus, isValidAudienceFilter,
  BROADCAST_STATUSES, AUDIENCE_FILTERS,
  MAX_BATCH_SIZE, MAX_BROADCASTS_PER_DAY, DEFAULT_BATCH_DELAY_MS,
  __setFirestoreForTests,
} = require('../core/broadcast_engine');

const UID = 'testUid1234567890';
const TEMPLATE = 'Hola {nombre}, tenemos una oferta especial para vos!';

function makeMockDb({ stored = {}, throwGet = false, throwSet = false } = {}) {
  const db_stored = { ...stored };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              db_stored[id] = opts && opts.merge ? { ...(db_stored[id] || {}), ...data } : data;
            },
            get: async () => ({
              exists: !!db_stored[id],
              data: () => db_stored[id],
            }),
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return {
              forEach: fn => Object.entries(db_stored).forEach(([id, data]) => fn({ data: () => data })),
            };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

describe('Constantes', () => {
  test('BROADCAST_STATUSES tiene 7 estados', () => { expect(BROADCAST_STATUSES.length).toBe(7); });
  test('frozen BROADCAST_STATUSES', () => { expect(() => { BROADCAST_STATUSES.push('x'); }).toThrow(); });
  test('AUDIENCE_FILTERS tiene 6 filtros', () => { expect(AUDIENCE_FILTERS.length).toBe(6); });
  test('frozen AUDIENCE_FILTERS', () => { expect(() => { AUDIENCE_FILTERS.push('x'); }).toThrow(); });
  test('MAX_BATCH_SIZE es 50', () => { expect(MAX_BATCH_SIZE).toBe(50); });
  test('MAX_BROADCASTS_PER_DAY es 3', () => { expect(MAX_BROADCASTS_PER_DAY).toBe(3); });
  test('DEFAULT_BATCH_DELAY_MS es 2000', () => { expect(DEFAULT_BATCH_DELAY_MS).toBe(2000); });
});

describe('isValidStatus / isValidAudienceFilter', () => {
  test('draft es status valido', () => { expect(isValidStatus('draft')).toBe(true); });
  test('deleted no es valido', () => { expect(isValidStatus('deleted')).toBe(false); });
  test('leads es filtro valido', () => { expect(isValidAudienceFilter('leads')).toBe(true); });
  test('vip no es filtro valido', () => { expect(isValidAudienceFilter('vip')).toBe(false); });
});

describe('buildBroadcastRecord', () => {
  test('lanza si uid undefined', () => {
    expect(() => buildBroadcastRecord(undefined, TEMPLATE)).toThrow('uid requerido');
  });
  test('lanza si messageTemplate undefined', () => {
    expect(() => buildBroadcastRecord(UID, undefined)).toThrow('messageTemplate requerido');
  });
  test('lanza si messageTemplate vacio', () => {
    expect(() => buildBroadcastRecord(UID, '   ')).toThrow('no puede estar vacio');
  });
  test('construye record con defaults', () => {
    const r = buildBroadcastRecord(UID, TEMPLATE);
    expect(r.broadcastId).toMatch(/^bcast_/);
    expect(r.uid).toBe(UID);
    expect(r.messageTemplate).toBe(TEMPLATE.trim());
    expect(r.audienceFilter).toBe('all');
    expect(r.batchSize).toBe(MAX_BATCH_SIZE);
    expect(r.status).toBe('draft');
    expect(r.stats).toEqual({ total: 0, sent: 0, failed: 0, skipped: 0 });
    expect(r.createdAt).toBeDefined();
  });
  test('aplica opts correctamente', () => {
    const r = buildBroadcastRecord(UID, TEMPLATE, {
      audienceFilter: 'leads', tags: ['vip'], batchSize: 10, name: 'Campaña VIP',
    });
    expect(r.audienceFilter).toBe('leads');
    expect(r.tags).toContain('vip');
    expect(r.batchSize).toBe(10);
    expect(r.name).toBe('Campaña VIP');
  });
  test('batchSize se limita a MAX_BATCH_SIZE', () => {
    const r = buildBroadcastRecord(UID, TEMPLATE, { batchSize: 200 });
    expect(r.batchSize).toBe(MAX_BATCH_SIZE);
  });
  test('audienceFilter invalido cae a all', () => {
    const r = buildBroadcastRecord(UID, TEMPLATE, { audienceFilter: 'vip_only' });
    expect(r.audienceFilter).toBe('all');
  });
});

describe('saveBroadcast', () => {
  test('lanza si uid undefined', async () => {
    await expect(saveBroadcast(undefined, { broadcastId: 'x' })).rejects.toThrow('uid requerido');
  });
  test('lanza si record invalido', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(saveBroadcast(UID, null)).rejects.toThrow('record invalido');
  });
  test('guarda sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    const record = buildBroadcastRecord(UID, TEMPLATE);
    const id = await saveBroadcast(UID, record);
    expect(id).toBe(record.broadcastId);
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    const record = buildBroadcastRecord(UID, TEMPLATE);
    await expect(saveBroadcast(UID, record)).rejects.toThrow('set error');
  });
});

describe('updateBroadcastStatus', () => {
  test('lanza si uid undefined', async () => {
    await expect(updateBroadcastStatus(undefined, 'b1', 'running')).rejects.toThrow('uid requerido');
  });
  test('lanza si broadcastId undefined', async () => {
    await expect(updateBroadcastStatus(UID, undefined, 'running')).rejects.toThrow('broadcastId requerido');
  });
  test('lanza si status invalido', async () => {
    await expect(updateBroadcastStatus(UID, 'b1', 'working')).rejects.toThrow('status invalido');
  });
  test('actualiza a running sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateBroadcastStatus(UID, 'b1', 'running')).resolves.toBeUndefined();
  });
  test('acepta stats en opts', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(updateBroadcastStatus(UID, 'b1', 'completed', { stats: { total: 10, sent: 9, failed: 1, skipped: 0 } })).resolves.toBeUndefined();
  });
});

describe('getBroadcast', () => {
  test('lanza si uid undefined', async () => {
    await expect(getBroadcast(undefined, 'b1')).rejects.toThrow('uid requerido');
  });
  test('retorna null si no existe', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getBroadcast(UID, 'noexiste')).toBeNull();
  });
  test('fail-open retorna null si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getBroadcast(UID, 'b1')).toBeNull();
  });
});

describe('getBroadcasts', () => {
  test('lanza si uid undefined', async () => {
    await expect(getBroadcasts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay broadcasts', async () => {
    __setFirestoreForTests(makeMockDb());
    expect(await getBroadcasts(UID)).toEqual([]);
  });
  test('filtra por status', async () => {
    const stored = {
      'b1': { broadcastId: 'b1', status: 'completed', createdAt: new Date().toISOString() },
      'b2': { broadcastId: 'b2', status: 'draft', createdAt: new Date().toISOString() },
    };
    __setFirestoreForTests(makeMockDb({ stored }));
    const r = await getBroadcasts(UID, { status: 'completed' });
    expect(r.length).toBe(1);
    expect(r[0].status).toBe('completed');
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getBroadcasts(UID)).toEqual([]);
  });
});

describe('filterAudience', () => {
  const contacts = [
    { phone: '+541', name: 'Juan', type: 'lead', tags: ['vip'], lastMessageAt: '2026-01-01T00:00:00Z' },
    { phone: '+542', name: 'Ana', type: 'client', tags: ['premium'] },
    { phone: '+543', name: 'Carlos', type: 'lead', tags: ['vip', 'premium'] },
    { phone: '+544', name: 'Maria', type: 'client', tags: [] },
  ];

  test('all retorna todos', () => {
    expect(filterAudience(contacts, 'all')).toHaveLength(4);
  });
  test('leads filtra solo leads', () => {
    const r = filterAudience(contacts, 'leads');
    expect(r).toHaveLength(2);
    expect(r.every(c => c.type === 'lead')).toBe(true);
  });
  test('clients filtra solo clientes', () => {
    const r = filterAudience(contacts, 'clients');
    expect(r).toHaveLength(2);
  });
  test('tagged filtra por tags', () => {
    const r = filterAudience(contacts, 'tagged', ['vip']);
    expect(r).toHaveLength(2);
    expect(r.every(c => c.tags.includes('vip'))).toBe(true);
  });
  test('inactive filtra inactivos (>30 dias)', () => {
    const r = filterAudience(contacts, 'inactive');
    expect(r.length).toBeGreaterThan(0);
    expect(r.some(c => c.name === 'Juan')).toBe(true);
  });
  test('array vacio retorna vacio', () => {
    expect(filterAudience([], 'all')).toEqual([]);
  });
  test('null retorna vacio', () => {
    expect(filterAudience(null, 'all')).toEqual([]);
  });
});

describe('buildBatches', () => {
  test('retorna vacio si contacts vacio', () => {
    expect(buildBatches([], 10)).toEqual([]);
  });
  test('divide en batches correctamente', () => {
    const contacts = Array.from({ length: 25 }, (_, i) => ({ phone: '+5411' + i }));
    const batches = buildBatches(contacts, 10);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(10);
    expect(batches[1].length).toBe(10);
    expect(batches[2].length).toBe(5);
  });
  test('1 batch si menos que batchSize', () => {
    const contacts = Array.from({ length: 5 }, (_, i) => ({ phone: '+5411' + i }));
    expect(buildBatches(contacts, 50).length).toBe(1);
  });
});

describe('personalizeMessage', () => {
  test('reemplaza {nombre}', () => {
    const r = personalizeMessage('Hola {nombre}!', { name: 'Ana', phone: '+54111' });
    expect(r).toBe('Hola Ana!');
  });
  test('reemplaza {phone}', () => {
    const r = personalizeMessage('Tu numero es {phone}', { name: 'Ana', phone: '+54111' });
    expect(r).toContain('+54111');
  });
  test('usa phone si no hay name', () => {
    const r = personalizeMessage('Hola {nombre}', { phone: '+54999' });
    expect(r).toContain('+54999');
  });
  test('retorna vacio si template null', () => {
    expect(personalizeMessage(null, { name: 'Ana' })).toBe('');
  });
});

describe('buildBroadcastSummaryText', () => {
  test('retorna vacio si null', () => {
    expect(buildBroadcastSummaryText(null)).toBe('');
  });
  test('incluye nombre y estado', () => {
    const record = buildBroadcastRecord(UID, TEMPLATE, { name: 'Campaña Navidad' });
    const text = buildBroadcastSummaryText({ ...record, status: 'completed', stats: { total: 50, sent: 48, failed: 2, skipped: 0 } });
    expect(text).toContain('Campaña Navidad');
    expect(text).toContain('completed');
    expect(text).toContain('48');
    expect(text).toContain('2');
  });
});
