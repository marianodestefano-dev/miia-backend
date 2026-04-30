'use strict';

/**
 * Tests: T31 — Health Smoke Harness production.
 *
 * Origen: Wi mail [167] [ACK-T24-T25-T26-T27+N4-VI] — "T31 Health check
 * production smoke harness (verificacion automatica)".
 *
 * Tests estaticos sobre source scripts/_health_smoke_harness.py:
 *   §A — estructura: imports + funciones core
 *   §B — modos --json --strict --notify
 *   §C — detect_alerts logica criterios criticos/degraded
 *   §D — endpoint correcto + timeout configurado
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HARNESS_PATH = path.resolve(__dirname, '../scripts/_health_smoke_harness.py');

describe('T31 §A — _health_smoke_harness.py source structure', () => {
  let SOURCE;

  beforeAll(() => {
    SOURCE = fs.readFileSync(HARNESS_PATH, 'utf8');
  });

  test('A.1 — script existe en scripts/', () => {
    expect(fs.existsSync(HARNESS_PATH)).toBe(true);
  });

  test('A.2 — comentario T31-IMPLEMENT presente', () => {
    expect(SOURCE).toMatch(/T31-IMPLEMENT/);
  });

  test('A.3 — imports basicos urllib + json', () => {
    expect(SOURCE).toMatch(/import urllib\.request/);
    expect(SOURCE).toMatch(/import json/);
  });

  test('A.4 — funciones core definidas', () => {
    expect(SOURCE).toMatch(/def fetch_health\(\)/);
    expect(SOURCE).toMatch(/def format_summary/);
    expect(SOURCE).toMatch(/def detect_alerts/);
    expect(SOURCE).toMatch(/def main\(\)/);
  });

  test('A.5 — main() guard __name__ == __main__', () => {
    expect(SOURCE).toMatch(/if __name__ == ['"]__main__['"]/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — Modos --json, --strict, --notify
// ════════════════════════════════════════════════════════════════════

describe('T31 §B — modes flags', () => {
  let SOURCE;

  beforeAll(() => {
    SOURCE = fs.readFileSync(HARNESS_PATH, 'utf8');
  });

  test('B.1 — --json mode: imprime JSON + exit', () => {
    expect(SOURCE).toMatch(/json_mode\s*=\s*'--json' in args/);
    expect(SOURCE).toMatch(/json\.dumps\(body, indent=2\)/);
  });

  test('B.2 — --strict mode: exit 1 si overall != healthy', () => {
    expect(SOURCE).toMatch(/strict_mode\s*=\s*'--strict' in args/);
    expect(SOURCE).toMatch(/strict_mode and overall != 'healthy'/);
  });

  test('B.3 — --notify mode flag definido (futuro mail alerta)', () => {
    expect(SOURCE).toMatch(/notify_mode\s*=\s*'--notify' in args/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — detect_alerts logica
// ════════════════════════════════════════════════════════════════════

describe('T31 §C — detect_alerts criterios', () => {
  let SOURCE;

  beforeAll(() => {
    SOURCE = fs.readFileSync(HARNESS_PATH, 'utf8');
  });

  test('C.1 — alerta si overall in (critical, degraded)', () => {
    expect(SOURCE).toMatch(/overall in \(['"]critical['"], ['"]degraded['"]\)/);
  });

  test('C.2 — alerta si firestore status critical/degraded', () => {
    expect(SOURCE).toMatch(/fs\.get\(['"]status['"]\) in \(['"]critical['"], ['"]degraded['"]\)/);
  });

  test('C.3 — alerta si messagesUpsert status critical/warn', () => {
    expect(SOURCE).toMatch(/upsert\.get\(['"]status['"]\) in \(['"]critical['"], ['"]warn['"]\)/);
  });

  test('C.4 — alerta si baileys disconnected count > 0', () => {
    expect(SOURCE).toMatch(/disconnected\s*=.*b\.get\(['"]status['"]\) == ['"]disconnected['"]/);
  });

  test('C.5 — formato T24 latency p50/p95/p99 mostrado', () => {
    expect(SOURCE).toMatch(/p50=.*p95=.*p99=/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — Endpoint correcto + timeout configurado
// ════════════════════════════════════════════════════════════════════

describe('T31 §D — endpoint + timeout', () => {
  let SOURCE;

  beforeAll(() => {
    SOURCE = fs.readFileSync(HARNESS_PATH, 'utf8');
  });

  test('D.1 — HEALTH_URL apunta a Railway production miia-backend', () => {
    expect(SOURCE).toMatch(/miia-backend-production\.up\.railway\.app\/api\/health/);
  });

  test('D.2 — TIMEOUT_SECONDS configurado (>= 10s)', () => {
    expect(SOURCE).toMatch(/TIMEOUT_SECONDS\s*=\s*1[5-9]/);
  });

  test('D.3 — User-Agent identifica como T31 harness', () => {
    expect(SOURCE).toMatch(/MIIA-HealthHarness.*T31/);
  });

  test('D.4 — manejo errores HTTPError + URLError + Exception generico', () => {
    expect(SOURCE).toMatch(/HTTPError/);
    expect(SOURCE).toMatch(/URLError/);
    expect(SOURCE).toMatch(/except Exception/);
  });
});
