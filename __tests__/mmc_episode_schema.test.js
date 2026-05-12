'use strict';

const {
  buildNewEpisodeV03,
  upgradeEpisodeSchema,
  buildLesson,
  isValidLesson,
  isValidSensacion,
  DEFAULT_EXPIRES_DAYS,
} = require('../core/mmc/episode_schema');

// ── buildNewEpisodeV03 ────────────────────────────────────────────────────────

describe('buildNewEpisodeV03', () => {
  test('input null -> throw', () => {
    expect(() => buildNewEpisodeV03(null)).toThrow('episodeId_requerido');
  });
  test('sin episodeId -> throw', () => {
    expect(() => buildNewEpisodeV03({})).toThrow('episodeId_requerido');
  });
  test('sin ownerUid -> throw', () => {
    expect(() => buildNewEpisodeV03({ episodeId: 'e1' })).toThrow('ownerUid_requerido');
  });
  test('sin contactPhone -> throw', () => {
    expect(() => buildNewEpisodeV03({ episodeId: 'e1', ownerUid: 'u1' })).toThrow('contactPhone_requerido');
  });

  test('OK con campos minimos', () => {
    const ep = buildNewEpisodeV03({
      episodeId: 'e1', ownerUid: 'u1', contactPhone: '5491',
    });
    expect(ep.status).toBe('open');
    expect(ep.endedAt).toBeNull();
    expect(ep.lecciones).toEqual([]);
    expect(ep.tags).toEqual([]);
    expect(ep.messageIds).toEqual([]);
    expect(ep.vector).toBeNull();
    expect(ep.retrievalCount).toBe(0);
    expect(ep.injectionCount).toBe(0);
    expect(ep.contradicted).toBe(false);
    expect(ep.distilling).toBe(false);
    expect(ep.deletedByOwnerAt).toBeNull();
    expect(typeof ep.expiresAt).toBe('number');
  });

  test('OK con startedAt y messageIds', () => {
    const t = 1700000000000;
    const ep = buildNewEpisodeV03({
      episodeId: 'e1', ownerUid: 'u1', contactPhone: '5491',
      startedAt: t, messageIds: ['msg1', 'msg2'],
    });
    expect(ep.startedAt).toBe(t);
    expect(ep.messageIds).toEqual(['msg1', 'msg2']);
    expect(ep.expiresAt).toBe(t + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  });

  test('messageIds no array -> []', () => {
    const ep = buildNewEpisodeV03({
      episodeId: 'e1', ownerUid: 'u1', contactPhone: '5491',
      messageIds: 'not_array',
    });
    expect(ep.messageIds).toEqual([]);
  });

  test('startedAt no number -> usa Date.now()', () => {
    const ep = buildNewEpisodeV03({
      episodeId: 'e1', ownerUid: 'u1', contactPhone: '5491',
      startedAt: 'not_a_number',
    });
    expect(typeof ep.startedAt).toBe('number');
  });
});

// ── upgradeEpisodeSchema ──────────────────────────────────────────────────────

describe('upgradeEpisodeSchema', () => {
  test('doc null -> throw', () => {
    expect(() => upgradeEpisodeSchema(null)).toThrow('doc_invalido');
  });
  test('doc no object -> throw', () => {
    expect(() => upgradeEpisodeSchema('string')).toThrow('doc_invalido');
  });

  test('doc viejo legacy (9 campos) -> upgradea a 27+ campos', () => {
    const old = {
      episodeId: 'e1',
      ownerUid: 'u1',
      contactPhone: '5491',
      startedAt: 1700000000000,
      endedAt: null,
      messageIds: ['msg1'],
      status: 'open',
      topic: null,
      summary: null,
    };
    const u = upgradeEpisodeSchema(old);
    expect(u.lecciones).toEqual([]);
    expect(u.tags).toEqual([]);
    expect(u.idiomaDetectado).toBeNull();
    expect(u.tonadaDetectada).toBeNull();
    expect(u.vector).toBeNull();
    expect(u.retrievalCount).toBe(0);
    expect(u.injectionCount).toBe(0);
    expect(typeof u.expiresAt).toBe('number');
    expect(u.contradicted).toBe(false);
    expect(u.graduatedAt).toBeNull();
    expect(u.deletedByOwnerAt).toBeNull();
    expect(u.distilling).toBe(false);
  });

  test('doc sin startedAt -> usa Date.now() para expiresAt', () => {
    const u = upgradeEpisodeSchema({ episodeId: 'e1' });
    expect(typeof u.startedAt).toBe('number');
    expect(typeof u.expiresAt).toBe('number');
  });

  test('doc con summary pero sin resumen -> resumen = summary', () => {
    const u = upgradeEpisodeSchema({ summary: 'Resumen de prueba' });
    expect(u.resumen).toBe('Resumen de prueba');
  });

  test('doc sin summary ni resumen -> ambos null', () => {
    const u = upgradeEpisodeSchema({});
    expect(u.resumen).toBeNull();
    expect(u.summary).toBeNull();
  });

  test('doc con campos v0.3 ya seteados -> no los pisa', () => {
    const u = upgradeEpisodeSchema({
      retrievalCount: 5, injectionCount: 2,
      contradicted: true, distilling: true,
      vector: [0.1, 0.2], embeddingModel: 'test',
    });
    expect(u.retrievalCount).toBe(5);
    expect(u.injectionCount).toBe(2);
    expect(u.contradicted).toBe(true);
    expect(u.distilling).toBe(true);
    expect(u.vector).toEqual([0.1, 0.2]);
    expect(u.embeddingModel).toBe('test');
  });

  test('doc con messageIds no array -> []', () => {
    const u = upgradeEpisodeSchema({ messageIds: 'string' });
    expect(u.messageIds).toEqual([]);
  });

  test('doc con tags no array -> []', () => {
    const u = upgradeEpisodeSchema({ tags: 'string' });
    expect(u.tags).toEqual([]);
  });

  test('doc con lecciones no array -> []', () => {
    const u = upgradeEpisodeSchema({ lecciones: 'string' });
    expect(u.lecciones).toEqual([]);
  });

  test('doc sin status -> open default', () => {
    const u = upgradeEpisodeSchema({});
    expect(u.status).toBe('open');
  });

  test('doc con expiresAt no number -> recalcula', () => {
    const u = upgradeEpisodeSchema({ expiresAt: 'invalid', startedAt: 1700000000000 });
    expect(u.expiresAt).toBe(1700000000000 + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  });

  test('doc con durationMinutes no number -> 0', () => {
    const u = upgradeEpisodeSchema({ durationMinutes: 'invalid' });
    expect(u.durationMinutes).toBe(0);
  });

  test('doc con contradicted no boolean -> false', () => {
    const u = upgradeEpisodeSchema({ contradicted: 'yes' });
    expect(u.contradicted).toBe(false);
  });

  test('doc con distilling no boolean -> false', () => {
    const u = upgradeEpisodeSchema({ distilling: 'yes' });
    expect(u.distilling).toBe(false);
  });

  test('doc completo v0.3 con TODOS los campos definidos -> no pisa nada', () => {
    const complete = {
      episodeId: 'e1', ownerUid: 'u1', contactPhone: '5491',
      startedAt: 1700000000000, endedAt: 1700000003600000,
      durationMinutes: 60, messageIds: ['m1'], status: 'closed',
      topic: 'consulta', summary: 'resumen', resumen: 'resumen',
      tono: 'positivo', lecciones: [{ id: 'l1', text: 'x', confidence: 'low', source: 'nightly_distill' }],
      tags: ['t1'], idiomaDetectado: 'es', tonadaDetectada: 'argentina',
      expectativa: 'a', desvioTension: 'b', resolucion: 'c',
      sensacion: { before: 'tense', after: 'calm', delta: 'reparacion' },
      tipo: 'reparacion', cadenceConfidence: 'medium',
      vector: [0.1, 0.2], embeddingModel: 'text-embedding-004',
      lastRetrievedAt: '2026-05-12', retrievalCount: 3,
      lastInjectedAt: '2026-05-11', injectionCount: 2,
      expiresAt: 1800000000000, contradicted: false, graduatedAt: '2026-05-10',
      deletedByOwnerAt: null, deletionReason: null, distilling: false,
    };
    const u = upgradeEpisodeSchema(complete);
    expect(u.topic).toBe('consulta');
    expect(u.tono).toBe('positivo');
    expect(u.tipo).toBe('reparacion');
    expect(u.cadenceConfidence).toBe('medium');
    expect(u.idiomaDetectado).toBe('es');
    expect(u.tonadaDetectada).toBe('argentina');
    expect(u.expectativa).toBe('a');
    expect(u.desvioTension).toBe('b');
    expect(u.resolucion).toBe('c');
    expect(u.sensacion.delta).toBe('reparacion');
    expect(u.embeddingModel).toBe('text-embedding-004');
    expect(u.lastRetrievedAt).toBe('2026-05-12');
    expect(u.lastInjectedAt).toBe('2026-05-11');
    expect(u.graduatedAt).toBe('2026-05-10');
  });
});

// ── buildLesson ───────────────────────────────────────────────────────────────

describe('buildLesson', () => {
  test('input null -> throw', () => {
    expect(() => buildLesson(null)).toThrow('input_requerido');
  });
  test('input no object -> throw', () => {
    expect(() => buildLesson('string')).toThrow('input_requerido');
  });
  test('sin text -> throw', () => {
    expect(() => buildLesson({})).toThrow('text_requerido');
  });
  test('text vacio -> throw', () => {
    expect(() => buildLesson({ text: '   ' })).toThrow('text_requerido');
  });
  test('text no string -> throw', () => {
    expect(() => buildLesson({ text: 123 })).toThrow('text_requerido');
  });

  test('OK con defaults', () => {
    const l = buildLesson({ text: 'Mariano prefiere mensajes cortos' });
    expect(l.id).toMatch(/^lsn_/);
    expect(l.text).toBe('Mariano prefiere mensajes cortos');
    expect(l.confidence).toBe('low');
    expect(l.source).toBe('nightly_distill');
    expect(l.citationCount).toBe(0);
    expect(l.citationEpisodes).toEqual([]);
    expect(l.contradicted).toBe(false);
    expect(l.deletedByOwnerAt).toBeNull();
    expect(l.graduatedAt).toBeNull();
  });

  test('OK con confidence + source validos', () => {
    const l = buildLesson({ text: 'X', confidence: 'high', source: 'owner_explicit' });
    expect(l.confidence).toBe('high');
    expect(l.source).toBe('owner_explicit');
  });

  test('confidence invalido -> low (fallback)', () => {
    const l = buildLesson({ text: 'X', confidence: 'mega' });
    expect(l.confidence).toBe('low');
  });

  test('source invalido -> nightly_distill (fallback)', () => {
    const l = buildLesson({ text: 'X', source: 'imaginario' });
    expect(l.source).toBe('nightly_distill');
  });

  test('text largo -> truncado a 500', () => {
    const l = buildLesson({ text: 'x'.repeat(1000) });
    expect(l.text.length).toBe(500);
  });

  test('text con whitespace -> trim', () => {
    const l = buildLesson({ text: '  hola  ' });
    expect(l.text).toBe('hola');
  });
});

// ── isValidLesson ─────────────────────────────────────────────────────────────

describe('isValidLesson', () => {
  test('null -> false', () => expect(isValidLesson(null)).toBe(false));
  test('no object -> false', () => expect(isValidLesson('string')).toBe(false));
  test('sin id -> false', () => expect(isValidLesson({ text: 'x', confidence: 'low', source: 'nightly_distill' })).toBe(false));
  test('sin text -> false', () => expect(isValidLesson({ id: 'a', confidence: 'low', source: 'nightly_distill' })).toBe(false));
  test('text vacio -> false', () => expect(isValidLesson({ id: 'a', text: '', confidence: 'low', source: 'nightly_distill' })).toBe(false));
  test('confidence invalida -> false', () => expect(isValidLesson({ id: 'a', text: 'x', confidence: 'mega', source: 'nightly_distill' })).toBe(false));
  test('source invalida -> false', () => expect(isValidLesson({ id: 'a', text: 'x', confidence: 'low', source: 'foo' })).toBe(false));

  test('lesson valida -> true', () => {
    const l = buildLesson({ text: 'X', confidence: 'medium', source: 'owner_explicit' });
    expect(isValidLesson(l)).toBe(true);
  });
});

// ── isValidSensacion ──────────────────────────────────────────────────────────

describe('isValidSensacion', () => {
  test('null -> true (sensacion ausente es valido)', () => {
    expect(isValidSensacion(null)).toBe(true);
  });
  test('no object -> false', () => {
    expect(isValidSensacion('string')).toBe(false);
  });
  test('undefined -> false', () => {
    expect(isValidSensacion(undefined)).toBe(false);
  });
  test('sensacion completa valida', () => {
    expect(isValidSensacion({ before: 'tense', after: 'calm', delta: 'reparacion' })).toBe(true);
  });
  test('sensacion con null delta valida', () => {
    expect(isValidSensacion({ before: 'tense', after: 'calm', delta: null })).toBe(true);
  });
  test('before no string ni null -> false', () => {
    expect(isValidSensacion({ before: 5, after: null, delta: null })).toBe(false);
  });
  test('after no string ni null -> false', () => {
    expect(isValidSensacion({ before: null, after: {}, delta: null })).toBe(false);
  });
  test('delta no string ni null -> false', () => {
    expect(isValidSensacion({ before: null, after: null, delta: 123 })).toBe(false);
  });
});
