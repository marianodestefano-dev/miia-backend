/**
 * Tests: mod_voice_v2 (COMMIT 2 A1 — CARTA_C-397 §5 + ANEXO 2026-04-23)
 *
 * Scope COMMIT 2:
 *   - buildVoiceV2Block() responde SOLO a chatType='miia_lead'.
 *   - CENTER profile (MIIA_SALES_PROFILE marker) → bloque voice_seed_center.md §2.1.
 *   - Personal profile → null (ETAPA 1 C-388 D.1).
 *   - 4 capas de fallback cubiertas.
 */

'use strict';

const { buildVoiceV2Block, isMiiaCenterProfile } = require('../core/mod_voice_v2');
const { resetCache, MIIA_CENTER_UID, OWNER_PERSONAL_UID } = require('../core/voice_v2_loader');
const { assemblePrompt } = require('../core/prompt_modules');

describe('mod_voice_v2 — COMMIT 2 A1 (C-397 §5)', () => {
  beforeEach(() => {
    resetCache();
  });

  const centerProfile = {
    name: 'MIIA',
    businessName: 'MIIA',
    role: 'ventas MIIA producto'
  };
  const personalProfile = {
    name: 'Mariano De Stefano',
    businessName: 'MediLink',
    role: 'médico'
  };

  // ─────────────────────────────────────────────────────────────────────
  describe('isMiiaCenterProfile()', () => {
    test('MIIA_SALES_PROFILE marker (name=MIIA + businessName=MIIA) → true', () => {
      expect(isMiiaCenterProfile(centerProfile)).toBe(true);
    });

    test('Personal profile (name=Mariano De Stefano) → false', () => {
      expect(isMiiaCenterProfile(personalProfile)).toBe(false);
    });

    test('null → false', () => {
      expect(isMiiaCenterProfile(null)).toBe(false);
    });

    test('undefined → false', () => {
      expect(isMiiaCenterProfile(undefined)).toBe(false);
    });

    test('perfil con name=MIIA pero businessName distinto → false (marker incompleto)', () => {
      expect(isMiiaCenterProfile({ name: 'MIIA', businessName: 'Other' })).toBe(false);
    });

    test('perfil con businessName=MIIA pero name distinto → false', () => {
      expect(isMiiaCenterProfile({ name: 'SomeBot', businessName: 'MIIA' })).toBe(false);
    });

    test('string (no-object) → false', () => {
      expect(isMiiaCenterProfile('MIIA')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — chatType=miia_lead + CENTER profile', () => {
    test('devuelve bloque + meta con source voice_seed_center.md', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile,
        context: { uid: MIIA_CENTER_UID, contactName: 'Dr. Pérez' }
      });
      expect(out).not.toBeNull();
      expect(typeof out.block).toBe('string');
      expect(out.block.length).toBeGreaterThan(100);
      expect(out.block).toContain('VOICE DNA V2');
      expect(out.block).toContain('leads_medilink');
      expect(out.meta).toMatchObject({
        chatType: 'miia_lead',
        owner: 'center',
        subregistro: 'lead'
      });
      expect(out.meta.source).toContain('voice_seed_center.md');
    });

    test('CENTER sin uid (solo marker) → sigue funcionando', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile,
        context: { contactName: 'Dr. X' }
      });
      expect(out).not.toBeNull();
      expect(out.meta.owner).toBe('center');
    });

    test('CENTER sin context → funciona (context es opcional)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile
      });
      expect(out).not.toBeNull();
    });

    test('incluye IDENTIDAD BASE COMÚN §1 + subregistro §2.1', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile,
        context: { uid: MIIA_CENTER_UID }
      });
      // §1 debe incluir regla de delatar-IA
      expect(out.block).toMatch(/IDENTIDAD BASE/i);
      // §2.1 leads_medilink debe estar incluido
      expect(out.block).toContain('leads_medilink');
    });

    test('CENTER delata-IA ("soy IA") está en el bloque (§1 identidad CENTER)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile
      });
      // CENTER puede decir que es IA — esto debe aparecer en el seed
      expect(out.block).toMatch(/IA/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — chatType=miia_client + CENTER profile (COMMIT 4)', () => {
    test('devuelve bloque §2.2 clientes_medilink + meta.chatType=miia_client', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_client',
        ownerProfile: centerProfile,
        context: { uid: MIIA_CENTER_UID, contactName: 'Dr. Cliente' }
      });
      expect(out).not.toBeNull();
      expect(out.block).toContain('VOICE DNA V2');
      expect(out.block).toContain('clientes_medilink');
      expect(out.meta).toMatchObject({
        chatType: 'miia_client',
        owner: 'center',
        subregistro: 'client'
      });
    });

    test('Personal profile + miia_client → null (ETAPA 1 no elegible)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_client',
        ownerProfile: personalProfile,
        context: { uid: OWNER_PERSONAL_UID }
      });
      expect(out).toBeNull();
    });

    test('miia_client + CENTER sin uid → sigue funcionando por marker', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_client',
        ownerProfile: centerProfile
      });
      expect(out).not.toBeNull();
      expect(out.meta.subregistro).toBe('client');
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — chatType=miia_lead + Personal profile', () => {
    test('Personal profile → null (ETAPA 1 no elegible)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: personalProfile,
        context: { uid: OWNER_PERSONAL_UID }
      });
      expect(out).toBeNull();
    });

    test('Personal profile sin uid → null (marker no-CENTER)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: personalProfile
      });
      expect(out).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — chatType no soportado en COMMIT 2', () => {
    test('chatType=selfchat → null (COMMIT 5 lo activa)', () => {
      const out = buildVoiceV2Block({
        chatType: 'selfchat',
        ownerProfile: centerProfile,
        context: { uid: MIIA_CENTER_UID }
      });
      expect(out).toBeNull();
    });

    test('chatType=family_chat → null (COMMIT 6 lo activa vía Personal)', () => {
      const out = buildVoiceV2Block({
        chatType: 'family_chat',
        ownerProfile: centerProfile
      });
      expect(out).toBeNull();
    });

    test('chatType=medilink_team → null (COMMIT 7 lo activa vía Personal)', () => {
      const out = buildVoiceV2Block({
        chatType: 'medilink_team',
        ownerProfile: centerProfile
      });
      expect(out).toBeNull();
    });

    test('chatType null → null', () => {
      expect(buildVoiceV2Block({ chatType: null, ownerProfile: centerProfile })).toBeNull();
    });

    test('chatType undefined → null', () => {
      expect(buildVoiceV2Block({ chatType: undefined, ownerProfile: centerProfile })).toBeNull();
    });

    test('chatType string aleatorio → null', () => {
      expect(buildVoiceV2Block({ chatType: 'random_foo', ownerProfile: centerProfile })).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — CAPA 3 ownerProfile inválido', () => {
    test('ownerProfile null → null + warn', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const out = buildVoiceV2Block({ chatType: 'miia_lead', ownerProfile: null });
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('ownerProfile undefined → null + warn', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const out = buildVoiceV2Block({ chatType: 'miia_lead', ownerProfile: undefined });
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('ownerProfile string → null + warn', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const out = buildVoiceV2Block({ chatType: 'miia_lead', ownerProfile: 'not-an-object' });
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — defensa en profundidad guard UID', () => {
    test('CENTER profile pero uid=Personal → null (guard C-388)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile,
        context: { uid: OWNER_PERSONAL_UID }
      });
      expect(out).toBeNull();
    });

    test('CENTER profile con uid random → null (no elegible)', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile,
        context: { uid: 'aPiLM9Z7hdU4Oo2alzTX9gGxfCj2' }
      });
      expect(out).toBeNull();
    });

    test('CENTER profile con uid correcto → OK', () => {
      const out = buildVoiceV2Block({
        chatType: 'miia_lead',
        ownerProfile: centerProfile,
        context: { uid: MIIA_CENTER_UID }
      });
      expect(out).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('Wire-in en assemblePrompt() — COMMIT 3 A1', () => {
    // MIIA_SALES_PROFILE real tiene role='ventas MIIA producto' por guardia integridad L634
    const miiaSalesProfile = {
      name: 'MIIA',
      businessName: 'MIIA',
      role: 'ventas MIIA producto',
      passions: 'ayudar a médicos'
    };

    test('assemblePrompt(miia_lead + CENTER) → inyecta V2 + meta.v2 poblado', () => {
      const result = assemblePrompt({
        chatType: 'miia_lead',
        messageBody: 'Hola, quería saber qué es MIIA',
        ownerProfile: miiaSalesProfile,
        context: { uid: MIIA_CENTER_UID, contactName: 'Dr. Test' }
      });
      expect(result.prompt).toContain('VOICE DNA V2');
      expect(result.prompt).toContain('leads_medilink');
      expect(result.meta.modulesLoaded).toContain('mod_voice_v2');
      expect(result.meta.v2).not.toBeNull();
      expect(result.meta.v2).toMatchObject({
        chatType: 'miia_lead',
        owner: 'center',
        subregistro: 'lead'
      });
    });

    test('assemblePrompt(miia_lead + CENTER sin uid) → V2 igual se inyecta por marker', () => {
      const result = assemblePrompt({
        chatType: 'miia_lead',
        messageBody: 'hola',
        ownerProfile: miiaSalesProfile,
        context: {}
      });
      expect(result.meta.modulesLoaded).toContain('mod_voice_v2');
      expect(result.meta.v2).not.toBeNull();
    });

    test('assemblePrompt(lead + Personal profile) → NO inyecta V2 (V1 puro)', () => {
      const result = assemblePrompt({
        chatType: 'lead',
        messageBody: 'hola',
        ownerProfile: { name: 'Mariano De Stefano', businessName: 'MediLink', role: 'médico' },
        context: { uid: OWNER_PERSONAL_UID }
      });
      expect(result.meta.modulesLoaded).not.toContain('mod_voice_v2');
      expect(result.meta.v2).toBeNull();
      expect(result.prompt).not.toContain('VOICE DNA V2');
    });

    test('assemblePrompt(selfchat + CENTER) → COMMIT 3 scope NO activa V2 en selfchat', () => {
      // En COMMIT 3 solo miia_lead activa V2. selfchat se activa en COMMIT 5.
      const result = assemblePrompt({
        chatType: 'selfchat',
        messageBody: 'hola',
        ownerProfile: miiaSalesProfile,
        context: { uid: MIIA_CENTER_UID, isAdmin: true }
      });
      expect(result.meta.modulesLoaded).not.toContain('mod_voice_v2');
      expect(result.meta.v2).toBeNull();
    });

    test('assemblePrompt(miia_client + CENTER) → COMMIT 4 activa V2 con §2.2', () => {
      const result = assemblePrompt({
        chatType: 'miia_client',
        messageBody: 'tengo un problema',
        ownerProfile: miiaSalesProfile,
        context: { uid: MIIA_CENTER_UID }
      });
      expect(result.meta.modulesLoaded).toContain('mod_voice_v2');
      expect(result.prompt).toContain('clientes_medilink');
      expect(result.meta.v2).toMatchObject({
        chatType: 'miia_client',
        owner: 'center',
        subregistro: 'client'
      });
    });

    test('assemblePrompt NO rompe si module mod_voice_v2 retorna null (V1 pipeline intacto)', () => {
      const result = assemblePrompt({
        chatType: 'lead', // Personal path — V2 NO se activa
        messageBody: 'hola',
        ownerProfile: { name: 'Test User', businessName: 'Test Co', role: 'owner' }
      });
      // V1 clásico: debe tener core_identity, core_rules, mod_lead_sales
      expect(result.meta.modulesLoaded).toContain('core_identity');
      expect(result.meta.modulesLoaded).toContain('mod_lead_sales');
      expect(result.meta.divergences).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  describe('buildVoiceV2Block() — CAPA 4 no crashea ante excepciones', () => {
    test('args null → null (no crashea)', () => {
      expect(() => buildVoiceV2Block(null)).not.toThrow();
      // buildVoiceV2Block(null) → rompe destructuring default, se maneja en try
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const out = buildVoiceV2Block(null);
      expect(out).toBeNull();
      errSpy.mockRestore();
    });

    test('args undefined → null (no crashea)', () => {
      expect(() => buildVoiceV2Block(undefined)).not.toThrow();
      expect(buildVoiceV2Block(undefined)).toBeNull();
    });

    test('args {} → null (no crashea)', () => {
      expect(() => buildVoiceV2Block({})).not.toThrow();
      expect(buildVoiceV2Block({})).toBeNull();
    });
  });
});
