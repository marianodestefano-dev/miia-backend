'use strict';

const {
  containsCanaryMarker, detectUIDLeak, buildCanaryPayload,
  auditPromptForLeaks, auditConversationsForLeaks, runCanaryTest, generateIsolationReport,
  CANARY_MARKER, CANARY_SECONDARY, ISOLATION_SEVERITY, VIOLATION_TYPES, MAX_PROMPT_SCAN_LENGTH,
} = require('../core/tenant_isolation_validator');

const UID_A = 'OwnerA_UID_1234567890ABCDEF';
const UID_B = 'OwnerB_UID_9876543210FEDCBA';
const CLEAN_PROMPT = 'Eres un asistente de ventas. Ayuda a los clientes con consultas sobre productos.';
const CANARY_PROMPT = 'Eres un asistente. ' + 'UNICORNIO_FUCSIA_42' + ' dato extra. Ayuda.';

describe('Constantes', () => {
  test('CANARY_MARKER es UNICORNIO_FUCSIA_42', () => { expect(CANARY_MARKER).toBe('UNICORNIO_FUCSIA_42'); });
  test('ISOLATION_SEVERITY es CRITICAL', () => { expect(ISOLATION_SEVERITY).toBe('CRITICAL'); });
  test('VIOLATION_TYPES tiene 4 tipos', () => { expect(VIOLATION_TYPES.length).toBe(4); });
  test('frozen VIOLATION_TYPES', () => { expect(() => { VIOLATION_TYPES.push('x'); }).toThrow(); });
  test('MAX_PROMPT_SCAN_LENGTH es 50000', () => { expect(MAX_PROMPT_SCAN_LENGTH).toBe(50000); });
});

describe('containsCanaryMarker', () => {
  test('detecta UNICORNIO_FUCSIA_42 en texto', () => {
    expect(containsCanaryMarker('texto con UNICORNIO_FUCSIA_42 dentro')).toBe(true);
  });
  test('no detecta en texto limpio', () => {
    expect(containsCanaryMarker(CLEAN_PROMPT)).toBe(false);
  });
  test('retorna false si null', () => { expect(containsCanaryMarker(null)).toBe(false); });
  test('retorna false si numero', () => { expect(containsCanaryMarker(42)).toBe(false); });
  test('detecta marker secundario', () => {
    expect(containsCanaryMarker('texto con CANARY_ISOLATION_TEST_MIIA')).toBe(true);
  });
});

describe('buildCanaryPayload', () => {
  test('lanza si ownerUID undefined', () => {
    expect(() => buildCanaryPayload(undefined)).toThrow('ownerUID requerido');
  });
  test('retorna payload con marker y uid', () => {
    const p = buildCanaryPayload(UID_A);
    expect(p.marker).toBe(CANARY_MARKER);
    expect(p.ownerUID).toBe(UID_A);
    expect(p.type).toBe('isolation_test');
    expect(p.insertedAt).toBeDefined();
  });
});

describe('auditPromptForLeaks', () => {
  test('lanza si prompt undefined', () => {
    expect(() => auditPromptForLeaks(undefined, UID_A)).toThrow('prompt requerido');
  });
  test('lanza si ownerUID undefined', () => {
    expect(() => auditPromptForLeaks(CLEAN_PROMPT, undefined)).toThrow('ownerUID requerido');
  });
  test('prompt limpio es isClean=true', () => {
    const r = auditPromptForLeaks(CLEAN_PROMPT, UID_A);
    expect(r.isClean).toBe(true);
    expect(r.violations.length).toBe(0);
    expect(r.severity).toBe('OK');
  });
  test('prompt con canary es isClean=false CRITICAL', () => {
    const r = auditPromptForLeaks(CANARY_PROMPT, UID_A);
    expect(r.isClean).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations[0].type).toBe('canary_leak');
    expect(r.severity).toBe('CRITICAL');
  });
  test('detecta UID foraneo si se provee knownForeignUIDs', () => {
    const promptWithUID = 'Data for owner: ' + UID_B + ' extra info';
    const r = auditPromptForLeaks(promptWithUID, UID_A, { knownForeignUIDs: [UID_B] });
    expect(r.isClean).toBe(false);
    expect(r.violations.some(v => v.type === 'cross_tenant_data')).toBe(true);
  });
  test('auditedAt esta definido', () => {
    const r = auditPromptForLeaks(CLEAN_PROMPT, UID_A);
    expect(r.auditedAt).toBeDefined();
  });
});

describe('auditConversationsForLeaks', () => {
  test('lanza si conversations no es array', () => {
    expect(() => auditConversationsForLeaks('no-array', UID_A)).toThrow('debe ser array');
  });
  test('lanza si ownerUID undefined', () => {
    expect(() => auditConversationsForLeaks([], undefined)).toThrow('ownerUID requerido');
  });
  test('conversaciones limpias del owner correcto son isClean', () => {
    const convs = [{ uid: UID_A, text: 'Hola' }, { uid: UID_A, text: 'Como estas' }];
    const r = auditConversationsForLeaks(convs, UID_A);
    expect(r.isClean).toBe(true);
    expect(r.violations.length).toBe(0);
  });
  test('detecta uid_mismatch', () => {
    const convs = [{ uid: UID_A, text: 'Hola' }, { uid: UID_B, text: 'Soy owner B' }];
    const r = auditConversationsForLeaks(convs, UID_A);
    expect(r.isClean).toBe(false);
    expect(r.violations.some(v => v.type === 'uid_mismatch')).toBe(true);
    expect(r.severity).toBe('CRITICAL');
  });
  test('detecta canary en conversaciones', () => {
    const convs = [{ uid: UID_A, text: 'Mensaje con ' + CANARY_MARKER }];
    const r = auditConversationsForLeaks(convs, UID_A);
    expect(r.isClean).toBe(false);
    expect(r.violations.some(v => v.type === 'canary_leak')).toBe(true);
  });
  test('retorna totalConversations correcto', () => {
    const convs = Array.from({ length: 5 }, (_, i) => ({ uid: UID_A, text: 'msg ' + i }));
    const r = auditConversationsForLeaks(convs, UID_A);
    expect(r.totalConversations).toBe(5);
  });
});

describe('runCanaryTest', () => {
  test('lanza si ownerA_UID undefined', () => {
    expect(() => runCanaryTest(undefined, CLEAN_PROMPT)).toThrow('ownerA_UID requerido');
  });
  test('lanza si ownerB_prompt undefined', () => {
    expect(() => runCanaryTest(UID_A, undefined)).toThrow('ownerB_prompt requerido');
  });
  test('passed=true si canary no esta en prompt de owner B', () => {
    const r = runCanaryTest(UID_A, CLEAN_PROMPT);
    expect(r.passed).toBe(true);
    expect(r.canaryFoundInOwnerB).toBe(false);
    expect(r.severity).toBe('OK');
  });
  test('passed=false CRITICAL si canary aparece en prompt de owner B', () => {
    const r = runCanaryTest(UID_A, CANARY_PROMPT);
    expect(r.passed).toBe(false);
    expect(r.canaryFoundInOwnerB).toBe(true);
    expect(r.severity).toBe('CRITICAL');
  });
  test('acepta string vacio como ownerB_prompt (limpio)', () => {
    const r = runCanaryTest(UID_A, '');
    expect(r.passed).toBe(true);
  });
});

describe('generateIsolationReport', () => {
  test('lanza si uid undefined', () => {
    expect(() => generateIsolationReport(undefined, [])).toThrow('uid requerido');
  });
  test('lanza si auditResults no es array', () => {
    expect(() => generateIsolationReport(UID_A, 'no-array')).toThrow('debe ser array');
  });
  test('reporte sin violaciones es ISOLATED', () => {
    const audits = [{ violations: [] }, { violations: [] }];
    const r = generateIsolationReport(UID_A, audits);
    expect(r.overallStatus).toBe('ISOLATED');
    expect(r.totalViolations).toBe(0);
    expect(r.hasCanaryLeak).toBe(false);
  });
  test('reporte con violaciones es BREACH_DETECTED', () => {
    const audits = [{ violations: [{ type: 'canary_leak' }] }];
    const r = generateIsolationReport(UID_A, audits);
    expect(r.overallStatus).toBe('BREACH_DETECTED');
    expect(r.totalViolations).toBe(1);
    expect(r.hasCanaryLeak).toBe(true);
  });
  test('retorna generatedAt y totalAudits', () => {
    const r = generateIsolationReport(UID_A, [{ violations: [] }]);
    expect(r.generatedAt).toBeDefined();
    expect(r.totalAudits).toBe(1);
  });
});
