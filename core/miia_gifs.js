'use strict';

/**
 * MIIA GIFS — Sistema de GIFs animados para MIIA Sales.
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Detecta en las respuestas de MIIA cuándo enviar un GIF/video demostrativo
 * para complementar la presentación de features a leads.
 *
 * Tipos de GIFs:
 *   - Feature demos (dashboard, WhatsApp, agenda, etc.)
 *   - Celebration (cuando lead acepta/compra)
 *   - Onboarding steps
 *
 * Formato: Baileys soporta GIF como video con gifPlayback=true
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ═══════════════════════════════════════════════════════════════
// GIF CATALOG — Mapeo de features a GIFs
// ═══════════════════════════════════════════════════════════════

/**
 * Catálogo de GIFs. Cada entrada tiene:
 *   - keywords: palabras clave que detectan cuándo enviar este GIF
 *   - url: URL pública del GIF/MP4 (se descarga y cachea)
 *   - localPath: ruta local (si existe, se usa directamente)
 *   - caption: texto que acompaña al GIF
 *   - cooldownMs: mínimo tiempo entre envíos del mismo GIF al mismo lead
 */
const GIF_CATALOG = {
  dashboard: {
    keywords: ['dashboard', 'panel', 'estadísticas', 'métricas', 'analytics'],
    caption: '📊 Así se ve tu dashboard personalizado',
    cooldownMs: 3600000, // 1 hora
  },
  whatsapp_auto: {
    keywords: ['responde automático', 'automática', 'responde sola', '24/7', 'sin intervención'],
    caption: '💬 MIIA responde por vos las 24 horas',
    cooldownMs: 3600000,
  },
  agenda: {
    keywords: ['agenda', 'cita', 'turno', 'agendar', 'recordatorio'],
    caption: '📅 Agenda inteligente con recordatorios automáticos',
    cooldownMs: 3600000,
  },
  cotizacion: {
    keywords: ['cotización', 'cotizacion', 'presupuesto', 'precio personalizado'],
    caption: '💰 Cotizaciones personalizadas en segundos',
    cooldownMs: 3600000,
  },
  learning: {
    keywords: ['aprende', 'entrena', 'cerebro', 'inteligencia', 'se adapta'],
    caption: '🧠 MIIA aprende de tu negocio y se adapta',
    cooldownMs: 3600000,
  },
  multicanal: {
    keywords: ['multicanal', 'email', 'gmail', 'calendar', 'google'],
    caption: '🔗 Conectada a Gmail, Calendar, Sheets y más',
    cooldownMs: 3600000,
  },
  celebration: {
    keywords: ['bienvenido', 'felicidades', 'activado', 'lista tu cuenta'],
    caption: '🎉',
    cooldownMs: 7200000, // 2 horas
  },
};

// Cache de GIFs descargados
const gifCache = {};
// Cooldown tracker por lead
const gifCooldowns = {};

// ═══════════════════════════════════════════════════════════════
// GIF PATH RESOLUTION
// ═══════════════════════════════════════════════════════════════

const GIF_DIR = path.join(__dirname, '..', 'media', 'gifs');

/**
 * Obtener el buffer del GIF para un feature dado.
 * Busca en: 1) media/gifs/{feature}.mp4 local, 2) URL configurada, 3) null
 */
async function getGifBuffer(feature) {
  const entry = GIF_CATALOG[feature];
  if (!entry) return null;

  // 1. Caché en memoria
  if (gifCache[feature]) {
    return gifCache[feature];
  }

  // 2. Archivo local
  const localMp4 = path.join(GIF_DIR, `${feature}.mp4`);
  const localGif = path.join(GIF_DIR, `${feature}.gif`);

  if (fs.existsSync(localMp4)) {
    const buf = fs.readFileSync(localMp4);
    gifCache[feature] = buf;
    console.log(`[MIIA-GIFS] 📁 Cargado local: ${feature}.mp4 (${buf.length} bytes)`);
    return buf;
  }
  if (fs.existsSync(localGif)) {
    const buf = fs.readFileSync(localGif);
    gifCache[feature] = buf;
    console.log(`[MIIA-GIFS] 📁 Cargado local: ${feature}.gif (${buf.length} bytes)`);
    return buf;
  }

  // 3. URL remota
  if (entry.url) {
    try {
      const buf = await downloadBuffer(entry.url);
      gifCache[feature] = buf;
      console.log(`[MIIA-GIFS] 🌐 Descargado: ${feature} (${buf.length} bytes)`);
      return buf;
    } catch (e) {
      console.error(`[MIIA-GIFS] ❌ Error descargando ${feature}:`, e.message);
    }
  }

  console.warn(`[MIIA-GIFS] ⚠️ No hay GIF para "${feature}" — ni local ni remoto`);
  return null;
}

/**
 * Descargar un buffer desde URL.
 */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : require('http');
    protocol.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════
// DETECT & SEND — Detectar feature en mensaje y enviar GIF
// ═══════════════════════════════════════════════════════════════

/**
 * Analiza el mensaje de MIIA y detecta si debe enviar un GIF.
 * @param {string} aiMessage - Mensaje generado por la IA
 * @param {string} phone - Teléfono del destinatario
 * @returns {Array<{feature, caption, buffer}>} GIFs a enviar (puede ser 0 o 1+)
 */
async function detectAndPrepareGifs(aiMessage, phone) {
  if (!aiMessage) return [];

  const msgLower = aiMessage.toLowerCase();
  const toSend = [];

  for (const [feature, entry] of Object.entries(GIF_CATALOG)) {
    // Check keywords
    const matches = entry.keywords.some(kw => msgLower.includes(kw));
    if (!matches) continue;

    // Check cooldown
    const cooldownKey = `${phone}:${feature}`;
    const lastSent = gifCooldowns[cooldownKey] || 0;
    if (Date.now() - lastSent < entry.cooldownMs) {
      continue; // Skip, sent too recently
    }

    // Get buffer
    const buffer = await getGifBuffer(feature);
    if (!buffer) continue;

    toSend.push({ feature, caption: entry.caption, buffer });
    gifCooldowns[cooldownKey] = Date.now();

    // Max 1 GIF per message to not overwhelm
    break;
  }

  if (toSend.length > 0) {
    console.log(`[MIIA-GIFS] 🎬 ${toSend.length} GIF(s) preparado(s) para ${phone}: ${toSend.map(g => g.feature).join(', ')}`);
  }

  return toSend;
}

/**
 * Enviar GIF via Baileys sock.
 * @param {object} sock - Baileys socket
 * @param {string} jid - Destinatario JID
 * @param {Buffer} buffer - GIF/MP4 buffer
 * @param {string} caption - Texto acompañante
 */
async function sendGif(sock, jid, buffer, caption = '') {
  if (!sock || !jid || !buffer) return;

  try {
    // Baileys: enviar video con gifPlayback=true para que se reproduzca como GIF
    await sock.sendMessage(jid, {
      video: buffer,
      caption,
      gifPlayback: true,
      mimetype: 'video/mp4',
    });
    console.log(`[MIIA-GIFS] ✅ GIF enviado a ${jid} (${buffer.length} bytes)`);
  } catch (err) {
    console.error(`[MIIA-GIFS] ❌ Error enviando GIF a ${jid}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// INIT — Crear directorio de GIFs si no existe
// ═══════════════════════════════════════════════════════════════

function initGifDirectory() {
  if (!fs.existsSync(GIF_DIR)) {
    fs.mkdirSync(GIF_DIR, { recursive: true });
    console.log(`[MIIA-GIFS] 📁 Directorio creado: ${GIF_DIR}`);
  }
  // Contar GIFs disponibles
  try {
    const files = fs.readdirSync(GIF_DIR).filter(f => f.endsWith('.mp4') || f.endsWith('.gif'));
    console.log(`[MIIA-GIFS] 📊 ${files.length} GIF(s) disponibles: ${files.join(', ') || '(vacío — agregar GIFs en media/gifs/)'}`);
  } catch (e) {
    console.warn(`[MIIA-GIFS] ⚠️ Error leyendo directorio:`, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  GIF_CATALOG,
  detectAndPrepareGifs,
  sendGif,
  getGifBuffer,
  initGifDirectory,
};
