/**
 * Tests: C-446-FIX-ADN §B.1 — sales-image bastardo ELIMINADO.
 *
 * Origen: CARTA C-446-FIX-ADN [FIRMADA_VIVO_C446_FIX_ADN_MARIANO_2026-04-28].
 *
 * Cita Mariano 2026-04-28 08:34 COT:
 * "Probadita es probar... usar a MIIA y obtener lo que MIIA ofrece.
 *  No enviar una puta imagen o gif... eso es mierda podrida."
 *
 * Validar via static regex que server.js NO contiene wire-in sales-image.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const SOURCE = fs.readFileSync(SERVER_PATH, 'utf8');

describe('C-446-FIX-ADN §B.1 — sales-image bastardo eliminado server.js', () => {
  test('A.1 — NO hay invocación salesAssets.shouldSendImage', () => {
    expect(SOURCE).not.toMatch(/salesAssets\.shouldSendImage\s*\(/);
  });

  test('A.2 — NO hay invocación salesAssets.detectSalesTopic', () => {
    expect(SOURCE).not.toMatch(/salesAssets\.detectSalesTopic\s*\(/);
  });

  test('A.3 — NO hay invocación salesAssets.getSalesAsset', () => {
    expect(SOURCE).not.toMatch(/salesAssets\.getSalesAsset\s*\(/);
  });

  test('A.4 — NO hay log [SALES-IMAGE] activo (solo en comentario o eliminado)', () => {
    // Buscar log productivo (line con console.log + [SALES-IMAGE]).
    const productiveLog = SOURCE.match(/^\s*console\.log\([^)]*\[SALES-IMAGE\]/m);
    expect(productiveLog).toBeNull();
  });

  test('A.5 — require(.../sales_assets) está comentado o ausente', () => {
    // Si está, debe ser comentado (// const salesAssets = ...)
    const activeRequire = SOURCE.match(/^\s*const\s+salesAssets\s*=\s*require/m);
    expect(activeRequire).toBeNull();
  });

  test('A.6 — comentario justificación C-446 §B.1 presente', () => {
    expect(SOURCE).toMatch(/C-446-FIX-ADN §B\.1.*sales-image/);
  });

  test('A.7 — bloque condicional isMiiaSalesLead + sales image NO existe activo', () => {
    // El bloque viejo arrancaba con if (isMiiaSalesLead && !isSelfChat) seguido
    // de currentProbadita + shouldSendImage. NO debe existir activo.
    const block = SOURCE.match(/if\s*\(isMiiaSalesLead\s*&&\s*!isSelfChat\)\s*\{[\s\S]{0,200}?shouldSendImage/);
    expect(block).toBeNull();
  });
});
