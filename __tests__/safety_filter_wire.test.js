'use strict';

/**
 * Tests integration safety_filter wire-in — C-410.b PASO 6.
 *
 * NO carga TMH completo (zona crítica §5 — riesgo importar 5000+ líneas).
 * En su lugar, simula la lógica del wire-in con harness que reproduce el
 * mismo flow control: detectar sensibilidad → resolver action → ejecutar
 * branch correcto.
 *
 * Cubre 17 cases:
 *  §1 Guards 4 (self-chat, group, fromMe, sfDisabled)
 *  §2 Action block (skip + exclude + alert + throttle)
 *  §3 Action log_warn (continue + flag + alert)
 *  §4 Action log_only (continue + flag + sin alert)
 *  §5 Action disabled per category (no-op)
 *  §6 Response excluded_from_training inherited
 *  §7 Throttle dedup acts uid+phone+category
 *  §8 Audio transcribed pasa por filtro
 *  §9 Fallback contactName lookup error
 */

jest.mock('firebase-admin', () => {
  const setMock = jest.fn().mockResolvedValue();
  const addMock = jest.fn();
  const getMock = jest.fn();

  const docRef = {
    set: setMock,
    get: getMock,
    collection: jest.fn(() => ({
      add: addMock,
      doc: jest.fn(() => docRef),
    })),
  };

  const colRef = {
    doc: jest.fn(() => docRef),
    add: addMock,
  };

  return {
    app: jest.fn(() => ({ name: 'test-app' })),
    firestore: jest.fn(() => ({
      collection: jest.fn(() => colRef),
    })),
    __mocks: { setMock, addMock, getMock },
  };
});

const admin = require('firebase-admin');
const safetyFilter = require('../core/safety_filter');
const consentRoutes = require('../routes/consent');

// ─── Harness: simula la lógica del wire-in TMH PASO 4.5 ────────────────
async function wireInSimulation({
  ownerUid,
  basePhone,
  phone,
  messageBody,
  isSelfChat = false,
  isGroup = false,
  isFromMe = false,
  isTranscribedAudio = false,
  transcription = null,
  ownerJid = '573054169969@s.whatsapp.net',
  leadName = null,
  contactIndexLookupError = false,
}) {
  const messageContext = { isTranscribedAudio, transcription };
  const sendFnMock = jest.fn().mockResolvedValue();

  // Simula los guards del wire-in
  if (isSelfChat || isGroup || isFromMe) {
    return { skipped: true, reason: 'guard', messageContext, sendFnMock, blockReturn: false };
  }

  const sfEnabled = await safetyFilter.isSafetyFilterEnabledForUid(ownerUid);
  if (!sfEnabled) {
    return { skipped: true, reason: 'sf_disabled', messageContext, sendFnMock, blockReturn: false };
  }

  const bodyToCheck = isTranscribedAudio ? (transcription || messageBody) : messageBody;
  const classif = safetyFilter.classifyMessageSensitivity(bodyToCheck);
  if (!classif) {
    return { skipped: true, reason: 'no_match', messageContext, sendFnMock, blockReturn: false };
  }

  const catCfg = await safetyFilter.getCategoryConfig(ownerUid, classif.category);
  if (!catCfg.enabled) {
    return { skipped: true, reason: 'category_disabled', classif, messageContext, sendFnMock, blockReturn: false };
  }

  const action = catCfg.action;
  let contactName = leadName;
  if (!contactName && !contactIndexLookupError) {
    // Simula lookupContactIndex success path → no devuelve nombre
    contactName = null;
  }

  const incidentId = await safetyFilter.recordSafetyIncident(
    ownerUid, basePhone, classif, bodyToCheck, action, contactName
  );

  if (action === 'block') {
    await consentRoutes.addExclusionInternal(ownerUid, basePhone, {
      reason: 'sensitive_data_auto', source: 'safety_filter', category: classif.category, incidentId,
    });
    if (safetyFilter.shouldAlertOwner(ownerUid, basePhone, classif.category) && ownerJid) {
      await safetyFilter.sendOwnerSafetyAlert({
        uid: ownerUid, ownerSelfJid: ownerJid, contactPhoneE164: `+${basePhone}`,
        classification: classif, action, contactName: contactName || 'anónimo',
        incidentId, sendFn: sendFnMock,
      });
    }
    return { skipped: false, action, classif, incidentId, messageContext, sendFnMock, blockReturn: true };
  }

  if (action === 'log_warn' || action === 'log_only') {
    messageContext.excluded_from_training = true;
    if (action === 'log_warn' && safetyFilter.shouldAlertOwner(ownerUid, basePhone, classif.category) && ownerJid) {
      await safetyFilter.sendOwnerSafetyAlert({
        uid: ownerUid, ownerSelfJid: ownerJid, contactPhoneE164: `+${basePhone}`,
        classification: classif, action, contactName: contactName || 'anónimo',
        incidentId, sendFn: sendFnMock,
      });
    }
    return { skipped: false, action, classif, incidentId, messageContext, sendFnMock, blockReturn: false };
  }

  return { skipped: true, reason: 'unknown_action', messageContext, sendFnMock, blockReturn: false };
}

// ─── Helpers ────────────────────────────────────────────────────────────
function mockEnabled(action = { salud: 'block' }) {
  // Build categories config from action map
  const categories = {};
  for (const cat of safetyFilter.CATEGORIES) {
    categories[cat] = { enabled: action[cat] !== 'disabled', action: action[cat] || 'disabled' };
  }
  admin.__mocks.getMock.mockResolvedValue({
    exists: true,
    data: () => ({ safety_filter_config: { enabled: true, categories } }),
  });
}

function mockDisabled() {
  admin.__mocks.getMock.mockResolvedValue({
    exists: true,
    data: () => ({ safety_filter_config: { enabled: false, categories: {} } }),
  });
}

beforeEach(() => {
  Object.values(admin.__mocks).forEach((m) => m.mockReset && m.mockReset());
  admin.__mocks.setMock.mockResolvedValue();
  admin.__mocks.addMock.mockImplementation(() => Promise.resolve({ id: `inc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }));
  safetyFilter._resetCaches();
});

// ════════════════════════════════════════════════════════════════════════
// §1 — Guards (4 cases)
// ════════════════════════════════════════════════════════════════════════

describe('§1 Guards', () => {
  test('case 1 — isSelfChat → skip safety filter', async () => {
    mockEnabled({ salud: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: '573054169969@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico', isSelfChat: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('guard');
    expect(r.blockReturn).toBe(false);
  });

  test('case 2 — isGroup (@g.us) → skip', async () => {
    mockEnabled({ salud: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: '120363xxxxx@g.us',
      messageBody: 'Tengo un diagnóstico complicado', isGroup: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('guard');
  });

  test('case 3 — isFromMe → skip (msg del owner no se filtra)', async () => {
    mockEnabled({ salud: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: '573054169969@s.whatsapp.net',
      messageBody: 'Le explico el diagnóstico al lead', isFromMe: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('guard');
  });

  test('case 4 — safety filter disabled at owner level → skip', async () => {
    mockDisabled();
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: '573054169969@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('sf_disabled');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 — Action BLOCK (skip + exclude + alert + throttle) — 4 cases
// ════════════════════════════════════════════════════════════════════════

describe('§2 Action block', () => {
  test('case 5 — finanzas detectada → block: incident + exclude + alert + return true', async () => {
    mockEnabled({ finanzas: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: '573054169969@s.whatsapp.net',
      messageBody: 'Mi número de tarjeta es 4532015112830366',
    });
    expect(r.action).toBe('block');
    expect(r.classif.category).toBe('finanzas');
    expect(r.incidentId).toBeTruthy();
    expect(r.blockReturn).toBe(true);
    expect(admin.__mocks.addMock).toHaveBeenCalled(); // safety_incident creado
    expect(admin.__mocks.setMock).toHaveBeenCalled(); // exclusion + ownerNotifiedAt
    expect(r.sendFnMock).toHaveBeenCalledTimes(1); // alert
  });

  test('case 6 — menores detectada → block + alert', async () => {
    mockEnabled({ menores: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Es menor de edad, no puede firmar contrato',
    });
    expect(r.action).toBe('block');
    expect(r.classif.category).toBe('menores');
    expect(r.blockReturn).toBe(true);
  });

  test('case 7 — credenciales detectada → block', async () => {
    mockEnabled({ credenciales: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Mi password: secretkey123abc',
    });
    expect(r.action).toBe('block');
    expect(r.classif.category).toBe('credenciales');
    expect(r.blockReturn).toBe(true);
  });

  test('case 8 — second block para mismo phone+cat → throttle: NO segundo alert', async () => {
    mockEnabled({ salud: 'block' });
    // primer block — alert se envía
    const r1 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico médico',
    });
    expect(r1.sendFnMock).toHaveBeenCalledTimes(1);
    // segundo block — alert NO se envía (throttle)
    const r2 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Otro mensaje con tratamiento',
    });
    expect(r2.action).toBe('block');
    expect(r2.sendFnMock).toHaveBeenCalledTimes(0); // primer call sería del PROPIO sendFnMock de r2 (nuevo mock)
    // Lo importante: el throttle global no permite 2do alert para misma combinación
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 — Action LOG_WARN (continue + flag + alert) — 3 cases
// ════════════════════════════════════════════════════════════════════════

describe('§3 Action log_warn', () => {
  test('case 9 — salud + log_warn: continúa pipeline, flag set, alert sí', async () => {
    mockEnabled({ salud: 'log_warn' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico médico',
    });
    expect(r.action).toBe('log_warn');
    expect(r.classif.category).toBe('salud');
    expect(r.blockReturn).toBe(false); // pipeline continúa
    expect(r.messageContext.excluded_from_training).toBe(true); // flag set
    expect(r.sendFnMock).toHaveBeenCalledTimes(1); // alert sí
  });

  test('case 10 — judicial general (sin violencia) + log_warn → flag set', async () => {
    mockEnabled({ judicial: 'log_warn' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Estoy hablando con mi abogado por el contrato',
    });
    expect(r.action).toBe('log_warn');
    expect(r.classif.severity).toBe('MEDIA');
    expect(r.messageContext.excluded_from_training).toBe(true);
  });

  test('case 11 — log_warn throttle: 2do msg misma cat+phone → no alert pero flag sí', async () => {
    mockEnabled({ salud: 'log_warn' });
    await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Diagnóstico inicial',
    });
    const r2 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Necesito tratamiento',
    });
    expect(r2.messageContext.excluded_from_training).toBe(true);
    expect(r2.sendFnMock).toHaveBeenCalledTimes(0); // throttle bloquea
  });
});

// ════════════════════════════════════════════════════════════════════════
// §4 — Action LOG_ONLY (continue + flag + SIN alert) — 1 case
// ════════════════════════════════════════════════════════════════════════

describe('§4 Action log_only', () => {
  test('case 12 — log_only: pipeline continúa, flag set, NO alert', async () => {
    mockEnabled({ salud: 'log_only' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico médico',
    });
    expect(r.action).toBe('log_only');
    expect(r.blockReturn).toBe(false);
    expect(r.messageContext.excluded_from_training).toBe(true);
    expect(r.sendFnMock).toHaveBeenCalledTimes(0); // sin alert
  });
});

// ════════════════════════════════════════════════════════════════════════
// §5 — Category DISABLED (no-op) — 1 case
// ════════════════════════════════════════════════════════════════════════

describe('§5 Category disabled', () => {
  test('case 13 — categoría disabled aunque sf enabled → no-op para esa cat', async () => {
    mockEnabled({ salud: 'disabled' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico médico',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('category_disabled');
    expect(r.classif?.category).toBe('salud');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §6 — No match — 1 case
// ════════════════════════════════════════════════════════════════════════

describe('§6 No match', () => {
  test('case 14 — mensaje normal sin sensibilidad → no_match (no skip por flag)', async () => {
    mockEnabled({ salud: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Hola, vi tu publicidad de MIIA, me interesa',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_match');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §7 — Audio transcribed (m8 voz) — 1 case
// ════════════════════════════════════════════════════════════════════════

describe('§7 Audio transcribed', () => {
  test('case 15 — audio transcrito con info sensible dispara filtro', async () => {
    mockEnabled({ salud: 'block' });
    const r = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: '[audio]',
      isTranscribedAudio: true,
      transcription: 'Necesito un diagnóstico urgente para mi madre',
    });
    expect(r.action).toBe('block');
    expect(r.classif?.category).toBe('salud');
  });
});

// ════════════════════════════════════════════════════════════════════════
// §8 — Throttle dedup acts uid+phone+category — 2 cases
// ════════════════════════════════════════════════════════════════════════

describe('§8 Throttle granularidad', () => {
  test('case 16 — distinta categoría misma phone → alert nuevo', async () => {
    mockEnabled({ salud: 'log_warn', finanzas: 'log_warn' });
    const r1 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico',
    });
    const r2 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'x@s.whatsapp.net',
      messageBody: 'Mi cuenta bancaria está en problemas',
    });
    expect(r1.classif.category).toBe('salud');
    expect(r2.classif.category).toBe('finanzas');
    expect(r1.sendFnMock).toHaveBeenCalledTimes(1);
    expect(r2.sendFnMock).toHaveBeenCalledTimes(1); // distinta cat → nuevo alert
  });

  test('case 17 — distinto phone misma categoría → alert nuevo', async () => {
    mockEnabled({ salud: 'log_warn' });
    const r1 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573054169969', phone: 'a@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico',
    });
    const r2 = await wireInSimulation({
      ownerUid: 'uid_x', basePhone: '573163937365', phone: 'b@s.whatsapp.net',
      messageBody: 'Necesito un diagnóstico también',
    });
    expect(r1.sendFnMock).toHaveBeenCalledTimes(1);
    expect(r2.sendFnMock).toHaveBeenCalledTimes(1); // distinto phone → nuevo alert
  });
});

// ════════════════════════════════════════════════════════════════════════
// §9 — MINING FILTER (corpus ADN excluye msgs sensibles) — 4 cases
// ════════════════════════════════════════════════════════════════════════

/**
 * Simula la lógica del mining filter en tenant_manager.js:2703.
 * Recibe array de msgs Baileys-shape y retorna chatLog filtrado
 * (mismo flow control que el código real).
 */
function miningFilterSimulation(allMsgs) {
  return allMsgs.map(m => {
    const body = m.message?.conversation
      || m.message?.extendedTextMessage?.text
      || m.message?.imageMessage?.caption
      || '';
    if (!body.trim()) return null;
    try {
      if (safetyFilter.classifyMessageSensitivity(body)) return null;
    } catch (_) {
      return null;
    }
    return `${m.key?.fromMe ? 'VENDEDOR' : 'CONTACTO'}: ${body.replace(/\n/g, ' ')}`;
  }).filter(Boolean).join('\n');
}

describe('§9 Mining filter (Opción A — absoluto, independiente de config)', () => {
  test('case 18 — msgs sin sensibilidad SÍ entran al chatLog', () => {
    const allMsgs = [
      { key: { fromMe: false }, message: { conversation: 'Hola, vi tu publi de MIIA' } },
      { key: { fromMe: true },  message: { conversation: 'Genial, contame qué necesitás' } },
      { key: { fromMe: false }, message: { conversation: 'Quiero probar el demo' } },
    ];
    const chatLog = miningFilterSimulation(allMsgs);
    expect(chatLog).toContain('CONTACTO: Hola, vi tu publi de MIIA');
    expect(chatLog).toContain('VENDEDOR: Genial, contame qué necesitás');
    expect(chatLog).toContain('CONTACTO: Quiero probar el demo');
    // 3 entries esperadas
    expect(chatLog.split('\n')).toHaveLength(3);
  });

  test('case 19 — msgs con jerga sensible NO entran (mix)', () => {
    const allMsgs = [
      { key: { fromMe: false }, message: { conversation: 'Hola, vi tu publi de MIIA' } },
      { key: { fromMe: false }, message: { conversation: 'Mi password: secret123abc' } }, // sensible (creds)
      { key: { fromMe: true },  message: { conversation: 'Genial, contame qué necesitás' } },
      { key: { fromMe: false }, message: { conversation: 'Necesito un diagnóstico médico' } }, // sensible (salud)
      { key: { fromMe: false }, message: { conversation: 'Quiero el demo' } },
    ];
    const chatLog = miningFilterSimulation(allMsgs);
    expect(chatLog).toContain('Hola, vi tu publi');
    expect(chatLog).toContain('Genial, contame');
    expect(chatLog).toContain('Quiero el demo');
    // Sensibles excluidos
    expect(chatLog).not.toContain('password');
    expect(chatLog).not.toContain('secret123');
    expect(chatLog).not.toContain('diagnóstico');
    // 3 entries esperadas (de 5 originales — 2 filtrados)
    expect(chatLog.split('\n')).toHaveLength(3);
  });

  test('case 20 — TODOS sensibles → chatLog vacío', () => {
    const allMsgs = [
      { key: { fromMe: false }, message: { conversation: 'Mi número de tarjeta es 4532015112830366' } },
      { key: { fromMe: false }, message: { conversation: 'Es menor de edad, no puede firmar' } },
      { key: { fromMe: false }, message: { conversation: 'Estoy hablando con mi abogado por amenaza' } },
    ];
    const chatLog = miningFilterSimulation(allMsgs);
    expect(chatLog).toBe('');
  });

  test('case 21 — body undefined / msg vacío NO crashea (fail-safe)', () => {
    const allMsgs = [
      { key: { fromMe: false }, message: {} }, // sin body
      { key: { fromMe: false }, message: null }, // null
      { key: { fromMe: false }, message: { conversation: '' } }, // empty string
      { key: { fromMe: false }, message: { conversation: 'Mensaje normal' } },
    ];
    expect(() => miningFilterSimulation(allMsgs)).not.toThrow();
    const chatLog = miningFilterSimulation(allMsgs);
    expect(chatLog).toContain('Mensaje normal');
    expect(chatLog.split('\n')).toHaveLength(1);
  });

  test('case 22 — Opción A absoluta: filtra independiente de config per-category', () => {
    // Importante: el mining NO consulta config — filtra TODO lo sensible.
    // Si owner tiene salud=disabled en runtime, mining igual excluye salud del corpus.
    // (Verificación conceptual: classifyMessageSensitivity es pure function, no consulta config)
    mockEnabled({ salud: 'disabled' });
    const allMsgs = [
      { key: { fromMe: false }, message: { conversation: 'Necesito tratamiento médico urgente' } },
    ];
    const chatLog = miningFilterSimulation(allMsgs);
    expect(chatLog).toBe(''); // excluido aunque categoría disabled en config
  });
});
