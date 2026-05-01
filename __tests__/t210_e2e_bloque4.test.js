'use strict';

/**
 * T210 - Tests E2E Bloque 4
 */

const { contactsToCSV, generateExportManifest } = require('../core/data_exporter');
const { parseCSV, validateContact, normalizeContact } = require('../core/contact_importer');
const { getPlanLimits, isValidPlan } = require('../core/plan_rate_limiter');
const { buildReferralMessage } = require('../core/lead_referral_network');
const { validateCommission } = require('../core/referral_agreement');
const { getNextSuggestedStage } = require('../core/referral_tracker');
const { scheduleBroadcast } = require('../core/broadcast_scheduler');
const { personalizeMessage, validateBroadcastMessage, estimateSendCost } = require('../core/broadcast_preview');

const NOW = new Date('2026-05-04T15:00:00.000Z').getTime();

describe('E2E: Exportar + reimportar contactos', () => {
  test('CSV exportado puede parsearse de vuelta', () => {
    const contacts = [
      { phone: '+541155667788', name: 'Juan', tags: ['cliente', 'vip'], score: 80 },
      { phone: '+541155667799', name: 'Maria', tags: ['lead'], score: 30 },
    ];
    const csv = contactsToCSV(contacts);
    const rows = parseCSV(csv);
    expect(rows.length).toBe(2);
    expect(rows[0].phone).toBe('+541155667788');
  });

  test('roundtrip: exportar -> parsear -> validar -> normalizar', () => {
    const contacts = [{ phone: '+541155667788', name: 'Ana' }];
    const csv = contactsToCSV(contacts);
    const rows = parseCSV(csv);
    const vr = validateContact(rows[0]);
    expect(vr.valid).toBe(true);
    const norm = normalizeContact(rows[0]);
    expect(norm.phone).toBe('+541155667788');
    expect(norm.name).toBe('Ana');
  });

  test('manifest agrupa multiples exports correctamente', () => {
    const exports = [
      { type: 'contacts', format: 'csv', count: 150 },
      { type: 'conversations', format: 'json', count: 1200 },
    ];
    const manifest = generateExportManifest('uid123', exports);
    expect(manifest.totalRecords).toBe(1350);
    expect(manifest.exports.length).toBe(2);
  });
});

describe('E2E: Plan rate limiter + broadcast preview', () => {
  test('plan pro permite mas mensajes que free', () => {
    const free = getPlanLimits('free');
    const pro = getPlanLimits('pro');
    expect(pro.messagesPerDay).toBeGreaterThan(free.messagesPerDay);
  });

  test('broadcast message valida y personaliza', () => {
    const vr = validateBroadcastMessage('Hola [NOMBRE], tu pedido llegara pronto!');
    expect(vr.valid).toBe(true);
    const personalized = personalizeMessage('Hola [NOMBRE]!', { name: 'Juan', phone: '+1' });
    expect(personalized).toContain('Juan');
    expect(personalized).not.toContain('[NOMBRE]');
  });

  test('costo estimado sube con media', () => {
    const costText = estimateSendCost(100, false);
    const costMedia = estimateSendCost(100, true);
    expect(costMedia.estimatedCost).toBeGreaterThan(costText.estimatedCost);
  });

  test('validacion rechaza mensaje vacio', () => {
    const vr = validateBroadcastMessage('');
    expect(vr.valid).toBe(false);
  });
});

describe('E2E: Red referidos inter-MIIA', () => {
  test('mensaje de referido en espanol incluye nombre del negocio', () => {
    const msg = buildReferralMessage('La Rosa', 'El Sol', 'mejor servicio');
    expect(msg).toContain('El Sol');
    expect(msg.length).toBeGreaterThan(10);
  });

  test('comision valida no lanza excepcion', () => {
    expect(() => validateCommission('percentage', 20)).not.toThrow();
  });

  test('comision invalida lanza excepcion', () => {
    expect(() => validateCommission('percentage', 60)).toThrow();
    expect(() => validateCommission('tipo_falso', 10)).toThrow();
  });

  test('stages del referido siguen orden logico', () => {
    expect(getNextSuggestedStage('referred')).toBe('contacted');
    expect(getNextSuggestedStage('contacted')).toBe('interested');
    expect(getNextSuggestedStage('lost')).toBeNull();
  });
});

describe('E2E: Validacion de planes', () => {
  test('todos los planes tienen campos obligatorios', () => {
    const { PLANS } = require('../core/plan_rate_limiter');
    Object.entries(PLANS).forEach(([name, limits]) => {
      expect(limits.messagesPerDay).toBeDefined();
      expect(limits.broadcastsPerDay).toBeDefined();
      expect(limits.contactsMax).toBeDefined();
    });
  });

  test('planes conocidos son todos validos', () => {
    ['free', 'starter', 'pro', 'enterprise'].forEach(plan => {
      expect(isValidPlan(plan)).toBe(true);
    });
    expect(isValidPlan('unknown')).toBe(false);
  });
});

describe('E2E: Importacion CSV realista', () => {
  test('CSV con tags pipe se convierte a array', () => {
    const csv = 'phone,name,tags\n+541155667788,Carlos,cliente|vip|promo';
    const rows = parseCSV(csv);
    const norm = normalizeContact(rows[0]);
    expect(Array.isArray(norm.tags)).toBe(true);
    expect(norm.tags).toContain('cliente');
    expect(norm.tags).toContain('vip');
  });

  test('validacion correcta de contactos invalidos', () => {
    const rows = [
      { phone: '+541155667788', name: 'Juan' },
      { phone: '123', name: 'Invalido' },
      { name: 'Sin phone' },
    ];
    const results = rows.map(r => validateContact(r));
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[2].valid).toBe(false);
  });
});

describe('E2E: Broadcast scheduler validaciones', () => {
  test('scheduleBroadcast rechaza uid undefined', async () => {
    await expect(scheduleBroadcast(undefined, { message: 'Hola', recipients: ['+1'], sendAt: new Date(NOW + 60000).toISOString() })).rejects.toThrow('uid requerido');
  });

  test('scheduleBroadcast rechaza opts sin message', async () => {
    await expect(scheduleBroadcast('uid', {})).rejects.toThrow('message requerido');
  });
});
