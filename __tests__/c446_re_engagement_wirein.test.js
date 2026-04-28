/**
 * Tests: C-446-FIX-ADN §C.2 — wire-in TMH re-engagement.
 *
 * Static regex sobre tenant_message_handler.js verifica wire-in correcto.
 * Continuidad C-440 patrón.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TMH_PATH = path.resolve(__dirname, '../whatsapp/tenant_message_handler.js');
const SOURCE = fs.readFileSync(TMH_PATH, 'utf8');

describe('C-446-FIX-ADN §C.2 — wire-in TMH re-engagement', () => {
  test('A.1 — require core/re_engagement importado', () => {
    expect(SOURCE).toMatch(/require\(['"]\.\.\/core\/re_engagement['"]\)/);
  });

  test('A.2 — detectReEngagement invocado', () => {
    expect(SOURCE).toMatch(/reEngagement\.detectReEngagement\s*\(/);
  });

  test('A.3 — buildReEngagementContext invocado', () => {
    expect(SOURCE).toMatch(/reEngagement\.buildReEngagementContext\s*\(/);
  });

  test('A.4 — auditReEngagementResponse invocado', () => {
    expect(SOURCE).toMatch(/reEngagement\.auditReEngagementResponse\s*\(/);
  });

  test('A.5 — guard isSelfChat + LEAD_LIKE_TYPES en pre-check', () => {
    const block = SOURCE.match(/!isSelfChat[\s&\w.]+reEngagement\.LEAD_LIKE_TYPES\.has/);
    expect(block).not.toBeNull();
  });

  test('A.6 — try/catch defensivo en wire-in inyección', () => {
    // Verifica que la lógica re-engagement está dentro de try/catch
    const block = SOURCE.match(/try\s*\{[\s\S]{0,800}?detectReEngagement[\s\S]{0,800}?\}\s*catch/);
    expect(block).not.toBeNull();
  });

  test('A.7 — log [C-446][§C][RE-ENGAGEMENT] presente', () => {
    expect(SOURCE).toContain('[C-446][§C][RE-ENGAGEMENT]');
  });

  test('A.8 — log [V2-ALERT][RE-ENGAGEMENT-WIRE-IN] error path', () => {
    expect(SOURCE).toContain('[V2-ALERT][RE-ENGAGEMENT-WIRE-IN]');
  });

  test('A.9 — auditReEngagementResponse + regeneración wire-in', () => {
    const block = SOURCE.match(/auditReEngagementResponse[\s\S]{0,500}?shouldVeto[\s\S]{0,500}?smartCall/);
    expect(block).not.toBeNull();
  });

  test('A.10 — fullPrompt += reBlock (no overwrite)', () => {
    expect(SOURCE).toMatch(/fullPrompt\s*\+=\s*reBlock/);
  });
});
