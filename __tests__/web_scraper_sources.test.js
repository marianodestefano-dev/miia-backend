'use strict';

/**
 * Test EXTRA #2 — services/web_scraper.js SOURCES contiene URLs Medilink reales.
 * Bug detectado por Mariano 2026-05-12: medilink.cl es OTRA empresa.
 * Spec: softwaremedilink.com con variantes /co/ /cl/ /mx/ + intercom help.
 */

// Require el modulo. Las SOURCES son const no exportada,
// pero exportamos via property en module en el wrapper de tests.
// Estrategia: cargar el archivo como texto y verificar URLs presentes.

const fs = require('fs');
const path = require('path');

describe('web_scraper SOURCES — URLs Medilink reales (EXTRA #2)', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../services/web_scraper.js'),
    'utf8'
  );

  test('NO contiene medilink.cl (bug fix)', () => {
    // Buscar la URL como string (no como mención en comentario)
    // Hay 1 hit en comentario explicativo que debe sobrevivir; valido que
    // NO haya URL con ese host.
    const urlMatch = source.match(/https?:\/\/[^"\s)]*medilink\.cl[^"\s)]*/g);
    expect(urlMatch).toBeNull();
  });

  test('Contiene softwaremedilink.com', () => {
    expect(source).toContain('softwaremedilink.com');
  });

  test('Contiene variantes /co/, /cl/, /mx/', () => {
    expect(source).toContain('softwaremedilink.com/co/');
    expect(source).toContain('softwaremedilink.com/cl/');
    expect(source).toContain('softwaremedilink.com/mx/');
  });

  test('Contiene intercom.help/softwaremedilink', () => {
    expect(source).toContain('intercom.help/softwaremedilink/es/');
  });

  test('Pais codes correctos (MEDILINK_LATAM, MEDILINK_COLOMBIA, MEDILINK_CHILE, MEDILINK_MEXICO, MEDILINK_HELP)', () => {
    expect(source).toContain('MEDILINK_LATAM');
    expect(source).toContain('MEDILINK_COLOMBIA');
    expect(source).toContain('MEDILINK_CHILE');
    expect(source).toContain('MEDILINK_MEXICO');
    expect(source).toContain('MEDILINK_HELP');
  });

  test('Mantiene fuentes existentes de ministerios LATAM', () => {
    expect(source).toContain('Minsalud Colombia');
    expect(source).toContain('Minsal Chile');
    expect(source).toContain('SSA Mexico');
    expect(source).toContain('Minsalud Argentina');
    expect(source).toContain('MSP Dom. Rep.');
  });
});
