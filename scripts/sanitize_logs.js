'use strict';

/**
 * sanitize_logs.js — C-426 §C.3
 *
 * Redacta tokens, API keys, phones, emails, idTokens en archivos .log/.jsonl.
 * Output paralelo `<file>.sanitized` (NO modifica originales — idempotente).
 *
 * Usage:
 *   node miia-backend/scripts/sanitize_logs.js <input>           # input file or dir
 *   node miia-backend/scripts/sanitize_logs.js <input> --recursive
 *   node miia-backend/scripts/sanitize_logs.js <input> --dry-run # show stats, no write
 *   node miia-backend/scripts/sanitize_logs.js __selftest         # built-in smoke test
 *
 * Redacta categorías:
 *   - Anthropic API keys (sk-ant-...)
 *   - OpenAI keys (sk-...)
 *   - Google API keys (AIza...)
 *   - Stripe keys (sk_live_, sk_test_, pk_live_, pk_test_, rk_live_)
 *   - JWT tokens (eyJ... 3-part dotted)
 *   - Bearer authorization headers
 *   - Firebase ID tokens / generic long alnum (>=32 chars hex/base64-like)
 *   - Phone numbers internacionales (+E164 8-15 dígitos, AR/CO/MX/RD/CL/ES/US prefixes)
 *   - Emails (preserva dominio para debug, redacta local-part: usuario@dominio.com → ***@dominio.com)
 *   - PASS labels (PASS:, PASS 1:, PASS 2:) seguidos de cualquier valor.
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// REDACTORS — order matters, more specific first

const REDACTORS = [
  {
    // Captura PASS X: <valor con posibles espacios internos> hasta fin de línea
    // o hasta separator " - <KEYWORD>:" (siguiente label en misma línea, ej:
    // "PASS 1: foo bar baz - PASS 2: qux quux corge").
    name: 'PASS_label_value',
    pattern: /\b(PASS\s*\d*\s*:)\s*((?:(?!\s+-\s+[A-Z_][A-Z0-9_\s]*:)[^\r\n])+)/g,
    replace: (m, label) => `${label} [REDACTED:PASS]`,
  },
  {
    name: 'anthropic_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replace: '[REDACTED:ANTHROPIC_KEY]',
  },
  {
    name: 'openai_key',
    pattern: /\bsk-[A-Za-z0-9]{40,}\b/g,
    replace: '[REDACTED:OPENAI_KEY]',
  },
  {
    name: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replace: '[REDACTED:GOOGLE_API_KEY]',
  },
  {
    name: 'stripe_key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replace: '[REDACTED:STRIPE_KEY]',
  },
  {
    name: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replace: '[REDACTED:JWT]',
  },
  {
    name: 'bearer_header',
    pattern: /\b(Bearer|bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g,
    replace: 'Bearer [REDACTED:BEARER]',
  },
  {
    name: 'authorization_header',
    pattern: /\b([Aa]uthorization\s*[:=]\s*)([^\s,;"']{16,})/g,
    replace: (m, prefix) => `${prefix}[REDACTED:AUTH]`,
  },
  {
    name: 'phone_e164',
    pattern: /(?:^|\s|["'(:>])(\+\d{8,15})(?=\D|$)/g,
    replace: (m, phone) => m.replace(phone, '[REDACTED:PHONE]'),
  },
  {
    name: 'email',
    pattern: /\b([A-Za-z0-9_%+.-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    replace: (m, local, domain) => `[REDACTED:EMAIL_LOCAL]@${domain}`,
  },
  {
    // Catch-all generic long alphanumeric tokens (UUIDs, raw API keys not prefixed).
    // Last guard — catches what others missed. Threshold 32 chars to avoid false positives.
    name: 'long_alnum_token',
    pattern: /\b[A-Za-z0-9_-]{32,}\b/g,
    replace: (m) => {
      // Skip common file paths / git SHAs (40 chars exact hex are git SHAs — but those
      // are also worth redacting in logs since may identify deploys).
      // Keep simple — redact all >= 32 alnum unless it's surrounded by file path chars.
      return '[REDACTED:LONG_TOKEN]';
    },
  },
];

const REDACT_STATS = Object.fromEntries(REDACTORS.map(r => [r.name, 0]));

function sanitizeContent(content) {
  let out = content;
  for (const r of REDACTORS) {
    out = out.replace(r.pattern, (...args) => {
      REDACT_STATS[r.name]++;
      return typeof r.replace === 'function' ? r.replace(...args) : r.replace;
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE WALK + SANITIZE

function isTargetFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext === '.log' || ext === '.jsonl' || ext === '.txt';
}

function listFiles(inputPath, recursive) {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return [inputPath];
  }
  if (!stat.isDirectory()) return [];
  const out = [];
  for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
    const full = path.join(inputPath, entry.name);
    if (entry.isFile() && isTargetFile(entry.name) && !entry.name.endsWith('.sanitized')) {
      out.push(full);
    } else if (entry.isDirectory() && recursive) {
      out.push(...listFiles(full, true));
    }
  }
  return out;
}

function processFile(filepath, dryRun) {
  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch (err) {
    console.error(`[ERR] read ${filepath}: ${err.message}`);
    return { ok: false, redactions: 0 };
  }

  const before = content.length;
  const preStats = { ...REDACT_STATS };
  const sanitized = sanitizeContent(content);
  const totalRedactions = Object.entries(REDACT_STATS)
    .reduce((acc, [k, v]) => acc + (v - (preStats[k] || 0)), 0);

  const outPath = filepath + '.sanitized';
  if (!dryRun) {
    const tmp = outPath + '.tmp';
    fs.writeFileSync(tmp, sanitized, { mode: 0o600 });
    fs.renameSync(tmp, outPath);
  }

  console.log(
    `[${dryRun ? 'DRY' : 'OK'}] ${filepath} | ${before}B → ${sanitized.length}B | redactions=${totalRedactions}`
  );
  return { ok: true, redactions: totalRedactions };
}

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TEST

function selfTest() {
  console.log('Self-test: smoke con secrets sintéticos...\n');

  const tmpDir = path.join(__dirname, '__sanitize_selftest_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const sample = path.join(tmpDir, 'sample.log');

  const fixtures = [
    'Anthropic key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'Google key: AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI',
    'OpenAI key: sk-proj-abc123abc123abc123abc123abc123abc123abc123',
    'Stripe live: sk_live_51HnXXXXXXXXXXXXXXXXXX',
    'JWT auth: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.signaturepart123',
    'Bearer token: Bearer abc.def.ghi.jkl.mnop.qrst.uvwx.yzab',
    'Authorization: 14d6461e-1234-5678-9abc-def012345678',
    'PASS 1: Wimiiaapp1207!',
    'PASS 2: abcd efgh ijkl mnop',
    'Email user: alice.bob@miia-app.com',
    'Phone Mariano: +5491164431700',
    'Phone Colombia: +573054169969',
    'UUID Railway: 14d6461e-1234-5678-9abc-def012345678',
    'Plain text que no debería redactarse: hola mundo este es texto normal.',
    'JSON line: {"event":"login","userId":"abc123","at":1700000000}',
  ];

  fs.writeFileSync(sample, fixtures.join('\n') + '\n');

  // Reset stats
  for (const k of Object.keys(REDACT_STATS)) REDACT_STATS[k] = 0;

  processFile(sample, false);

  const result = fs.readFileSync(sample + '.sanitized', 'utf8');
  console.log('\nSanitized content:');
  console.log('─'.repeat(60));
  console.log(result);
  console.log('─'.repeat(60));

  console.log('\nRedaction stats:');
  for (const [k, v] of Object.entries(REDACT_STATS)) {
    if (v > 0) console.log(`  ${k}: ${v}`);
  }

  // Assertions: críticas no aparecen en output
  const criticals = [
    'sk-ant-api03',
    'AIzaSyDdI0hCZtE6vySjMm',
    'sk-proj-abc123',
    'sk_live_51Hn',
    'eyJhbGciOiJIUzI1NiJ9',
    'Wimiiaapp1207',
    'abcd efgh ijkl mnop',
    'alice.bob',
    '+5491164431700',
    '+573054169969',
  ];
  let failed = 0;
  for (const c of criticals) {
    if (result.includes(c)) {
      console.error(`[FAIL] secret "${c}" still present in sanitized output`);
      failed++;
    }
  }

  // Cleanup
  fs.unlinkSync(sample);
  fs.unlinkSync(sample + '.sanitized');
  fs.rmdirSync(tmpDir);

  if (failed > 0) {
    console.error(`\nSELFTEST FAILED: ${failed} criticals leaked`);
    process.exit(1);
  }
  console.log('\nSELFTEST OK — all criticals redacted ✓');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node sanitize_logs.js <input> [--recursive] [--dry-run]');
    console.error('       node sanitize_logs.js __selftest');
    process.exit(2);
  }

  if (args[0] === '__selftest') {
    selfTest();
    return;
  }

  const input = args[0];
  const recursive = args.includes('--recursive');
  const dryRun = args.includes('--dry-run');

  if (!fs.existsSync(input)) {
    console.error(`ERR: input not found: ${input}`);
    process.exit(2);
  }

  const files = listFiles(input, recursive);
  if (files.length === 0) {
    console.log('No .log/.jsonl/.txt files found.');
    return;
  }

  console.log(`Processing ${files.length} files (recursive=${recursive}, dryRun=${dryRun})...`);
  let totalRedactions = 0;
  for (const f of files) {
    const r = processFile(f, dryRun);
    totalRedactions += r.redactions;
  }
  console.log(`\nTotal redactions: ${totalRedactions}`);
  console.log('Per-category stats:');
  for (const [k, v] of Object.entries(REDACT_STATS)) {
    if (v > 0) console.log(`  ${k}: ${v}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { sanitizeContent, REDACTORS };
