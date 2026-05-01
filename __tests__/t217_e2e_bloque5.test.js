'use strict';

/**
 * T217 - Tests E2E Bloque 5
 * Piso 5 base: personalizacion avanzada, seguridad, performance.
 */

const { getDefaultTone, applyTone, getToneProfile } = require('../core/tone_adapter');
const { validatePersona, mergeWithDefault, buildPersonaPromptHint } = require('../core/miia_persona_config');
const { buildPreferenceContextHint, isValidPreferenceType } = require('../core/lead_preferences_memory');
const { classifyAnomaly, isUnusualHour } = require('../core/anomaly_detector');
const { isValidAction } = require('../core/owner_audit_log');
const { classifyLatency, analyzeResponseTimes, P95_TARGET_MS } = require('../core/response_optimizer');

describe('E2E: Personalizacion completa (tone + persona + prefs)', () => {
  test('flujo completo: tone segun tipo de contacto', () => {
    const toneVip = getDefaultTone('vip');
    const toneEnterprise = getDefaultTone('enterprise');
    expect(toneVip).not.toBe(toneEnterprise);
    const profileVip = getToneProfile(toneVip);
    const profileEnt = getToneProfile(toneEnterprise);
    expect(profileEnt.emojiLevel).toBe(0);
    expect(profileVip.emojiLevel).toBeGreaterThanOrEqual(1);
  });

  test('persona personalizada genera hint de prompt correcto', () => {
    const persona = mergeWithDefault({ name: 'Luna', style: 'warm', greeting: 'Que tal!' });
    expect(validatePersona(persona).valid).toBe(true);
    const hint = buildPersonaPromptHint(persona);
    expect(hint).toContain('Luna');
    expect(hint).toContain('warm');
    expect(hint).toContain('Que tal!');
  });

  test('preferencias del lead generan hint de contexto', () => {
    const prefs = { language: 'es', budget: '$500', interest: 'tecnologia' };
    const hint = buildPreferenceContextHint(prefs);
    expect(hint).toContain('es');
    expect(hint).toContain('$500');
    expect(hint).toContain('tecnologia');
  });

  test('tipos de preferencia validos', () => {
    expect(isValidPreferenceType('language')).toBe(true);
    expect(isValidPreferenceType('budget')).toBe(true);
    expect(isValidPreferenceType('secreto')).toBe(false);
  });
});

describe('E2E: Seguridad - audit + anomalias', () => {
  test('acciones criticas son validas para audit log', () => {
    expect(isValidAction('login')).toBe(true);
    expect(isValidAction('api_key_rotate')).toBe(true);
    expect(isValidAction('hackear')).toBe(false);
  });

  test('clasificacion de anomalias segun tipo', () => {
    const low = classifyAnomaly('unusual_hour', {});
    const crit = classifyAnomaly('api_key_multiple_rotations', {});
    expect(low.severity).toBe('low');
    expect(crit.severity).toBe('critical');
  });

  test('deteccion de hora inusual', () => {
    const unusual = new Date('2026-05-04T03:00:00.000Z').getTime();
    const normal = new Date('2026-05-04T14:00:00.000Z').getTime();
    expect(isUnusualHour(unusual)).toBe(true);
    expect(isUnusualHour(normal)).toBe(false);
  });
});

describe('E2E: Performance - latencia y P95', () => {
  test('tiempos buenos clasifican como <500ms o 500-1s', () => {
    expect(classifyLatency(300)).toBe('<500ms');
    expect(classifyLatency(800)).toBe('500-1s');
  });

  test('P95 target es 2000ms', () => {
    expect(P95_TARGET_MS).toBe(2000);
  });

  test('100 requests de 500ms pasan el target P95', () => {
    const times = Array.from({ length: 100 }, () => 500);
    const r = analyzeResponseTimes(times);
    expect(r.meetsTarget).toBe(true);
    expect(r.p95).toBe(500);
  });

  test('requests lentas fallan el target P95', () => {
    const times = Array.from({ length: 100 }, (_, i) => i < 95 ? 500 : 5000);
    const r = analyzeResponseTimes(times);
    expect(r.meetsTarget).toBe(false);
  });
});

describe('E2E: Tone adapter aplicado a mensajes reales', () => {
  test('mensaje con saludo formal', () => {
    const result = applyTone('Su pedido esta listo', 'formal', { addGreeting: true });
    expect(result).toContain('Buenos dias');
    expect(result).toContain('Su pedido esta listo');
  });

  test('mensaje con cierre casual', () => {
    const result = applyTone('Tu pedido llega hoy', 'casual', { addClosing: true });
    expect(result).toContain('Tu pedido llega hoy');
    expect(result).toContain('escribime');
  });

  test('tono friendly es el default para leads', () => {
    const tone = getDefaultTone('lead');
    expect(tone).toBe('friendly');
  });
});
