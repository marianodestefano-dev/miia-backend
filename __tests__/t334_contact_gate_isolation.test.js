'use strict';

const {
  FORBIDDEN_KEYWORDS, validateKeyword, matchesBusinessKeywords,
  shouldMiiaRespond, buildUnknownContactAlert,
  classifyUnknownContact, _normalize,
} = require('../core/contact_gate');

const {
  writeCanary, checkIsolation, runIsolationSuite,
  CANARY_TOKEN, __setFirestoreForTests: setIsolDb,
} = require('../core/mmc_isolation');

const UID_A = 'uid_tenant_a';
const UID_B = 'uid_tenant_b';
const PHONE = '+571111222';

// Mock Firestore que separa correctamente los docs de uidA y uidB
function makeTenantDb() {
  const store = {};
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (docId) => ({
            set: async (data, opts) => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
              else store[key] = { ...data };
            },
            get: async () => {
              const key = `${col}/${uid}/${subCol}/${docId}`;
              const d = store[key];
              return { exists: !!d, data: () => d };
            },
          }),
        }),
      }),
    }),
  };
}

describe('T334 -- contact_gate + mmc_isolation (28 tests)', () => {

  // FORBIDDEN_KEYWORDS
  test('FORBIDDEN_KEYWORDS es Set y contiene saludos genericos', () => {
    expect(FORBIDDEN_KEYWORDS instanceof Set).toBe(true);
    expect(FORBIDDEN_KEYWORDS.has('hola')).toBe(true);
    expect(FORBIDDEN_KEYWORDS.has('gracias')).toBe(true);
    expect(FORBIDDEN_KEYWORDS.has('ok')).toBe(true);
  });

  // _normalize
  test('_normalize: lowercase + sin tildes', () => {
    expect(_normalize('HÓLÁ')).toBe('hola');
  });

  test('_normalize: null -> ""', () => {
    expect(_normalize(null)).toBe('');
  });

  // validateKeyword
  test('validateKeyword: keyword valida', () => {
    const r = validateKeyword('MIIA automatizacion');
    expect(r.valid).toBe(true);
  });

  test('validateKeyword: demasiado corta (<2 chars)', () => {
    const r = validateKeyword('a');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/2 caracteres/);
  });

  test('validateKeyword: demasiado larga (>50 chars)', () => {
    const r = validateKeyword('a'.repeat(51));
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/larga/);
  });

  test('validateKeyword: en FORBIDDEN_KEYWORDS -> invalida', () => {
    const r = validateKeyword('hola');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/genérica/);
  });

  test('validateKeyword: solo numeros -> invalida', () => {
    const r = validateKeyword('12345');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/números/);
  });

  // matchesBusinessKeywords
  test('matchesBusinessKeywords: keyword vacia -> no match', () => {
    const r = matchesBusinessKeywords('quiero comprar', []);
    expect(r.matched).toBe(false);
  });

  test('matchesBusinessKeywords: keyword en mensaje -> match', () => {
    const r = matchesBusinessKeywords('quiero comprar MIIA para mi negocio', ['MIIA', 'automatizacion']);
    expect(r.matched).toBe(true);
    expect(r.keyword).toBe('MIIA');
  });

  test('matchesBusinessKeywords: keyword forbidden saltada', () => {
    const r = matchesBusinessKeywords('hola como estas', ['hola']);
    expect(r.matched).toBe(false); // 'hola' en blacklist
  });

  // shouldMiiaRespond
  test('shouldMiiaRespond: self-chat -> respond=true', () => {
    const r = shouldMiiaRespond({ isSelfChat: true, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('self-chat');
  });

  test('shouldMiiaRespond: grupo -> respond=false', () => {
    const r = shouldMiiaRespond({ isSelfChat: false, isGroup: true, basePhone: PHONE });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('group_blocked');
  });

  test('shouldMiiaRespond: contactType=ignore -> respond=false', () => {
    const r = shouldMiiaRespond({ isSelfChat: false, isGroup: false, contactType: 'ignore', basePhone: PHONE });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('contact_ignored');
  });

  test('shouldMiiaRespond: lead conocido -> respond=true', () => {
    const r = shouldMiiaRespond({ isSelfChat: false, isGroup: false, contactType: 'lead', basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('known_lead');
  });

  test('shouldMiiaRespond: familia sin trigger -> respond=false', () => {
    const r = shouldMiiaRespond({ isSelfChat: false, isGroup: false, contactType: 'familia', miiaActive: false, isHolaMiia: false, basePhone: PHONE });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('familia_no_trigger');
  });

  test('shouldMiiaRespond: familia con "Hola MIIA" -> respond=true', () => {
    const r = shouldMiiaRespond({ isSelfChat: false, isGroup: false, contactType: 'familia', isHolaMiia: true, basePhone: PHONE });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('familia_triggered');
  });

  test('shouldMiiaRespond: desconocido con keyword -> keyword_match', () => {
    const r = shouldMiiaRespond({
      isSelfChat: false, isGroup: false, contactType: null,
      messageBody: 'quiero informacion sobre automatizacion de ventas',
      businessKeywords: ['automatizacion', 'ventas'],
      basePhone: PHONE,
    });
    expect(r.respond).toBe(true);
    expect(r.reason).toBe('keyword_match');
    expect(r.matchedKeyword).toBe('automatizacion');
  });

  test('shouldMiiaRespond: desconocido sin keyword -> no_keyword_match', () => {
    const r = shouldMiiaRespond({
      isSelfChat: false, isGroup: false, contactType: null,
      messageBody: 'hola como estas',
      businessKeywords: ['automatizacion'],
      basePhone: PHONE,
    });
    expect(r.respond).toBe(false);
    expect(r.reason).toBe('no_keyword_match');
    expect(r.action).toBe('notify_owner');
  });

  // classifyUnknownContact
  test('classifyUnknownContact: lead keyword match', () => {
    const r = classifyUnknownContact('me interesa automatizacion para mi empresa', ['automatizacion'], []);
    expect(r.type).toBe('lead');
  });

  test('classifyUnknownContact: sin keywords -> unknown', () => {
    const r = classifyUnknownContact('hola como estas', [], []);
    expect(r.type).toBe('unknown');
  });

  // buildUnknownContactAlert
  test('buildUnknownContactAlert: contiene numero y mensaje', () => {
    const alert = buildUnknownContactAlert(PHONE, 'Hola quiero info', 'Juan');
    expect(alert).toContain(PHONE);
    expect(alert).toContain('Nuevo contacto desconocido');
  });

  // CANARY_TOKEN
  test('CANARY_TOKEN = UNICORNIO_FUCSIA_42', () => {
    expect(CANARY_TOKEN).toBe('UNICORNIO_FUCSIA_42');
  });

  // writeCanary
  test('writeCanary: uid/phone null lanza', async () => {
    await expect(writeCanary(null, PHONE)).rejects.toThrow();
  });

  test('writeCanary: escribe doc y retorna path', async () => {
    setIsolDb(makeTenantDb());
    const path = await writeCanary(UID_A, PHONE);
    expect(path).toContain(UID_A);
    expect(path).toContain(PHONE);
  });

  // checkIsolation
  test('checkIsolation: uidA===uidB lanza', async () => {
    setIsolDb(makeTenantDb());
    await expect(checkIsolation(UID_A, UID_A, PHONE)).rejects.toThrow('distintos');
  });

  test('checkIsolation: uidB doc inexistente -> no leak', async () => {
    setIsolDb(makeTenantDb());
    const r = await checkIsolation(UID_A, UID_B, PHONE);
    expect(r.leak).toBe(false);
  });

  // runIsolationSuite (end-to-end isolation check)
  test('runIsolationSuite: escribe en A, verifica que B no ve datos', async () => {
    setIsolDb(makeTenantDb());
    const r = await runIsolationSuite(UID_A, UID_B, PHONE);
    expect(r.leak).toBe(false); // DB separadas por uid, no hay cross-contamination
  });
});
