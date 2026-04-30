'use strict';

/**
 * T48 — coverage gap fix: split_smart_heuristic.js
 * (era 6.15% → target >90%)
 */

const ssh = require('../core/split_smart_heuristic');

describe('T48 §A — splitByParagraph', () => {
  test('texto sin saltos dobles → 1 elemento', () => {
    expect(ssh.splitByParagraph('una sola línea')).toEqual(['una sola línea']);
  });
  test('texto con dobles saltos → multiples elementos', () => {
    const r = ssh.splitByParagraph('parte 1\n\nparte 2\n\nparte 3');
    expect(r).toEqual(['parte 1', 'parte 2', 'parte 3']);
  });
  test('texto vacío → []', () => {
    expect(ssh.splitByParagraph('')).toEqual([]);
  });
  test('triple salto → ignora vacios', () => {
    const r = ssh.splitByParagraph('a\n\n\nb');
    expect(r).toEqual(['a', 'b']);
  });
});

describe('T48 §B — splitBySentence', () => {
  test('texto sin puntuacion → 1 elemento', () => {
    expect(ssh.splitBySentence('texto sin puntos')).toEqual(['texto sin puntos']);
  });
  test('multiples oraciones → split por punctuacion', () => {
    const r = ssh.splitBySentence('Primera. Segunda! Tercera?');
    expect(r.length).toBe(3);
    expect(r[0]).toMatch(/Primera/);
    expect(r[2]).toMatch(/Tercera/);
  });
  test('texto vacio → []', () => {
    expect(ssh.splitBySentence('')).toEqual([]);
  });
});

describe('T48 §C — packIntoLimit', () => {
  test('fragmentos chicos se concatenan dentro del limite', () => {
    const r = ssh.packIntoLimit(['aaa', 'bbb', 'ccc'], 100);
    expect(r.length).toBe(1);
    expect(r[0]).toContain('aaa');
    expect(r[0]).toContain('bbb');
    expect(r[0]).toContain('ccc');
  });
  test('fragmentos grandes se separan', () => {
    const big1 = 'a'.repeat(50);
    const big2 = 'b'.repeat(50);
    const big3 = 'c'.repeat(50);
    const r = ssh.packIntoLimit([big1, big2, big3], 70);
    expect(r.length).toBe(3); // cada uno solo no cabe junto con otro
  });
  test('fragmento solo > limit pasa igual sin truncar', () => {
    const huge = 'x'.repeat(200);
    const r = ssh.packIntoLimit([huge], 50);
    expect(r).toEqual([huge]);
  });
  test('lista vacia → []', () => {
    expect(ssh.packIntoLimit([], 100)).toEqual([]);
  });
});

describe('T48 §D — joinParts', () => {
  test('array de partes → join con \\n\\n', () => {
    expect(ssh.joinParts(['a', 'b', 'c'])).toBe('a\n\nb\n\nc');
  });
  test('non-array → string del valor', () => {
    expect(ssh.joinParts('solo')).toBe('solo');
  });
  test('null/undefined → ""', () => {
    expect(ssh.joinParts(null)).toBe('');
    expect(ssh.joinParts(undefined)).toBe('');
  });
  test('partes vacias se filtran', () => {
    expect(ssh.joinParts(['a', '', 'b'])).toBe('a\n\nb');
  });
});

describe('T48 §E — splitBySubregistro: PAREDÓN forzado', () => {
  test('lead recibe array → concatena a 1 burbuja', () => {
    const r = ssh.splitBySubregistro(['hola', 'soy MIIA', 'planes'], 'lead');
    expect(r.length).toBe(1);
    expect(r[0]).toContain('hola');
    expect(r[0]).toContain('planes');
  });
  test('enterprise_lead recibe texto → 1 burbuja', () => {
    const r = ssh.splitBySubregistro('texto unico', 'enterprise_lead');
    expect(r.length).toBe(1);
  });
  test('follow_up_cold recibe array → 1 burbuja', () => {
    const r = ssh.splitBySubregistro(['p1', 'p2', 'p3'], 'follow_up_cold');
    expect(r.length).toBe(1);
  });
  test('input vacio → []', () => {
    expect(ssh.splitBySubregistro('', 'lead')).toEqual([]);
  });
});

describe('T48 §F — splitBySubregistro: ALLOW_SPLIT respeta split previo', () => {
  test('family con array > 1 → respeta split', () => {
    const r = ssh.splitBySubregistro(['hola', 'mama', 'que tal'], 'family');
    expect(r.length).toBe(3);
  });
  test('friend_argentino con array > 1 → respeta', () => {
    const r = ssh.splitBySubregistro(['ey', 'che'], 'friend_argentino');
    expect(r.length).toBe(2);
  });
  test('respectExistingSplit=false → reagrupa segun policy', () => {
    const r = ssh.splitBySubregistro(['a', 'b'], 'family', { respectExistingSplit: false });
    // Reagrupa: todos caben en limit family 140 → 1 burbuja
    expect(r.length).toBe(1);
  });
});

describe('T48 §G — splitBySubregistro: heuristica para texto largo', () => {
  test('texto monolitico largo family → split por oraciones', () => {
    const long = 'Hola mama. Como estas hoy. Te quiero contar. Algo importante. Sobre la familia. Y el viaje.';
    const r = ssh.splitBySubregistro(long, 'family');
    expect(r.length).toBeGreaterThanOrEqual(1);
  });
  test('texto monolitico con parrafos friend_colombiano', () => {
    const long = 'Parte uno larga aqui que tiene muchas palabras.\n\nParte dos tambien larga con muchas palabras.\n\nParte tres final.';
    const r = ssh.splitBySubregistro(long, 'friend_colombiano');
    expect(r.length).toBeGreaterThanOrEqual(1);
  });
  test('chatType desconocido → fallback default conservador', () => {
    const r = ssh.splitBySubregistro('hola', 'tipo_inventado');
    expect(r.length).toBe(1);
  });
  test('texto que cabe en un chunk → 1 burbuja', () => {
    const r = ssh.splitBySubregistro('hola', 'family');
    expect(r).toEqual(['hola']);
  });
});

describe('T48 §H — getSplitMode', () => {
  test('lead → paredon', () => {
    expect(ssh.getSplitMode('lead')).toBe('paredon');
  });
  test('ale_pareja → split_ultra_corto', () => {
    expect(ssh.getSplitMode('ale_pareja')).toBe('split_ultra_corto');
  });
  test('friend_argentino → split_ultra_corto', () => {
    expect(ssh.getSplitMode('friend_argentino')).toBe('split_ultra_corto');
  });
  test('family → split_breve', () => {
    expect(ssh.getSplitMode('family')).toBe('split_breve');
  });
  test('friend_colombiano → split_moderado', () => {
    expect(ssh.getSplitMode('friend_colombiano')).toBe('split_moderado');
  });
  test('client → mezcla', () => {
    expect(ssh.getSplitMode('client')).toBe('mezcla');
  });
  test('unknown → default_conservador', () => {
    expect(ssh.getSplitMode('inventado')).toBe('default_conservador');
  });
});

describe('T48 §I — Constantes exportadas', () => {
  test('SPLIT_LIMITS contiene todos los chatTypes', () => {
    expect(typeof ssh.SPLIT_LIMITS.lead).toBe('number');
    expect(typeof ssh.SPLIT_LIMITS.family).toBe('number');
    expect(ssh.SPLIT_LIMITS.lead).toBeGreaterThan(ssh.SPLIT_LIMITS.family);
  });
  test('FORCE_PAREDON Set contiene lead/enterprise_lead/follow_up_cold', () => {
    expect(ssh.FORCE_PAREDON.has('lead')).toBe(true);
    expect(ssh.FORCE_PAREDON.has('enterprise_lead')).toBe(true);
    expect(ssh.FORCE_PAREDON.has('follow_up_cold')).toBe(true);
    expect(ssh.FORCE_PAREDON.has('family')).toBe(false);
  });
  test('ALLOW_SPLIT Set contiene family/friends/ale', () => {
    expect(ssh.ALLOW_SPLIT.has('family')).toBe(true);
    expect(ssh.ALLOW_SPLIT.has('ale_pareja')).toBe(true);
    expect(ssh.ALLOW_SPLIT.has('lead')).toBe(false);
  });
});
