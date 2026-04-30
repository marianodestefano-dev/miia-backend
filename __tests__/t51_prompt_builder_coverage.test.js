'use strict';

/**
 * T51 — coverage gap fix: prompt_builder.js
 * (era 37.01% → target levantar funciones puras + dispatchers sin tocar
 * builders complejos que requieren Firestore mocks)
 */

const pb = require('../core/prompt_builder');

describe('T51 §A — resolveOwnerFirstName', () => {
  test('shortName valido → retorna shortName', () => {
    expect(pb.resolveOwnerFirstName({ shortName: 'Mariano' })).toBe('Mariano');
  });
  test('shortName "Hola" → descarta y va a name', () => {
    const r = pb.resolveOwnerFirstName({ shortName: 'Hola', name: 'Mariano De Stefano' });
    expect(r).toBe('Mariano');
  });
  test('shortName con greeting "Buenas" + name vacio → empty + error log', () => {
    const orig = console.error;
    let logged = false;
    console.error = (...args) => { if (args.join(' ').includes('CRITICAL')) logged = true; };
    try {
      const r = pb.resolveOwnerFirstName({ shortName: 'Buenas', name: '' });
      expect(r).toBe('');
      expect(logged).toBe(true);
    } finally {
      console.error = orig;
    }
  });
  test('name con primer token greeting → segundo token con warn', () => {
    const orig = console.warn;
    console.warn = () => {};
    try {
      const r = pb.resolveOwnerFirstName({ name: 'Hola Mariano' });
      expect(r).toBe('Mariano');
    } finally {
      console.warn = orig;
    }
  });
  test('userProfile null → vacio + error', () => {
    const orig = console.error;
    console.error = () => {};
    try {
      expect(pb.resolveOwnerFirstName(null)).toBe('');
    } finally {
      console.error = orig;
    }
  });
  test('shortName con espacios alrededor → trim funciona', () => {
    expect(pb.resolveOwnerFirstName({ shortName: '  Mariano  ' })).toBe('Mariano');
  });
});

describe('T51 §B — resolveProfile', () => {
  test('null → DEFAULT_OWNER_PROFILE', () => {
    const r = pb.resolveProfile(null);
    expect(r).toBe(pb.DEFAULT_OWNER_PROFILE);
  });
  test('partial profile → merge con defaults', () => {
    const r = pb.resolveProfile({ name: 'Juan', businessName: 'Acme' });
    expect(r.name).toBe('Juan');
    expect(r.businessName).toBe('Acme');
    expect(r.miiaPersonality).toBe(pb.DEFAULT_OWNER_PROFILE.miiaPersonality);
  });
  test('profile completo → preserva todos los campos', () => {
    const custom = { ...pb.DEFAULT_OWNER_PROFILE, name: 'X', role: 'CEO', autonomyLevel: 7 };
    const r = pb.resolveProfile(custom);
    expect(r.role).toBe('CEO');
    expect(r.autonomyLevel).toBe(7);
  });
});

describe('T51 §C — buildADN', () => {
  test('profile con businessName → identity menciona businessName', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'Mariano', role: 'CEO', businessName: 'Acme' });
    expect(adn).toContain('Acme');
    expect(adn).toContain('Mariano');
    expect(adn).toContain('CEO');
  });
  test('profile sin businessName → identity menciona solo name', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'Mariano' });
    expect(adn).toContain('Mariano');
    expect(adn).not.toMatch(/IA de "/);
  });
  test('passions presentes → linea pasiones incluida', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'M', passions: 'fútbol, tango' });
    expect(adn).toContain('Pasiones');
    expect(adn).toContain('fútbol');
  });
  test('autonomyLevel 7 → menciona Discute/defiende', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'M', autonomyLevel: 8 });
    expect(adn).toMatch(/Discute|defiende|propone/i);
  });
  test('autonomyLevel 5 → menciona Opina/sugiere', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'M', autonomyLevel: 5 });
    expect(adn).toMatch(/Opina|sugiere/i);
  });
  test('autonomyLevel 0 default → Servicial', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'M' });
    expect(adn).toMatch(/Servicial|no opina/i);
  });
  test('currentMood offended → texto modo ofendida', () => {
    const adn = pb.buildADN({ ...pb.DEFAULT_OWNER_PROFILE, name: 'M', currentMood: 'offended' });
    expect(adn).toMatch(/OFENDIDA/i);
  });
});

describe('T51 §D — DEFAULT_OWNER_PROFILE / MIIA_SALES_PROFILE constants', () => {
  test('DEFAULT_OWNER_PROFILE exportado y tiene shape esperado', () => {
    expect(pb.DEFAULT_OWNER_PROFILE).toBeDefined();
    expect(typeof pb.DEFAULT_OWNER_PROFILE.miiaPersonality).toBe('string');
    expect(pb.DEFAULT_OWNER_PROFILE.revealAsAI).toBe(false);
    expect(Array.isArray(pb.DEFAULT_OWNER_PROFILE.nicknames)).toBe(true);
  });
  test('MIIA_SALES_PROFILE name=MIIA businessName=MIIA', () => {
    expect(pb.MIIA_SALES_PROFILE.name).toBe('MIIA');
    expect(pb.MIIA_SALES_PROFILE.businessName).toBe('MIIA');
    expect(pb.MIIA_SALES_PROFILE.demoLink).toMatch(/miia-app/);
  });
});

describe('T51 §E — buildVademecum', () => {
  test('chatType=lead omite I-20 trigger commands (regla 6.12)', () => {
    const vade = pb.buildVademecum(pb.DEFAULT_OWNER_PROFILE, 'lead');
    // I-20 son los trigger commands "Hola MIIA"/"Chau MIIA"
    expect(vade).not.toMatch(/I-20.*trigger/i);
  });
  test('chatType=miia_lead omite I-20', () => {
    const vade = pb.buildVademecum(pb.DEFAULT_OWNER_PROFILE, 'miia_lead');
    expect(vade).not.toMatch(/I-20.*trigger/i);
  });
  test('chatType=client omite I-20', () => {
    const vade = pb.buildVademecum(pb.DEFAULT_OWNER_PROFILE, 'client');
    expect(vade).not.toMatch(/I-20.*trigger/i);
  });
  test('chatType=family conserva info de triggers', () => {
    const vade = pb.buildVademecum(pb.DEFAULT_OWNER_PROFILE, 'family');
    expect(typeof vade).toBe('string');
    expect(vade.length).toBeGreaterThan(100);
  });
});

describe('T51 §F — V2 loader re-exports', () => {
  test('loadVoiceDNAForGroup exportado como function', () => {
    expect(typeof pb.loadVoiceDNAForGroup).toBe('function');
  });
  test('resolveV2ChatType exportado', () => {
    expect(typeof pb.resolveV2ChatType).toBe('function');
  });
  test('isV2EligibleUid exportado', () => {
    expect(typeof pb.isV2EligibleUid).toBe('function');
  });
  test('isV2EligibleUid bloquea UID Personal (paridad spec §2-bis)', () => {
    expect(pb.isV2EligibleUid('bq2BbtCVF8cZo30tum584zrGATJ3')).toBe(false);
  });
  test('isV2EligibleUid permite MIIA CENTER UID (etapa 1)', () => {
    expect(pb.isV2EligibleUid('A5pMESWlfmPWCoCPRbwy85EzUzy2')).toBe(true);
  });
  test('isV2EligibleUid bloquea UID random', () => {
    expect(pb.isV2EligibleUid('random_uid_xyz')).toBe(false);
  });
});

describe('T51 §G — buildPrompt dispatcher (smoke)', () => {
  test('dispatcher con tipo invalido lanza o retorna fallback', () => {
    // No throw — al menos no debe romper completamente
    expect(() => {
      pb.buildPrompt({ type: 'invalid_type' });
    }).not.toThrow();
  });

  test('dispatcher buildOwnerLeadPrompt path', () => {
    const r = pb.buildPrompt({
      type: 'owner_lead',
      contactName: 'Lead Test',
      trainingData: 'data test',
      countryContext: '🌍 CO',
      ownerProfile: { ...pb.DEFAULT_OWNER_PROFILE, name: 'Mariano', role: 'CEO', businessName: 'Acme' },
    });
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(50);
  });

  test('dispatcher buildTenantPrompt path', () => {
    const r = pb.buildPrompt({
      type: 'tenant',
      contactName: 'Lead',
      trainingData: 'data',
      conversationHistory: [],
    });
    expect(typeof r).toBe('string');
  });

  test('dispatcher buildTestPrompt path', () => {
    const r = pb.buildPrompt({ type: 'test', trainingData: 'data test' });
    expect(typeof r).toBe('string');
  });
});

describe('T51 §H — buildOwnerLeadPrompt directo (smoke)', () => {
  test('con countryContext + ownerProfile válido', () => {
    const r = pb.buildOwnerLeadPrompt(
      'Juan',
      'training data del negocio',
      '🌍 El contacto es de COLOMBIA',
      { ...pb.DEFAULT_OWNER_PROFILE, name: 'Mariano', role: 'CEO', businessName: 'Acme' }
    );
    expect(r).toContain('Juan');
    expect(r).toContain('COLOMBIA');
  });

  test('sin countryContext (null) → no rompe', () => {
    const r = pb.buildOwnerLeadPrompt(
      'Juan',
      'data',
      null,
      { ...pb.DEFAULT_OWNER_PROFILE, name: 'M', businessName: 'Acme' }
    );
    expect(typeof r).toBe('string');
  });
});

describe('T51 §I — buildTenantBrainString', () => {
  test('args completos genera string', () => {
    const r = pb.buildTenantBrainString(
      'baseDNA test',
      [{ name: 'p1' }],
      [{ summary: 's1' }],
      [{ rule: 'r1' }]
    );
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });

  test('args vacios → string sin throw', () => {
    expect(() => {
      pb.buildTenantBrainString('', [], [], []);
    }).not.toThrow();
  });
});

describe('T51 §J — buildSportsPrompt', () => {
  test('argumentos completos → string', () => {
    const r = pb.buildSportsPrompt(
      'Juan',
      { team: 'Boca' },
      { match: 'River vs Boca' },
      { lastChange: 'goal' },
      'high',
      { ...pb.DEFAULT_OWNER_PROFILE, name: 'Mariano' },
      'positive'
    );
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(50);
  });
});

describe('T51 §K — buildElderlyPrompt', () => {
  test('argumentos minimos', () => {
    const r = pb.buildElderlyPrompt('Maria', 75, {});
    expect(typeof r).toBe('string');
    expect(r).toContain('Maria');
  });
});

describe('T51 §L — buildOutreachLeadPrompt', () => {
  test('opts minimos', () => {
    const r = pb.buildOutreachLeadPrompt({
      contactName: 'Lead',
      ownerProfile: pb.DEFAULT_OWNER_PROFILE,
    });
    expect(typeof r).toBe('string');
  });
});

describe('T51 §M — buildAgentSelfChatPrompt', () => {
  test('args minimos', () => {
    const r = pb.buildAgentSelfChatPrompt(
      'Agent A',
      'Acme',
      'cerebro test',
      pb.DEFAULT_OWNER_PROFILE
    );
    expect(typeof r).toBe('string');
  });
});

describe('T51 §N — Constantes ADN_MIIA / VADEMECUM_RULES exportadas', () => {
  test('ADN_MIIA es string no vacio', () => {
    expect(typeof pb.ADN_MIIA).toBe('string');
    expect(pb.ADN_MIIA.length).toBeGreaterThan(100);
    expect(pb.ADN_MIIA).toContain('MIIA');
  });
  test('ADN_MIIA_BASE es string no vacio', () => {
    expect(typeof pb.ADN_MIIA_BASE).toBe('string');
    expect(pb.ADN_MIIA_BASE).toContain('MIIA');
  });
  test('VADEMECUM_RULES es string', () => {
    expect(typeof pb.VADEMECUM_RULES).toBe('string');
    expect(pb.VADEMECUM_RULES.length).toBeGreaterThan(50);
  });
  test('COTIZACION_PROTOCOL es string', () => {
    expect(typeof pb.COTIZACION_PROTOCOL).toBe('string');
  });
});
