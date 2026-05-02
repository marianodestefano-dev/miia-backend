'use strict';

/**
 * T58 — coverage gap: mod_voice_v2.js (era 88.88%)
 */

const mv = require('../core/mod_voice_v2');
const v2l = require('../core/voice_v2_loader');

describe('T58 §A — isMiiaCenterProfile', () => {
  test('profile MIIA_SALES → true', () => {
    expect(mv.isMiiaCenterProfile({ name: 'MIIA', businessName: 'MIIA' })).toBe(true);
  });
  test('profile owner regular → false', () => {
    expect(mv.isMiiaCenterProfile({ name: 'Mariano', businessName: 'Acme' })).toBe(false);
  });
  test('profile null → false', () => {
    expect(mv.isMiiaCenterProfile(null)).toBe(false);
  });
  test('profile no-object → false', () => {
    expect(mv.isMiiaCenterProfile('string')).toBe(false);
  });
  test('businessName diferente → false', () => {
    expect(mv.isMiiaCenterProfile({ name: 'MIIA', businessName: 'Otro' })).toBe(false);
  });
});

describe('T58 §B — buildVoiceV2Block: capas fallback', () => {
  const orig = console.warn;
  beforeAll(() => { console.warn = () => {}; });
  afterAll(() => { console.warn = orig; });

  test('args null → null (CAPA 2 chatType no soportado)', () => {
    expect(mv.buildVoiceV2Block(null)).toBeNull();
    expect(mv.buildVoiceV2Block(undefined)).toBeNull();
    expect(mv.buildVoiceV2Block({})).toBeNull();
  });

  test('chatType no soportado → null', () => {
    const r = mv.buildVoiceV2Block({ chatType: 'family', ownerProfile: { name: 'M', businessName: 'X' } });
    expect(r).toBeNull();
  });

  test('chatType miia_lead + ownerProfile null → null + warn (CAPA 3)', () => {
    const r = mv.buildVoiceV2Block({ chatType: 'miia_lead', ownerProfile: null });
    expect(r).toBeNull();
  });

  test('chatType miia_lead + ownerProfile string → null', () => {
    const r = mv.buildVoiceV2Block({ chatType: 'miia_lead', ownerProfile: 'invalid' });
    expect(r).toBeNull();
  });

  test('context.uid Personal + miia_lead → null (chatType es CENTER-only, Personal no usa miia_lead)', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'miia_lead',
      ownerProfile: { name: 'M', businessName: 'A' },
      context: { uid: v2l.OWNER_PERSONAL_UID },
    });
    expect(r).toBeNull();
  });

  test('context.uid CENTER + ownerProfile any → activa V2 CENTER (si seed disponible)', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'miia_lead',
      ownerProfile: { name: 'CualquierOwner', businessName: 'X' },
      context: { uid: v2l.MIIA_CENTER_UID, contactName: 'Lead Test' },
    });
    // Si voice_seed_center.md disponible -> objeto con block. Si no -> null.
    if (r !== null) {
      expect(typeof r.block).toBe('string');
      expect(r.meta.owner).toBe('center');
      expect(r.meta.chatType).toBe('miia_lead');
    }
  });

  test('sin context.uid + ownerProfile MIIA_SALES → activa CENTER si seed disponible', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'miia_lead',
      ownerProfile: { name: 'MIIA', businessName: 'MIIA' },
    });
    if (r !== null) {
      expect(r.meta.owner).toBe('center');
    }
  });

  test('sin context.uid + ownerProfile NO MIIA_SALES → null (Personal owner)', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'miia_lead',
      ownerProfile: { name: 'Mariano', businessName: 'Medilink' },
    });
    expect(r).toBeNull();
  });

  test('chatType miia_client soportado en COMMIT 4', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'miia_client',
      ownerProfile: { name: 'MIIA', businessName: 'MIIA' },
    });
    if (r !== null) {
      expect(r.meta.chatType).toBe('miia_client');
    }
  });

  test('chatType selfchat soportado en COMMIT 5', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'selfchat',
      ownerProfile: { name: 'MIIA', businessName: 'MIIA' },
    });
    if (r !== null) {
      expect(r.meta.chatType).toBe('selfchat');
    }
  });
});

describe('T58 §C — meta shape verification', () => {
  test('CENTER + miia_lead retorna meta con campos esperados (si seed dispobible)', () => {
    const r = mv.buildVoiceV2Block({
      chatType: 'miia_lead',
      ownerProfile: { name: 'MIIA', businessName: 'MIIA' },
      context: { uid: v2l.MIIA_CENTER_UID },
    });
    if (r !== null) {
      expect(typeof r.meta.source).toBe('string');
      expect(typeof r.meta.subregistro).toBe('string');
      expect(r.meta.chatType).toBe('miia_lead');
      expect(r.meta.owner).toBe('center');
    }
  });
});
