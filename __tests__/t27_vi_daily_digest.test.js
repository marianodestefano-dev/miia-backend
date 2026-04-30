'use strict';

/**
 * Tests: T27 — Vi Daily Digest script.
 *
 * Origen: Wi mail [164] [NUEVA-TAREA-T27-DIGEST-VI]. Patron similar a
 * JUEGA_cron_arq_digest. Mariano firmo: "si te sirve a Wi, mejor; pero
 * tambien Vi y TEC".
 *
 * Tests estaticos sobre source scripts/_vi_daily_digest.py:
 *   - Existe + estructura correcta
 *   - Lee PASS 2 desde Cambios.txt sin imprimir valor
 *   - SOLO envia a wi.gg@miia-app.com (NO hola@)
 *   - Subject [DIGEST-DIARIO-VI] resumen 24h
 *   - Categoriza CIERRES + PROPUESTAS + COMMITS + ACKs/Otros
 *   - Soporta --dry-run mode
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIGEST_PATH = path.resolve(__dirname, '../scripts/_vi_daily_digest.py');

describe('T27 §A — _vi_daily_digest.py source structure', () => {
  let SOURCE;

  beforeAll(() => {
    SOURCE = fs.readFileSync(DIGEST_PATH, 'utf8');
  });

  test('A.1 — script existe en scripts/', () => {
    expect(fs.existsSync(DIGEST_PATH)).toBe(true);
  });

  test('A.2 — comentario T27-IMPLEMENT presente', () => {
    expect(SOURCE).toMatch(/T27-IMPLEMENT/);
  });

  test('A.3 — usa imaplib para leer sent mails', () => {
    expect(SOURCE).toMatch(/import imaplib/);
    expect(SOURCE).toMatch(/IMAP4_SSL\(['"]imap\.gmail\.com['"]\)/);
  });

  test('A.4 — usa smtplib para enviar digest', () => {
    expect(SOURCE).toMatch(/import smtplib/);
    expect(SOURCE).toMatch(/SMTP\(['"]smtp\.gmail\.com['"]/);
  });

  test('A.5 — lee PASS 2 desde Cambios.txt (R-H3 compliant)', () => {
    expect(SOURCE).toMatch(/get_pass2_for/);
    expect(SOURCE).toMatch(/Cambios\.txt/);
    expect(SOURCE).toMatch(/'EMAIL VI TEC'/);
  });

  test('A.6 — DESTINATARIO es SOLO wi.gg@miia-app.com (NO hola@)', () => {
    // Verificar que el destinatario en send_digest es ONLY wi.gg
    expect(SOURCE).toMatch(/'wi\.gg@miia-app\.com'/);
    // NO debe haber hola@ en el sendmail/recipients del digest principal
    const sendDigestIdx = SOURCE.indexOf('def send_digest');
    expect(sendDigestIdx).toBeGreaterThan(0);
    const sendDigestBlock = SOURCE.slice(sendDigestIdx, sendDigestIdx + 1500);
    expect(sendDigestBlock).not.toMatch(/hola@miia-app\.com/);
  });

  test('A.7 — Subject [DIGEST-DIARIO-VI] resumen 24h', () => {
    expect(SOURCE).toMatch(/\[DIGEST-DIARIO-VI\] resumen 24h/);
  });

  test('A.8 — Categoriza CIERRES, PROPUESTAS, ACKs', () => {
    expect(SOURCE).toMatch(/categorize_mails/);
    expect(SOURCE).toMatch(/'cierres'/);
    expect(SOURCE).toMatch(/'propuestas'/);
    expect(SOURCE).toMatch(/'acks'/);
  });

  test('A.9 — Lista commits git --since=24 hours ago', () => {
    expect(SOURCE).toMatch(/get_git_commits_yesterday/);
    expect(SOURCE).toMatch(/--since=24 hours ago/);
  });

  test('A.10 — soporta --dry-run mode (sin enviar)', () => {
    expect(SOURCE).toMatch(/'--dry-run' in sys\.argv/);
  });

  test('A.11 — main() ejecuta solo si __name__ == __main__', () => {
    expect(SOURCE).toMatch(/if __name__ == ['"]__main__['"]/);
    expect(SOURCE).toMatch(/main\(\)/);
  });

  test('A.12 — fail loud si PASS 2 no encontrado (sys.exit)', () => {
    expect(SOURCE).toMatch(/sys\.exit\(1\)/);
  });
});
