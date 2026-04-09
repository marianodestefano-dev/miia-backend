/**
 * MIIA Sales Assets — Gestión de imágenes/banners para probaditas
 *
 * Mapea temas de conversación a imágenes SVG → convierte a PNG buffer → envía por WhatsApp.
 * Ratio: 30% con imagen, 70% solo texto (controlado por el caller).
 *
 * Las imágenes son ILUSTRATIVAS (branding). El texto que MIIA envía es el valor real con datos en tiempo real.
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'sales');

// ═══ MAPEO TEMA → ASSET ═══
// Cada tema tiene: archivo SVG, keywords para detección, caption corto
const SALES_ASSETS = {
  clima: {
    file: 'clima.svg',
    keywords: ['clima', 'lluvia', 'llover', 'sol', 'temperatura', 'pronóstico', 'pronostico', 'weather', 'paraguas', 'tormenta', 'calor', 'frío', 'frio', 'nublado', 'hace calor', 'hace frio'],
    caption: 'MIIA Clima - Tu asistente meteorológica personal ☔',
  },
  recetas: {
    file: 'recetas.svg',
    keywords: ['cocinar', 'receta', 'cocina', 'heladera', 'ingredientes', 'almuerzo', 'cena', 'desayuno', 'comida', 'plato', 'chef', 'freezer'],
    caption: 'MIIA en tu Cocina - Foto de heladera = receta al instante 🍳',
  },
  agenda: {
    file: 'agenda.svg',
    keywords: ['agenda', 'reunión', 'reunion', 'cita', 'turno', 'agendar', 'calendario', 'meeting', 'horario'],
    caption: 'MIIA Agenda - Nunca más olvides una reunión 📅',
  },
  recordatorios: {
    file: 'recordatorios.svg',
    keywords: ['recordar', 'recordame', 'recuérdame', 'recordatorio', 'olvidar', 'no olvidar', 'avisar', 'avisame', 'alarma'],
    caption: 'MIIA Recordatorios - La memoria que nunca falla ⏰',
  },
  deportes: {
    file: 'deportes.svg',
    keywords: ['fútbol', 'futbol', 'boca', 'river', 'gol', 'partido', 'nba', 'f1', 'ufc', 'deporte', 'liga', 'champions', 'mundial', 'equipo'],
    caption: 'MIIA Deportes - Resultados en vivo de tu equipo ⚽',
  },
  noticias: {
    file: 'noticias.svg',
    keywords: ['noticias', 'noticia', 'news', 'diario', 'periódico', 'periodico', 'actualidad', 'últimas', 'ultimas', 'titulares'],
    caption: 'MIIA Noticias - Resumen diario de lo que te importa 📰',
  },
  youtube: {
    file: 'youtube.svg',
    keywords: ['youtube', 'video', 'canal', 'youtuber', 'mrbeast', 'suscri', 'subió', 'subio'],
    caption: 'MIIA YouTube - No te pierdas un video nuevo 📹',
  },
  finanzas: {
    file: 'finanzas.svg',
    keywords: ['bolsa', 'crypto', 'bitcoin', 'btc', 'dólar', 'dolar', 'acciones', 'inversión', 'inversion', 'nasdaq', 'wall street', 'cotización', 'cotizacion'],
    caption: 'MIIA Finanzas - Bolsa, crypto y alertas de precio 📈',
  },
  viajes: {
    file: 'viajes.svg',
    keywords: ['viaje', 'vuelo', 'avión', 'avion', 'aeropuerto', 'hotel', 'vacaciones', 'maleta', 'pasaje', 'destino', 'checklist viaje'],
    caption: 'MIIA Viajes - Tu agente de viajes en el bolsillo ✈️',
  },
  uber: {
    file: 'uber.svg',
    keywords: ['uber', 'didi', 'taxi', 'rappi', 'pedidosya', 'delivery', 'transporte', 'envío', 'envio', 'llevar', 'pedir auto'],
    caption: 'MIIA Transporte - Un mensaje y listo 🚗',
  },
  outfit: {
    file: 'outfit.svg',
    keywords: ['outfit', 'ropa', 'vestir', 'look', 'moda', 'estilo', 'combinar', 'zapatos', 'camisa', 'vestido', 'qué me pongo'],
    caption: 'MIIA Outfit - Tu asesora de imagen por WhatsApp 👗',
  },
  ninos: {
    file: 'ninos.svg',
    keywords: ['niño', 'nino', 'hijo', 'hija', 'tarea', 'escuela', 'colegio', 'educación', 'educacion', 'juego educativo', 'rutina niños'],
    caption: 'MIIA para Familias - Tu aliada para organizar la casa 👶',
  },
  abuelos: {
    file: 'abuelos.svg',
    keywords: ['abuelo', 'abuela', 'abuelito', 'abuelita', 'medicina', 'pastilla', 'remedio', 'mayor', 'tercera edad'],
    caption: 'MIIA para Abuelos - La nieta digital que nunca se olvida 👴',
  },
  ventas: {
    file: 'ventas.svg',
    keywords: ['negocio', 'vender', 'venta', 'clientes', 'leads', 'empresa', 'emprender', 'emprendimiento', 'factura', 'facturar'],
    caption: 'MIIA para tu Negocio - Tu vendedora 24/7 💼',
  },
  precios: {
    file: 'precios.svg',
    keywords: ['precio', 'presupuesto', 'cotizar', 'cuánto cuesta', 'cuanto cuesta', 'tarifa', 'cobrar', 'pagar', 'descuento'],
    caption: 'MIIA Cotizaciones - Presupuestos que cierran ventas 💰',
  },
  musica: {
    file: 'musica.svg',
    keywords: ['música', 'musica', 'canción', 'cancion', 'spotify', 'artista', 'album', 'playlist', 'escuchar', 'cantante'],
    caption: 'MIIA Música - Te aviso cuando sale música nueva 🎵',
  },
  salud: {
    file: 'salud.svg',
    keywords: ['ejercicio', 'gym', 'rutina', 'correr', 'salud', 'dieta', 'peso', 'calorías', 'calorias', 'médico', 'medico', 'fitness'],
    caption: 'MIIA Salud - Tu coach de bienestar por WhatsApp 💪',
  },
  compras: {
    file: 'compras.svg',
    keywords: ['comprar', 'compra', 'lista de compras', 'supermercado', 'producto', 'oferta', 'amazon', 'mercadolibre', 'seguimiento', 'pedido'],
    caption: 'MIIA Compras - Te aviso cuando baje de precio 🛒',
  },
  email: {
    file: 'email.svg',
    keywords: ['email', 'correo', 'gmail', 'mail', 'inbox', 'bandeja', 'enviar correo', 'mandar mail'],
    caption: 'MIIA Email - Nunca más pierdas un email urgente ✉️',
  },
};

// Cache de PNGs para no reconvertir cada vez
const pngCache = {};

/**
 * Detecta el tema de un mensaje y devuelve el asset correspondiente
 * @param {string} messageBody - Texto del mensaje o respuesta de MIIA
 * @returns {string|null} - Nombre del tema detectado, o null
 */
function detectSalesTopic(messageBody) {
  if (!messageBody) return null;
  const lower = messageBody.toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const [topic, config] of Object.entries(SALES_ASSETS)) {
    let score = 0;
    for (const keyword of config.keywords) {
      if (lower.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = topic;
    }
  }

  return bestScore >= 1 ? bestMatch : null;
}

/**
 * Convierte SVG a buffer PNG (con cache)
 * @param {string} topic - Nombre del tema
 * @returns {Promise<Buffer|null>} - Buffer PNG o null si error
 */
async function getSalesImageBuffer(topic) {
  if (pngCache[topic]) return pngCache[topic];

  const config = SALES_ASSETS[topic];
  if (!config) return null;

  const svgPath = path.join(ASSETS_DIR, config.file);
  if (!fs.existsSync(svgPath)) {
    console.error(`[SALES-ASSETS] ❌ SVG no encontrado: ${svgPath}`);
    return null;
  }

  try {
    const svgBuffer = fs.readFileSync(svgPath);
    const pngBuffer = await sharp(svgBuffer)
      .resize(800, 418)
      .png({ quality: 90 })
      .toBuffer();

    pngCache[topic] = pngBuffer;
    console.log(`[SALES-ASSETS] ✅ PNG generado para "${topic}" (${(pngBuffer.length / 1024).toFixed(1)}KB)`);
    return pngBuffer;
  } catch (e) {
    console.error(`[SALES-ASSETS] ❌ Error convirtiendo "${topic}": ${e.message}`);
    return null;
  }
}

/**
 * Decide si esta probadita debe incluir imagen (30% probabilidad)
 * @param {number} probadita - Número de probadita (1-10)
 * @returns {boolean}
 */
function shouldSendImage(probadita) {
  // Probaditas 2, 5 y 8 SIEMPRE tienen imagen (fijos para impacto visual)
  if ([2, 5, 8].includes(probadita)) return true;
  // El resto: 30% probabilidad
  return Math.random() < 0.3;
}

/**
 * Obtiene la imagen y caption para un tema dado
 * @param {string} topic - Tema detectado
 * @returns {Promise<{buffer: Buffer, caption: string}|null>}
 */
async function getSalesAsset(topic) {
  const config = SALES_ASSETS[topic];
  if (!config) return null;

  const buffer = await getSalesImageBuffer(topic);
  if (!buffer) return null;

  return {
    buffer,
    caption: config.caption,
    mimetype: 'image/png',
  };
}

module.exports = {
  SALES_ASSETS,
  detectSalesTopic,
  getSalesImageBuffer,
  shouldSendImage,
  getSalesAsset,
};
