/**
 * Tests: C-431 §A.4 — ai_disclosure_enabled flag wire-in al auditor V2.
 *
 * Valida que el flag opt-in `ai_disclosure_enabled` del owner suprime el veto
 * RF#8 (admit IA en leads) sin liberar leak de mecánica interna.
 *
 * Cierra GAP-1 doctrinal CLAUDE.md §2: owners deben CONFIGURAR si MIIA admite
 * ser IA. Pre-C-431: hard-coded. Post-C-431: flag per-owner via endpoint
 * /api/owner/ai-disclosure.
 *
 * Origen: C-431 firmada bajo anchor [FIRMADO_VIVO_PLAN_CIMIENTOS_2026-04-27]
 * + ratificación viva Mariano "ejecutá C-431" turno 2026-04-27.
 */

'use strict';

const v2auditor = require('../core/v2_auditor');

describe('C-431 §A.3 — ai_disclosure_enabled wire-in v2_auditor', () => {
  // Reusamos auditV2Response para tests de integración del flag.
  // detectIALeak es función interna; el contract observable es a través
  // del auditor + ctx.aiDisclosureEnabled.

  test('A.4.1 — flag default (false): chatType=lead + admite IA → criticalFlags incluye RF8', () => {
    const result = v2auditor.auditV2Response(
      'Hola, soy una asistente de IA que te puede ayudar',
      'lead',
      { basePhone: '5491100000000', lastContactMessage: 'qué sos vos?' }
    );
    expect(result.flagged).toBe(true);
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).toContain('RF8_no_ia_con_leads');
  });

  test('A.4.2 — flag=true: chatType=lead + admite IA → NO criticalFlag RF8 (owner habilitó)', () => {
    const result = v2auditor.auditV2Response(
      'Hola, soy una asistente de IA que te puede ayudar',
      'lead',
      {
        basePhone: '5491100000000',
        lastContactMessage: 'qué sos vos?',
        aiDisclosureEnabled: true,
      }
    );
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).not.toContain('RF8_no_ia_con_leads');
  });

  test('A.4.3 — flag=true NO libera leak mecánica (Firestore/Baileys/prompt) → sigue RF8', () => {
    const result = v2auditor.auditV2Response(
      'Soy una IA que usa Firestore para guardar tus contactos',
      'lead',
      {
        basePhone: '5491100000000',
        lastContactMessage: 'qué tecnología usás?',
        aiDisclosureEnabled: true,
      }
    );
    expect(result.flagged).toBe(true);
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).toContain('RF8_no_ia_con_leads');
    // Verificamos que el detalle apunta a mecánica, no a identidad
    const ialeak = result.criticalFlags.find(f => f.code === 'RF8_no_ia_con_leads');
    expect(JSON.stringify(ialeak.detail)).toMatch(/firestore|infraestructura/i);
  });

  test('A.4.4 — chatType=miia_lead override (MIIA CENTER) ignora flag y siempre permite IA', () => {
    // Sin flag (default false) — miia_lead aún permite admitir IA.
    const result = v2auditor.auditV2Response(
      'Hola, soy MIIA, una asistente IA',
      'miia_lead',
      { basePhone: '5491100000000', lastContactMessage: 'qué sos?' }
    );
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).not.toContain('RF8_no_ia_con_leads');
  });

  test('A.4.5 — auditSafetyRules (V1 path) respeta aiDisclosureEnabled=true para identidad', () => {
    const result = v2auditor.auditSafetyRules(
      'Soy un asistente virtual del negocio',
      'lead',
      { basePhone: '5491100000000', aiDisclosureEnabled: true }
    );
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).not.toContain('RF8_no_ia_con_leads');
  });

  test('A.4.6 — auditSafetyRules (V1 path) sin flag mantiene veto identidad IA', () => {
    const result = v2auditor.auditSafetyRules(
      'Soy un asistente virtual del negocio',
      'lead',
      { basePhone: '5491100000000' }
    );
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).toContain('RF8_no_ia_con_leads');
  });

  test('A.4.7 — owner_selfchat ignora flag y siempre permite (Mariano consigo)', () => {
    const result = v2auditor.auditV2Response(
      'Soy una IA que automatiza mensajes para vos',
      'owner_selfchat',
      { basePhone: '573163937365', aiDisclosureEnabled: false }
    );
    const codes = result.criticalFlags.map(f => f.code);
    expect(codes).not.toContain('RF8_no_ia_con_leads');
  });
});

describe('C-431 §B — granularidad consent_records (static checks server.js)', () => {
  const fs = require('fs');
  const path = require('path');
  const SERVER_JS = fs.readFileSync(
    path.resolve(__dirname, '..', 'server.js'),
    'utf8'
  );

  test('B.4.1 — endpoint /api/consent/adn escribe consent_type="adn_mining"', () => {
    expect(SERVER_JS).toMatch(/app\.post\(\s*['"]\/api\/consent\/adn['"]/);
    // Find the section between /api/consent/adn handler start and next app.post / app.get
    const adnIdx = SERVER_JS.indexOf("/api/consent/adn");
    expect(adnIdx).toBeGreaterThan(0);
    const nextHandlerRe = /app\.(post|get|put|delete)\(/g;
    nextHandlerRe.lastIndex = adnIdx + 1;
    const next = nextHandlerRe.exec(SERVER_JS);
    const block = SERVER_JS.slice(adnIdx, next ? next.index : adnIdx + 4000);
    expect(block).toMatch(/consent_type:\s*['"]adn_mining['"]/);
  });

  test('B.4.2 — endpoint /api/owner/ai-disclosure existe + escribe consent_type="ai_disclosure"', () => {
    expect(SERVER_JS).toMatch(/app\.post\(\s*['"]\/api\/owner\/ai-disclosure['"]/);
    const aiIdx = SERVER_JS.indexOf("/api/owner/ai-disclosure");
    expect(aiIdx).toBeGreaterThan(0);
    const nextHandlerRe = /app\.(post|get|put|delete)\(/g;
    nextHandlerRe.lastIndex = aiIdx + 1;
    const next = nextHandlerRe.exec(SERVER_JS);
    const block = SERVER_JS.slice(aiIdx, next ? next.index : aiIdx + 4000);
    expect(block).toMatch(/consent_type:\s*['"]ai_disclosure['"]/);
    expect(block).toMatch(/ai_disclosure_enabled/);
    expect(block).toMatch(/ai_disclosure_set_at/);
  });

  test('B.4.3 — endpoint ai-disclosure usa append-only doc id (timestamp suffix)', () => {
    const aiIdx = SERVER_JS.indexOf("/api/owner/ai-disclosure");
    const block = SERVER_JS.slice(aiIdx, aiIdx + 4000);
    // El doc id debe incluir timestamp para garantizar append-only audit trail
    // (NO sobrescribe records previos del mismo uid).
    expect(block).toMatch(/consent_records.*\$\{uid\}_ai_disclosure_\$\{ts\}|consent_records.*ai_disclosure.*Date\.now/);
  });

  test('B.4.4 — endpoint ai-disclosure valida tipo boolean para enabled', () => {
    const aiIdx = SERVER_JS.indexOf("/api/owner/ai-disclosure");
    const block = SERVER_JS.slice(aiIdx, aiIdx + 4000);
    expect(block).toMatch(/typeof\s+enabled\s*!==?\s*['"]boolean['"]/);
  });

  test('B.4.5 — owner profile loader cargue ai_disclosure_enabled del Firestore', () => {
    const TMH = fs.readFileSync(
      path.resolve(__dirname, '..', 'whatsapp', 'tenant_message_handler.js'),
      'utf8'
    );
    expect(TMH).toMatch(/aiDisclosureEnabled:\s*data\.ai_disclosure_enabled\s*===\s*true/);
  });
});
