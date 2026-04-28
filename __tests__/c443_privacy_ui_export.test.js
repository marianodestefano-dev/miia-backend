/**
 * Tests: C-443 Privacy UI dashboard + export JSON.
 *
 * Origen: CARTA_C-443 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27].
 *
 * Static regex tests sobre server.js (endpoint export) +
 * owner-dashboard.html (UI). Continuidad C-440/C-442 patrón.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SERVER_SRC = fs.readFileSync(SERVER_PATH, 'utf8');

const HTML_PATH = path.resolve(__dirname, '../../miia-frontend/owner-dashboard.html');
const HTML_SRC = fs.existsSync(HTML_PATH) ? fs.readFileSync(HTML_PATH, 'utf8') : '';

// ════════════════════════════════════════════════════════════════════
// §A — Endpoint /api/privacy/report/export wire-in
// ════════════════════════════════════════════════════════════════════

describe('C-443 §A — endpoint /api/privacy/report/export', () => {
  test('A.1 — endpoint registrado con app.get', () => {
    expect(SERVER_SRC).toMatch(/app\.get\(\s*['"]\/api\/privacy\/report\/export['"]/);
  });

  test('A.2 — usa rrRequireAuth + rrRequireOwnerOfResource (continuidad C-442)', () => {
    const block = SERVER_SRC.match(/app\.get\(\s*['"]\/api\/privacy\/report\/export['"][\s\S]{0,500}?async/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/rrRequireAuth/);
    expect(block[0]).toMatch(/rrRequireOwnerOfResource/);
  });

  test('A.3 — middleware Zod validate aplicado', () => {
    const block = SERVER_SRC.match(/app\.get\(\s*['"]\/api\/privacy\/report\/export['"][\s\S]{0,500}?async/);
    expect(block[0]).toMatch(/publicSchemas\.validate.*privacyReportRequestSchema/);
  });

  test('A.4 — Content-Disposition attachment con filename', () => {
    expect(SERVER_SRC).toMatch(/Content-Disposition[\s\S]{0,200}attachment[\s\S]{0,200}filename/);
  });

  test('A.5 — buildPrivacyReport invocado (reusa C-442)', () => {
    const block = SERVER_SRC.match(/app\.get\(\s*['"]\/api\/privacy\/report\/export['"][\s\S]{0,1500}?\n\)/);
    expect(block[0]).toMatch(/privacyReportBuilder\.buildPrivacyReport/);
  });

  test('A.6 — log [V2-ALERT][PRIVACY-EXPORT-FAIL] en error', () => {
    expect(SERVER_SRC).toContain('[V2-ALERT][PRIVACY-EXPORT-FAIL]');
  });

  test('A.7 — JSON.stringify con indent 2 (legible para owner)', () => {
    const block = SERVER_SRC.match(/app\.get\(\s*['"]\/api\/privacy\/report\/export['"][\s\S]{0,1500}?\n\)/);
    expect(block[0]).toMatch(/JSON\.stringify\(report,\s*null,\s*2\)/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — UI dashboard (owner-dashboard.html)
// ════════════════════════════════════════════════════════════════════

describe('C-443 §B — UI dashboard owner-dashboard.html', () => {
  test('B.1 — owner-dashboard.html existe', () => {
    expect(HTML_SRC.length).toBeGreaterThan(1000);
  });

  test('B.2 — bloque privacy-report-block presente', () => {
    expect(HTML_SRC).toMatch(/id=["']privacy-report-block["']/);
  });

  test('B.3 — botón "Ver mis datos" → loadPrivacyReport()', () => {
    expect(HTML_SRC).toMatch(/onclick=["']loadPrivacyReport\(\)["']/);
    expect(HTML_SRC).toMatch(/Ver mis datos/);
  });

  test('B.4 — botón "Descargar JSON" → exportPrivacyReport()', () => {
    expect(HTML_SRC).toMatch(/onclick=["']exportPrivacyReport\(\)["']/);
    expect(HTML_SRC).toMatch(/Descargar JSON/);
  });

  test('B.5 — fetch a /api/privacy/report (sin export)', () => {
    expect(HTML_SRC).toMatch(/\/api\/privacy\/report\?userId=/);
  });

  test('B.6 — fetch a /api/privacy/report/export', () => {
    expect(HTML_SRC).toMatch(/\/api\/privacy\/report\/export\?userId=/);
  });

  test('B.7 — Authorization Bearer header en fetches', () => {
    const block = HTML_SRC.match(/loadPrivacyReport[\s\S]{0,2000}/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/Authorization.*Bearer/);
  });

  test('B.8 — render tabla 7 categorías (al menos esos labels)', () => {
    expect(HTML_SRC).toMatch(/Conversaciones/);
    expect(HTML_SRC).toMatch(/Contactos clasificados/);
    expect(HTML_SRC).toMatch(/Eventos calendario/);
    expect(HTML_SRC).toMatch(/Cotizaciones/);
    expect(HTML_SRC).toMatch(/Audit log/);
  });
});
