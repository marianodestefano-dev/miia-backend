'use strict';
// R19-B -- ml_auto_answer.test.js -- 100% branch coverage

let mockIsConnected = async function () { return true; };
let mockGetPendingQuestions = async function () { return []; };
let mockGetListing = async function () { throw new Error('not-mocked'); };
let mockAnswerQuestion = async function () { return { ok: true }; };

const mockMl = {
  isConnected: async function (uid) { return mockIsConnected(uid); },
  getPendingQuestions: async function (uid) { return mockGetPendingQuestions(uid); },
  getListing: async function (uid, itemId) { return mockGetListing(uid, itemId); },
  answerQuestion: async function (uid, qId, resp) { return mockAnswerQuestion(uid, qId, resp); },
};

let mockGeminiImpl = async function () { return 'Respuesta de prueba'; };
let mockSnapDocs = [];

const mockFs = {
  collectionGroup: function () {
    return { get: async function () { return { forEach: function (fn) { mockSnapDocs.forEach(fn); } }; } };
  },
};

const { runAutoAnswerCron, processOwnerQuestions, getMlConnectedOwners,
  MAX_QUESTIONS_PER_RUN, MAX_ANSWER_LENGTH,
  __setFirestoreForTests, __setMlForTests, __setGeminiForTests,
} = require('../core/integrations/ml_auto_answer');

__setFirestoreForTests(mockFs);
__setMlForTests(mockMl);
__setGeminiForTests(async function (uid, p) { return mockGeminiImpl(uid, p); });

function makeQuestion(overrides) { return Object.assign({ id: 'Q1', item_id: 'MLA1', text: 'Garantia?' }, overrides); }

beforeEach(function () {
  mockIsConnected = async function () { return true; };
  mockGetPendingQuestions = async function () { return []; };
  mockGetListing = async function () { return { title: 'Prod', price: 100, available_quantity: 5 }; };
  mockAnswerQuestion = async function () { return { ok: true }; };
  mockGeminiImpl = async function () { return 'Respuesta de prueba'; };
  mockSnapDocs = [];
});
describe('runAutoAnswerCron', function () {
  test('uids null => []', async function () {
    var r = await runAutoAnswerCron(null);
    expect(r).toEqual([]);
  });
  test('uids no array => []', async function () {
    var r = await runAutoAnswerCron('uid-1');
    expect(r).toEqual([]);
  });
  test('uids array vacio => []', async function () {
    var r = await runAutoAnswerCron([]);
    expect(r).toEqual([]);
  });
  test('owner not connected => skipped', async function () {
    mockIsConnected = async function () { return false; };
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].skipped).toBe(true);
    expect(r[0].reason).toBe('not_connected');
  });
  test('sin preguntas => processed=0', async function () {
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].processed).toBe(0);
    expect(r[0].answered).toBe(0);
  });
  test('questions null => processed=0', async function () {
    mockGetPendingQuestions = async function () { return null; };
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].processed).toBe(0);
  });
  test('1 pregunta Gemini OK => answered=1', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].answered).toBe(1);
    expect(r[0].errors).toBe(0);
  });
  test('Gemini null => errors=1', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    mockGeminiImpl = async function () { return null; };
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].errors).toBe(1);
    expect(r[0].answered).toBe(0);
  });
  test('answerQuestion error => errors++', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    mockAnswerQuestion = async function () { throw new Error('ML-FAIL'); };
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].errors).toBe(1);
  });
  test('processOwnerQuestions lanza => error en results', async function () {
    mockIsConnected = async function () { throw new Error('FS-ERROR'); };
    var r = await runAutoAnswerCron(['uid-1']);
    expect(r[0].error).toBe('FS-ERROR');
  });
  test('multiples owners => resultado por cada uno', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    var r = await runAutoAnswerCron(['uid-1', 'uid-2']);
    expect(r).toHaveLength(2);
    expect(r[0].answered).toBe(1);
    expect(r[1].answered).toBe(1);
  });
});
describe('processOwnerQuestions', function () {
  test('uid vacio => uid_requerido', async function () {
    await expect(processOwnerQuestions('')).rejects.toThrow('uid_requerido');
  });
  test('uid null => uid_requerido', async function () {
    await expect(processOwnerQuestions(null)).rejects.toThrow("uid_requerido");
  });
  test('not connected => skipped', async function () {
    mockIsConnected = async function () { return false; };
    var r = await processOwnerQuestions('uid-1');
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('not_connected');
  });
  test('sin preguntas => processed=0', async function () {
    var r = await processOwnerQuestions('uid-1');
    expect(r).toEqual({ uid: 'uid-1', processed: 0, answered: 0, errors: 0 });
  });
  test('MAX_QUESTIONS_PER_RUN limita slice', async function () {
    var muchas = Array.from({ length: MAX_QUESTIONS_PER_RUN + 5 }, function (_, i) {
      return { id: 'Q' + i, item_id: null, text: 'texto' };
    });
    mockGetPendingQuestions = async function () { return muchas; };
    var r = await processOwnerQuestions('uid-1');
    expect(r.processed).toBe(MAX_QUESTIONS_PER_RUN);
  });
});

describe('_buildAnswer via processOwnerQuestions', function () {
  test('sin item_id => no getListing => answered=1', async function () {
    var called = false;
    mockGetListing = async function () { called = true; return {}; };
    mockGetPendingQuestions = async function () { return [makeQuestion({ item_id: null })]; };
    var r = await processOwnerQuestions('uid-1');
    expect(called).toBe(false);
    expect(r.answered).toBe(1);
  });
  test('con item_id getListing OK => contexto en prompt', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion({ item_id: "MLA1" })]; };
    var captured = null;
    mockGeminiImpl = async function (uid, p) { captured = p; return "OK"; };
    await processOwnerQuestions('uid-1');
    expect(captured).toContain('Prod');
  });
  test('getListing lanza => continua sin contexto => answered=1', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion({ item_id: "BAD" })]; };
    mockGetListing = async function () { throw new Error('NOPE'); };
    var r = await processOwnerQuestions('uid-1');
    expect(r.answered).toBe(1);
  });
  test('Gemini string vacio => errors++', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    mockGeminiImpl = async function () { return ''; };
    var r = await processOwnerQuestions('uid-1');
    expect(r.errors).toBe(1);
  });
  test('Gemini retorna numero => errors++', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    mockGeminiImpl = async function () { return 42; };
    var r = await processOwnerQuestions('uid-1');
    expect(r.errors).toBe(1);
  });
  test('respuesta > MAX_ANSWER_LENGTH => truncada', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion()]; };
    var largo = 'A'.repeat(MAX_ANSWER_LENGTH + 500);
    mockGeminiImpl = async function () { return largo; };
    var calls = [];
    mockAnswerQuestion = async function (u, q, resp) { calls.push(resp); return { ok: true }; };
    await processOwnerQuestions('uid-1');
    expect(calls[0].length).toBe(MAX_ANSWER_LENGTH);
  });
});
describe('getMlConnectedOwners', function () {
  test('snapshot vacio => []', async function () {
    var r = await getMlConnectedOwners();
    expect(r).toEqual([]);
  });
  test('doc mercadolibre con access_token => uid extraido', async function () {
    mockSnapDocs = [{
      id: 'mercadolibre',
      data: function () { return { access_token: 'AT-1' }; },
      ref: { path: 'owners/UID-A/integrations/mercadolibre' },
    }];
    var r = await getMlConnectedOwners();
    expect(r).toContain('UID-A');
  });
  test('sin access_token => excluido', async function () {
    mockSnapDocs = [{
      id: 'mercadolibre',
      data: function () { return { access_token: null }; },
      ref: { path: 'owners/UID-B/integrations/mercadolibre' },
    }];
    var r = await getMlConnectedOwners();
    expect(r).toHaveLength(0);
  });
  test('data null => excluido', async function () {
    mockSnapDocs = [{
      id: 'mercadolibre',
      data: function () { return null; },
      ref: { path: 'owners/UID-C/integrations/mercadolibre' },
    }];
    var r = await getMlConnectedOwners();
    expect(r).toHaveLength(0);
  });
  test('doc no es mercadolibre => excluido', async function () {
    mockSnapDocs = [{
      id: 'google',
      data: function () { return { access_token: 'AT' }; },
      ref: { path: 'owners/UID-D/integrations/google' },
    }];
    var r = await getMlConnectedOwners();
    expect(r).toHaveLength(0);
  });
  test('path sin uid => excluido', async function () {
    mockSnapDocs = [{
      id: 'mercadolibre',
      data: function () { return { access_token: 'AT' }; },
      ref: { path: 'mercadolibre' },
    }];
    var r = await getMlConnectedOwners();
    expect(r).toHaveLength(0);
  });
  test('mix => solo validos', async function () {
    mockSnapDocs = [
      { id: 'mercadolibre', data: function () { return { access_token: 'AT1' }; }, ref: { path: 'owners/UID-X/integrations/mercadolibre' } },
      { id: 'other', data: function () { return { access_token: 'AT2' }; }, ref: { path: 'owners/UID-Y/integrations/other' } },
      { id: 'mercadolibre', data: function () { return { access_token: 'AT3' }; }, ref: { path: 'owners/UID-Z/integrations/mercadolibre' } },
    ];
    var r = await getMlConnectedOwners();
    expect(r).toHaveLength(2);
    expect(r).toContain('UID-X');
    expect(r).toContain('UID-Z');
  });
});

describe('constantes', function () {
  test('MAX_QUESTIONS_PER_RUN = 10', function () {
    expect(MAX_QUESTIONS_PER_RUN).toBe(10);
  });
  test('MAX_ANSWER_LENGTH = 2000', function () {
    expect(MAX_ANSWER_LENGTH).toBe(2000);
  });
});
// cobertura ramas adicionales
describe('cobertura ramas adicionales', function () {
  test('question.text null => usa string vacio (|| )', async function () {
    mockGetPendingQuestions = async function () { return [makeQuestion({ text: null })]; };
    var captured = null;
    mockGeminiImpl = async function (uid, p) { captured = p; return "OK"; };
    await processOwnerQuestions('uid-1');
    expect(captured).toContain('Pregunta del comprador: ');
  });
  test('uid null en uids => uid||empty en log (catch branch)', async function () {
    // processOwnerQuestions(null) lanza uid_requerido -> catch en runAutoAnswerCron
    var r = await runAutoAnswerCron([null]);
    expect(r[0].error).toBe('uid_requerido');
  });
});