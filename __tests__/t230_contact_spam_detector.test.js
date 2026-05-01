'use strict';

const {
  analyzeContact, shouldSendAlert, recordAlertSent, checkAndAlert,
  buildSpamAlertMessage, detectKeywords, detectRapidFire, detectIdenticalContent,
  computeSimilarity, isValidSignal,
  SPAM_SIGNALS, SPAM_KEYWORDS, ALERT_COOLDOWN_MS, RAPID_FIRE_THRESHOLD, SIMILARITY_THRESHOLD,
  __setFirestoreForTests,
} = require('../core/contact_spam_detector');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';

function makeMockDb({ exists = false, lastAlertAt = null, throwGet = false, throwSet = false } = {}) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            set: async (data, opts) => { if (throwSet) throw new Error('set error'); },
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists, data: () => ({ lastAlertAt, alertCount: 1 }) };
            },
          }),
        }),
      }),
    }),
  };
}

function makeMessages(count, text, windowMs) {
  var win = windowMs || 30 * 1000;
  var now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    text: text || 'mensaje',
    timestamp: new Date(now - (count - i) * Math.floor(win / count)).toISOString(),
  }));
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('Constantes', () => {
  test('SPAM_SIGNALS tiene 7 senales', () => { expect(SPAM_SIGNALS.length).toBe(7); });
  test('frozen SPAM_SIGNALS', () => { expect(() => { SPAM_SIGNALS.push('x'); }).toThrow(); });
  test('ALERT_COOLDOWN_MS es 24h', () => { expect(ALERT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000); });
  test('RAPID_FIRE_THRESHOLD es 10', () => { expect(RAPID_FIRE_THRESHOLD).toBe(10); });
  test('SIMILARITY_THRESHOLD es 0.90', () => { expect(SIMILARITY_THRESHOLD).toBe(0.90); });
  test('SPAM_KEYWORDS es frozen', () => { expect(() => { SPAM_KEYWORDS.push('x'); }).toThrow(); });
});

describe('isValidSignal', () => {
  test('rapid_fire es valida', () => { expect(isValidSignal('rapid_fire')).toBe(true); });
  test('spam_signal es invalida', () => { expect(isValidSignal('spam_signal')).toBe(false); });
});

describe('detectKeywords', () => {
  test('detecta keyword spam', () => {
    const r = detectKeywords('Ganaste un premio gratis click aqui');
    expect(r.length).toBeGreaterThan(0);
    expect(r).toContain('ganaste');
  });
  test('no detecta texto limpio', () => {
    expect(detectKeywords('Hola como estas')).toEqual([]);
  });
  test('retorna array vacio si text null', () => {
    expect(detectKeywords(null)).toEqual([]);
  });
  test('es case insensitive', () => {
    expect(detectKeywords('GRATIS para vos')).toContain('gratis');
  });
});

describe('detectRapidFire', () => {
  test('detecta rafaga con 10+ mensajes en 1 minuto', () => {
    const msgs = makeMessages(12, 'hola', 30 * 1000);
    expect(detectRapidFire(msgs)).toBe(true);
  });
  test('no detecta rafaga con menos de 10 mensajes', () => {
    const msgs = makeMessages(5, 'hola', 30 * 1000);
    expect(detectRapidFire(msgs)).toBe(false);
  });
  test('retorna false si array vacio', () => {
    expect(detectRapidFire([])).toBe(false);
  });
  test('retorna false si no es array', () => {
    expect(detectRapidFire(null)).toBe(false);
  });
});

describe('detectIdenticalContent', () => {
  test('detecta mensajes identicos', () => {
    const msgs = [{ text: 'Hola quiero info' }, { text: 'Hola quiero info' }];
    expect(detectIdenticalContent(msgs)).toBe(true);
  });
  test('no detecta mensajes distintos', () => {
    const msgs = [{ text: 'Hola' }, { text: 'Buenos dias, necesito ayuda con mi pedido' }];
    expect(detectIdenticalContent(msgs)).toBe(false);
  });
  test('retorna false para menos de 2 mensajes', () => {
    expect(detectIdenticalContent([{ text: 'Hola' }])).toBe(false);
  });
});

describe('computeSimilarity', () => {
  test('texto identico retorna 1', () => {
    expect(computeSimilarity('hola', 'hola')).toBe(1);
  });
  test('texto vacio retorna 0', () => {
    expect(computeSimilarity('', 'hola')).toBe(0);
  });
  test('textos muy distintos tienen baja similitud', () => {
    expect(computeSimilarity('abcdefghij', 'xyz')).toBeLessThan(0.5);
  });
});

describe('analyzeContact', () => {
  test('lanza si phone undefined', () => {
    expect(() => analyzeContact(undefined, [])).toThrow('phone requerido');
  });
  test('no spam para mensajes normales', () => {
    const msgs = [{ text: 'Hola quiero precio', timestamp: new Date().toISOString() }];
    const r = analyzeContact(PHONE, msgs);
    expect(r.isSpam).toBe(false);
    expect(r.phone).toBe(PHONE);
  });
  test('detecta spam por keywords', () => {
    const msgs = [{ text: 'Ganaste gratis criptomoneda inversion garantizada', timestamp: new Date().toISOString() }];
    const r = analyzeContact(PHONE, msgs);
    expect(r.isSpam).toBe(true);
    expect(r.signals).toContain('keyword_match');
    expect(r.severity).toBe('high');
  });
  test('detecta spam por rafaga', () => {
    const msgs = makeMessages(12, 'Hola');
    const r = analyzeContact(PHONE, msgs);
    expect(r.isSpam).toBe(true);
    expect(r.signals).toContain('rapid_fire');
  });
  test('unknown_number agrega senal', () => {
    const r = analyzeContact(PHONE, [], { isUnknown: true });
    expect(r.signals).toContain('unknown_number');
  });
  test('analyzedAt esta definido', () => {
    const r = analyzeContact(PHONE, []);
    expect(r.analyzedAt).toBeDefined();
  });
});

describe('shouldSendAlert', () => {
  test('lanza si uid undefined', async () => {
    await expect(shouldSendAlert(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(shouldSendAlert(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('retorna true si no hay alerta previa', async () => {
    __setFirestoreForTests(makeMockDb({ exists: false }));
    expect(await shouldSendAlert(UID, PHONE)).toBe(true);
  });
  test('retorna false si alerta reciente', async () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ exists: true, lastAlertAt: recent }));
    expect(await shouldSendAlert(UID, PHONE)).toBe(false);
  });
  test('retorna true si alerta vieja (mas de 24h)', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ exists: true, lastAlertAt: old }));
    expect(await shouldSendAlert(UID, PHONE)).toBe(true);
  });
  test('fail-open retorna true si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await shouldSendAlert(UID, PHONE)).toBe(true);
  });
});

describe('recordAlertSent', () => {
  test('lanza si uid undefined', async () => {
    await expect(recordAlertSent(undefined, PHONE, {})).rejects.toThrow('uid requerido');
  });
  test('registra sin error', async () => {
    __setFirestoreForTests(makeMockDb());
    await expect(recordAlertSent(UID, PHONE, {})).resolves.toBeUndefined();
  });
});

describe('checkAndAlert', () => {
  test('lanza si uid undefined', async () => {
    await expect(checkAndAlert(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('no alerta si no es spam', async () => {
    __setFirestoreForTests(makeMockDb({ exists: false }));
    const r = await checkAndAlert(UID, PHONE, [{ text: 'Hola' }]);
    expect(r.alerted).toBe(false);
  });
  test('alerta si es spam y no hay cooldown', async () => {
    __setFirestoreForTests(makeMockDb({ exists: false }));
    const msgs = makeMessages(12, 'ganaste gratis inversion garantizada');
    const r = await checkAndAlert(UID, PHONE, msgs);
    expect(r.alerted).toBe(true);
    expect(r.analysis.isSpam).toBe(true);
  });
  test('no alerta si cooldown activo', async () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    __setFirestoreForTests(makeMockDb({ exists: true, lastAlertAt: recent }));
    const msgs = makeMessages(12, 'ganaste gratis inversion garantizada');
    const r = await checkAndAlert(UID, PHONE, msgs);
    expect(r.alerted).toBe(false);
    expect(r.reason).toContain('cooldown');
  });
});

describe('buildSpamAlertMessage', () => {
  test('incluye phone y razones', () => {
    const analysis = {
      severity: 'high',
      reasons: ['Mensajes en rafaga', 'Keyword spam'],
    };
    const msg = buildSpamAlertMessage(PHONE, analysis);
    expect(msg).toContain(PHONE);
    expect(msg).toContain('Mensajes en rafaga');
    expect(msg).toContain('ALERTA');
  });
  test('medium usa AVISO', () => {
    const msg = buildSpamAlertMessage(PHONE, { severity: 'medium', reasons: ['test'] });
    expect(msg).toContain('AVISO');
  });
});
