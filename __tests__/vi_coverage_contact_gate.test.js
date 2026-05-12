'use strict';

const {
  shouldMiiaRespond,
  buildUnknownContactAlert,
  getOwnerBusinessKeywords,
  classifyUnknownContact,
} = require('../core/contact_gate');

const {
  checkIsolation,
  runIsolationSuite,
  CANARY_TOKEN,
  __setFirestoreForTests: setIsolDb,
} = require('../core/mmc_isolation');

const PHONE = '+571111222';
const UID_A = 'uid_a_vi';
const UID_B = 'uid_b_vi';

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('VI-COV contact_gate -- shouldMiiaRespond missing branches', () => {
  test('isInvocation -> reason=invocation (lines 164-165)', () => {
    const r = shouldMiiaRespond({ isInvocation: true, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('invocation');
    expect(r.action).toBe('invocation');
  });
  test('isMiiaInvoked && isChauMiia -> invocation_farewell (170-172)', () => {
    const r = shouldMiiaRespond({ isMiiaInvoked: true, isChauMiia: true, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('invocation_farewell');
  });
  test('isMiiaInvoked && !isChauMiia -> miia_invoked (174-175)', () => {
    const r = shouldMiiaRespond({ isMiiaInvoked: true, isChauMiia: false, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('miia_invoked');
  });
  test('isChauMiia && miiaActive=true -> farewell (183-184)', () => {
    const r = shouldMiiaRespond({ isChauMiia: true, miiaActive: true, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('farewell');
  });
  test('isChauMiia && miiaActive=false -> farewell_no_session (187-188)', () => {
    const r = shouldMiiaRespond({ isChauMiia: true, miiaActive: false, isMiiaInvoked: false, basePhone: PHONE });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('farewell_no_session');
  });
  test('enterprise_lead -> enterprise_lead_discovery (201)', () => {
    const r = shouldMiiaRespond({ contactType: 'enterprise_lead', basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('enterprise_lead_discovery');
  });
  test('group && miiaActive=true -> group_triggered (212-213)', () => {
    const r = shouldMiiaRespond({ contactType: 'group', miiaActive: true, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('group_triggered');
  });
  test('group && !miiaActive && !isHolaMiia -> group_no_trigger (215)', () => {
    const r = shouldMiiaRespond({ contactType: 'group', miiaActive: false, isHolaMiia: false, basePhone: PHONE });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('group_no_trigger');
  });
});

describe('VI-COV contact_gate -- buildUnknownContactAlert isLid branches (265-269)', () => {
  test('isLid && pushName -> muestra nombre, oculta numero (266-267)', () => {
    const r = buildUnknownContactAlert('12345', 'hola', 'Juan', { isLid: true });
    expect(r).toContain('Juan');
    expect(r).not.toContain('+12345');
  });
  test('isLid && !pushName -> sin nombre oculto (268-269)', () => {
    const r = buildUnknownContactAlert('12345', 'hola', null, { isLid: true });
    expect(r).toContain('sin nombre');
    expect(r).not.toContain('+12345');
  });
});

describe('VI-COV contact_gate -- getOwnerBusinessKeywords branches (302-329)', () => {
  test('keywordsSet string+object, businesses, takeoverKeywords', () => {
    const ctx = {
      keywordsSet: ['str_kw', { keyword: 'obj_kw' }],
      businesses: [{ contact_rules: { lead_keywords: ['biz_kw', 'str_kw'] } }],
      takeoverKeywords: ['tak_kw', 'biz_kw'],
    };
    const kws = getOwnerBusinessKeywords(ctx);
    expect(kws).toContain('str_kw');
    expect(kws).toContain('obj_kw');
    expect(kws).toContain('biz_kw');
    expect(kws).toContain('tak_kw');
    expect(kws.filter(k => k === 'str_kw').length).toBe(1);
    expect(kws.filter(k => k === 'biz_kw').length).toBe(1);
  });
  test('ctx vacio -> []', () => {
    expect(getOwnerBusinessKeywords({})).toEqual([]);
  });
});

describe('VI-COV contact_gate -- classifyUnknownContact client match (368)', () => {
  test('client keyword match -> type=client', () => {
    const r = classifyUnknownContact('necesito soporte urgente', ['comprar'], ['soporte', 'urgente']);
    expect(r.type).toBe('client');
    expect(r.keyword).toBeDefined();
  });
  test('messageBody null -> unknown (363)', () => {
    expect(classifyUnknownContact(null, ['kw'], ['ck']).type).toBe('unknown');
  });
});

describe('VI-COV mmc_isolation -- checkIsolation snap.exists branches (55-63,69-70,89)', () => {
  function makeLeakDb() {
    return {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              set: async () => {},
              get: async () => ({ exists: true, data: () => ({ entries: [{ content: CANARY_TOKEN }] }) }),
            }),
          }),
        }),
      }),
    };
  }
  function makeNullEntriesDb() {
    return {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              set: async () => {},
              get: async () => ({ exists: true, data: () => ({ entries: null }) }),
            }),
          }),
        }),
      }),
    };
  }
  function makeThrowDb() {
    return {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({
              set: async () => {},
              get: async () => { throw new Error('db crash'); },
            }),
          }),
        }),
      }),
    };
  }

  test('snap.exists=true, entries=[canary] -> leak=true (55-61)', async () => {
    setIsolDb(makeLeakDb());
    const r = await checkIsolation(UID_A, UID_B, PHONE);
    expect(r.leak).toBe(true);
    expect(r.details).toContain('LEAK');
  });
  test('snap.exists=true, entries=null -> no leak (56 FALSE branch, 62-63)', async () => {
    setIsolDb(makeNullEntriesDb());
    const r = await checkIsolation(UID_A, UID_B, PHONE);
    expect(r.leak).toBe(false);
  });
  test('get() throws -> catch branch (69-70)', async () => {
    setIsolDb(makeThrowDb());
    const r = await checkIsolation(UID_A, UID_B, PHONE);
    expect(r.leak).toBe(false);
    expect(r.details).toContain('Error en lectura');
  });
  test('runIsolationSuite leak=true -> console.error CRITICAL (89)', async () => {
    setIsolDb(makeLeakDb());
    const r = await runIsolationSuite(UID_A, UID_B, PHONE);
    expect(r.leak).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('CRITICAL LEAK'));
  });
});
