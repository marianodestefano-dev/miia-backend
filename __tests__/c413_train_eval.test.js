'use strict';

/**
 * Tests integration C-413 — /api/train APRENDE: bypass + fail soft.
 *
 * Bug pre-existente: cuando admin enviaba "APRENDE: <contenido>" en Chat
 * Experto, el handler ignoraba el prefijo y mandaba todo el mensaje al
 * evalPrompt Gemini. Si Gemini devolvía formato inesperado (no UTIL/
 * PREGUNTA/BASURA), parsing fallaba → owner recibía respuesta confusa.
 *
 * Fix C-413 v2 (post-Voz Vi REGLA #0):
 * - Cambio 1: APRENDE: explícito → bypass eval, guardar directo. Regex
 *   robusto a leading whitespace (^\s*APRENDE:\s*). Cap 5000 chars
 *   server-side defensa-en-profundidad.
 * - Cambio 2: fail soft educativo si Gemini devuelve formato inesperado.
 *   NO guarda a ciegas (eso ensucia corpus sin undo). Educa al admin
 *   sobre patrón APRENDE: explícito.
 *
 * Estrategia: NO importar server.js (5000+ líneas). Harness Express con
 * misma lógica del handler real + mocks de generateAIContent +
 * cerebroAbsoluto + saveDB + userProfile + resolveOwnerFirstName.
 *
 * 9 cases:
 *   1. APRENDE: con contenido válido → UTIL_EXPLICIT 200 + saved
 *   2. APRENDE: solo prefijo sin contenido → EMPTY 200 + saved=false
 *   3. APRENDE: case-insensitive (apreNDE:) → match
 *   4. APRENDE: con leading whitespace ("  APRENDE: ...") → match (regex \s*)
 *   5. APRENDE: con contenido > 5000 chars → cap server-side aplicado
 *   6. Mensaje sin APRENDE: + Gemini UTIL → guardado original (regresión)
 *   7. Mensaje sin APRENDE: + Gemini PREGUNTA → respuesta original
 *   8. Mensaje sin APRENDE: + Gemini formato inesperado → UNKNOWN fail soft
 *   9. Mensaje sin APRENDE: + generateAIContent throw → 500 con error capturado
 */

const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────────
const generateAIContent = jest.fn();
const cerebroAbsoluto = { appendLearning: jest.fn() };
const saveDB = jest.fn();
const userProfile = { name: 'Mariano' };
const resolveOwnerFirstName = jest.fn(() => 'Mariano');

// ─── Harness Express con la lógica real del handler /api/train (v2) ───
function buildApp() {
  const app = express();
  app.use(express.json());

  app.post('/api/train', async (req, res) => {
    try {
      const { message } = req.body || {};
      if (!message || !message.trim()) return res.status(400).json({ error: 'message requerido' });

      // C-413 Cambio 1: APRENDE: explícito bypass
      const APRENDE_REGEX = /^\s*APRENDE:\s*/i;
      if (APRENDE_REGEX.test(message)) {
        const knowledgeToSave = message.replace(APRENDE_REGEX, '').trim().slice(0, 5000);
        if (knowledgeToSave.length < 5) {
          return res.json({
            response: 'Por favor agregá contenido después de APRENDE: para que pueda guardarlo.',
            saved: false,
            tipo: 'EMPTY'
          });
        }
        cerebroAbsoluto.appendLearning(knowledgeToSave, 'WEB_TRAINING_EXPLICIT');
        saveDB();
        return res.json({
          response: `✅ Guardado en mi memoria: "${knowledgeToSave.slice(0, 80)}${knowledgeToSave.length > 80 ? '...' : ''}"`,
          saved: true,
          tipo: 'UTIL_EXPLICIT'
        });
      }

      const evalResult = await generateAIContent('eval prompt mock');
      const lines = (evalResult || '').split('\n').map(l => l.trim()).filter(Boolean);
      const tipo = (lines[0] || '').toUpperCase().replace(/[^A-Z]/g, '');
      const detail = lines[1] || '';

      // C-413 Cambio 2: fail soft educativo
      if (tipo !== 'UTIL' && tipo !== 'PREGUNTA' && tipo !== 'BASURA') {
        return res.json({
          response: 'Hmm, no estoy segura si querés que guarde eso. Si es conocimiento para enseñarme, escribilo con prefijo "APRENDE: ..." y lo guardo seguro. Si era pregunta o test, ignorá.',
          saved: false,
          tipo: 'UNKNOWN'
        });
      }

      if (tipo === 'UTIL') {
        const knowledgeToSave = detail || message;
        cerebroAbsoluto.appendLearning(knowledgeToSave, 'WEB_TRAINING');
        saveDB();
        const confirmation = await generateAIContent('confirm prompt mock');
        res.json({ response: confirmation || '✅ Guardado en mi memoria.', saved: true, tipo: 'UTIL' });
      } else if (tipo === 'PREGUNTA') {
        res.json({ response: `Eso parece una pregunta, no un conocimiento para guardar. ${detail}`, saved: false, tipo: 'PREGUNTA' });
      } else {
        res.json({ response: `No guardé eso — parece texto de prueba o sin sentido. ${detail}`, saved: false, tipo: 'BASURA' });
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return app;
}

beforeEach(() => {
  generateAIContent.mockReset();
  cerebroAbsoluto.appendLearning.mockReset();
  saveDB.mockReset();
  resolveOwnerFirstName.mockReset();
  resolveOwnerFirstName.mockReturnValue('Mariano');
});

// ════════════════════════════════════════════════════════════════════════
// §1 — APRENDE: bypass eval (Cambio 1)
// ════════════════════════════════════════════════════════════════════════

describe('§1 APRENDE: bypass eval (Cambio 1)', () => {
  test('case 1 — APRENDE: con contenido válido → UTIL_EXPLICIT 200 + saved', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: 'APRENDE: la regla X es importante' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.tipo).toBe('UTIL_EXPLICIT');
    expect(res.body.response).toContain('Guardado en mi memoria');
    expect(cerebroAbsoluto.appendLearning).toHaveBeenCalledWith('la regla X es importante', 'WEB_TRAINING_EXPLICIT');
    expect(saveDB).toHaveBeenCalledTimes(1);
    // Bypass eval: NO debe llamar a generateAIContent
    expect(generateAIContent).not.toHaveBeenCalled();
  });

  test('case 2 — APRENDE: solo prefijo sin contenido → EMPTY 200 + saved=false', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: 'APRENDE: ' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.tipo).toBe('EMPTY');
    expect(cerebroAbsoluto.appendLearning).not.toHaveBeenCalled();
  });

  test('case 3 — APRENDE: case-insensitive (apreNDE:) → match', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: 'apreNDE: contenido válido aquí' });
    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('UTIL_EXPLICIT');
    expect(cerebroAbsoluto.appendLearning).toHaveBeenCalledWith('contenido válido aquí', 'WEB_TRAINING_EXPLICIT');
  });

  test('case 4 — APRENDE: con leading whitespace → match (regex \\s* robusto)', async () => {
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: '  APRENDE: con espacios al inicio' });
    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('UTIL_EXPLICIT');
    expect(cerebroAbsoluto.appendLearning).toHaveBeenCalledWith('con espacios al inicio', 'WEB_TRAINING_EXPLICIT');
  });

  test('case 5 — APRENDE: con > 5000 chars → cap server-side aplicado', async () => {
    const app = buildApp();
    const longContent = 'a'.repeat(6000);
    const res = await request(app).post('/api/train').send({ message: `APRENDE: ${longContent}` });
    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('UTIL_EXPLICIT');
    const savedArg = cerebroAbsoluto.appendLearning.mock.calls[0][0];
    expect(savedArg.length).toBeLessThanOrEqual(5000);
  });
});

// ════════════════════════════════════════════════════════════════════════
// §2 — Path original sin APRENDE: (regresión)
// ════════════════════════════════════════════════════════════════════════

describe('§2 Path original sin APRENDE: (regresión)', () => {
  test('case 6 — sin APRENDE: + Gemini UTIL → guardado original', async () => {
    generateAIContent
      .mockResolvedValueOnce('UTIL\nLa regla mejorada es X')  // eval prompt
      .mockResolvedValueOnce('Anotado, jefe.');                 // confirm prompt
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: 'el descuento es 10% en días lunes' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
    expect(res.body.tipo).toBe('UTIL');
    expect(cerebroAbsoluto.appendLearning).toHaveBeenCalledWith('La regla mejorada es X', 'WEB_TRAINING');
  });

  test('case 7 — sin APRENDE: + Gemini PREGUNTA → respuesta original', async () => {
    generateAIContent.mockResolvedValueOnce('PREGUNTA\nEl usuario está testeando');
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: '¿cómo funciona MIIA?' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.tipo).toBe('PREGUNTA');
    expect(cerebroAbsoluto.appendLearning).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════
// §3 — Cambio 2 fail soft educativo (NO guardar a ciegas)
// ════════════════════════════════════════════════════════════════════════

describe('§3 Cambio 2 fail soft educativo', () => {
  test('case 8 — sin APRENDE: + Gemini formato inesperado → UNKNOWN fail soft + NO guarda', async () => {
    generateAIContent.mockResolvedValueOnce('Análisis razonado del mensaje del usuario que no respeta el formato esperado UTIL/PREGUNTA/BASURA');
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: 'test sesión 25 abril' });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(false);
    expect(res.body.tipo).toBe('UNKNOWN');
    expect(res.body.response).toContain('APRENDE:');
    // CRÍTICO: NO guarda a ciegas
    expect(cerebroAbsoluto.appendLearning).not.toHaveBeenCalled();
  });

  test('case 9 — sin APRENDE: + generateAIContent throw → 500 con error capturado (R-2)', async () => {
    generateAIContent.mockRejectedValueOnce(new Error('Gemini timeout 503'));
    const app = buildApp();
    const res = await request(app).post('/api/train').send({ message: 'cualquier mensaje sin APRENDE:' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Gemini');
    expect(cerebroAbsoluto.appendLearning).not.toHaveBeenCalled();
  });
});
