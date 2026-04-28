/**
 * Tests: C-446-FIX-ADN §B.2 wire-in TMH probadita real.
 *
 * Static regex sobre tenant_message_handler.js. Continuidad C-440 patrón.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TMH_PATH = path.resolve(__dirname, '../whatsapp/tenant_message_handler.js');
const SOURCE = fs.readFileSync(TMH_PATH, 'utf8');

describe('C-446-FIX-ADN §B.2 — wire-in TMH probadita real', () => {
  test('A.1 — require core/probadita_real importado', () => {
    expect(SOURCE).toMatch(/require\(['"]\.\.\/core\/probadita_real['"]\)/);
  });

  test('A.2 — probaditaReal.detectProbaditaFeatures invocado', () => {
    expect(SOURCE).toMatch(/probaditaReal\.detectProbaditaFeatures\s*\(/);
  });

  test('A.3 — probaditaReal.buildProbaditaPromptContext invocado', () => {
    expect(SOURCE).toMatch(/probaditaReal\.buildProbaditaPromptContext\s*\(/);
  });

  test('A.4 — guard isV2EligibleUid + LEAD_LIKE_TYPES', () => {
    const block = SOURCE.match(/LEAD_LIKE_TYPES\.has\(contactType\)\s*&&\s*isV2EligibleUid\(uid\)[\s\S]{0,300}?detectProbaditaFeatures/);
    expect(block).not.toBeNull();
  });

  test('A.5 — try/catch defensivo en wire-in', () => {
    const block = SOURCE.match(/try\s*\{[\s\S]{0,500}?detectProbaditaFeatures[\s\S]{0,500}?\}\s*catch/);
    expect(block).not.toBeNull();
  });

  test('A.6 — log [C-446][§B.2][PROBADITA-REAL] presente', () => {
    expect(SOURCE).toContain('[C-446][§B.2][PROBADITA-REAL]');
  });

  test('A.7 — log [V2-ALERT][PROBADITA-REAL-WIRE-IN] error path', () => {
    expect(SOURCE).toContain('[V2-ALERT][PROBADITA-REAL-WIRE-IN]');
  });

  test('A.8 — fullPrompt += probaditaBlock (no overwrite)', () => {
    expect(SOURCE).toMatch(/fullPrompt\s*\+=\s*probaditaBlock/);
  });

  test('A.9 — guard !isSelfChat (no aplica self-chat Mariano)', () => {
    const block = SOURCE.match(/!isSelfChat[\s&\w.]+messageBody[\s&\w.]+contactType[\s\S]{0,300}?detectProbaditaFeatures/);
    expect(block).not.toBeNull();
  });
});
