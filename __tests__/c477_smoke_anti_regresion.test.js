/**
 * Tests: C-477-SMOKE-ANTI-REGRESION — anti-regresion para fixes
 * C-471/C-472/C-473/C-475/C-476 contra prompt_builder.js + server.js +
 * voice_seed_center.md.
 *
 * Origen: ciclo ALERTA-ROJA Wi 2026-04-28 + firma viva expansiva
 * Mariano "si a todo!!! adelante!!!" + [ACK-STRIKE-5-VAMOS-C475].
 *
 * Cobertura E1-E10 v2_smoke_scenarios.md mapeada a tests:
 *   - E5 (cotizacion sin metadata interna) → tag_processing existente.
 *   - E10 (sos IA) → c464_voice_rewrite.
 *   - PRESION-VENTA (E8) → este archivo.
 *   - HEADER CARDS (E1+E2) → este archivo.
 *   - SALUDO time-aware (E1) → este archivo.
 *   - PREGUNTA DIRECTA (E9 desconfianza) → este archivo.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROMPT_BUILDER = fs.readFileSync(
  path.resolve(__dirname, '../core/prompt_builder.js'), 'utf8'
);
const SERVER_JS = fs.readFileSync(
  path.resolve(__dirname, '../server.js'), 'utf8'
);
const VOICE_SEED = fs.readFileSync(
  path.resolve(__dirname, '../prompts/v2/voice_seed_center.md'), 'utf8'
);

describe('C-477 anti-regresion fixes C-471 a C-476', () => {

  // ════════════════════════════════════════════════════════════════
  // C-471: presion venta eliminada (Anti-ADN P3 #3)
  // ════════════════════════════════════════════════════════════════
  describe('C-471 presion venta eliminada', () => {
    test('A.1 - prompt_builder NO contiene "10 demos gratis"', () => {
      expect(PROMPT_BUILDER).not.toMatch(/10 DEMOS GRATIS/);
      expect(PROMPT_BUILDER).not.toMatch(/10 demos gratis/i);
    });

    test('A.2 - prompt_builder NO contiene "demo #11"', () => {
      expect(PROMPT_BUILDER).not.toMatch(/demo #11/i);
    });

    test('A.3 - prompt_builder NO contiene "registrate antes de la demo #11"', () => {
      expect(PROMPT_BUILDER).not.toMatch(/registrate antes de la demo/i);
    });

    test('A.4 - prompt_builder titulo nuevo SIN PRESION presente', () => {
      expect(PROMPT_BUILDER).toMatch(/DEMOSTRAR CON HECHOS \(SIN PRESI[OÓ]N\)/);
    });

    test('A.5 - prompt_builder tiene REGLA #8 ANTI-PRESION ESTRICTO', () => {
      expect(PROMPT_BUILDER).toMatch(/ANTI-PRESI[OÓ]N ESTRICTO/);
      expect(PROMPT_BUILDER).toMatch(/Quedan pocas demos/);
      expect(PROMPT_BUILDER).toMatch(/se acaba el tiempo/);
    });

    test('A.6 - server.js NO inyecta "quedan pocas demos" en prompt activo', () => {
      // Excluir comments (lineas que empiezan con // o que son anchor doc fix).
      const linesNonComment = SERVER_JS.split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .join('\n');
      expect(linesNonComment).not.toMatch(/quedan pocas/i);
      expect(linesNonComment).not.toMatch(/SE ACERCAN AL FINAL/);
      expect(linesNonComment).not.toMatch(/YA SE ACABARON LAS 10 GRATIS/);
    });

    test('A.7 - server.js inyeccion tiene marker INTERACCION SIN presion', () => {
      expect(SERVER_JS).toMatch(/INTERACCI[OÓ]N #\$\{miiaResponseCount \+ 1\} CON ESTE LEAD/);
      expect(SERVER_JS).toMatch(/NUNCA digas "quedan X demos"/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // C-472: header cards "**MIIA Email**" prohibidos
  // ════════════════════════════════════════════════════════════════
  describe('C-472 header cards marketing prohibidos', () => {
    test('B.1 - prompt_builder REGLA #10 prohibe MIIA Email/Finanzas', () => {
      expect(PROMPT_BUILDER).toMatch(/PROHIBIDO HEADERS DE MARKETING/);
      expect(PROMPT_BUILDER).toMatch(/\*\*MIIA Email\*\*/);
      expect(PROMPT_BUILDER).toMatch(/\*\*MIIA Finanzas\*\*/);
      expect(PROMPT_BUILDER).toMatch(/\*\*MIIA Agenda\*\*/);
    });

    test('B.2 - voice_seed_center §6.11 anti-headers presente', () => {
      expect(VOICE_SEED).toMatch(/§6\.11 Anti-headers de marketing/);
      expect(VOICE_SEED).toMatch(/PROHIBIDO TOTAL/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // C-473: saludo time-aware inyectado al prompt
  // ════════════════════════════════════════════════════════════════
  describe('C-473 saludo time-aware inyectado', () => {
    test('C.1 - server.js calcula timezone segun countryCode', () => {
      expect(SERVER_JS).toMatch(/_leadTz.*=.*countryCode.*===.*'54'/);
      expect(SERVER_JS).toMatch(/America\/Argentina\/Buenos_Aires/);
      expect(SERVER_JS).toMatch(/America\/Bogota/);
    });

    test('C.2 - server.js calcula greeting buenos dias/tardes/noches', () => {
      expect(SERVER_JS).toMatch(/buenos d[ií]as/);
      expect(SERVER_JS).toMatch(/buenas tardes/);
      expect(SERVER_JS).toMatch(/buenas noches/);
    });

    test('C.3 - server.js inyecta hora local + saludo correcto al prompt', () => {
      expect(SERVER_JS).toMatch(/Hora local del lead/);
      expect(SERVER_JS).toMatch(/saludo time-aware correcto/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // C-475: AGENDAR_EVENTO guard pre-add (root cause)
  // ════════════════════════════════════════════════════════════════
  describe('C-475 AGENDAR_EVENTO guard pre-add', () => {
    const TMH = fs.readFileSync(
      path.resolve(__dirname, '../whatsapp/tenant_message_handler.js'), 'utf8'
    );

    test('D.1 - TMH valida scheduledForUTC antes de .add()', () => {
      expect(TMH).toMatch(/_scheduledIsoOk/);
      expect(TMH).toMatch(/!isNaN\(new Date\(scheduledForUTC\)\.getTime\(\)\)/);
    });

    test('D.2 - TMH valida reason no vacio', () => {
      expect(TMH).toMatch(/_reasonOk/);
      expect(TMH).toMatch(/razon\.trim\(\)\.length > 0/);
    });

    test('D.3 - TMH C-475 GUARD log error + notifica owner si invalido', () => {
      expect(TMH).toMatch(/C-475 GUARD: rechazo evento invalido/);
      expect(TMH).toMatch(/MIIA NO promete sin cumplir/);
    });

    test('D.4 - TMH defaults para optional fields (no undefined a Firestore)', () => {
      expect(TMH).toMatch(/contactPhone: resolvedContactPhone \|\| 'unknown'/);
      expect(TMH).toMatch(/eventMode: eventMode \|\| 'presencial'/);
      expect(TMH).toMatch(/calendarSynced: !!calendarOk/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // C-476: responder pregunta directa antes de cambiar tema
  // ════════════════════════════════════════════════════════════════
  describe('C-476 responder pregunta directa antes de cambiar tema', () => {
    test('E.1 - prompt_builder REGLA #-1 PRIORIDAD ABSOLUTA presente', () => {
      expect(PROMPT_BUILDER).toMatch(/REGLA #-1.*PRIORIDAD ABSOLUTA/);
      expect(PROMPT_BUILDER).toMatch(/RESPOND[EÉ] LA PREGUNTA DEL LEAD ANTES DE TODO/);
    });

    test('E.2 - prompt_builder ejemplos OBLIGATORIOS para preguntas tipo', () => {
      expect(PROMPT_BUILDER).toMatch(/por qu[eé] deber[ií]a contratarte/i);
      expect(PROMPT_BUILDER).toMatch(/cu[aá]nto sale/i);
      expect(PROMPT_BUILDER).toMatch(/sos confiable/i);
    });

    test('E.3 - voice_seed_center §6.12 responder pregunta directa', () => {
      expect(VOICE_SEED).toMatch(/§6\.12 Responder pregunta directa antes de cambiar tema/);
      expect(VOICE_SEED).toMatch(/PRIORIDAD ABSOLUTA/);
    });
  });

  // ════════════════════════════════════════════════════════════════
  // C-477 audit: §6.11 + §6.12 + historial v2.1+EMPATIA+C477
  // ════════════════════════════════════════════════════════════════
  describe('C-477 audit cuaternario', () => {
    test('F.1 - voice_seed §6.11 (anti-headers) + §6.12 (pregunta directa) presentes', () => {
      expect(VOICE_SEED).toMatch(/### §6\.11 Anti-headers de marketing \(C-472\)/);
      expect(VOICE_SEED).toMatch(/### §6\.12 Responder pregunta directa antes de cambiar tema \(C-476\)/);
    });

    test('F.2 - voice_seed historial marker v2.1+EMPATIA+C477 presente', () => {
      expect(VOICE_SEED).toMatch(/v2\.1\+EMPATIA\+C477.*2026-04-28/);
    });
  });

});
