'use strict';

// T277: template_engine
const {
  buildTemplateRecord, renderTemplate, validateTemplate, buildTemplatePreview,
  buildDefaultTemplates, extractVariables,
  saveTemplate, getTemplate, updateTemplate, listTemplates, recordTemplateUsage,
  TEMPLATE_TYPES, TEMPLATE_CHANNELS, TEMPLATE_LANGUAGES,
  MAX_VARIABLES_PER_TEMPLATE, MAX_BODY_LENGTH,
  __setFirestoreForTests,
} = require('../core/template_engine');

const UID = 'testTplUid';

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
            get: async () => {
              if (throwGet) throw new Error('get error');
              return { exists: !!db_stored[id], data: () => db_stored[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { empty: Object.keys(db_stored).length === 0, forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

beforeEach(() => __setFirestoreForTests(null));
afterEach(() => __setFirestoreForTests(null));

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
describe('constants', () => {
  test('TEMPLATE_TYPES frozen 12 valores', () => {
    expect(TEMPLATE_TYPES).toHaveLength(12);
    expect(TEMPLATE_TYPES).toContain('greeting');
    expect(TEMPLATE_TYPES).toContain('appointment_reminder');
    expect(Object.isFrozen(TEMPLATE_TYPES)).toBe(true);
  });
  test('TEMPLATE_CHANNELS frozen 5 valores', () => {
    expect(TEMPLATE_CHANNELS).toHaveLength(5);
    expect(TEMPLATE_CHANNELS).toContain('whatsapp');
    expect(Object.isFrozen(TEMPLATE_CHANNELS)).toBe(true);
  });
  test('TEMPLATE_LANGUAGES frozen 3 valores', () => {
    expect(TEMPLATE_LANGUAGES).toHaveLength(3);
    expect(TEMPLATE_LANGUAGES).toContain('es');
    expect(Object.isFrozen(TEMPLATE_LANGUAGES)).toBe(true);
  });
});

// ─── extractVariables ─────────────────────────────────────────────────────────
describe('extractVariables', () => {
  test('extrae variables de body', () => {
    const vars = extractVariables('Hola {{nombre}}, tu turno es {{fecha}} a las {{hora}}.');
    expect(vars).toHaveLength(3);
    expect(vars).toContain('nombre');
    expect(vars).toContain('fecha');
    expect(vars).toContain('hora');
  });
  test('variable repetida aparece una vez', () => {
    const vars = extractVariables('{{nombre}} y luego {{nombre}} de nuevo');
    expect(vars).toHaveLength(1);
  });
  test('sin variables → array vacio', () => {
    const vars = extractVariables('Texto sin variables');
    expect(vars).toHaveLength(0);
  });
  test('body no-string → array vacio', () => {
    expect(extractVariables(null)).toHaveLength(0);
    expect(extractVariables(42)).toHaveLength(0);
  });
});

// ─── buildTemplateRecord ──────────────────────────────────────────────────────
describe('buildTemplateRecord', () => {
  test('defaults correctos', () => {
    const t = buildTemplateRecord(UID, { name: 'Plantilla Test', body: 'Hola {{nombre}}!' });
    expect(t.uid).toBe(UID);
    expect(t.type).toBe('custom');
    expect(t.channel).toBe('whatsapp');
    expect(t.language).toBe('es');
    expect(t.active).toBe(true);
    expect(t.usageCount).toBe(0);
    expect(t.variables).toContain('nombre');
    expect(t.variableCount).toBe(1);
  });
  test('templateId personalizado se respeta', () => {
    const t = buildTemplateRecord(UID, { templateId: 'tpl_custom', name: 'X', body: 'Y' });
    expect(t.templateId).toBe('tpl_custom');
  });
  test('type invalido cae a custom', () => {
    const t = buildTemplateRecord(UID, { name: 'X', body: 'Y', type: 'INVALID' });
    expect(t.type).toBe('custom');
  });
  test('channel invalido cae a whatsapp', () => {
    const t = buildTemplateRecord(UID, { name: 'X', body: 'Y', channel: 'telegram' });
    expect(t.channel).toBe('whatsapp');
  });
  test('body largo se trunca', () => {
    const t = buildTemplateRecord(UID, { name: 'X', body: 'a'.repeat(MAX_BODY_LENGTH + 100) });
    expect(t.body.length).toBe(MAX_BODY_LENGTH);
  });
  test('extrae multiples variables', () => {
    const t = buildTemplateRecord(UID, {
      name: 'Test',
      body: '{{a}} {{b}} {{c}} {{a}}', // a repetido
    });
    expect(t.variableCount).toBe(3); // a, b, c deduplicados
  });
});

// ─── renderTemplate ───────────────────────────────────────────────────────────
describe('renderTemplate', () => {
  test('renderiza todas las variables', () => {
    const t = buildTemplateRecord(UID, {
      name: 'T', body: 'Hola {{nombre}}, tu turno es el {{fecha}}.',
    });
    const { rendered, missing, complete } = renderTemplate(t, { nombre: 'Laura', fecha: '2026-05-15' });
    expect(rendered).toBe('Hola Laura, tu turno es el 2026-05-15.');
    expect(missing).toHaveLength(0);
    expect(complete).toBe(true);
  });
  test('variable faltante reporta missing', () => {
    const t = buildTemplateRecord(UID, { name: 'T', body: 'Hola {{nombre}}, servicio: {{servicio}}.' });
    const { rendered, missing, complete } = renderTemplate(t, { nombre: 'Ana' });
    expect(rendered).toContain('Ana');
    expect(rendered).toContain('{{servicio}}');
    expect(missing).toContain('servicio');
    expect(complete).toBe(false);
  });
  test('sin variables devuelve body sin cambios', () => {
    const t = buildTemplateRecord(UID, { name: 'T', body: 'Mensaje fijo sin variables.' });
    const { rendered, complete } = renderTemplate(t, {});
    expect(rendered).toBe('Mensaje fijo sin variables.');
    expect(complete).toBe(true);
  });
  test('template invalido → error', () => {
    expect(() => renderTemplate(null, {})).toThrow('invalido');
    expect(() => renderTemplate({}, {})).toThrow('invalido');
  });
  test('variable aparece multiples veces → todas se reemplazan', () => {
    const t = buildTemplateRecord(UID, { name: 'T', body: '{{n}} y luego {{n}} y {{n}}.' });
    const { rendered } = renderTemplate(t, { n: 'Carlos' });
    expect(rendered).toBe('Carlos y luego Carlos y Carlos.');
  });
});

// ─── validateTemplate ─────────────────────────────────────────────────────────
describe('validateTemplate', () => {
  test('plantilla valida', () => {
    const t = buildTemplateRecord(UID, { name: 'Test', body: 'Hola {{nombre}}!' });
    const { valid, errors } = validateTemplate(t);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
  test('sin name → error', () => {
    const t = { ...buildTemplateRecord(UID, { name: 'T', body: 'B' }), name: '' };
    const { valid, errors } = validateTemplate(t);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('name'))).toBe(true);
  });
  test('sin body → error', () => {
    const t = { ...buildTemplateRecord(UID, { name: 'T', body: 'B' }), body: '' };
    const { valid, errors } = validateTemplate(t);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('body'))).toBe(true);
  });
  test('no-objeto → error', () => {
    const { valid } = validateTemplate('not an object');
    expect(valid).toBe(false);
  });
});

// ─── buildTemplatePreview ─────────────────────────────────────────────────────
describe('buildTemplatePreview', () => {
  test('null retorna defecto', () => {
    expect(buildTemplatePreview(null)).toContain('no encontrada');
  });
  test('preview completo con variables', () => {
    const t = buildTemplateRecord(UID, {
      name: 'Recordatorio', type: 'appointment_reminder', channel: 'whatsapp',
      body: 'Hola {{nombre}}, turno el {{fecha}}.',
    });
    const preview = buildTemplatePreview(t, { nombre: 'Maria', fecha: '15/05' });
    expect(preview).toContain('Recordatorio');
    expect(preview).toContain('Maria');
    expect(preview).toContain('15/05');
    expect(preview).not.toContain('{{');
  });
  test('preview con variable faltante lo indica', () => {
    const t = buildTemplateRecord(UID, { name: 'T', body: 'Hola {{nombre}}, tu {{servicio}}.' });
    const preview = buildTemplatePreview(t, { nombre: 'Ana' });
    expect(preview).toContain('Variables faltantes');
    expect(preview).toContain('servicio');
  });
});

// ─── buildDefaultTemplates ────────────────────────────────────────────────────
describe('buildDefaultTemplates', () => {
  test('genera 5 plantillas predefinidas', () => {
    const templates = buildDefaultTemplates(UID);
    expect(templates).toHaveLength(5);
    templates.forEach(t => {
      expect(t.uid).toBe(UID);
      expect(t.body.length).toBeGreaterThan(0);
      expect(t.variableCount).toBeGreaterThan(0);
    });
  });
  test('incluye tipos esenciales', () => {
    const templates = buildDefaultTemplates(UID);
    const types = templates.map(t => t.type);
    expect(types).toContain('welcome');
    expect(types).toContain('appointment_reminder');
    expect(types).toContain('payment_confirmed');
  });
});

// ─── FIRESTORE CRUD ──────────────────────────────────────────────────────────
describe('saveTemplate + getTemplate round-trip', () => {
  test('guarda y recupera plantilla', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const t = buildTemplateRecord(UID, {
      name: 'Turno Recordatorio', type: 'appointment_reminder',
      body: 'Hola {{nombre}}, turno {{fecha}} a las {{hora}}.',
      templateId: 'tpl_turno_rec',
    });
    await saveTemplate(UID, t);
    __setFirestoreForTests(db);
    const loaded = await getTemplate(UID, 'tpl_turno_rec');
    expect(loaded).not.toBeNull();
    expect(loaded.name).toBe('Turno Recordatorio');
    expect(loaded.variableCount).toBe(3);
  });
  test('getTemplate null si no existe', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    expect(await getTemplate(UID, 'nonexistent')).toBeNull();
  });
  test('saveTemplate lanza con throwSet', async () => {
    const db = makeMockDb({ throwSet: true });
    __setFirestoreForTests(db);
    const t = buildTemplateRecord(UID, { name: 'T', body: 'X' });
    await expect(saveTemplate(UID, t)).rejects.toThrow('set error');
  });
});

describe('updateTemplate', () => {
  test('actualiza body y recalcula variables', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const t = buildTemplateRecord(UID, { name: 'T', body: '{{a}} {{b}}', templateId: 'tpl_upd' });
    await saveTemplate(UID, t);
    __setFirestoreForTests(db);
    await updateTemplate(UID, 'tpl_upd', { body: '{{x}} {{y}} {{z}}' });
    __setFirestoreForTests(db);
    const loaded = await getTemplate(UID, 'tpl_upd');
    expect(loaded.variables).toContain('x');
    expect(loaded.variableCount).toBe(3);
  });
});

describe('listTemplates', () => {
  test('filtra por type', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const t1 = buildTemplateRecord(UID, { name: 'A', type: 'welcome', body: 'X', templateId: 'tpl_a' });
    const t2 = buildTemplateRecord(UID, { name: 'B', type: 'follow_up', body: 'Y', templateId: 'tpl_b' });
    await saveTemplate(UID, t1);
    await saveTemplate(UID, t2);
    __setFirestoreForTests(db);
    const welcome = await listTemplates(UID, { type: 'welcome' });
    expect(welcome.every(t => t.type === 'welcome')).toBe(true);
  });
});

describe('recordTemplateUsage', () => {
  test('incrementa usageCount', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const t = buildTemplateRecord(UID, { name: 'T', body: 'X', templateId: 'tpl_use' });
    await saveTemplate(UID, t);
    __setFirestoreForTests(db);
    const count1 = await recordTemplateUsage(UID, 'tpl_use');
    __setFirestoreForTests(db);
    const count2 = await recordTemplateUsage(UID, 'tpl_use');
    expect(count1).toBe(1);
    expect(count2).toBe(2);
  });
  test('templateId inexistente retorna null', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);
    const result = await recordTemplateUsage(UID, 'nonexistent');
    expect(result).toBeNull();
  });
});

// ─── PIPELINE: crear, renderizar y usar plantilla ─────────────────────────────
describe('Pipeline: plantillas default + render + uso', () => {
  test('generar plantillas, buscar, renderizar y registrar uso', async () => {
    const db = makeMockDb();
    __setFirestoreForTests(db);

    // 1. Generar y guardar plantillas por defecto
    const defaults = buildDefaultTemplates(UID);
    for (const tpl of defaults) {
      await saveTemplate(UID, tpl);
    }
    setAll: __setFirestoreForTests(db);

    // 2. Buscar plantilla de bienvenida
    __setFirestoreForTests(db);
    const welcomeTemplates = await listTemplates(UID, { type: 'welcome' });
    expect(welcomeTemplates.length).toBeGreaterThanOrEqual(1);
    const welcomeTpl = welcomeTemplates[0];
    expect(welcomeTpl.variables).toContain('nombre');

    // 3. Validar
    const { valid } = validateTemplate(welcomeTpl);
    expect(valid).toBe(true);

    // 4. Renderizar con variables
    const { rendered, complete } = renderTemplate(welcomeTpl, {
      nombre: 'Carlos', negocio: 'Salon de Belleza MIIA',
    });
    expect(complete).toBe(true);
    expect(rendered).toContain('Carlos');
    expect(rendered).toContain('Salon de Belleza MIIA');
    expect(rendered).not.toContain('{{');

    // 5. Registrar uso
    __setFirestoreForTests(db);
    const usageCount = await recordTemplateUsage(UID, welcomeTpl.templateId);
    expect(usageCount).toBe(1);

    // 6. Buscar plantilla de recordatorio de turno
    __setFirestoreForTests(db);
    const reminderTemplates = await listTemplates(UID, { type: 'appointment_reminder' });
    expect(reminderTemplates.length).toBeGreaterThanOrEqual(1);
    const reminderTpl = reminderTemplates[0];

    // 7. Preview parcial (con variables faltantes)
    const preview = buildTemplatePreview(reminderTpl, { nombre: 'Ana' });
    expect(preview).toContain('Ana');
    // Tiene mas variables no provistas (fecha, hora, servicio)
    expect(preview).toContain('Variables faltantes');

    // 8. Render completo
    const { rendered: reminderRendered, complete: reminderComplete } = renderTemplate(reminderTpl, {
      nombre: 'Ana', servicio: 'Corte de pelo', fecha: '16/05', hora: '14:30',
    });
    expect(reminderComplete).toBe(true);
    expect(reminderRendered).toContain('Ana');
    expect(reminderRendered).toContain('Corte de pelo');
    expect(reminderRendered).not.toContain('{{');
  });
});
