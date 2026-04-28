/**
 * Tests: C-454-GIT-CLEANUP-ONE-SHOT-SCRIPTS — verifica que los 2
 * scripts one-shot ya ejecutados NO esten tracked en git index.
 *
 * Origen: ITER 2 RRC-VI-001 candidata C-454. APROBADO Wi autoridad
 * delegada 2026-04-28.
 *
 * Fix C-454: git rm --cached aplicado a:
 *   - scripts/delete_peru_cotizacion.js (Peru cotizacion 3617b60d, ya
 *     ejecutado, ya no sirve)
 *   - scripts/generate_8_mocks_fase_c.js (mocks FASE C.1 C-342 ADENDA 2,
 *     uso one-shot)
 *
 * Ancla: Wi audito 2026-04-22 (zero secrets, solo mocks publicos).
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

function gitLsFiles() {
  return execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('C-454-GIT-CLEANUP-ONE-SHOT-SCRIPTS — scripts removidos del index', () => {
  test('A.1 — scripts/delete_peru_cotizacion.js NO en git ls-files', () => {
    const lsfiles = gitLsFiles();
    expect(lsfiles).not.toMatch(/^scripts\/delete_peru_cotizacion\.js$/m);
  });

  test('A.2 — scripts/generate_8_mocks_fase_c.js NO en git ls-files', () => {
    const lsfiles = gitLsFiles();
    expect(lsfiles).not.toMatch(/^scripts\/generate_8_mocks_fase_c\.js$/m);
  });

  test('A.3 — git ls-files no esta vacio (sanity check)', () => {
    const lsfiles = gitLsFiles();
    expect(lsfiles.length).toBeGreaterThan(100);
  });
});
