'use strict';

/**
 * T337 -- E2E Bloque 44
 * Pipeline: config_validator -> settings -> audit_trail -> CRM
 */

const { validateTenantConfig } = require('../core/config_validator');
const { updateSettings, getSettings, __setFirestoreForTests: setSettingsDb } = require('../core/owner_settings');
const { logAuditEvent, getAuditLog, __setFirestoreForTests: setAuditDb } = require('../core/audit_trail');
const {
  buildCrmContact, updatePipelineStage, computeCrmStats,
  __setFirestoreForTests: setCrmDb,
} = require('../core/crm_engine');

const UID = 'owner_bloque44_001';

function makeMultiDb(settingsData = null, auditDocs = []) {
  const store = {};
  return {
    collection: (col) => ({
      doc: (docId) => ({
        get: async () => {
          if (col === 'owners' && docId === UID && settingsData) {
            return { exists: true, data: () => ({ settings: settingsData }) };
          }
          return { exists: false };
        },
        set: async (data, opts) => {
          const key = `${col}/${docId}`;
          if (opts && opts.merge) store[key] = { ...(store[key] || {}), ...data };
          else store[key] = { ...data };
        },
        collection: (subCol) => ({
          doc: (subDocId) => ({
            set: async (data) => {
              const key = `${col}/${docId}/${subCol}/${subDocId}`;
              store[key] = data;
            },
            get: async () => ({ exists: false }),
          }),
          get: async () => ({ docs: auditDocs.map(d => ({ data: () => d })) }),
        }),
      }),
    }),
  };
}

describe('T337 -- E2E Bloque 44: config_validator + settings + audit + CRM', () => {
  beforeEach(() => {
    const db = makeMultiDb();
    setSettingsDb(db);
    setAuditDb(db);
    setCrmDb(db);
  });

  test('Paso 1 -- validar config del tenant', () => {
    const r = validateTenantConfig({
      businessName: 'Restaurante La Bogotana',
      timezone: 'America/Bogota',
      language: 'es',
      autoReply: true,
      maxMessagesPerHour: 100,
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.normalized.language).toBe('es');
  });

  test('Paso 2 -- config invalida detectada', () => {
    const r = validateTenantConfig({ timezone: 'UTC' }); // falta businessName
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('businessName'))).toBe(true);
  });

  test('Paso 3 -- actualizar settings del owner', async () => {
    const db = makeMultiDb();
    setSettingsDb(db);
    const r = await updateSettings(UID, { language: 'es', notificationsEnabled: true });
    expect(r.updatedKeys).toContain('language');
  });

  test('Paso 4 -- audit log al actualizar settings', async () => {
    const db = makeMultiDb();
    setAuditDb(db);
    const r = await logAuditEvent(UID, 'settings:updated', 'owner', { keys: ['language'] });
    expect(r.entryId).toMatch(/^audit_/);
    expect(r.hash).toHaveLength(16);
  });

  test('Paso 5 -- audit log data:exported', async () => {
    const db = makeMultiDb();
    setAuditDb(db);
    const r = await logAuditEvent(UID, 'data:exported', 'system', { format: 'json', conversations: 5 });
    expect(r.entryId).toMatch(/^audit_/);
  });

  test('Paso 6 -- CRM: lead calificado -> prospect', () => {
    let contact = buildCrmContact(UID, {
      phone: '+5711112222',
      name: 'Ana Gomez',
      stage: 'lead',
      tags: ['configurado'],
    });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');
    expect(contact.stageChangedAt).toBeDefined();
  });

  test('Pipeline completo -- validate + settings + audit + CRM', async () => {
    // A: validar config
    const cfg = validateTenantConfig({
      businessName: 'Tech Colombia SAS',
      timezone: 'America/Bogota',
      language: 'es',
      autoReply: true,
    });
    expect(cfg.valid).toBe(true);

    // B: settings
    const db = makeMultiDb();
    setSettingsDb(db);
    setAuditDb(db);
    const s = await updateSettings(UID, { language: 'es', aiEnabled: true });
    expect(s.updatedKeys).toContain('aiEnabled');

    // C: audit settings:updated
    const a1 = await logAuditEvent(UID, 'settings:updated', 'owner', { via: 'api' });
    expect(a1.hash).toBeDefined();

    // D: audit data:exported
    const a2 = await logAuditEvent(UID, 'data:exported', 'system', { rows: 100 });
    expect(a2.hash).toBeDefined();

    // E: CRM
    let contact = buildCrmContact(UID, { phone: '+5799998888', name: 'Luis', stage: 'lead' });
    contact = updatePipelineStage(contact, 'prospect');
    expect(contact.stage).toBe('prospect');

    // F: stats
    const stats = computeCrmStats([contact]);
    expect(stats.byStage.prospect).toBe(1);
  });
});
