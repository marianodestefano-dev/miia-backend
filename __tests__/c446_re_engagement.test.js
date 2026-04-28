/**
 * Tests: C-446-FIX-ADN §C — Re-engagement detector + auditor.
 *
 * Origen: CARTA C-446-FIX-ADN [FIRMADA_VIVO_C446_FIX_ADN_MARIANO_2026-04-28].
 *
 * Bug 1 (Mariano): "lead vuelve después de días, MIIA tira cotización
 * sin saludar — humano saluda, pregunta cómo está, si pensó."
 */

'use strict';

const {
  detectReEngagement,
  buildReEngagementContext,
  auditReEngagementResponse,
  DEFAULT_GAP_THRESHOLD_MS,
} = require('../core/re_engagement');

const NOW = 1700000000000; // ts fijo para tests determinísticos
const ONE_DAY = 24 * 60 * 60 * 1000;

describe('C-446-FIX-ADN §C — detectReEngagement', () => {
  test('A.1 — gap > 24h en lead → isReEngagement=true', () => {
    const conv = [
      { role: 'user', content: 'hola', timestamp: NOW - (3 * ONE_DAY) },
    ];
    const r = detectReEngagement(conv, 'lead', NOW);
    expect(r.isReEngagement).toBe(true);
    expect(r.gapDays).toBe(3);
  });

  test('A.2 — gap > 24h en miia_lead → isReEngagement=true', () => {
    const conv = [{ role: 'user', content: 'hi', timestamp: NOW - (5 * ONE_DAY) }];
    expect(detectReEngagement(conv, 'miia_lead', NOW).isReEngagement).toBe(true);
  });

  test('A.3 — gap < 24h en lead → isReEngagement=false', () => {
    const conv = [{ role: 'user', content: 'hola', timestamp: NOW - (2 * 60 * 60 * 1000) }];
    expect(detectReEngagement(conv, 'lead', NOW).isReEngagement).toBe(false);
  });

  test('A.4 — gap > 24h pero contactType "family" → false (no aplica)', () => {
    const conv = [{ role: 'user', content: 'hola', timestamp: NOW - (3 * ONE_DAY) }];
    expect(detectReEngagement(conv, 'family', NOW).isReEngagement).toBe(false);
  });

  test('A.5 — conversation vacía → false', () => {
    expect(detectReEngagement([], 'lead', NOW).isReEngagement).toBe(false);
  });

  test('A.6 — threshold custom respetado', () => {
    const customThreshold = 60 * 60 * 1000; // 1h
    const conv = [{ role: 'user', content: 'x', timestamp: NOW - (2 * 60 * 60 * 1000) }];
    const r = detectReEngagement(conv, 'lead', NOW, { gapThresholdMs: customThreshold });
    expect(r.isReEngagement).toBe(true);
  });

  test('A.7 — última msg sin timestamp → busca en mensajes anteriores', () => {
    const conv = [
      { role: 'user', content: 'old', timestamp: NOW - (3 * ONE_DAY) },
      { role: 'assistant', content: 'no-ts' },
    ];
    expect(detectReEngagement(conv, 'lead', NOW).isReEngagement).toBe(true);
  });

  test('A.8 — contactType client (post-venta) también aplica', () => {
    const conv = [{ role: 'user', content: 'h', timestamp: NOW - (3 * ONE_DAY) }];
    expect(detectReEngagement(conv, 'client', NOW).isReEngagement).toBe(true);
  });
});

describe('C-446-FIX-ADN §C — buildReEngagementContext', () => {
  test('B.1 — re-engagement true → string con instrucción', () => {
    const r = { isReEngagement: true, gapMs: 3 * ONE_DAY, gapDays: 3 };
    const block = buildReEngagementContext(r);
    expect(block).toContain('RE-ENGAGEMENT');
    expect(block).toContain('3 día');
    expect(block).toContain('Saludá');
    expect(block).toContain('NO repitas oferta');
  });

  test('B.2 — re-engagement false → null', () => {
    expect(buildReEngagementContext({ isReEngagement: false, gapMs: 0 })).toBeNull();
  });

  test('B.3 — null/undefined defensivo', () => {
    expect(buildReEngagementContext(null)).toBeNull();
    expect(buildReEngagementContext(undefined)).toBeNull();
  });
});

describe('C-446-FIX-ADN §C — auditReEngagementResponse', () => {
  const reActive = { isReEngagement: true, gapMs: 3 * ONE_DAY, gapDays: 3 };

  test('C.1 — lead saludó "hola" + MIIA tira "$15 mensual" → veto', () => {
    const r = auditReEngagementResponse(
      'Hola Juan! El plan mensual es $15 USD. ¿Te animás?',
      reActive,
      'hola'
    );
    expect(r.shouldVeto).toBe(true);
    expect(r.reason).toMatch(/precio|leak/i);
  });

  test('C.2 — lead pregunta "cuanto cuesta?" → MIIA puede responder precio (NO veto)', () => {
    const r = auditReEngagementResponse(
      'El plan mensual es $15 USD.',
      reActive,
      '¿cuanto cuesta MIIA?'
    );
    expect(r.shouldVeto).toBe(false);
  });

  test('C.3 — lead saludó + MIIA NO menciona precio → no veto', () => {
    const r = auditReEngagementResponse(
      'Hola! ¿Cómo estás? ¿Pensaste lo que hablamos la última vez?',
      reActive,
      'hola'
    );
    expect(r.shouldVeto).toBe(false);
  });

  test('C.4 — re-engagement false (no aplica) → no veto', () => {
    const r = auditReEngagementResponse(
      'El plan mensual es $15.',
      { isReEngagement: false, gapMs: 0 },
      'hola'
    );
    expect(r.shouldVeto).toBe(false);
  });

  test('C.5 — pattern "plan mensual" + lead saludó → veto', () => {
    const r = auditReEngagementResponse(
      'Te recuerdo el plan mensual del que hablamos.',
      reActive,
      'qué tal?'
    );
    expect(r.shouldVeto).toBe(true);
  });

  test('C.6 — texto vacío → no veto', () => {
    const r = auditReEngagementResponse('', reActive, 'hola');
    expect(r.shouldVeto).toBe(false);
  });

  test('C.7 — pattern "cotizacion" sin que lead pregunte → veto', () => {
    const r = auditReEngagementResponse(
      'Ahora te paso la cotización completa.',
      reActive,
      'eso es mi buenos días'
    );
    expect(r.shouldVeto).toBe(true);
  });
});
