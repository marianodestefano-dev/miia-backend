/**
 * MIIA Pattern Engine + ADN Vendedor
 * Analiza conversaciones de leads para detectar patrones y aprender
 * el estilo de venta del owner.
 *
 * Patrones detectados:
 * - Preguntas frecuentes (FAQ automático)
 * - Objeciones comunes y cómo las maneja el owner
 * - Frases que cierran ventas vs frases que las pierden
 * - Horarios de mayor conversión
 * - Tiempo promedio hasta cierre
 *
 * ADN Vendedor:
 * - Estilo de comunicación del owner (formal/informal, emojis, etc.)
 * - Tono ante objeciones (agresivo/empático/técnico)
 * - Velocidad de respuesta promedio
 * - Estrategias de cierre preferidas
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

'use strict';

let _deps = null;
let _ownerUid = null;
let _analysisInterval = null;

const ANALYSIS_INTERVAL_MS = 86400000; // 1 vez por día

/**
 * Inicializa el pattern engine.
 * @param {string} ownerUid
 * @param {Object} deps - { firestore, aiGateway }
 */
function init(ownerUid, deps) {
  _ownerUid = ownerUid;
  _deps = deps;

  _analysisInterval = setInterval(runPatternAnalysis, ANALYSIS_INTERVAL_MS);
  console.log('[PATTERN-ENGINE] ✅ Inicializado — análisis diario de patrones');

  // Primera ejecución en 15 min (dar tiempo a que todo cargue)
  setTimeout(runPatternAnalysis, 900000);
}

/**
 * Analiza las conversaciones recientes para detectar patrones.
 */
async function runPatternAnalysis() {
  if (!_deps || !_ownerUid) return;

  const { firestore, aiGateway } = _deps;
  if (!firestore || !aiGateway) return;

  try {
    // 1. Recolectar conversaciones de leads de los últimos 7 días
    const conversations = await collectLeadConversations(7);
    if (!conversations || conversations.length < 3) {
      console.log('[PATTERN-ENGINE] 📭 Pocas conversaciones de leads (< 3) — saltando análisis');
      return;
    }

    console.log(`[PATTERN-ENGINE] 📊 Analizando ${conversations.length} conversaciones de leads...`);

    // 2. Detectar patrones con IA
    const patterns = await detectPatterns(conversations);
    if (!patterns) return;

    // 3. Guardar patrones en Firestore
    const today = new Date().toISOString().split('T')[0];
    await firestore.collection('users').doc(_ownerUid)
      .collection('pattern_analysis').doc(today)
      .set({
        date: today,
        conversationsAnalyzed: conversations.length,
        patterns,
        generatedAt: new Date().toISOString()
      });

    // 4. Actualizar ADN vendedor (acumulativo)
    await updateSellerDNA(patterns);

    console.log(`[PATTERN-ENGINE] ✅ Patrones detectados y ADN actualizado (${today})`);
  } catch (e) {
    console.error(`[PATTERN-ENGINE] ❌ Error: ${e.message}`);
  }
}

async function collectLeadConversations(days) {
  const { firestore } = _deps;
  const conversations = [];

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    for (let d = 0; d < days; d++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + d);
      const dateStr = date.toISOString().split('T')[0];

      const doc = await firestore.collection('users').doc(_ownerUid)
        .collection('tenant_sessions').doc(dateStr).get();

      if (doc.exists) {
        const data = doc.data();
        if (data.conversations) {
          for (const [phone, conv] of Object.entries(data.conversations)) {
            if (conv.messages && conv.messages.length >= 2) {
              conversations.push({
                phone,
                date: dateStr,
                contactName: conv.contactName || phone,
                type: conv.type || 'lead',
                messageCount: conv.messages.length,
                messages: conv.messages.slice(-30).map(m => ({
                  role: m.role || m.from || 'unknown',
                  text: (m.text || m.body || m.content || '').substring(0, 300)
                }))
              });
            }
          }
        }
      }
    }
  } catch (e) {
    console.error(`[PATTERN-ENGINE] ❌ Error recolectando: ${e.message}`);
  }

  return conversations;
}

async function detectPatterns(conversations) {
  const { aiGateway } = _deps;

  const convSummary = conversations.map(c => {
    const msgs = c.messages.map(m => `[${m.role}]: ${m.text}`).join('\n');
    return `--- ${c.contactName} (${c.date}, ${c.messageCount} msgs) ---\n${msgs}`;
  }).join('\n\n');

  const prompt = `Analizá estas ${conversations.length} conversaciones de leads y detectá patrones.

CONVERSACIONES:
${convSummary.substring(0, 8000)}

EXTRAÉ:

1. **FAQ** — Las 5 preguntas más frecuentes de los leads (con respuesta ideal)
2. **OBJECIONES** — Las 3 objeciones más comunes y la mejor forma de manejarlas
3. **CIERRE** — Frases o estrategias que funcionaron para cerrar (o perder) ventas
4. **HORARIOS** — En qué horarios los leads son más receptivos
5. **ADN_VENDEDOR** — Estilo de venta detectado del owner (tono, velocidad, estrategia)

Formato JSON estricto:
{
  "faq": [{"question": "...", "idealAnswer": "..."}],
  "objections": [{"objection": "...", "bestResponse": "..."}],
  "closingStrategies": ["..."],
  "peakHours": ["..."],
  "sellerDNA": {
    "tone": "informal/formal/mixto",
    "speed": "rápido/normal/lento",
    "style": "consultivo/agresivo/empático",
    "strengths": ["..."],
    "weaknesses": ["..."]
  }
}`;

  try {
    const result = await aiGateway.smartCall('nightly_brain', prompt, {}, { maxTokens: 2048 });
    if (!result?.text) return null;

    // Intentar parsear JSON
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Si no es JSON, guardar como texto
    return { rawAnalysis: result.text };
  } catch (e) {
    console.error(`[PATTERN-ENGINE] ❌ Error detectando patrones: ${e.message}`);
    return null;
  }
}

async function updateSellerDNA(patterns) {
  if (!patterns?.sellerDNA && !patterns?.faq) return;

  const { firestore } = _deps;

  try {
    const dnaDoc = await firestore.collection('users').doc(_ownerUid)
      .collection('settings').doc('seller_dna').get();

    const existingDNA = dnaDoc.exists ? dnaDoc.data() : {};

    // Merge FAQ (acumular, no reemplazar)
    const existingFAQ = existingDNA.faq || [];
    const newFAQ = patterns.faq || [];
    const mergedFAQ = [...existingFAQ];

    for (const newQ of newFAQ) {
      const exists = mergedFAQ.some(q =>
        q.question.toLowerCase().includes(newQ.question.toLowerCase().substring(0, 20))
      );
      if (!exists) mergedFAQ.push(newQ);
    }

    // Guardar DNA actualizado
    await firestore.collection('users').doc(_ownerUid)
      .collection('settings').doc('seller_dna')
      .set({
        ...existingDNA,
        faq: mergedFAQ.slice(-20), // Max 20 FAQs
        objections: patterns.objections || existingDNA.objections || [],
        closingStrategies: patterns.closingStrategies || existingDNA.closingStrategies || [],
        sellerDNA: patterns.sellerDNA || existingDNA.sellerDNA || {},
        lastUpdated: new Date().toISOString(),
        totalAnalyses: (existingDNA.totalAnalyses || 0) + 1
      }, { merge: true });

    console.log(`[PATTERN-ENGINE] 🧬 ADN vendedor actualizado (${mergedFAQ.length} FAQs, análisis #${(existingDNA.totalAnalyses || 0) + 1})`);
  } catch (e) {
    console.error(`[PATTERN-ENGINE] ❌ Error actualizando DNA: ${e.message}`);
  }
}

/**
 * Obtener el ADN vendedor actual (para inyectar en prompts de leads).
 */
async function getSellerDNA() {
  if (!_deps?.firestore || !_ownerUid) return null;

  try {
    const doc = await _deps.firestore.collection('users').doc(_ownerUid)
      .collection('settings').doc('seller_dna').get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.error(`[PATTERN-ENGINE] ❌ Error leyendo DNA: ${e.message}`);
    return null;
  }
}

function stop() {
  if (_analysisInterval) clearInterval(_analysisInterval);
  console.log('[PATTERN-ENGINE] 🛑 Detenido');
}

module.exports = { init, stop, getSellerDNA, runPatternAnalysis };
