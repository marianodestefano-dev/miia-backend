/**
 * CONFIDENCE ENGINE — Sistema de inteligencia progresiva para MIIA
 *
 * MIIA aprende qué es importante automáticamente:
 * 1. Evalúa importancia de nuevos inputs (0-100)
 * 2. Si confidence < threshold → pregunta a Mariano
 * 3. Aprende del feedback (sí/no) para mejorar certeza futura
 * 4. Memoriza patrones de lo que Mariano considera importante
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIDENCE_FILE = path.join(DATA_DIR, 'confidence_patterns.json');

// Estado en memoria
let confidencePatterns = {
  patterns: [],      // Histórico de decisiones: { text, score, feedback, timestamp }
  thresholds: {
    auto_save: 85,   // >= 85% confidence → guarda directo sin preguntar
    ask: 70,         // 70-84% → pregunta a Mariano
    ignore: 0        // < 70% → ignora
  },
  feedback_history: []  // Para aprender de Mariano
};

// Cargar histórico
function loadPatterns() {
  try {
    if (fs.existsSync(CONFIDENCE_FILE)) {
      confidencePatterns = JSON.parse(fs.readFileSync(CONFIDENCE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[CONFIDENCE] Error cargando patterns:', e.message);
  }
}

// Guardar histórico
function savePatterns() {
  try {
    fs.writeFileSync(CONFIDENCE_FILE, JSON.stringify(confidencePatterns, null, 2));
  } catch (e) {
    console.error('[CONFIDENCE] Error guardando patterns:', e.message);
  }
}

/**
 * Evalúa qué tan importante es un trozo de texto (0-100)
 * Basado en: estructura, complejidad, datos críticos, aplicabilidad
 */
async function evaluateImportance(text, callGemini) {
  if (!text || text.length < 20) return 15; // Muy corto = poco importante

  try {
    const evalPrompt = `Evalúa la IMPORTANCIA de este contenido para una IA de ventas (0-100):

CONTENIDO: "${text.substring(0, 500)}"

Criterios:
- 80-100: CRÍTICO — Reglas de negocio, precios, restricciones, instrucciones maestras, normativa
- 60-79: IMPORTANTE — Datos de productos, contexto comercial, patrones de venta
- 40-59: MODERADO — Información de clientes, anécdotas, contexto conversacional
- 20-39: MENOR — Observaciones, ejemplos casuales
- 0-19: TRIVIAL — Saludos, pruebas, ruido

Responde SOLO con un número (0-100):`;

    const result = await callGemini(evalPrompt);
    const score = parseInt(result.match(/\\d+/)?.[0] || '50');
    return Math.min(100, Math.max(0, score));
  } catch (e) {
    console.error('[CONFIDENCE] Error evaluando importancia:', e.message);
    return 50; // Default: neutral
  }
}

/**
 * Decide qué hacer basado en importancia y patrón de aprendizaje
 * Retorna: { action, confidence, reason }
 */
function decideAction(importance, text) {
  // Revisar si patrones similares fueron confirmados por Mariano
  const similarPatterns = findSimilarPatterns(text, 0.75); // 75% similitud

  // Si hay 3+ confirmaciones similares, aumentar confianza
  const boostFromHistory = similarPatterns.filter(p => p.feedback === 'yes').length * 5;
  const confidenceScore = Math.min(100, importance + boostFromHistory);

  let action = 'ignore';
  let reason = 'Importancia baja';

  if (confidenceScore >= confidencePatterns.thresholds.auto_save) {
    action = 'save';
    reason = `Confianza alta (${confidenceScore}%) — guardar automáticamente`;
  } else if (confidenceScore >= confidencePatterns.thresholds.ask) {
    action = 'ask';
    reason = `Confianza media (${confidenceScore}%) — preguntar a Mariano`;
  } else {
    action = 'ignore';
    reason = `Confianza baja (${confidenceScore}%) — ignorar`;
  }

  return { action, confidence: confidenceScore, reason };
}

/**
 * Busca patrones similares en histórico
 */
function findSimilarPatterns(text, minSimilarity = 0.7) {
  return confidencePatterns.patterns.filter(p => {
    const similarity = calculateSimilarity(text, p.text);
    return similarity >= minSimilarity;
  });
}

/**
 * Calcula similitud entre dos strings (0-1)
 */
function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().split(/\s+/).slice(0, 10).join(' ');
  const s2 = str2.toLowerCase().split(/\s+/).slice(0, 10).join(' ');

  const minLen = Math.min(s1.length, s2.length);
  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (s1[i] === s2[i]) matches++;
  }
  return matches / Math.max(s1.length, s2.length);
}

/**
 * Registra feedback de Mariano ("sí", "no", "solo esto")
 */
function recordFeedback(text, feedback, importance) {
  confidencePatterns.patterns.push({
    text: text.substring(0, 300),
    importanceScore: importance,
    feedback, // 'yes' | 'no' | 'partial'
    timestamp: new Date().toISOString()
  });

  // Actualizar estadísticas para mejorar thresholds futuro
  const recentYes = confidencePatterns.patterns.filter(
    p => p.feedback === 'yes' &&
    new Date(p.timestamp) > new Date(Date.now() - 7*24*60*60*1000) // Últimas 7 días
  ).length;

  const recentNo = confidencePatterns.patterns.filter(
    p => p.feedback === 'no' &&
    new Date(p.timestamp) > new Date(Date.now() - 7*24*60*60*1000)
  ).length;

  // Si últimos 10 feedback fueron "sí" → subir threshold de auto_save
  if (recentYes > 8 && recentNo < 2) {
    confidencePatterns.thresholds.auto_save = Math.max(75, confidencePatterns.thresholds.auto_save - 2);
  }
  // Si últimos feedback fueron "no" → bajar threshold (ser más conservador)
  if (recentNo > 5) {
    confidencePatterns.thresholds.auto_save = Math.min(95, confidencePatterns.thresholds.auto_save + 3);
  }

  savePatterns();
}

// Inicializar
loadPatterns();

module.exports = {
  evaluateImportance,
  decideAction,
  recordFeedback,
  findSimilarPatterns,
  getPatterns: () => confidencePatterns,
  loadPatterns,
  savePatterns
};
