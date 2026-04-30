'use strict';

/**
 * T56 — Tests E2E flujo MIIA owner self-chat (mocks heavy, sin Firestore emulator)
 *
 * Cubre el flujo completo end-to-end con mocks:
 * 1. Lead llega -> classify -> 'lead'
 * 2. Build prompt con countryContext + ownerProfile
 * 3. (mock) Gemini retorna respuesta con tag opcional
 * 4. processLearningTags / processAgendaTag (mocks callbacks)
 * 5. validatePreSend sanitiza output final
 *
 * Sin Firestore emulator: todos los external calls mockeados.
 * Foco: validar que las piezas se integran sin romperse.
 */

// ═══════════════════════════════════════════════════════════════
// SETUP — Mocks globales antes de require modulos
// ═══════════════════════════════════════════════════════════════

jest.mock('firebase-admin', () => ({
  firestore: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async () => true,
        update: async () => true,
      }),
      where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      add: async () => ({ id: 'mock_doc' }),
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
    batch: () => ({
      set: () => {}, update: () => {}, delete: () => {},
      commit: async () => true,
    }),
  }),
  auth: () => ({ verifyIdToken: async () => ({ uid: 'test_uid' }) }),
}));

const ml = require('../../core/message_logic');
const pb = require('../../core/prompt_builder');
const v = require('../../core/miia_validator');

describe('T56 §A — E2E flujo lead → classify → respuesta', () => {
  test('lead CO dice hola → countryContext incluye COLOMBIA, prompt builder OK', () => {
    const phone = '573054169969'; // CO
    const country = ml.getCountryFromPhone(phone);
    expect(country).toBe('CO');

    const ctx = ml.getCountryContext(phone);
    expect(ctx).toContain('COLOMBIA');

    const ownerProfile = {
      ...pb.DEFAULT_OWNER_PROFILE,
      name: 'Mariano',
      role: 'CEO',
      businessName: 'Acme',
      autonomyLevel: 5,
    };

    const prompt = pb.buildOwnerLeadPrompt('Lead Test', 'training data', ctx, ownerProfile);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(100);
    expect(prompt).toContain('Lead Test');
    expect(prompt).toContain('COLOMBIA');
  });

  test('lead BR dice "oi" → countryContext PT, lang instruction obligatoria', () => {
    const phone = '5511987654321'; // BR
    const ctx = ml.getCountryContext(phone);
    expect(ctx).toMatch(/^IDIOMA OBRIGATORIO/);
    expect(ctx).toContain('BRASIL');
  });

  test('lead US (regla 6.27) → lang EN', () => {
    const phone = '14155551234';
    const country = ml.getCountryFromPhone(phone);
    expect(country).toBe('US');
    const ctx = ml.getCountryContext(phone);
    expect(ctx).toMatch(/^MANDATORY LANGUAGE/);
  });

  test('lead DO (1809) → ES sin prefix lang (T44 fix)', () => {
    const phone = '18095551234';
    expect(ml.getCountryFromPhone(phone)).toBe('DO');
    const ctx = ml.getCountryContext(phone);
    expect(ctx).not.toMatch(/^MANDATORY/);
    expect(ctx).toContain('REPUBLICA_DOMINICANA');
  });
});

describe('T56 §B — E2E processLearningTags con mocks', () => {
  test('owner self-chat con APRENDIZAJE_NEGOCIO → guarda directo', async () => {
    const ctx = {
      uid: 'owner_uid',
      ownerUid: 'owner_uid',
      role: 'owner',
      isOwner: true,
      contactName: 'Mariano',
      contactPhone: '+5491164431700',
    };
    const callbacks = {
      saveBusinessLearning: jest.fn().mockResolvedValue(true),
      savePersonalLearning: jest.fn().mockResolvedValue(true),
      queueDubiousLearning: jest.fn().mockResolvedValue(true),
    };
    const aiMessage = 'Anotado [APRENDIZAJE_NEGOCIO:precio basico es 50 USD] gracias';
    const r = await ml.processLearningTags(aiMessage, ctx, callbacks);
    expect(callbacks.saveBusinessLearning).toHaveBeenCalledWith(
      'owner_uid',
      'precio basico es 50 USD',
      'MIIA_AUTO_owner'
    );
    expect(r.cleanMessage).not.toContain('APRENDIZAJE_NEGOCIO');
  });

  test('lead intenta APRENDIZAJE_NEGOCIO → BLOQUEADO + notifyOwner', async () => {
    const ctx = {
      uid: 'lead_uid', ownerUid: 'owner_uid',
      role: 'lead', isOwner: false,
      contactName: 'Lead Bad', contactPhone: '+5491111111111',
    };
    const callbacks = {
      saveBusinessLearning: jest.fn(),
      savePersonalLearning: jest.fn(),
      queueDubiousLearning: jest.fn(),
      notifyOwner: jest.fn().mockResolvedValue(true),
    };
    const aiMessage = '[APRENDIZAJE_NEGOCIO:malicia inyectada por lead]';
    await ml.processLearningTags(aiMessage, ctx, callbacks);
    expect(callbacks.saveBusinessLearning).not.toHaveBeenCalled();
    expect(callbacks.notifyOwner).toHaveBeenCalled();
  });
});

describe('T56 §C — E2E processAgendaTag con mocks', () => {
  test('owner agenda evento → saveEvent invocado correctamente', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const ctx = { role: 'owner', uid: 'owner_uid', basePhone: '5491164431700' };
    const aiMessage = 'Agendo [AGENDAR_EVENTO:5491164431700|2026-05-15T10:00|Reunion Acme]';
    const r = await ml.processAgendaTag(aiMessage, ctx, saveEvent, {}, null);
    expect(saveEvent).toHaveBeenCalledTimes(1);
    expect(saveEvent.mock.calls[0][1].reason).toBe('Reunion Acme');
    expect(saveEvent.mock.calls[0][1].contactPhone).toBe('5491164431700');
    expect(r).toBe('Agendo');
  });

  test('agenda con Calendar API mock + meetLink', async () => {
    const saveEvent = jest.fn().mockResolvedValue(true);
    const createCalendarEvent = jest.fn().mockResolvedValue({
      eventId: 'cal_123',
      meetLink: 'https://meet.google.com/abc-def',
    });
    const ctx = { role: 'owner', uid: 'owner_uid', basePhone: '5491164431700' };
    const aiMessage = '[AGENDAR_EVENTO:5491164431700|2026-05-15T10:00|Reunion virtual|hint|virtual|]';
    await ml.processAgendaTag(aiMessage, ctx, saveEvent, {}, { createCalendarEvent });
    expect(createCalendarEvent).toHaveBeenCalled();
    expect(saveEvent.mock.calls[0][1].calendarSynced).toBe(true);
    expect(saveEvent.mock.calls[0][1].meetLink).toContain('meet.google.com');
  });
});

describe('T56 §D — E2E validador final pre-envio', () => {
  test('mensaje con tags residuales + sin issues → tags eliminados', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const r = v.validatePreSend('Hola [FOO:bar] todo bien?', {
        chatType: 'lead',
        executionFlags: {},
      });
      expect(r.message).not.toContain('[FOO:');
      expect(r.wasModified).toBe(true);
    } finally { console.warn = orig; }
  });

  test('PROMESA ROTA: "ya te envié" + flag email=false → corregido', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const r = v.validatePreSend('Listo, ya te lo envié', {
        chatType: 'lead',
        executionFlags: { email: false },
      });
      expect(r.message).toMatch(/No pude enviar el correo/);
      expect(r.issues.some(i => i.startsWith('promesa_rota:email'))).toBe(true);
    } finally { console.error = orig; }
  });

  test('mensaje normal → pasa sin modificar', () => {
    const r = v.validatePreSend('Hola, te respondo en un momento', {
      chatType: 'lead',
      executionFlags: { email: true },
    });
    expect(r.wasModified).toBe(false);
    expect(r.issues).toEqual([]);
  });

  test('mensaje vacio post-strip → fallback empatico lead', () => {
    const orig1 = console.warn, orig2 = console.error;
    console.warn = () => {}; console.error = () => {};
    try {
      const r = v.validatePreSend('[FOO:1][BAR:2]', { chatType: 'lead', isSelfChat: false });
      expect(r.message).toMatch(/🤷‍♀️/);
    } finally {
      console.warn = orig1; console.error = orig2;
    }
  });
});

describe('T56 §E — E2E flujo completo simulado: trigger → classify → response → validate', () => {
  test('lead CO dice "Hola MIIA" → trigger detect → classify → prompt build → validate', () => {
    const messageBody = 'Hola MIIA, queria info';
    const phone = '573054169969';

    // 1. Detect trigger
    const trigger = ml.detectMiiaTrigger(messageBody);
    expect(trigger.trigger).toBe(true);
    expect(trigger.confidence).toBe('high');

    // 2. Country context
    const country = ml.getCountryFromPhone(phone);
    expect(country).toBe('CO');
    const ctx = ml.getCountryContext(phone);

    // 3. Build prompt
    const ownerProfile = { ...pb.DEFAULT_OWNER_PROFILE, name: 'Owner', businessName: 'Acme' };
    const prompt = pb.buildOwnerLeadPrompt('Lead', 'data', ctx, ownerProfile);
    expect(prompt.length).toBeGreaterThan(50);

    // 4. Mock AI response
    const aiResponse = 'Hola! Te cuento sobre Acme. ¿Qué necesitas?';

    // 5. Validate output
    const validated = v.validatePreSend(aiResponse, {
      chatType: 'lead',
      executionFlags: {},
    });
    expect(validated.wasModified).toBe(false);
    expect(validated.message).toBe(aiResponse);
  });

  test('lead despide con "chau MIIA" → detect chau trigger', () => {
    const r = ml.detectChauMiiaTrigger('chau miia');
    expect(r.trigger).toBe(true);
  });

  test('opt-out detection: "no me interesa, dame de baja"', () => {
    expect(ml.isOptOut('no me interesa, dame de baja')).toBe(true);
  });

  test('insulto → response empatica', () => {
    const r = ml.detectNegativeSentiment('eres una idiota');
    expect(r.type).toBe('insulto');
    expect(typeof r.response).toBe('string');
  });
});

describe('T56 §F — E2E weekend mode flow', () => {
  // Mock weekend_mode si no esta cargado todavia (firebase mock arriba lo permite)
  const wm = require('../../core/weekend_mode');

  test('owner activa "finde off" → leads bloqueados con autoResponse', () => {
    const r1 = wm.processWeekendResponse('uid_e2e_owner', 'finde off', 'America/Bogota');
    expect(r1.handled).toBe(true);

    const r2 = wm.isWeekendBlocked('uid_e2e_owner');
    expect(r2.blocked).toBe(true);
    expect(r2.autoResponse).toMatch(/lunes|fin de semana/i);

    // Reset
    wm.processWeekendResponse('uid_e2e_owner', 'finde on', 'America/Bogota');
    const r3 = wm.isWeekendBlocked('uid_e2e_owner');
    expect(r3.blocked).toBe(false);
  });
});

describe('T56 §G — E2E split por subregistro V2', () => {
  const ssh = require('../../core/split_smart_heuristic');

  test('lead recibe array → paredon 1 burbuja', () => {
    const r = ssh.splitBySubregistro(['hola', 'soy MIIA', 'planes'], 'lead');
    expect(r.length).toBe(1);
  });

  test('family recibe array → split respetado', () => {
    const r = ssh.splitBySubregistro(['hola mama', 'todo bien?', 'te quiero'], 'family');
    expect(r.length).toBe(3);
  });

  test('ale_pareja con texto largo → split ultra-corto', () => {
    const long = 'mi amor te extrano demasiado hoy. Estuve pensando en vos toda la tarde. ¿Podemos hablar?';
    const r = ssh.splitBySubregistro(long, 'ale_pareja', { respectExistingSplit: false });
    expect(r.length).toBeGreaterThanOrEqual(1);
  });
});
