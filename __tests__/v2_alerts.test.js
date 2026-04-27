/**
 * Tests: V2 alerts inline observability (C-426 §B.4)
 *
 * Valida que cada punto crítico del pipeline V2 emita un log con prefijo
 * `[V2-ALERT]` cuando hay degradación o error, y que el pipeline siga
 * funcionando con fallback a V1 (no crash).
 *
 * Cobertura:
 *   - voice_v2_loader.loadVoiceDNAForGroup → unknown chatType emite alert.
 *   - voice_v2_loader.loadVoiceDNAForGroup → voice_seed.md no legible emite alert.
 *   - voice_v2_loader.loadVoiceDNAForCenter → unknown chatType emite alert.
 *   - voice_v2_loader.loadVoiceDNAForCenter → voice_seed_center.md no legible emite alert.
 *   - Fallback shape correcto (systemBlock vacío + fallback=true) sin crash.
 *
 * Pattern: capturar console.error/warn con jest.spyOn, verificar que el
 * primer argumento es exactamente '[V2-ALERT]' (string match, no regex
 * sobre objetos serializados — evita false positives).
 */

'use strict';

const fs = require('fs');
const {
  loadVoiceDNAForGroup,
  loadVoiceDNAForCenter,
  resetCache,
} = require('../core/voice_v2_loader');

function getV2AlertCalls(spy) {
  return spy.mock.calls.filter(call => call[0] === '[V2-ALERT]');
}

describe('V2 alerts inline (C-426 §B)', () => {
  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    resetCache();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('loadVoiceDNAForGroup con chatType desconocido → emite [V2-ALERT] warn + retorna fallback', () => {
    const result = loadVoiceDNAForGroup('chatType_inexistente_xyz');

    expect(result.fallback).toBe(true);
    expect(result.systemBlock).toBe('');
    expect(result.subregistro).toBeNull();
    expect(result.source).toBe('unknown_chattype');

    const alerts = getV2AlertCalls(warnSpy);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const payload = alerts[0][1];
    expect(payload).toMatchObject({
      context: 'loadVoiceDNAForGroup',
      reason: 'unknown_chattype',
      chatType: 'chatType_inexistente_xyz',
      fallback_to: 'V1',
    });
  });

  test('loadVoiceDNAForGroup con voice_seed.md no legible → emite [V2-ALERT] error + warn fallback', () => {
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce((path) => {
      if (String(path).endsWith('voice_seed.md')) {
        const err = new Error('ENOENT: simulated');
        err.code = 'ENOENT';
        throw err;
      }
      return '';
    });

    const result = loadVoiceDNAForGroup('lead');

    expect(result.fallback).toBe(true);
    expect(result.systemBlock).toBe('');
    expect(result.source).toBe('none');

    const errorAlerts = getV2AlertCalls(errorSpy);
    expect(errorAlerts.length).toBeGreaterThanOrEqual(1);
    expect(errorAlerts[0][1]).toMatchObject({
      context: 'voice_v2_loader.readVoiceSeed',
      code: 'ENOENT',
    });

    const warnAlerts = getV2AlertCalls(warnSpy);
    expect(warnAlerts.length).toBeGreaterThanOrEqual(1);
    expect(warnAlerts[0][1]).toMatchObject({
      context: 'loadVoiceDNAForGroup',
      reason: 'voice_seed_unavailable',
      chatType: 'lead',
      fallback_to: 'V1',
    });

    readSpy.mockRestore();
  });

  test('loadVoiceDNAForCenter con chatType no soportado → emite [V2-ALERT] warn + retorna fallback', () => {
    const result = loadVoiceDNAForCenter('family');  // family NO está en SUBREGISTRO_HEADERS_CENTER

    expect(result.fallback).toBe(true);
    expect(result.systemBlock).toBe('');
    expect(result.source).toBe('unknown_chattype_center');

    const alerts = getV2AlertCalls(warnSpy);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0][1]).toMatchObject({
      context: 'loadVoiceDNAForCenter',
      reason: 'unknown_chattype_center',
      chatType: 'family',
      fallback_to: 'V1',
    });
  });

  test('loadVoiceDNAForCenter con voice_seed_center.md no legible → emite [V2-ALERT] error + warn fallback', () => {
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementationOnce((path) => {
      if (String(path).endsWith('voice_seed_center.md')) {
        const err = new Error('EACCES: simulated');
        err.code = 'EACCES';
        throw err;
      }
      return '';
    });

    const result = loadVoiceDNAForCenter('lead');

    expect(result.fallback).toBe(true);
    expect(result.source).toBe('none');

    const errorAlerts = getV2AlertCalls(errorSpy);
    expect(errorAlerts.length).toBeGreaterThanOrEqual(1);
    expect(errorAlerts[0][1]).toMatchObject({
      context: 'voice_v2_loader.readVoiceSeedCenter',
      code: 'EACCES',
    });

    const warnAlerts = getV2AlertCalls(warnSpy);
    expect(warnAlerts.length).toBeGreaterThanOrEqual(1);
    expect(warnAlerts[0][1]).toMatchObject({
      context: 'loadVoiceDNAForCenter',
      reason: 'voice_seed_center_unavailable',
      chatType: 'lead',
      fallback_to: 'V1',
    });

    readSpy.mockRestore();
  });

  test('fallback shape preserva contrato sin crash en pipeline (objeto válido + flags consistentes)', () => {
    const result = loadVoiceDNAForGroup('chatType_no_existe');

    // El caller (TMH wire-in) usa estos campos para decidir fallback a V1.
    // Si alguno cambia de tipo o falta, el wire-in se rompe.
    expect(result).toHaveProperty('systemBlock');
    expect(result).toHaveProperty('subregistro');
    expect(result).toHaveProperty('fallback');
    expect(result).toHaveProperty('source');
    expect(typeof result.systemBlock).toBe('string');
    expect(typeof result.fallback).toBe('boolean');
    expect(typeof result.source).toBe('string');
    expect(result.fallback).toBe(true);
    expect(result.systemBlock).toBe('');
    // subregistro puede ser null (esperado en fallback) o string en caso success
    expect(result.subregistro === null || typeof result.subregistro === 'string').toBe(true);
  });
});
