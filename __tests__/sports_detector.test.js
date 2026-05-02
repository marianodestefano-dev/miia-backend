'use strict';

const sd = require('../core/sports_detector');

const UID = 'test_uid_12345';
const PHONE = '5491155667788';

function makeMockDb({ existingSports = null, throwGet = false, throwSet = false } = {}) {
  const docs = {};
  if (existingSports) {
    Object.keys(existingSports).forEach(k => { docs[k] = existingSports[k]; });
  }
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (key) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const data = docs[key];
              return { exists: !!data, data: () => data || {} };
            },
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              docs[key] = Object.assign(docs[key] || {}, data);
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const items = Object.entries(docs).map(([k, d]) => ({ id: k, data: () => d }));
            return { forEach: fn => items.forEach(fn) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => { sd.__setFirestoreForTests(null); });
afterEach(() => { sd.__setFirestoreForTests(null); });

describe('SPORT_TYPES', () => {
  test('frozen', () => { expect(() => { sd.SPORT_TYPES.push('x'); }).toThrow(); });
  test('contiene futbol y f1', () => {
    expect(sd.SPORT_TYPES).toContain('futbol');
    expect(sd.SPORT_TYPES).toContain('f1');
  });
});

describe('setSportForContact', () => {
  test('uid undefined throw', async () => {
    await expect(sd.setSportForContact(undefined, PHONE, { type: 'futbol', team: 'Boca' })).rejects.toThrow('uid');
  });
  test('sportSpec null throw', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    await expect(sd.setSportForContact(UID, PHONE, null)).rejects.toThrow('sportSpec');
  });
  test('type invalido throw', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    await expect(sd.setSportForContact(UID, PHONE, { type: 'xxx' })).rejects.toThrow('type invalido');
  });
  test('futbol sin team throw', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    await expect(sd.setSportForContact(UID, PHONE, { type: 'futbol' })).rejects.toThrow('team');
  });
  test('f1 sin driver throw', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    await expect(sd.setSportForContact(UID, PHONE, { type: 'f1' })).rejects.toThrow('driver');
  });
  test('contactPhone undefined throw', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    await expect(sd.setSportForContact(UID, undefined, { type: 'futbol', team: 'Boca' })).rejects.toThrow('contactPhone');
  });
  test('agrega futbol con contactName', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    const r = await sd.setSportForContact(UID, PHONE, { type: 'futbol', team: 'Boca', rivalry: 'River' }, { contactName: 'Tio' });
    expect(r.contactPhone).toBe(PHONE);
    expect(r.sports.length).toBe(1);
  });
  test('agrega f1', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    const r = await sd.setSportForContact(UID, PHONE, { type: 'f1', driver: 'Verstappen' });
    expect(r.sports[0].driver).toBe('Verstappen');
  });
  test('reemplaza mismo type', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { contactPhone: PHONE, sports: [{ type: 'futbol', team: 'River' }] };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    const r = await sd.setSportForContact(UID, PHONE, { type: 'futbol', team: 'Boca' });
    expect(r.sports.length).toBe(1);
    expect(r.sports[0].team).toBe('Boca');
  });
  test('agrega segundo distinto type', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { contactPhone: PHONE, sports: [{ type: 'futbol', team: 'Boca' }] };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    const r = await sd.setSportForContact(UID, PHONE, { type: 'f1', driver: 'V' });
    expect(r.sports.length).toBe(2);
  });
  test('contactPhone self', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    const r = await sd.setSportForContact(UID, 'self', { type: 'futbol', team: 'Boca' });
    expect(r.contactPhone).toBe('self');
  });
});

describe('getSportsForContact', () => {
  test('uid undefined throw', async () => {
    await expect(sd.getSportsForContact(undefined, PHONE)).rejects.toThrow('uid');
  });
  test('contactPhone undefined throw', async () => {
    await expect(sd.getSportsForContact(UID, undefined)).rejects.toThrow('contactPhone');
  });
  test('doc no existe -> []', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    expect(await sd.getSportsForContact(UID, PHONE)).toEqual([]);
  });
  test('doc existe -> sports', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { sports: [{ type: 'futbol', team: 'Boca' }] };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    expect((await sd.getSportsForContact(UID, PHONE)).length).toBe(1);
  });
  test('data sin sports -> []', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { otherField: 'x' };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    expect(await sd.getSportsForContact(UID, PHONE)).toEqual([]);
  });
});

describe('removeSportForContact', () => {
  test('uid undefined throw', async () => {
    await expect(sd.removeSportForContact(undefined, PHONE, 'futbol')).rejects.toThrow('uid');
  });
  test('contactPhone undefined throw', async () => {
    await expect(sd.removeSportForContact(UID, undefined, 'futbol')).rejects.toThrow('contactPhone');
  });
  test('sportType invalido throw', async () => {
    await expect(sd.removeSportForContact(UID, PHONE, 'xx')).rejects.toThrow('type invalido');
  });
  test('doc no existe -> []', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    expect(await sd.removeSportForContact(UID, PHONE, 'futbol')).toEqual([]);
  });
  test('remueve sport', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { sports: [{ type: 'futbol', team: 'Boca' }, { type: 'f1', driver: 'V' }] };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    const r = await sd.removeSportForContact(UID, PHONE, 'futbol');
    expect(r.length).toBe(1);
    expect(r[0].type).toBe('f1');
  });
  test('sport no existe -> array vacio', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { sports: [] };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    expect(await sd.removeSportForContact(UID, PHONE, 'futbol')).toEqual([]);
  });
});

describe('getAllContactsBySport', () => {
  test('uid undefined throw', async () => {
    await expect(sd.getAllContactsBySport(undefined, 'futbol')).rejects.toThrow('uid');
  });
  test('sportType invalido throw', async () => {
    await expect(sd.getAllContactsBySport(UID, 'xx')).rejects.toThrow('type invalido');
  });
  test('no docs -> []', async () => {
    sd.__setFirestoreForTests(makeMockDb());
    expect(await sd.getAllContactsBySport(UID, 'futbol')).toEqual([]);
  });
  test('retorna contactos que siguen ese deporte', async () => {
    const ex = { tio: { contactPhone: '+1', contactName: 'Tio', sports: [{ type: 'futbol', team: 'Boca' }] } };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    const r = await sd.getAllContactsBySport(UID, 'futbol');
    expect(r.length).toBe(1);
    expect(r[0].contactName).toBe('Tio');
  });
});

describe('extra branch coverage sports_detector', () => {
  test('getSportsForContact con data.sports no array', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { sports: 'not-an-array' };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    expect(await sd.getSportsForContact(UID, PHONE)).toEqual([]);
  });

  test('setSportForContact con existing data.sports no array', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { contactPhone: PHONE, sports: 'broken' };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    const r = await sd.setSportForContact(UID, PHONE, { type: 'futbol', team: 'Boca' });
    expect(r.sports.length).toBe(1);
  });

  test('removeSportForContact con data.sports no array', async () => {
    const key = PHONE.replace(/[^0-9a-zA-Z_]/g, '_');
    const ex = {}; ex[key] = { sports: 'broken' };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    const r = await sd.removeSportForContact(UID, PHONE, 'futbol');
    expect(r).toEqual([]);
  });

  test('getAllContactsBySport con data.sports no array', async () => {
    const ex = { x: { contactPhone: '+1', sports: 'broken' } };
    sd.__setFirestoreForTests(makeMockDb({ existingSports: ex }));
    expect(await sd.getAllContactsBySport(UID, 'futbol')).toEqual([]);
  });
});

describe('extra: doc sin .data property', () => {
  test('getSportsForContact con doc.exists pero sin data fn', async () => {
    sd.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true })
      })})})})
    });
    expect(await sd.getSportsForContact(UID, PHONE)).toEqual([]);
  });
  test('removeSportForContact con doc.exists pero sin data fn', async () => {
    sd.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true }),
        set: async () => {}
      })})})})
    });
    expect(await sd.removeSportForContact(UID, PHONE, 'futbol')).toEqual([]);
  });
  test('getAllContactsBySport con doc sin data fn', async () => {
    sd.__setFirestoreForTests({
      collection: () => ({ doc: () => ({ collection: () => ({
        get: async () => ({ forEach: fn => [{id:'x'}].forEach(fn) })
      })})})
    });
    expect(await sd.getAllContactsBySport(UID, 'futbol')).toEqual([]);
  });
});
