'use strict';
const { resolvePersona, canRevealAI, shouldApplyHumanDelay, PERSONA_MODES, PERSONA_RULES } = require('../core/persona_switcher');

describe('PERSONA_MODES y PERSONA_RULES', () => {
  test('contiene modos esperados', () => {
    expect(PERSONA_MODES).toContain('owner_selfchat');
    expect(PERSONA_MODES).toContain('lead');
    expect(PERSONA_MODES).toContain('miia_lead');
    expect(PERSONA_MODES).toContain('family');
  });
  test('cada modo tiene reglas definidas', () => {
    for (const mode of PERSONA_MODES) {
      expect(PERSONA_RULES[mode]).toBeDefined();
      expect(typeof PERSONA_RULES[mode].revealAI).toBe('boolean');
    }
  });
});

describe('resolvePersona', () => {
  test('selfchat = owner_selfchat', () => {
    const r = resolvePersona({ isSelfChat: true });
    expect(r.mode).toBe('owner_selfchat');
    expect(r.rules.revealAI).toBe(true);
    expect(r.rules.humanDelay).toBe(false);
  });
  test('isGroup = group', () => {
    const r = resolvePersona({ isGroup: true });
    expect(r.mode).toBe('group');
  });
  test('chatType=miia_lead = miia_lead', () => {
    const r = resolvePersona({ chatType: 'miia_lead' });
    expect(r.mode).toBe('miia_lead');
    expect(r.rules.revealAI).toBe(true);
  });
  test('chatType=lead = lead (no MIIA CENTER)', () => {
    const r = resolvePersona({ chatType: 'lead', isMiiaCenterUid: false });
    expect(r.mode).toBe('lead');
    expect(r.rules.revealAI).toBe(false);
  });
  test('chatType=lead con MIIA CENTER = miia_lead', () => {
    const r = resolvePersona({ chatType: 'lead', isMiiaCenterUid: true });
    expect(r.mode).toBe('miia_lead');
  });
  test('chatType=client = client', () => {
    const r = resolvePersona({ chatType: 'client', isMiiaCenterUid: false });
    expect(r.mode).toBe('client');
  });
  test('chatType=client con MIIA CENTER = miia_client', () => {
    const r = resolvePersona({ chatType: 'client', isMiiaCenterUid: true });
    expect(r.mode).toBe('miia_client');
  });
  test('chatType=family = family', () => {
    const r = resolvePersona({ chatType: 'family' });
    expect(r.mode).toBe('family');
    expect(r.rules.revealAI).toBe(true);
    expect(r.rules.humanDelay).toBe(false);
  });
  test('sin contexto = unknown', () => {
    const r = resolvePersona({});
    expect(r.mode).toBe('unknown');
  });
  test('null ctx = unknown', () => {
    const r = resolvePersona(null);
    expect(r.mode).toBe('unknown');
  });
});

describe('canRevealAI', () => {
  test('selfchat puede revelar AI', () => {
    expect(canRevealAI({ isSelfChat: true })).toBe(true);
  });
  test('lead no puede revelar AI', () => {
    expect(canRevealAI({ chatType: 'lead' })).toBe(false);
  });
  test('miia_lead puede revelar AI', () => {
    expect(canRevealAI({ chatType: 'miia_lead' })).toBe(true);
  });
  test('family puede revelar AI', () => {
    expect(canRevealAI({ chatType: 'family' })).toBe(true);
  });
});

describe('shouldApplyHumanDelay', () => {
  test('selfchat NO human delay', () => {
    expect(shouldApplyHumanDelay({ isSelfChat: true })).toBe(false);
  });
  test('lead SI human delay', () => {
    expect(shouldApplyHumanDelay({ chatType: 'lead' })).toBe(true);
  });
  test('family NO human delay', () => {
    expect(shouldApplyHumanDelay({ chatType: 'family' })).toBe(false);
  });
  test('group NO human delay', () => {
    expect(shouldApplyHumanDelay({ isGroup: true })).toBe(false);
  });
});
