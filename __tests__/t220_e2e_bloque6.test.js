'use strict';

/**
 * T220 - Tests E2E Bloque 6
 * Growth tracking + viral referrals + dashboard integration.
 */

const { calculateConversionRate, calculateRetentionRate, buildGrowthSummary, getPeriodKey } = require('../core/growth_tracker');
const { generateCode, isCodeValid, isCodeExpired, REWARD_TYPES } = require('../core/viral_referral_engine');
const { classifyLatency, analyzeResponseTimes } = require('../core/response_optimizer');
const { buildPersonaPromptHint, mergeWithDefault } = require('../core/miia_persona_config');
const { buildPreferenceContextHint } = require('../core/lead_preferences_memory');

describe('E2E: Growth cycle completo', () => {
  test('metricas de conversion calculadas correctamente', () => {
    const rate = calculateConversionRate(200, 50);
    expect(rate).toBe(25);
  });

  test('retention rate calculado correctamente', () => {
    const rate = calculateRetentionRate(200, 80);
    expect(rate).toBe(40);
  });

  test('buildGrowthSummary integra todas las metricas', () => {
    const data = {
      new_leads: 100, converted_leads: 25,
      returning_contacts: 40, messages_total: 1000,
    };
    const summary = buildGrowthSummary(data);
    expect(summary.conversionRate).toBe(25);
    expect(summary.retentionRate).toBe(40);
    expect(summary.totalActivity).toBe(1000);
  });

  test('period keys para todos los tipos', () => {
    const date = '2026-05-04T15:00:00Z';
    const daily = getPeriodKey('daily', date);
    const weekly = getPeriodKey('weekly', date);
    const monthly = getPeriodKey('monthly', date);
    expect(daily).toBe('2026-05-04');
    expect(monthly).toBe('2026-05');
    expect(weekly.startsWith('2026-W')).toBe(true);
  });
});

describe('E2E: Viral referral flow', () => {
  test('codigo generado es valido', () => {
    const uid = 'testUid1234567890';
    const code = generateCode(uid);
    expect(isCodeValid(code)).toBe(true);
    expect(code.length).toBe(8);
  });

  test('codigo futuro no esta expirado', () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    expect(isCodeExpired(future)).toBe(false);
  });

  test('codigo pasado si esta expirado', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(isCodeExpired(past)).toBe(true);
  });

  test('REWARD_TYPES incluye los tipos principales', () => {
    expect(REWARD_TYPES).toContain('discount');
    expect(REWARD_TYPES).toContain('free_month');
    expect(REWARD_TYPES).toContain('points');
  });
});

describe('E2E: Performance monitoring en produccion', () => {
  test('100 requests rapidas cumplen P95 target', () => {
    const times = Array.from({ length: 100 }, (_, i) => 100 + i * 5);
    const r = analyzeResponseTimes(times);
    expect(r.meetsTarget).toBe(true);
  });

  test('latencias altas detectadas correctamente', () => {
    const slow300 = Array.from({ length: 300 }, () => 200);
    const fast700 = Array.from({ length: 700 }, () => 100);
    const times = [...fast700, ...slow300];
    const r = analyzeResponseTimes(times);
    expect(r.count).toBe(1000);
    expect(r.mean).toBe(130);
  });

  test('clasificacion de latencia cubre todos los rangos', () => {
    expect(classifyLatency(100)).toBe('<500ms');
    expect(classifyLatency(600)).toBe('500-1s');
    expect(classifyLatency(1200)).toBe('1-2s');
    expect(classifyLatency(2500)).toBe('2-5s');
    expect(classifyLatency(8000)).toBe('>5s');
  });
});

describe('E2E: Contexto completo de personalizacion para prompt', () => {
  test('persona + preferencias generan contexto enriquecido', () => {
    const persona = mergeWithDefault({ name: 'Sofia', style: 'warm', greeting: 'Hola!' });
    const personaHint = buildPersonaPromptHint(persona);
    const prefs = { language: 'es', budget: '$200', interest: 'moda' };
    const prefsHint = buildPreferenceContextHint(prefs);
    expect(personaHint).toContain('Sofia');
    expect(personaHint).toContain('Hola!');
    expect(prefsHint).toContain('$200');
    expect(prefsHint).toContain('moda');
    const fullContext = personaHint + ' | ' + prefsHint;
    expect(fullContext.length).toBeGreaterThan(20);
  });
});
