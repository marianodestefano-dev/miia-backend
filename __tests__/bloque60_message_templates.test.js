const { createTemplate, renderTemplate, validateTemplate, listTemplates, useTemplate, __setFirestoreForTests } = require('../core/message_templates');

function makeDb() {
  const store = {};
  function makeDoc(p) {
    return {
      get: async () => { const d = store[p]; return { exists: !!d, data: () => d }; },
      set: async (data, opts) => {
        if (opts && opts.merge) store[p] = Object.assign({}, store[p] || {}, data);
        else store[p] = Object.assign({}, data);
      },
      collection: (sub) => makeCol(p + '/' + sub),
    };
  }
  function makeCol(p) {
    return {
      doc: (id) => makeDoc(p + '/' + id),
      where: (f, op, v) => ({
        where: (f2, op2, v2) => ({
          get: async () => {
            const prefix = p + '/';
            const docs = Object.entries(store)
              .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v && d[f2] === v2)
              .map(([, d]) => ({ data: () => d }));
            return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
          }
        }),
        get: async () => {
          const prefix = p + '/';
          const docs = Object.entries(store)
            .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v)
            .map(([, d]) => ({ data: () => d }));
          return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
        }
      }),
    };
  }
  return { collection: (col) => makeCol(col) };
}

beforeEach(() => { __setFirestoreForTests(makeDb()); });
afterAll(() => { __setFirestoreForTests(null); });

describe('T369 - message_templates', () => {
  test('createTemplate creates template with correct fields', async () => {
    const t = await createTemplate('uid1', { name: 'Bienvenida', content: 'Hola {nombre}!', variables: ['nombre'], category: 'greeting' });
    expect(t.id).toBeDefined();
    expect(t.name).toBe('Bienvenida');
    expect(t.use_count).toBe(0);
    expect(t.category).toBe('greeting');
    expect(t.uid).toBe('uid1');
  });

  test('createTemplate throws if missing required fields', async () => {
    await expect(createTemplate(null, { name: 'X', content: 'Y' })).rejects.toThrow('uid required');
    await expect(createTemplate('uid1', { content: 'Y' })).rejects.toThrow('name required');
    await expect(createTemplate('uid1', { name: 'X' })).rejects.toThrow('content required');
  });

  test('renderTemplate replaces variables correctly', () => {
    const t = { content: "Hola {nombre}, tu pedido {id} esta listo." };
    const rendered = renderTemplate(t, { nombre: "Mariano", id: "12345" });
    expect(rendered).toBe("Hola Mariano, tu pedido 12345 esta listo.");
  });

  test('renderTemplate leaves unmatched vars as-is', () => {
    const t = { content: "Hola {nombre}!" };
    const rendered = renderTemplate(t, {});
    expect(rendered).toBe("Hola {nombre}!");
  });

  test('validateTemplate detects valid template with variables', () => {
    const result = validateTemplate("Hola {nombre} y {apellido}");
    expect(result.valid).toBe(true);
    expect(result.variables).toContain("nombre");
    expect(result.variables).toContain("apellido");
  });

  test('validateTemplate detects unbalanced braces', () => {
    const result = validateTemplate("Hola {nombre}}");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('unbalanced_braces');
  });

  test('useTemplate increments use_count', async () => {
    const t = await createTemplate('uid1', { name: 'Test', content: 'Hello' });
    const used = await useTemplate('uid1', t.id);
    expect(used.use_count).toBe(1);
    expect(used.last_used).toBeDefined();
  });

  test('listTemplates returns all templates for uid', async () => {
    await createTemplate('uid4', { name: 'T1', content: 'A', category: 'sales' });
    await createTemplate('uid4', { name: 'T2', content: 'B', category: 'support' });
    const all = await listTemplates('uid4');
    expect(all.length).toBe(2);
    const sales = await listTemplates('uid4', 'sales');
    expect(sales.length).toBe(1);
  });
});
