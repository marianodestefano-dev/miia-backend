'use strict';

/**
 * T227 - Tests E2E Bloque 7
 * Flujos completos combinando: handoff_manager, quick_actions_engine, health_monitor, log_sanitizer.
 */

const { requestHandoff, updateHandoffStatus, isHandoffExpired, buildHandoffNotificationText, HANDOFF_REASONS } = require('../core/handoff_manager');
const { enqueueAction, summarizeQueue, isActionExpired, isValidAction, ACTION_TYPES } = require('../core/quick_actions_engine');
const { assessWhatsAppHealth, generateHealthAlert, HEALTH_COMPONENTS, ALERT_LEVELS } = require('../core/health_monitor');
const { sanitizeText, sanitizeObject, maskPhone, maskEmail, VERBOSE_ENV_KEY } = require('../core/log_sanitizer');

const { __setFirestoreForTests: setHandoffDb } = require('../core/handoff_manager');
const { __setFirestoreForTests: setActionsDb } = require('../core/quick_actions_engine');
const { __setFirestoreForTests: setHealthDb } = require('../core/health_monitor');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const NOW = new Date('2026-05-04T15:00:00.000Z').getTime();

function makeMockDb() {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: async () => {} }),
          where: () => ({ get: async () => ({ forEach: () => {} }) }),
          get: async () => ({ forEach: () => {} }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  setHandoffDb(null);
  setActionsDb(null);
  setHealthDb(null);
  delete process.env[VERBOSE_ENV_KEY];
});
afterEach(() => {
  setHandoffDb(null);
  setActionsDb(null);
  setHealthDb(null);
  delete process.env[VERBOSE_ENV_KEY];
});

describe('E2E: Flujo handoff completo', () => {
  test('solicita handoff y verifica record', async () => {
    setHandoffDb(makeMockDb());
    const r = await requestHandoff(UID, PHONE, 'complaint', { notes: 'cliente molesto' });
    expect(r.handoffId).toBeDefined();
    expect(r.record.status).toBe('pending');
    expect(r.record.reason).toBe('complaint');
    expect(r.record.notes).toBe('cliente molesto');
  });

  test('handoff expira correctamente', () => {
    const past = new Date(NOW - 35 * 60 * 1000).toISOString();
    const record = { expiresAt: past };
    expect(isHandoffExpired(record, NOW)).toBe(true);
  });

  test('handoff no expirado con timeout largo', async () => {
    setHandoffDb(makeMockDb());
    const r = await requestHandoff(UID, PHONE, 'payment', { timeoutMs: 2 * 60 * 60 * 1000 });
    expect(isHandoffExpired(r.record)).toBe(false);
  });

  test('buildHandoffNotificationText cubre todos los reasons', () => {
    HANDOFF_REASONS.forEach(reason => {
      const txt = buildHandoffNotificationText(PHONE, reason);
      expect(txt).toContain(PHONE);
      expect(typeof txt).toBe('string');
    });
  });

  test('update handoff a resolved', async () => {
    let savedData = null;
    const mockDb = {
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        set: async (data) => { savedData = data; },
      })})})}),
    };
    setHandoffDb(mockDb);
    await updateHandoffStatus(UID, 'h1', 'resolved', { notes: 'Resuelto en 5 min' });
    expect(savedData.status).toBe('resolved');
    expect(savedData.resolvedAt).toBeDefined();
  });
});

describe('E2E: Flujo acciones rapidas del dashboard', () => {
  test('encola accion pause_miia y verifica', async () => {
    setActionsDb(makeMockDb());
    const r = await enqueueAction(UID, 'pause_miia', {}, { triggeredBy: 'dashboard' });
    expect(r.actionId).toMatch(/^qa_/);
    expect(r.record.type).toBe('pause_miia');
    expect(r.record.triggeredBy).toBe('dashboard');
  });

  test('ACTION_TYPES cubre acciones criticas', () => {
    ['pause_miia', 'resume_miia', 'set_ooo', 'clear_ooo', 'block_contact'].forEach(a => {
      expect(isValidAction(a)).toBe(true);
    });
  });

  test('summarizeQueue funciona con mix de acciones', () => {
    const actions = ACTION_TYPES.slice(0, 5).map((type, i) => ({
      type,
      status: i % 2 === 0 ? 'queued' : 'done',
    }));
    const s = summarizeQueue(actions);
    expect(s.total).toBe(5);
    expect(s.hasPendingActions).toBe(true);
  });

  test('isActionExpired detecta acciones viejas', () => {
    const old = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
    expect(isActionExpired({ createdAt: old }, NOW)).toBe(true);
  });

  test('isActionExpired no marca acciones recientes', () => {
    const recent = new Date(NOW - 60 * 1000).toISOString();
    expect(isActionExpired({ createdAt: recent }, NOW)).toBe(false);
  });
});

describe('E2E: Flujo health monitoring', () => {
  test('WhatsApp conectado da healthy', () => {
    const r = assessWhatsAppHealth(NOW - 30 * 1000, NOW);
    expect(r.status).toBe('healthy');
  });

  test('WhatsApp desconectado 15 min da down', () => {
    const r = assessWhatsAppHealth(NOW - 15 * 60 * 1000, NOW);
    expect(r.status).toBe('down');
    expect(r.elapsedMs).toBeGreaterThan(10 * 60 * 1000);
  });

  test('alerta critica para componente down', () => {
    const alert = generateHealthAlert('whatsapp', 'down', 'No hay conexion');
    expect(alert.level).toBe(ALERT_LEVELS.CRITICAL);
    expect(alert.component).toBe('whatsapp');
  });

  test('HEALTH_COMPONENTS incluye componentes criticos del sistema', () => {
    ['whatsapp', 'firestore', 'gemini', 'scheduler'].forEach(c => {
      expect(HEALTH_COMPONENTS).toContain(c);
    });
  });

  test('alerta warning para degraded', () => {
    const alert = generateHealthAlert('gemini', 'degraded', 'Latencia alta');
    expect(alert.level).toBe(ALERT_LEVELS.WARNING);
  });
});

describe('E2E: Flujo log sanitization en produccion', () => {
  test('datos sensibles no aparecen en logs', () => {
    const logData = {
      phone: PHONE,
      email: 'mariano@miia-app.com',
      message: 'Hola quiero saber el precio',
      count: 5,
    };
    const safe = sanitizeObject(logData);
    expect(safe.phone).not.toContain('5411556');
    expect(safe.email).not.toContain('mariano@');
    expect(safe.count).toBe(5);
  });

  test('maskPhone retiene ultimos 4 digitos', () => {
    const r = maskPhone(PHONE);
    expect(r).toBe('****7788');
  });

  test('modo verbose pasa datos sin filtro', () => {
    process.env[VERBOSE_ENV_KEY] = '1';
    const logData = { phone: PHONE };
    const safe = sanitizeObject(logData);
    expect(safe.phone).toBe(PHONE);
  });

  test('sanitizeText maneja texto mixto complejo', () => {
    const text = 'Lead PHONE llamo, email EMAIL token Bearer TOKENVALUE123';
    const filled = text
      .replace('PHONE', PHONE)
      .replace('EMAIL', 'test@test.com')
      .replace('TOKENVALUE123', 'secrettoken12345');
    const safe = sanitizeText(filled, { truncate: false });
    expect(safe).not.toContain('5411');
    expect(safe).not.toContain('test@test');
    expect(safe).not.toContain('secrettoken12345');
  });
});

describe('E2E: Sistema integrado salud + handoff + sanitizacion', () => {
  test('handoff notification text es sanitizable', async () => {
    const txt = buildHandoffNotificationText(PHONE, 'lead_request');
    const safe = sanitizeText(txt, { truncate: false });
    expect(safe).not.toContain('5411556');
    expect(safe).toContain('****');
  });

  test('health alert no expone datos internos', () => {
    const alert = generateHealthAlert('whatsapp', 'down', 'Error con ' + PHONE);
    const alertStr = JSON.stringify(alert);
    const safeAlert = sanitizeText(alertStr, { truncate: false });
    expect(safeAlert).not.toContain('5411556');
  });
});
