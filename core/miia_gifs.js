'use strict';

/**
 * MIIA GIFS — GIFs REALES via Tenor API (Google) para MIIA Sales.
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * NO miente al usuario. Busca GIFs REALES en Tenor (API gratuita de Google).
 * Cada feature tiene búsquedas pre-definidas que devuelven GIFs relevantes.
 * Fallback: si Tenor no responde, NO envía nada (no inventamos).
 *
 * Tenor API: https://developers.google.com/tenor/guides/quickstart
 * Gratis: 50 búsquedas/día (Anonymous), ilimitado con API key.
 * Formato: Tenor devuelve MP4 (tinygif_transparent o mp4).
 *
 * (c) 2024-2026 Mariano De Stefano. All rights reserved.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// TENOR API CONFIG
// ═══════════════════════════════════════════════════════════════

// API key de Tenor (gratis, registrar en Google Cloud Console > Tenor API)
// Si no hay key, usa anonymous (50 req/día)
const TENOR_API_KEY = process.env.TENOR_API_KEY || process.env.GOOGLE_API_KEY || '';
const TENOR_CLIENT_KEY = 'miia_whatsapp';

// ═══════════════════════════════════════════════════════════════
// GIF CATALOG — Búsquedas reales para cada feature
// ═══════════════════════════════════════════════════════════════

/**
 * Cada feature tiene:
 *   - keywords: qué detectar en el mensaje de MIIA
 *   - searchTerms: array de búsquedas para Tenor (se elige una al azar)
 *   - caption: texto que acompaña al GIF
 *   - cooldownMs: tiempo mínimo entre envíos del mismo feature al mismo lead
 *   - maxSize: tamaño máximo del GIF en bytes (WhatsApp no acepta >16MB)
 */
const GIF_CATALOG = {
  dashboard: {
    keywords: ['dashboard', 'panel', 'estadísticas', 'métricas', 'analytics', 'reportes'],
    searchTerms: ['analytics dashboard', 'data visualization', 'business metrics', 'chart animation'],
    caption: '📊 Tu negocio, en tiempo real',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
  whatsapp_auto: {
    keywords: ['responde automático', 'automática', 'responde sola', '24/7', 'sin intervención', 'todo el día'],
    searchTerms: ['robot assistant', 'AI chat', 'instant reply', 'fast typing'],
    caption: '💬 Respuestas al instante, 24/7',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
  agenda: {
    keywords: ['agenda', 'cita', 'turno', 'agendar', 'recordatorio', 'calendar'],
    searchTerms: ['calendar schedule', 'appointment booking', 'reminder notification', 'organize calendar'],
    caption: '📅 Tu agenda, siempre organizada',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
  cotizacion: {
    keywords: ['cotización', 'cotizacion', 'presupuesto', 'precio personalizado', 'factura'],
    searchTerms: ['invoice creation', 'price calculator', 'money deal', 'business proposal'],
    caption: '💰 Cotizaciones en segundos',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
  learning: {
    keywords: ['aprende', 'entrena', 'cerebro', 'inteligencia', 'se adapta', 'personaliza'],
    searchTerms: ['brain learning', 'AI training', 'neural network', 'machine learning'],
    caption: '🧠 Se adapta a tu negocio',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
  multicanal: {
    keywords: ['multicanal', 'email', 'gmail', 'calendar', 'google', 'sheets', 'integración'],
    searchTerms: ['connected apps', 'integration workflow', 'multi channel', 'sync everything'],
    caption: '🔗 Todo conectado',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
  celebration: {
    keywords: ['bienvenido', 'felicidades', 'activado', 'lista tu cuenta', '¡listo!', 'ya estás'],
    searchTerms: ['celebration confetti', 'welcome aboard', 'party time', 'congratulations'],
    caption: '🎉',
    cooldownMs: 7200000,
    maxSize: 5 * 1024 * 1024,
  },
  speed: {
    keywords: ['rápido', 'instantáneo', 'al toque', 'velocidad', 'en segundos'],
    searchTerms: ['super fast', 'lightning speed', 'instant response', 'quick'],
    caption: '⚡ Velocidad real',
    cooldownMs: 3600000,
    maxSize: 5 * 1024 * 1024,
  },
};

// Cache: feature → { buffer, url, fetchedAt }
const gifCache = {};
// Cooldown tracker: "phone:feature" → timestamp
const gifCooldowns = {};

// ═══════════════════════════════════════════════════════════════
// TENOR API — Búsqueda real de GIFs
// ═══════════════════════════════════════════════════════════════

/**
 * Busca un GIF en Tenor y devuelve la URL del MP4 más liviano.
 * @param {string} searchTerm
 * @returns {Promise<{url: string, size: number}|null>}
 */
async function searchTenorGif(searchTerm) {
  if (!TENOR_API_KEY) {
    console.warn(`[MIIA-GIFS] ⚠️ Sin TENOR_API_KEY / GOOGLE_API_KEY — no se pueden buscar GIFs`);
    return null;
  }

  const params = new URLSearchParams({
    q: searchTerm,
    key: TENOR_API_KEY,
    client_key: TENOR_CLIENT_KEY,
    limit: '8',
    media_filter: 'mp4,tinygif',
    contentfilter: 'medium', // safe for work
    ar_range: 'standard',
  });

  const url = `https://tenor.googleapis.com/v2/search?${params.toString()}`;

  return new Promise((resolve) => {
    https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        console.error(`[MIIA-GIFS] ❌ Tenor API HTTP ${res.statusCode}`);
        res.resume();
        return resolve(null);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = json.results || [];
          if (results.length === 0) {
            console.warn(`[MIIA-GIFS] ⚠️ Tenor: 0 resultados para "${searchTerm}"`);
            return resolve(null);
          }

          // Elegir uno al azar para variedad
          const pick = results[Math.floor(Math.random() * results.length)];

          // Preferir mp4 (Baileys lo necesita para gifPlayback)
          const mp4 = pick.media_formats?.mp4;
          const tinyMp4 = pick.media_formats?.tinymp4;
          const gifFormat = pick.media_formats?.tinygif;

          // Prioridad: tinymp4 (más liviano) > mp4 > tinygif
          const chosen = tinyMp4 || mp4 || gifFormat;
          if (!chosen?.url) {
            console.warn(`[MIIA-GIFS] ⚠️ Tenor: resultado sin MP4/GIF para "${searchTerm}"`);
            return resolve(null);
          }

          const size = chosen.size || 0;
          console.log(`[MIIA-GIFS] ✅ Tenor: "${searchTerm}" → ${chosen.url.substring(0, 80)}... (${Math.round(size/1024)}KB)`);
          resolve({ url: chosen.url, size, dims: chosen.dims });
        } catch (e) {
          console.error(`[MIIA-GIFS] ❌ Tenor JSON parse error:`, e.message);
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    }).on('error', (e) => {
      console.error(`[MIIA-GIFS] ❌ Tenor request error:`, e.message);
      resolve(null);
    });
  });
}

/**
 * Descargar buffer desde URL (con seguimiento de redirects).
 */
function downloadBuffer(url, maxSize = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : require('http');
    protocol.get(url, { timeout: 15000 }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location, maxSize).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let totalSize = 0;
      res.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > maxSize) {
          res.destroy();
          return reject(new Error(`GIF demasiado grande: ${Math.round(totalSize/1024)}KB > ${Math.round(maxSize/1024)}KB`));
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════
// DETECT & PREPARE — Detectar feature y buscar GIF real
// ═══════════════════════════════════════════════════════════════

/**
 * Analiza el mensaje de MIIA, detecta el feature, busca GIF REAL en Tenor.
 * @param {string} aiMessage - Mensaje generado por la IA
 * @param {string} phone - Teléfono del destinatario
 * @returns {Array<{feature, caption, buffer}>} GIFs a enviar (0 o 1)
 */
async function detectAndPrepareGifs(aiMessage, phone) {
  if (!aiMessage || !TENOR_API_KEY) return [];

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
      continue;
    }

    // Check cache first (válido por 30 min)
    const cached = gifCache[feature];
    if (cached && (Date.now() - cached.fetchedAt < 1800000)) {
      toSend.push({ feature, caption: entry.caption, buffer: cached.buffer });
      gifCooldowns[cooldownKey] = Date.now();
      console.log(`[MIIA-GIFS] 📦 Cache hit: ${feature} (${Math.round(cached.buffer.length/1024)}KB)`);
      break;
    }

    // Buscar en Tenor (elegir searchTerm al azar para variedad)
    const searchTerm = entry.searchTerms[Math.floor(Math.random() * entry.searchTerms.length)];

    try {
      const tenorResult = await searchTenorGif(searchTerm);
      if (!tenorResult) continue;

      // Verificar tamaño antes de descargar
      if (tenorResult.size && tenorResult.size > entry.maxSize) {
        console.warn(`[MIIA-GIFS] ⚠️ GIF demasiado grande para ${feature}: ${Math.round(tenorResult.size/1024)}KB`);
        continue;
      }

      // Descargar el buffer
      const buffer = await downloadBuffer(tenorResult.url, entry.maxSize);

      // Cachear
      gifCache[feature] = { buffer, url: tenorResult.url, fetchedAt: Date.now() };
      gifCooldowns[cooldownKey] = Date.now();

      toSend.push({ feature, caption: entry.caption, buffer });
      console.log(`[MIIA-GIFS] 🎬 GIF REAL preparado: ${feature} → "${searchTerm}" (${Math.round(buffer.length/1024)}KB)`);

      // Max 1 GIF por mensaje
      break;
    } catch (e) {
      console.error(`[MIIA-GIFS] ❌ Error buscando GIF para ${feature}:`, e.message);
      continue;
    }
  }

  return toSend;
}

/**
 * Enviar GIF via Baileys sock.
 */
async function sendGif(sock, jid, buffer, caption = '') {
  if (!sock || !jid || !buffer) return;

  try {
    // Detectar si es MP4 o GIF por los magic bytes
    const isGif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46; // "GIF"

    if (isGif) {
      // GIF nativo — enviar como imagen animada
      await sock.sendMessage(jid, {
        image: buffer,
        caption,
        mimetype: 'image/gif',
      });
    } else {
      // MP4 — enviar como video con gifPlayback
      await sock.sendMessage(jid, {
        video: buffer,
        caption,
        gifPlayback: true,
        mimetype: 'video/mp4',
      });
    }
    console.log(`[MIIA-GIFS] ✅ GIF enviado a ${jid} (${Math.round(buffer.length/1024)}KB, ${isGif ? 'GIF' : 'MP4'})`);
  } catch (err) {
    console.error(`[MIIA-GIFS] ❌ Error enviando GIF a ${jid}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// SHOWCASE MP4s — Videos generados desde los 25 HTMLs animados del brand MIIA
// ═══════════════════════════════════════════════════════════════

const SHOWCASE_DIR = path.join(__dirname, '..', 'media', 'showcase');

/**
 * Mapeo de keywords a showcase MP4.
 * Cuando MIIA habla de un feature, puede enviar el video demo correspondiente.
 */
const SHOWCASE_CATALOG = {
  ventas:           { file: '01_ventas.mp4',              caption: '💼 Así manejo tus ventas' },
  briefing:         { file: '02_briefing_matutino.mp4',   caption: '☀️ Tu briefing cada mañana' },
  deportes:         { file: '03_deportes.mp4',            caption: '⚽ Seguimiento deportivo en vivo' },
  familia:          { file: '04_familia.mp4',             caption: '👨‍👩‍👧 Cuidando a tu familia' },
  finanzas:         { file: '05_finanzas.mp4',            caption: '📈 Tus finanzas al día' },
  audios:           { file: '06_audios.mp4',              caption: '🎙️ Audio inteligente' },
  emails:           { file: '07_emails.mp4',              caption: '📧 Gestión de emails' },
  aprendizaje:      { file: '08_aprendizaje.mp4',         caption: '🧠 Aprendo de tu negocio' },
  agenda:           { file: '09_agenda.mp4',              caption: '📅 Tu agenda organizada' },
  imagenes:         { file: '10_imagenes.mp4',            caption: '🖼️ Imágenes inteligentes' },
  follow_up:        { file: '11_follow_up.mp4',           caption: '🔄 Seguimiento automático' },
  grupos:           { file: '12_grupos.mp4',              caption: '👥 Gestión de grupos' },
  pdfs:             { file: '13_pdfs.mp4',                caption: '📄 Documentos y PDFs' },
  modo_espera:      { file: '14_modo_espera_90min.mp4',   caption: '⏸️ Modo espera inteligente' },
  coaching:         { file: '15_coaching_nocturno.mp4',   caption: '🌙 Coaching nocturno' },
  mama:             { file: '16_mama_activa_miia.mp4',    caption: '👩 Mamá siempre conectada' },
  ninos:            { file: '17_ninos.mp4',               caption: '👶 Protección para niños' },
  abuelos:          { file: '18_abuelos.mp4',             caption: '👴 Cuidado de abuelos' },
  uber:             { file: '19_uber.mp4',                caption: '🚗 Transporte al instante' },
  rappi:            { file: '20_rappi.mp4',               caption: '🛵 Delivery inteligente' },
  spotify:          { file: '21_spotify_musica.mp4',      caption: '🎵 Tu música favorita' },
  vuelos:           { file: '22_vuelos.mp4',              caption: '✈️ Tracking de vuelos' },
  precios:          { file: '23_productos_tracking_precio.mp4', caption: '🏷️ Tracking de precios' },
  restaurantes:     { file: '24_restaurantes.mp4',        caption: '🍽️ Restaurantes cerca tuyo' },
  pwa:              { file: '25_pwa_voice.mp4',           caption: '📱 App de voz MIIA' },
};

// Keywords que mapean a cada showcase
const SHOWCASE_KEYWORDS = {
  ventas:      ['ventas', 'vender', 'cotización', 'cotizar', 'lead', 'cliente', 'negocio'],
  briefing:    ['briefing', 'resumen matutino', 'buenos días', 'resumen del día'],
  deportes:    ['deporte', 'fútbol', 'f1', 'partido', 'gol', 'carrera'],
  familia:     ['familia', 'familiar', 'papá', 'mamá', 'hijo', 'hija'],
  finanzas:    ['finanza', 'bolsa', 'crypto', 'bitcoin', 'acción', 'inversión'],
  audios:      ['audio', 'voz', 'transcrib', 'escuchar'],
  emails:      ['email', 'correo', 'gmail', 'mail'],
  aprendizaje: ['aprend', 'cerebro', 'entrenar', 'enseñar', 'inteligencia'],
  agenda:      ['agenda', 'cita', 'turno', 'agendar', 'recordatorio', 'calendario'],
  follow_up:   ['seguimiento', 'follow', 'recordar', 'pendiente'],
  grupos:      ['grupo', 'equipo', 'team'],
  pdfs:        ['pdf', 'documento', 'archivo', 'adjunto'],
  coaching:    ['coaching', 'consejo', 'motivación', 'nocturno'],
  uber:        ['uber', 'didi', 'taxi', 'transporte', 'viaje'],
  rappi:       ['rappi', 'pedidosya', 'delivery', 'domicilio', 'comida'],
  spotify:     ['spotify', 'música', 'canción', 'playlist'],
  vuelos:      ['vuelo', 'avión', 'aeropuerto', 'pasaje'],
  precios:     ['precio', 'tracking', 'oferta', 'descuento', 'amazon'],
  restaurantes:['restaurante', 'comer', 'reserva', 'menú'],
};

// Cooldown para showcase: "phone:feature" → timestamp
const showcaseCooldowns = {};
const SHOWCASE_COOLDOWN_MS = 7200000; // 2h entre el mismo showcase al mismo lead

/**
 * Detectar si el mensaje de MIIA merece un showcase MP4 local.
 * @param {string} aiMessage - Respuesta de MIIA
 * @param {string} phone - Destinatario
 * @returns {{feature: string, caption: string, buffer: Buffer}|null}
 */
function detectShowcaseVideo(aiMessage, phone) {
  if (!aiMessage) return null;

  const msgLower = aiMessage.toLowerCase();

  for (const [feature, keywords] of Object.entries(SHOWCASE_KEYWORDS)) {
    const matches = keywords.some(kw => msgLower.includes(kw));
    if (!matches) continue;

    // Cooldown check
    const cooldownKey = `${phone}:showcase_${feature}`;
    const lastSent = showcaseCooldowns[cooldownKey] || 0;
    if (Date.now() - lastSent < SHOWCASE_COOLDOWN_MS) continue;

    // Check file exists
    const entry = SHOWCASE_CATALOG[feature];
    if (!entry) continue;

    const filePath = path.join(SHOWCASE_DIR, entry.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`[MIIA-GIFS] ⚠️ Showcase MP4 no encontrado: ${entry.file}`);
      continue;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      showcaseCooldowns[cooldownKey] = Date.now();
      console.log(`[MIIA-GIFS] 🎬 Showcase MP4: ${feature} → ${entry.file} (${Math.round(buffer.length/1024)}KB)`);
      return { feature, caption: entry.caption, buffer };
    } catch (e) {
      console.error(`[MIIA-GIFS] ❌ Error leyendo showcase ${entry.file}:`, e.message);
      continue;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// INIT — Verificar API key disponible + showcase directory
// ═══════════════════════════════════════════════════════════════

function initGifDirectory() {
  if (TENOR_API_KEY) {
    console.log(`[MIIA-GIFS] ✅ Tenor API configurada — GIFs reales habilitados (${Object.keys(GIF_CATALOG).length} features)`);
  } else {
    console.warn(`[MIIA-GIFS] ⚠️ Sin TENOR_API_KEY ni GOOGLE_API_KEY — GIFs deshabilitados. Para activar: configurar variable de entorno TENOR_API_KEY o GOOGLE_API_KEY`);
  }

  // Check showcase directory
  if (fs.existsSync(SHOWCASE_DIR)) {
    const mp4Files = fs.readdirSync(SHOWCASE_DIR).filter(f => f.endsWith('.mp4'));
    console.log(`[MIIA-GIFS] 🎬 Showcase: ${mp4Files.length} MP4s locales disponibles en ${SHOWCASE_DIR}`);
  } else {
    console.log(`[MIIA-GIFS] ℹ️ Showcase dir no existe aún: ${SHOWCASE_DIR}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  GIF_CATALOG,
  SHOWCASE_CATALOG,
  detectAndPrepareGifs,
  detectShowcaseVideo,
  sendGif,
  searchTenorGif,
  downloadBuffer,
  initGifDirectory,
};
