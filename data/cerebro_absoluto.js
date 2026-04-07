'use strict';

/**
 * CEREBRO ABSOLUTO v2 — Módulo de aprendizaje autónomo para MIIA
 *
 * Cada noche a las 03:00 AM escanea chats históricos de WhatsApp con leads,
 * los clasifica (VENTA / DEBATE / NEGOCIACION / SILENCIO) y le pide a Gemini
 * que extraiga patrones de comunicación exitosos.
 * El resultado se acumula en trainingData y se inyecta al system prompt de MIIA.
 *
 * Escudos anti-baneo WhatsApp:
 *   - Solo corre a las 03:00 AM (tráfico mínimo)
 *   - Bloquea los domingos
 *   - Límite diario ALEATORIO 90-120 chats (no predecible por WA)
 *   - Pausa aleatoria 2-3 segundos entre cada chat leído
 *   - READ ONLY: nunca envía mensajes durante el minado
 *   - Bookmark: retoma exactamente donde quedó si se interrumpe
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────

let trainingData = '';

let adnMinerState = {
  currentSearchDate : 0,
  lastExecutionDayStr: '',
  dailyCount        : 0,
  dailyLimit        : 90,
  totalProcessed    : 0,
  isComplete        : false,
  lastProcessedPhone: null,
  dayD              : null
};

let _client            = null;
let _generateAIContent = null;
let _onTrainingUpdate  = null;
let _adnStatePath      = null;
let _isRunning         = false;

// ─────────────────────────────────────────────
// PERSISTENCIA
// ─────────────────────────────────────────────

function saveAdnMinerState() {
  if (!_adnStatePath) return;
  try {
    fs.writeFileSync(_adnStatePath, JSON.stringify(adnMinerState, null, 2));
  } catch (e) {
    console.error('[CEREBRO ABSOLUTO] Error guardando estado:', e.message);
  }
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

/**
 * @param {object}   opts.whatsappClient       - instancia whatsapp-web.js
 * @param {function} opts.generateAIContent    - async (prompt) => string
 * @param {function} opts.onTrainingUpdate     - callback(trainingData) para persistir en server
 * @param {string}   opts.dataDir              - ruta al directorio /data
 * @param {string}   [opts.initialTrainingData]- trainingData previo desde la DB
 */
function init({ whatsappClient, generateAIContent, onTrainingUpdate, dataDir, initialTrainingData = '' }) {
  _client            = whatsappClient;
  _generateAIContent = generateAIContent;
  _onTrainingUpdate  = onTrainingUpdate;
  _adnStatePath      = path.join(dataDir, 'adn_miner_state.json');

  if (initialTrainingData) trainingData = initialTrainingData;

  if (fs.existsSync(_adnStatePath)) {
    try {
      adnMinerState = { ...adnMinerState, ...JSON.parse(fs.readFileSync(_adnStatePath, 'utf8')) };
      console.log(`[CEREBRO ABSOLUTO] Estado restaurado. Total procesado: ${adnMinerState.totalProcessed} chats.`);
    } catch (_) {
      console.warn('[CEREBRO ABSOLUTO] Sin estado previo, iniciando desde cero.');
    }
  }

  console.log('[CEREBRO ABSOLUTO] Modulo listo. Minado nocturno: 03:00 AM (Bogotá).');
}

function updateClient(whatsappClient) {
  _client = whatsappClient;
}

// ─────────────────────────────────────────────
// GETTERS / SETTERS
// ─────────────────────────────────────────────

function getTrainingData()     { return trainingData; }
function setTrainingData(data) { trainingData = data || ''; }

// ─────────────────────────────────────────────
// CLASIFICACIÓN
// ─────────────────────────────────────────────

function classifyChat(messages) {
  const isVenta = messages.some(m => m.fromMe && (
    /bienvenid[oa]/i.test(m.body || '') ||
    /acceso\s+activ/i.test(m.body || '') ||
    /contrato/i.test(m.body || '') ||
    /cerramos/i.test(m.body || '') ||
    /cliente\s+nuevo/i.test(m.body || '')
  ));
  const firstMiia   = messages.find(m => m.fromMe);
  const isSilencio  = firstMiia && !messages.some(m => !m.fromMe && m.timestamp > firstMiia.timestamp);
  const isDebate    = messages.length > 20;

  if (isVenta)    return 'VENTA';
  if (isDebate)   return 'DEBATE';
  if (isSilencio) return 'SILENCIO';
  return 'NEGOCIACION';
}

// ─────────────────────────────────────────────
// EXTRACCIÓN PRINCIPAL
// ─────────────────────────────────────────────

async function extractDNAChronological() {
  if (_isRunning) {
    console.log('[CEREBRO ABSOLUTO] Extraccion ya en curso. Saltando.');
    return;
  }

  const todayStr = new Date().toLocaleDateString('es-ES');

  if (adnMinerState.lastExecutionDayStr === todayStr && adnMinerState.dailyCount >= adnMinerState.dailyLimit) {
    console.log(`[CEREBRO ABSOLUTO] Limite diario (${adnMinerState.dailyLimit}) alcanzado. Siguiente ciclo manana 03:00 AM.`);
    return;
  }

  if (adnMinerState.lastExecutionDayStr !== todayStr) {
    adnMinerState.dailyLimit = Math.floor(Math.random() * (120 - 90 + 1)) + 90;
    adnMinerState.dailyCount = 0;
    adnMinerState.lastExecutionDayStr = todayStr;
  }

  const oneDayAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  if (adnMinerState.currentSearchDate >= oneDayAgo) {
    adnMinerState.isComplete = true;
    saveAdnMinerState();
    console.log('[CEREBRO ABSOLUTO] Historial al dia. Motor en reposo.');
    return;
  }

  if (!_client) {
    console.warn('[CEREBRO ABSOLUTO] Cliente WA no disponible. Abortando.');
    return;
  }

  // Baileys no tiene getChats() — el minado masivo requiere whatsapp-web.js
  // El aprendizaje en tiempo real (appendLearning) SÍ funciona con Baileys
  if (typeof _client.getChats !== 'function') {
    console.log('[CEREBRO ABSOLUTO] Baileys detectado — minado masivo no disponible. Aprendizaje en tiempo real activo.');
    _isRunning = false;
    return;
  }

  _isRunning = true;
  console.log(`[CEREBRO ABSOLUTO] Iniciando minado. Limite hoy: ${adnMinerState.dailyLimit} chats.`);

  try {
    const chats       = await _client.getChats();
    const targetChats = [];

    for (const chat of chats) {
      if (chat.isGroup) continue;
      try {
        const contact = await chat.getContact();
        if (
          !contact.isMyContact &&
          chat.timestamp >= adnMinerState.currentSearchDate &&
          chat.timestamp <= oneDayAgo
        ) {
          targetChats.push(chat);
        }
      } catch (_) {}
    }

    targetChats.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`[CEREBRO ABSOLUTO] ${targetChats.length} chats candidatos.`);

    let extractedCount = 0;
    let batchContext   = '';

    for (const chat of targetChats) {
      if (adnMinerState.dailyCount >= adnMinerState.dailyLimit) break;

      if (adnMinerState.lastProcessedPhone && chat.id._serialized === adnMinerState.lastProcessedPhone) {
        adnMinerState.lastProcessedPhone = null;
        continue;
      }

      try {
        const messages = await chat.fetchMessages({ limit: 40 });
        if (!messages.some(m => m.fromMe)) continue;

        const contact     = await chat.getContact();
        const contactName = contact.name || contact.pushname || 'Lead';
        const phoneStr    = chat.id._serialized;
        const type        = classifyChat(messages);
        const chatLog     = messages
          .map(m => `${m.fromMe ? 'MIIA' : 'Lead'}: ${(m.body || '').replace(/\n/g, ' ')}`)
          .join('\n');

        batchContext += `\n[TIPO: ${type}] Chat con ${contactName} (${phoneStr}):\n${chatLog}\n`;

        extractedCount++;
        adnMinerState.dailyCount++;
        adnMinerState.totalProcessed++;
        adnMinerState.currentSearchDate  = chat.timestamp;
        adnMinerState.lastProcessedPhone = phoneStr;
        saveAdnMinerState();

        // ANTI-SPAM: pausa aleatoria 2-3 segundos
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1000) + 2000));

      } catch (_) {}
    }

    if (batchContext.length > 0 && _generateAIContent) {
      console.log(`[CEREBRO ABSOLUTO] Enviando ${extractedCount} chats a Gemini para analisis ADN...`);

      const prompt = `Eres MIIA, la asistente de ventas de Medilink creada por Mariano.
Analiza este lote de conversaciones reales de WhatsApp con leads medicos, clasificadas por tipo:
  VENTA = lead se convirtio en cliente
  DEBATE = conversacion larga con muchas objeciones
  NEGOCIACION = mostro interes pero no cerro
  SILENCIO = nunca respondio tras el primer contacto

Extrae los patrones de comunicacion mas efectivos, las objeciones mas frecuentes y que respuestas generaron mayor engagement. Responde en 1ra persona como MIIA. Maximo 300 palabras.

${batchContext}`;

      const adnUpdate = await _generateAIContent(prompt);

      if (adnUpdate && adnUpdate.trim()) {
        const stamp = new Date().toLocaleDateString('es-ES');
        appendLearning(adnUpdate, `ADN_CRONOLOGICO_${stamp}`);
        console.log(`[CEREBRO ABSOLUTO] ADN actualizado (${adnUpdate.length} chars).`);
      }
    }

    console.log(`[CEREBRO ABSOLUTO] Ciclo completo. Hoy: ${extractedCount}. Total: ${adnMinerState.totalProcessed}.`);

  } catch (e) {
    console.error('[CEREBRO ABSOLUTO] Error en extraccion:', e.message);
  } finally {
    _isRunning = false;
  }
}

// ─────────────────────────────────────────────
// CRON (llamar cada 60s desde server_v2.js)
// ─────────────────────────────────────────────

async function processADNMinerCron() {
  try {
    const nowBogota = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    if (nowBogota.getDay() === 0) return; // Domingo: prohibido

    const h       = nowBogota.getHours();
    const todayStr = `${nowBogota.getFullYear()}-${nowBogota.getMonth()}-${nowBogota.getDate()}`;

    if (h === 3 && adnMinerState.lastExecutionDayStr !== todayStr) {
      console.log('[CRON ADN] 03:00 AM — Lanzando CEREBRO ABSOLUTO...');
      if (!adnMinerState.dayD) adnMinerState.dayD = Date.now();
      saveAdnMinerState();
      await extractDNAChronological();
    }
  } catch (e) {
    console.error('[CRON ADN] Error:', e.message);
  }
}

// ─────────────────────────────────────────────
// APRENDIZAJE — PUNTO DE ESCRITURA ÚNICO
// ─────────────────────────────────────────────

/**
 * Agrega un bloque de conocimiento a trainingData desde cualquier fuente.
 * @param {string} text   - Contenido del aprendizaje
 * @param {string} source - Etiqueta de origen (WHATSAPP_ADMIN, WEB_TRAINING, API_DIRECTA, MIIA_AUTO, etc.)
 */
function appendLearning(text, source) {
  if (!text || !text.trim()) return;

  // ═══ FIX GAP 4: Dedup — no agregar si ya existe contenido idéntico o muy similar ═══
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  // Buscar si ya existe una línea con contenido sustancialmente igual (>80% de las palabras)
  const existingLines = trainingData.toLowerCase();
  if (existingLines.includes(normalized)) {
    console.log(`[CEREBRO] ⏭️ Aprendizaje duplicado exacto, saltando: "${text.substring(0, 60)}..."`);
    return;
  }
  // Check por similitud de palabras clave (evitar "Juan hincha Boca" x10 con variaciones)
  const keywords = normalized.split(' ').filter(w => w.length > 3);
  if (keywords.length >= 3) {
    const keyPattern = keywords.slice(0, 4).join('.*');
    try {
      const regex = new RegExp(keyPattern, 'i');
      if (regex.test(existingLines)) {
        console.log(`[CEREBRO] ⏭️ Aprendizaje similar ya existe (keywords match), saltando: "${text.substring(0, 60)}..."`);
        return;
      }
    } catch (_) { /* regex inválida — ignorar y guardar */ }
  }

  const stamp = new Date().toLocaleDateString('es-ES');
  const src   = (source || 'MANUAL').toUpperCase().replace(/\s+/g, '_');
  trainingData += `\n\n[APRENDIZAJE ${src} — ${stamp}]\n${text.trim()}\n`;
  console.log(`[CEREBRO] 🧬 Aprendizaje guardado (${source}): "${text.substring(0, 80)}..." — total: ${trainingData.length} chars`);
  if (_onTrainingUpdate) _onTrainingUpdate(trainingData);
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────

module.exports = {
  init,
  updateClient,
  getTrainingData,
  setTrainingData,
  appendLearning,
  extractDNAChronological,
  processADNMinerCron
};
