/**
 * Tests: C-446-FIX-ADN §A — detectMedilinkLeak auditor.
 *
 * Origen: CARTA C-446-FIX-ADN [FIRMADA_VIVO_C446_FIX_ADN_MARIANO_2026-04-28].
 *
 * Bug 4 root cause: voice_seed_center.md tiene subregistros legacy MediLink.
 * Detector inyecta CRITICAL flag si MIIA CENTER lead/client menciona
 * 'medilink' — fuerza regeneración respuesta.
 */

'use strict';

const { detectMedilinkLeak, auditV2Response } = require('../core/v2_auditor');

describe('C-446-FIX-ADN §A — detectMedilinkLeak', () => {
  test('A.1 — chatType "lead" + texto con MediLink → leak detectado', () => {
    const text = 'Hola, soy MIIA, la asistente de IA de MediLink.';
    const r = detectMedilinkLeak(text, 'lead');
    expect(r).not.toBeNull();
    expect(r.match.toLowerCase()).toBe('medilink');
  });

  test('A.2 — chatType "miia_lead" + MediLink → leak detectado', () => {
    const text = 'Trabajo en MediLink, ¿en qué te ayudo?';
    const r = detectMedilinkLeak(text, 'miia_lead');
    expect(r).not.toBeNull();
  });

  test('A.3 — chatType "client" + medilink (lowercase) → leak detectado', () => {
    const text = 'Tu plan medilink incluye...';
    const r = detectMedilinkLeak(text, 'client');
    expect(r).not.toBeNull();
  });

  test('A.4 — chatType "medilink_team" + MediLink → NO leak (legítimo)', () => {
    const text = 'Como integrante del equipo MediLink...';
    const r = detectMedilinkLeak(text, 'medilink_team');
    expect(r).toBeNull();
  });

  test('A.5 — chatType "owner_selfchat" + MediLink → NO leak (Mariano)', () => {
    const text = 'Ya me confirmaron en MediLink el cliente nuevo.';
    const r = detectMedilinkLeak(text, 'owner_selfchat');
    expect(r).toBeNull();
  });

  test('A.6 — chatType "lead" SIN MediLink → null', () => {
    const text = 'Hola, soy MIIA, ¿cómo puedo ayudarte hoy?';
    const r = detectMedilinkLeak(text, 'lead');
    expect(r).toBeNull();
  });

  test('A.7 — texto vacío → null defensivo', () => {
    expect(detectMedilinkLeak('', 'lead')).toBeNull();
    expect(detectMedilinkLeak(null, 'lead')).toBeNull();
  });

  test('A.8 — chatType "family" + MediLink → null (familia OK)', () => {
    const text = 'Sí, MediLink ayuda a clientes médicos.';
    const r = detectMedilinkLeak(text, 'family');
    expect(r).toBeNull();
  });
});

describe('C-446-FIX-ADN §A — auditMessage integration RF11', () => {
  const ctx = {
    contactName: 'Test',
    aiDisclosureEnabled: false,
  };

  test('B.1 — auditMessage chatType lead + MediLink → criticalFlags incluye RF11', () => {
    const candidate = '¡Hola! Soy MIIA, la asistente de inteligencia artificial de MediLink.';
    const r = auditV2Response(candidate, 'lead', ctx);
    const rf11 = (r.criticalFlags || []).find((f) => f.code === 'RF11_medilink_leak_center');
    expect(rf11).toBeDefined();
    expect(rf11.label).toContain('MediLink');
    expect(r.shouldRegenerate).toBe(true);
  });

  test('B.2 — auditMessage chatType medilink_team + MediLink → NO RF11', () => {
    const candidate = 'Bienvenido al equipo MediLink, soy MIIA.';
    const r = auditV2Response(candidate, 'medilink_team', ctx);
    const rf11 = (r.criticalFlags || []).find((f) => f.code === 'RF11_medilink_leak_center');
    expect(rf11).toBeUndefined();
  });

  test('B.3 — auditMessage chatType lead SIN MediLink → no RF11', () => {
    const candidate = 'Hola, soy MIIA, asistente IA. ¿En qué te ayudo?';
    const r = auditV2Response(candidate, 'lead', { ...ctx, aiDisclosureEnabled: true });
    const rf11 = (r.criticalFlags || []).find((f) => f.code === 'RF11_medilink_leak_center');
    expect(rf11).toBeUndefined();
  });
});
