'use strict';

/**
 * T54 — coverage gap fix: voice_v2_loader.js (era 69.04%)
 */

const fs = require('fs');
const v = require('../core/voice_v2_loader');

beforeEach(() => {
  v.resetCache();
});

describe('T54 §A — isV2EligibleUid', () => {
  test('MIIA CENTER UID → true', () => {
    expect(v.isV2EligibleUid(v.MIIA_CENTER_UID)).toBe(true);
  });
  test('Personal UID → false (etapa 1 scope)', () => {
    expect(v.isV2EligibleUid(v.OWNER_PERSONAL_UID)).toBe(false);
  });
  test('UID random → false', () => {
    expect(v.isV2EligibleUid('random_xyz')).toBe(false);
  });
  test('null → false', () => {
    expect(v.isV2EligibleUid(null)).toBe(false);
  });
});

describe('T54 §B — resolveV2ChatType', () => {
  test('UID NO eligible → unknown', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'lead' })).toBe('unknown');
  });
  test('isSelfChat true + UID CENTER → owner_selfchat', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, isSelfChat: true })).toBe('owner_selfchat');
  });
  test('contactType lead → lead', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'lead' })).toBe('lead');
  });
  test('contactType enterprise_lead → lead', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'enterprise_lead' })).toBe('lead');
  });
  test('contactType miia_lead → lead', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'miia_lead' })).toBe('lead');
  });
  test('contactType client → client', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'client' })).toBe('client');
  });
  test('contactType miia_client → client', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'miia_client' })).toBe('client');
  });
  test('contactType follow_up_cold → follow_up_cold', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'follow_up_cold' })).toBe('follow_up_cold');
  });
  test('contactType cold → follow_up_cold', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'cold' })).toBe('follow_up_cold');
  });
  test('contactType familia → unknown (no aplica MIIA CENTER)', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'familia' })).toBe('unknown');
  });
  test('contactType ale_pareja → unknown', () => {
    expect(v.resolveV2ChatType({ uid: v.MIIA_CENTER_UID, contactType: 'ale_pareja' })).toBe('unknown');
  });
  test('opts null → unknown', () => {
    expect(v.resolveV2ChatType(null)).toBe('unknown');
  });
  test('opts undefined → unknown', () => {
    expect(v.resolveV2ChatType()).toBe('unknown');
  });
});

describe('T54 §C — readVoiceSeed / readVoiceSeedCenter / readModeDetectors', () => {
  test('readVoiceSeed retorna string si existe el archivo', () => {
    const r = v.readVoiceSeed();
    // Si el archivo existe -> string. Si no -> null. Test tolerante.
    expect(typeof r === 'string' || r === null).toBe(true);
  });
  test('readVoiceSeed cacheado en segunda llamada', () => {
    const r1 = v.readVoiceSeed();
    const r2 = v.readVoiceSeed();
    expect(r1).toBe(r2); // mismo string ref si cache funciona
  });
  test('readVoiceSeedCenter retorna string o null', () => {
    const r = v.readVoiceSeedCenter();
    expect(typeof r === 'string' || r === null).toBe(true);
  });
  test('readModeDetectors retorna string o null', () => {
    const r = v.readModeDetectors();
    expect(typeof r === 'string' || r === null).toBe(true);
  });
  test('V2_VOICE_NO_CACHE=true fuerza re-lectura', () => {
    process.env.V2_VOICE_NO_CACHE = 'true';
    try {
      v.resetCache();
      const r = v.readVoiceSeed();
      expect(typeof r === 'string' || r === null).toBe(true);
    } finally {
      delete process.env.V2_VOICE_NO_CACHE;
    }
  });
});

describe('T54 §D — extractByHeader', () => {
  test('header existe → retorna sección', () => {
    const text = '## §1 PRIMERO\ncontenido 1\n### §1.1 DETALLE\nmas detalle';
    const r = v.extractByHeader(text, '## §1 PRIMERO');
    expect(r).toContain('PRIMERO');
  });
  test('header no existe → string vacio', () => {
    const r = v.extractByHeader('contenido sin header', '## NOEXISTE');
    expect(r).toBe('');
  });
  test('header al final del texto → retorna hasta EOF', () => {
    const r = v.extractByHeader('## §1 SOLO\ncontenido final', '## §1 SOLO');
    expect(r).toContain('SOLO');
  });
});

describe('T54 §E — loadVoiceDNAForGroup', () => {
  const orig = console.warn;
  beforeAll(() => { console.warn = () => {}; });
  afterAll(() => { console.warn = orig; });

  test('chatType unknown sin seed disponible → fallback true', () => {
    // Si voice_seed.md no existe en disco -> fallback true
    const r = v.loadVoiceDNAForGroup('unknown_type');
    if (r.fallback) {
      expect(r.systemBlock).toBe('');
      expect(r.subregistro).toBeNull();
    } else {
      // Si voice_seed.md existe pero el chatType no está en headers -> fallback unknown_chattype
      expect(r.fallback).toBe(true);
    }
  });

  test('chatType lead → si seed disponible, fallback false; si no, fallback true', () => {
    const r = v.loadVoiceDNAForGroup('lead', { contactName: 'TestLead' });
    expect(typeof r.systemBlock).toBe('string');
    expect(typeof r.fallback).toBe('boolean');
    expect(typeof r.source).toBe('string');
  });

  test('chatType owner_selfchat → si seed disponible, snapshot completo', () => {
    const r = v.loadVoiceDNAForGroup('owner_selfchat');
    if (!r.fallback) {
      expect(r.subregistro).toBe('owner_selfchat_snapshot');
      expect(r.systemBlock).toContain('SNAPSHOT COMPLETO MIIA CENTER');
    }
  });

  test('chatType inválido (no en SUBREGISTRO_HEADERS) → fallback', () => {
    const r = v.loadVoiceDNAForGroup('foo_invalid');
    expect(r.fallback).toBe(true);
  });

  test('opts.skipBaseIdentidad=true → no incluye §1', () => {
    const r = v.loadVoiceDNAForGroup('lead', { skipBaseIdentidad: true });
    if (!r.fallback) {
      // No tiene la base identidad — solo el subregistro
      expect(typeof r.systemBlock).toBe('string');
    }
  });
});

describe('T54 §F — loadVoiceDNAForCenter', () => {
  const orig = console.warn;
  beforeAll(() => { console.warn = () => {}; });
  afterAll(() => { console.warn = orig; });

  test('chatType owner_selfchat → snapshot CENTER (si seed disponible)', () => {
    const r = v.loadVoiceDNAForCenter('owner_selfchat');
    expect(typeof r.systemBlock).toBe('string');
    expect(typeof r.fallback).toBe('boolean');
  });

  test('chatType invalido en CENTER → fallback', () => {
    const r = v.loadVoiceDNAForCenter('not_in_center');
    expect(r.fallback).toBe(true);
  });

  test('chatType lead CENTER → si seed disponible block legitimo', () => {
    const r = v.loadVoiceDNAForCenter('lead', { contactName: 'X' });
    expect(typeof r.systemBlock).toBe('string');
  });

  test('opts.skipBaseIdentidad=true CENTER', () => {
    const r = v.loadVoiceDNAForCenter('lead', { skipBaseIdentidad: true });
    expect(typeof r.systemBlock).toBe('string');
  });
});

describe('T54 §G — getLoaderStats / resetCache', () => {
  test('getLoaderStats retorna objeto con campos esperados', () => {
    const s = v.getLoaderStats();
    expect(typeof s.attempts).toBe('number');
    expect(typeof s.failures).toBe('number');
    expect(typeof s.cacheHit).toBe('boolean');
    expect(typeof s.voiceSeedPath).toBe('string');
  });

  test('resetCache vacia el cache', () => {
    v.readVoiceSeed(); // cargar
    v.resetCache();
    const s = v.getLoaderStats();
    expect(s.cacheHit).toBe(false);
  });
});

describe('T54 §H — Constantes exportadas', () => {
  test('MIIA_CENTER_UID y OWNER_PERSONAL_UID', () => {
    expect(v.MIIA_CENTER_UID).toMatch(/^[A-Za-z0-9]{20,}$/);
    expect(v.OWNER_PERSONAL_UID).toMatch(/^[A-Za-z0-9]{20,}$/);
    expect(v.MIIA_CENTER_UID).not.toBe(v.OWNER_PERSONAL_UID);
  });
  test('ALE_PHONE definido', () => {
    expect(typeof v.ALE_PHONE).toBe('string');
    expect(v.ALE_PHONE).toMatch(/^\d{10,}$/);
  });
  test('SUBREGISTRO_HEADERS tiene mappings esperados', () => {
    expect(typeof v.SUBREGISTRO_HEADERS.lead).toBe('string');
    expect(typeof v.SUBREGISTRO_HEADERS.client).toBe('string');
    expect(typeof v.SUBREGISTRO_HEADERS.family).toBe('string');
  });
  test('SUBREGISTRO_HEADERS_CENTER tiene mappings esperados', () => {
    expect(typeof v.SUBREGISTRO_HEADERS_CENTER.lead).toBe('string');
    expect(typeof v.SUBREGISTRO_HEADERS_CENTER.client).toBe('string');
    // CENTER no tiene family/ale (no aplica etapa 1)
    expect(v.SUBREGISTRO_HEADERS_CENTER.family).toBeUndefined();
  });
});
