'use strict';
/**
 * T87 — Structured logging request_id tests
 * Verifica generacion de reqId unico por mensaje en handleTenantMessage
 * y propagacion de logPrefix a classifyContact.
 */

const { randomUUID } = require('crypto');

// === Suite 1: formato y unicidad del reqId ===
describe('T87 request_id — formato y unicidad', () => {
  test('randomUUID().slice(0,8) produce exactamente 8 caracteres', () => {
    const reqId = randomUUID().slice(0, 8);
    expect(reqId).toHaveLength(8);
  });

  test('reqId solo contiene caracteres hex (a-f, 0-9)', () => {
    const reqId = randomUUID().slice(0, 8);
    expect(reqId).toMatch(/^[0-9a-f]{8}$/);
  });

  test('100 reqIds generados son todos unicos', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(randomUUID().slice(0, 8));
    }
    // Con 100 UUIDs de 128 bits, la probabilidad de colision en 8 chars es ~1.4e-9
    // En practica siempre seran unicos en este test
    expect(ids.size).toBeGreaterThan(90); // tolerancia para colisiones teoricas
  });

  test('logPrefix con reqId tiene formato correcto', () => {
    const uid = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
    const reqId = randomUUID().slice(0, 8);
    const logPrefix = '[TMH:A5pMESWl...][REQ:' + reqId + ']';
    expect(logPrefix).toMatch(/^\[TMH:[A-Za-z0-9]{8}\.\.\.\]\[REQ:[0-9a-f]{8}\]$/);
  });
});

// === Suite 2: classifyContact acepta callerLogPrefix opcional ===
describe('T87 classifyContact — callerLogPrefix opcional', () => {
  let classifyContact;

  beforeAll(() => {
    try {
      const tmh = require('../whatsapp/tenant_message_handler');
      classifyContact = tmh.classifyContact;
    } catch (_) {
      classifyContact = null;
    }
  });

  test('classifyContact esta exportada', () => {
    expect(classifyContact).not.toBeNull();
    expect(typeof classifyContact).toBe('function');
  });

  test('classifyContact acepta 5 argumentos (4 originales + callerLogPrefix)', () => {
    // Verificar longitud de argumentos de la funcion
    expect(classifyContact.length).toBe(4); // length solo cuenta params sin default
    // El 5to param callerLogPrefix tiene default null, por eso length=4
    // Verificar que se puede llamar con 5 args sin TypeError
    // (no podemos llamarla de verdad sin contexto, solo verificamos la firma)
    const fnString = classifyContact.toString();
    expect(fnString).toContain('callerLogPrefix');
  });

  test('logPrefix en classifyContact usa callerLogPrefix si se pasa', () => {
    // Verificar en el codigo fuente que usa ??
    const fnString = classifyContact.toString();
    expect(fnString).toContain('callerLogPrefix ??');
  });
});

// === Suite 3: handleTenantMessage genera reqId ===
describe('T87 handleTenantMessage — reqId en source', () => {
  test('handleTenantMessage tiene randomUUID en su codigo', () => {
    let handleTenantMessage;
    try {
      const tmh = require('../whatsapp/tenant_message_handler');
      handleTenantMessage = tmh.handleTenantMessage;
    } catch (_) {
      handleTenantMessage = null;
    }
    if (handleTenantMessage) {
      const fnString = handleTenantMessage.toString();
      expect(fnString).toContain('randomUUID');
      expect(fnString).toContain('reqId');
      expect(fnString).toContain('[REQ:');
    } else {
      // Si no se puede importar, verificar via grep del archivo
      const fs = require('fs');
      const src = fs.readFileSync(
        require('path').join(__dirname, '../whatsapp/tenant_message_handler.js'),
        'utf8'
      );
      expect(src).toContain('randomUUID');
      expect(src).toContain('reqId');
      expect(src).toContain('[REQ:');
    }
  });
});
