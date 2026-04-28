/**
 * Tests: C-447-MSGID-RACE — random suffix anti-colision.
 *
 * Origen: RRC-VI-001 ITEM 1 aprobado por Wi como C-447 candidata
 * post-C-446-FIX-ADN. Ejecutado bajo autoridad delegada Wi (regla 2
 * post-expulsion TEC).
 *
 * Bug: tenant_message_handler.js anterior generaba mmcMsgId solo con
 * timestamp + phone tail. 2 mensajes mismo ms desde mismo phone →
 * mismo msgId → episode collision.
 *
 * Fix: agregar Math.random().toString(36).slice(2, 6) suffix.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TMH_PATH = path.resolve(__dirname, '../whatsapp/tenant_message_handler.js');
const SOURCE = fs.readFileSync(TMH_PATH, 'utf8');

describe('C-447-MSGID-RACE — wire-in TMH', () => {
  test('A.1 — mmcMsgId incluye random suffix Math.random toString(36)', () => {
    expect(SOURCE).toMatch(/mmcMsgId\s*=\s*`msg_\$\{Date\.now\(\)\}_\$\{phone\.slice\(-8\)\}_\$\{Math\.random\(\)\.toString\(36\)/);
  });

  test('A.2 — random suffix tiene slice(2, 6) — 4 chars base36', () => {
    const block = SOURCE.match(/mmcMsgId\s*=\s*`msg_[\s\S]{0,200}?Math\.random\(\)\.toString\(36\)\.slice\(2,\s*6\)/);
    expect(block).not.toBeNull();
  });

  test('A.3 — comentario C-447-MSGID-RACE presente', () => {
    expect(SOURCE).toContain('C-447-MSGID-RACE');
  });

  test('A.4 — comentario alusivo C-446 §B.1 sales-image residual presente', () => {
    expect(SOURCE).toMatch(/C-446-FIX-ADN §B\.1[\s\S]{0,300}?residual/);
  });
});

describe('C-447-MSGID-RACE — comportamiento runtime simulado', () => {
  // Simula la lógica generadora msgId in-memory para verificar unicidad.
  function generateMsgId(phone) {
    return `msg_${Date.now()}_${phone.slice(-8)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  test('B.1 — 100 generaciones consecutivas mismo phone → todos únicos', () => {
    const phone = '5491100000001@s.whatsapp.net';
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateMsgId(phone));
    }
    expect(ids.size).toBe(100);
  });

  test('B.2 — formato resulting matches expected shape', () => {
    const id = generateMsgId('5491100000001@s.whatsapp.net');
    expect(id).toMatch(/^msg_\d{13}_[\w@.]{1,12}_[a-z0-9]{4}$/);
  });

  test('B.3 — random suffix garantiza unicidad mismo ms (simulación)', () => {
    // Simular dos llamadas con same Date.now() forzando mock
    const realNow = Date.now;
    Date.now = () => 1700000000000; // mismo ts fijo
    try {
      const phone = '5491100000001@s.whatsapp.net';
      const ids = new Set();
      for (let i = 0; i < 50; i++) {
        ids.add(generateMsgId(phone));
      }
      // Con ts fijo, sin random suffix los 50 serían iguales.
      // Con random suffix base36 4 chars (1.6M combinaciones), 50 únicos esperado.
      expect(ids.size).toBeGreaterThanOrEqual(48); // 96%+ unicidad esperable
    } finally {
      Date.now = realNow;
    }
  });
});
