'use strict';

const {
  validateEnv, checkExternalServices, generateReport,
  REQUIRED_ENV_VARS, __setEnvForTests, __setFirestoreCheckForTests,
} = require('../scripts/env_validator');

const FULL_ENV = {
  ML_APP_ID: 'app123',
  ML_SECRET: 'secret',
  ML_REDIRECT_URI: 'https://miia.app/callback',
  FIREBASE_PROJECT_ID: 'miia-prod',
  GEMINI_API_KEY: 'AIzaSyTEST',
  SMTP_HOST: 'smtp.test.com',
  SMTP_USER: 'vi@miia.app',
  RAILWAY_TOKEN: 'rw_token_test',
};

afterEach(() => {
  __setEnvForTests(null);
  __setFirestoreCheckForTests(null);
});

describe('validateEnv', function () {
  test('env completo → ok=true, sin missing ni invalid', function () {
    __setEnvForTests(() => FULL_ENV);
    const r = validateEnv();
    expect(r.ok).toBe(true);
    expect(r.missing).toHaveLength(0);
    expect(r.invalid).toHaveLength(0);
  });

  test('vars faltantes → ok=false, missing poblado', function () {
    __setEnvForTests(() => ({ ML_APP_ID: 'x' }));
    const r = validateEnv();
    expect(r.ok).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  test('GEMINI_API_KEY invalido (no empieza con AI) → invalid', function () {
    __setEnvForTests(() => ({ ...FULL_ENV, GEMINI_API_KEY: 'sk-invalid' }));
    const r = validateEnv();
    expect(r.invalid).toContain('GEMINI_API_KEY');
    expect(r.ok).toBe(false);
  });

  test('GEMINI_API_KEY valido → no invalid', function () {
    __setEnvForTests(() => FULL_ENV);
    const r = validateEnv();
    expect(r.invalid).toHaveLength(0);
  });

  test('GEMINI_API_KEY ausente → no invalid (solo missing)', function () {
    const envSinGemini = { ...FULL_ENV };
    delete envSinGemini.GEMINI_API_KEY;
    __setEnvForTests(() => envSinGemini);
    const r = validateEnv();
    expect(r.invalid).toHaveLength(0);
    expect(r.missing).toContain('GEMINI_API_KEY');
  });
});

describe('checkExternalServices', function () {
  test('todos presentes → todo true', async function () {
    __setEnvForTests(() => FULL_ENV);
    __setFirestoreCheckForTests(async () => true);
    const r = await checkExternalServices();
    expect(r.gemini).toBe(true);
    expect(r.firestore).toBe(true);
    expect(r.smtp).toBe(true);
    expect(r.railway).toBe(true);
  });

  test('sin GEMINI → gemini false', async function () {
    __setEnvForTests(() => ({}));
    __setFirestoreCheckForTests(async () => false);
    const r = await checkExternalServices();
    expect(r.gemini).toBe(false);
    expect(r.smtp).toBe(false);
    expect(r.railway).toBe(false);
  });

  test('SMTP_HOST pero sin SMTP_USER → smtp false', async function () {
    __setEnvForTests(() => ({ ...FULL_ENV, SMTP_USER: undefined }));
    __setFirestoreCheckForTests(async () => true);
    const r = await checkExternalServices();
    expect(r.smtp).toBe(false);
  });

  test('firestore check retorna false', async function () {
    __setEnvForTests(() => FULL_ENV);
    __setFirestoreCheckForTests(async () => false);
    const r = await checkExternalServices();
    expect(r.firestore).toBe(false);
  });
});

describe('generateReport', function () {
  test('env ok → report con OK', function () {
    __setEnvForTests(() => FULL_ENV);
    const report = generateReport();
    expect(report).toContain('OK');
    expect(report).toContain('ENV VALIDATOR');
  });

  test('env con missing → report con Missing:', function () {
    __setEnvForTests(() => ({}));
    const report = generateReport();
    expect(report).toContain('Missing:');
    expect(report).toContain('ERRORS');
  });

  test('env con invalid → report con Invalid:', function () {
    __setEnvForTests(() => ({ ...FULL_ENV, GEMINI_API_KEY: 'bad-key' }));
    const report = generateReport();
    expect(report).toContain('Invalid:');
  });
});
