'use strict';

const { buildTonadaDirective, formatCadenciasBlock, DIRECTIVAS } = require('../core/mmc/prompt_mod_tonada');
const baselineLib = require('../core/mmc/baseline');

function makeBaselineMock(baseline) {
  // baseline = null -> no existe; objeto -> existe con esos campos
  let docData = baseline;
  const docRef = {
    get: jest.fn().mockResolvedValue({
      exists: docData !== null && docData !== undefined,
      data: () => docData || {},
    }),
    set: jest.fn().mockResolvedValue({}),
  };
  return {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        collection: jest.fn(() => ({
          doc: jest.fn(() => docRef),
        })),
      })),
    })),
  };
}

beforeEach(() => {
  baselineLib.__setFirestoreForTests(null);
});

// ── buildTonadaDirective ──────────────────────────────────────────────────────

describe('buildTonadaDirective', () => {
  test('opts null -> empty', async () => {
    expect(await buildTonadaDirective(null)).toBe('');
  });
  test('opts sin uid -> empty', async () => {
    expect(await buildTonadaDirective({})).toBe('');
  });

  test('chatType=lead -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'argentina' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'lead' })).toBe('');
  });

  test('chatType=miia_lead -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'argentina' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'miia_lead' })).toBe('');
  });

  test('chatType=client -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'argentina' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'client' })).toBe('');
  });

  test('baseline no existe -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock(null));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' })).toBe('');
  });

  test('bootstrapComplete=false -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: false, adaptacionActiva: true, tonadaRegional: 'argentina' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' })).toBe('');
  });

  test('adaptacionActiva=false -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: false, tonadaRegional: 'argentina' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' })).toBe('');
  });

  test('tonada=neutro -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'neutro' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' })).toBe('');
  });

  test('tonada=argentina -> directiva argentina', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'argentina' }));
    const r = await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' });
    expect(r).toContain('## TONADA');
    expect(r).toContain('voseo');
    expect(r).toContain('che');
  });

  test('tonada=colombia -> directiva colombia', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'colombia' }));
    const r = await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' });
    expect(r).toContain('parcero');
    expect(r).toContain('chévere');
  });

  test('tonada=mexico -> directiva mexico', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'mexico' }));
    const r = await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' });
    expect(r).toContain('órale');
    expect(r).toContain('chido');
  });

  test('tonada inexistente en DIRECTIVAS -> empty', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'chilena' }));
    expect(await buildTonadaDirective({ uid: 'uid12345', chatType: 'selfchat' })).toBe('');
  });

  test('chatType ausente (no provisto) -> aplica directiva (assume owner)', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({ bootstrapComplete: true, adaptacionActiva: true, tonadaRegional: 'argentina' }));
    const r = await buildTonadaDirective({ uid: 'uid12345' });
    expect(r).toContain('## TONADA');
  });
});

// ── formatCadenciasBlock ──────────────────────────────────────────────────────

describe('formatCadenciasBlock', () => {
  test('null -> empty', () => {
    expect(formatCadenciasBlock(null)).toBe('');
  });
  test('array vacio -> empty', () => {
    expect(formatCadenciasBlock([])).toBe('');
  });
  test('no array -> empty', () => {
    expect(formatCadenciasBlock('string')).toBe('');
  });

  test('1 item con fecha -> formato correcto', () => {
    const r = formatCadenciasBlock([{ fecha: '2026-05-12T10:00:00Z', lessonText: 'Mariano prefiere brevedad' }]);
    expect(r).toContain('## CADENCIAS PREVIAS');
    expect(r).toContain('📝 Recordás: Mariano prefiere brevedad (2026-05-12)');
  });

  test('item sin fecha -> sin parentesis', () => {
    const r = formatCadenciasBlock([{ lessonText: 'X' }]);
    expect(r).toContain('📝 Recordás: X\n');
    expect(r).not.toContain('()');
  });

  test('item con fecha vacia -> sin parentesis', () => {
    const r = formatCadenciasBlock([{ fecha: '', lessonText: 'X' }]);
    expect(r).not.toContain('()');
  });

  test('item con fecha no string -> sin parentesis', () => {
    const r = formatCadenciasBlock([{ fecha: 12345, lessonText: 'X' }]);
    expect(r).not.toContain('(12345)');
  });

  test('item con lessonText null -> empty string', () => {
    const r = formatCadenciasBlock([{ lessonText: null }]);
    expect(r).toContain('📝 Recordás: \n');
  });

  test('lessonText largo -> truncado a 200', () => {
    const r = formatCadenciasBlock([{ lessonText: 'x'.repeat(500) }]);
    // 200 caracteres x + "📝 Recordás: " prefix + newline
    expect(r.split('\n').filter(function (l) { return l.includes('Recordás'); })[0].length).toBeLessThanOrEqual(220);
  });

  test('3 items -> 3 lineas', () => {
    const r = formatCadenciasBlock([
      { lessonText: 'a' }, { lessonText: 'b' }, { lessonText: 'c' },
    ]);
    expect(r.match(/📝/g)).toHaveLength(3);
  });
});

// ── Exports ───────────────────────────────────────────────────────────────────

describe('DIRECTIVAS', () => {
  test('contiene argentina/colombia/mexico', () => {
    expect(DIRECTIVAS.argentina).toBeDefined();
    expect(DIRECTIVAS.colombia).toBeDefined();
    expect(DIRECTIVAS.mexico).toBeDefined();
  });
});
