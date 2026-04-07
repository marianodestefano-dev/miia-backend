'use strict';

/**
 * MIIA_OUTFIT.JS — Asesor de moda personal con Gemini Vision
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FUNCIONES:
 *   1. Owner envía foto de ropa → MIIA analiza (tipo, color, estilo, patrón)
 *   2. MIIA construye "guardarropa virtual" en memoria y Firestore
 *   3. Owner pregunta "qué me pongo" → MIIA sugiere combinaciones
 *   4. Owner envía foto de outfit puesto → MIIA opina honestamente
 *   5. MIIA aprende gustos del owner con el tiempo
 *
 * TRIGGERS (en self-chat):
 *   - Imagen + "guardar" / "agregar" / "nueva prenda" → agregar al guardarropa
 *   - Imagen + "qué opinas" / "cómo me queda" / "qué tal" → opinión del outfit
 *   - Texto: "qué me pongo" / "outfit para..." → sugerencia de combinación
 *   - Texto: "mi guardarropa" / "mis prendas" → ver resumen del guardarropa
 *
 * FIRESTORE:
 *   users/{uid}/miia_wardrobe/{itemId} → { type, color, pattern, style, season, description, addedAt }
 *   users/{uid}/miia_outfit_prefs → { favoriteColors, avoidColors, preferredStyles, occasions, bodyType }
 */

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const GARMENT_TYPES = [
  'remera', 'camiseta', 'camisa', 'polo', 'blusa', 'top', 'crop_top',
  'sweater', 'hoodie', 'buzo', 'cardigan', 'chaleco', 'saco', 'blazer',
  'campera', 'chaqueta', 'abrigo', 'tapado', 'parka', 'jean', 'pantalon',
  'jogger', 'short', 'bermuda', 'falda', 'vestido', 'mono', 'enterito',
  'zapatilla', 'zapato', 'bota', 'sandalia', 'ojota', 'mocasin',
  'gorra', 'sombrero', 'bufanda', 'cinturon', 'reloj', 'lentes',
  'mochila', 'bolso', 'cartera', 'corbata', 'pañuelo',
];

const STYLES = ['casual', 'formal', 'smart_casual', 'sport', 'streetwear', 'elegante', 'bohemio', 'minimalista', 'clasico'];
const SEASONS = ['verano', 'invierno', 'entretiempo', 'todo_el_año'];
const OCCASIONS = ['trabajo', 'casual_diario', 'cita', 'fiesta', 'deporte', 'reunion', 'viaje', 'playa', 'formal'];

// ═══════════════════════════════════════════════════════════════
// PROMPTS PARA GEMINI VISION
// ═══════════════════════════════════════════════════════════════

/**
 * Prompt para analizar una prenda individual en una foto
 * @returns {string}
 */
function buildGarmentAnalysisPrompt() {
  return `Analiza esta imagen de ropa/prenda. Extrae la información en JSON:

{
  "items": [
    {
      "type": "Tipo de prenda (ej: remera, jean, zapatilla, blazer, etc.)",
      "color": "Color principal (ej: azul marino, blanco, negro, rojo, beige)",
      "secondary_color": "Color secundario si tiene (null si no)",
      "pattern": "Patrón (liso, rayas, cuadros, estampado, floral, animal_print, null)",
      "style": "Estilo (casual, formal, smart_casual, sport, streetwear, elegante)",
      "season": "Temporada ideal (verano, invierno, entretiempo, todo_el_año)",
      "material": "Material si se puede apreciar (algodón, jean, cuero, lana, seda, etc.)",
      "brand": "Marca si es visible (null si no)",
      "condition": "Estado (nuevo, bueno, usado, gastado)",
      "description": "Descripción breve en 1 línea (ej: 'Remera blanca lisa de algodón, corte regular')"
    }
  ],
  "multiple_items": true/false,
  "context": "¿La persona está usando la ropa (outfit completo) o la muestra por separado?"
}

REGLAS:
- Si hay VARIAS prendas visibles, extrae TODAS
- Si la persona está usando la ropa → context: "wearing"
- Si muestra la prenda sola (ej: colgada, doblada) → context: "display"
- Sé específico con los colores (no solo "azul", sino "azul marino" o "celeste")
- Devuelve SOLO el JSON, sin texto adicional.`;
}

/**
 * Prompt para opinar sobre un outfit que el owner tiene puesto
 * @param {object[]} wardrobeHistory - Historial de preferencias del owner
 * @returns {string}
 */
function buildOutfitOpinionPrompt(wardrobeHistory) {
  let prefContext = '';
  if (wardrobeHistory && wardrobeHistory.length > 0) {
    const colors = wardrobeHistory.map(w => w.favoriteColors).flat().filter(Boolean);
    const styles = wardrobeHistory.map(w => w.preferredStyles).flat().filter(Boolean);
    prefContext = `\nCONOZCO SUS GUSTOS: colores favoritos: ${[...new Set(colors)].join(', ')}. Estilos: ${[...new Set(styles)].join(', ')}.`;
  }

  return `Analiza este outfit que la persona tiene puesto. Dame tu opinión honesta y constructiva como asesora de moda.
${prefContext}

Responde en JSON:
{
  "items_detected": ["lista de prendas que ves"],
  "overall_rating": 1-10,
  "color_harmony": "¿Los colores combinan? Explicar",
  "style_coherence": "¿El estilo es coherente? (no mezclar formal con sport, etc.)",
  "fit": "¿Le queda bien? ¿Algo le queda grande/chico?",
  "occasion_suitable": ["Para qué ocasiones sirve este outfit"],
  "compliment": "Un cumplido genuino sobre algo que se ve bien",
  "suggestion": "Una sugerencia concreta para mejorar (cambiar una prenda, agregar accesorio, etc.)",
  "alternative": "Si cambiaría algo, qué prenda alternativa sugeriría del guardarropa"
}

SÉ HONESTA pero con tacto. No cruel, pero tampoco mentirosa. Si algo no combina, decilo con cariño.
Devuelve SOLO el JSON.`;
}

/**
 * Prompt para sugerir un outfit basado en la ocasión y el guardarropa
 * @param {string} occasion - "trabajo", "cita", "casual", etc.
 * @param {object[]} wardrobe - Prendas del guardarropa virtual
 * @param {object} prefs - Preferencias del owner
 * @param {string} weather - Clima actual (opcional)
 * @returns {string}
 */
function buildOutfitSuggestionPrompt(occasion, wardrobe, prefs, weather) {
  const wardrobeStr = wardrobe.map((w, i) =>
    `${i + 1}. ${w.type} ${w.color}${w.pattern && w.pattern !== 'liso' ? ` (${w.pattern})` : ''} — ${w.style}, ${w.season}`
  ).join('\n');

  let weatherBlock = '';
  if (weather) {
    weatherBlock = `\nCLIMA ACTUAL: ${weather}`;
  }

  let prefsBlock = '';
  if (prefs) {
    prefsBlock = `\nPREFERENCIAS: ${prefs.favoriteColors ? `Colores favoritos: ${prefs.favoriteColors.join(', ')}` : ''}${prefs.avoidColors ? `. Evitar: ${prefs.avoidColors.join(', ')}` : ''}${prefs.preferredStyles ? `. Estilos: ${prefs.preferredStyles.join(', ')}` : ''}`;
  }

  return `Sos MIIA, asesora de moda personal. Sugerí un outfit para: "${occasion}"
${weatherBlock}
${prefsBlock}

GUARDARROPA DISPONIBLE:
${wardrobeStr || '(vacío — sugerí en general)'}

Responde con 2-3 opciones de outfit, cada una con:
1. Lista de prendas del guardarropa (por número)
2. Por qué combina bien
3. Para qué momento del día es ideal

Si el guardarropa está vacío o no tiene suficientes prendas, sugerí en general qué tipo de prendas servirían.

SÉ CREATIVA pero realista. Usa las prendas que tiene, no inventes prendas que no están en su guardarropa.
Responde en texto natural (no JSON), como si hablaras con tu amigo/a.`;
}

// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE COMANDOS DE OUTFIT EN SELF-CHAT
// ═══════════════════════════════════════════════════════════════

/**
 * Detecta si el mensaje es un comando de outfit/moda
 * @param {string} message
 * @param {boolean} hasImage
 * @returns {{ isOutfit: boolean, type: 'add_garment'|'opinion'|'suggest'|'view_wardrobe'|'none', occasion?: string }}
 */
function detectOutfitCommand(message, hasImage) {
  if (!message) {
    if (hasImage) return { isOutfit: false, type: 'none' }; // Solo imagen sin texto → regla mensajes sueltos
    return { isOutfit: false, type: 'none' };
  }

  const msgLower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Imagen + "guardar" / "agregar" / "nueva prenda" → agregar al guardarropa
  if (hasImage) {
    if (/\b(guard[áa]|agrega|nueva\s+prenda|sum[áa]|a[ñn]ad[ií]|para\s+mi\s+guardarropa|al\s+guardarropa)\b/i.test(msgLower)) {
      return { isOutfit: true, type: 'add_garment' };
    }

    // Imagen + "qué opinas" / "cómo me queda" → opinión
    if (/\b(qu[ée]\s+opin|c[óo]mo\s+me\s+queda|qu[ée]\s+tal|como\s+se\s+ve|me\s+queda\s+bien|qu[ée]\s+te\s+parece|outfit|look)\b/i.test(msgLower)) {
      return { isOutfit: true, type: 'opinion' };
    }
  }

  // "qué me pongo" / "outfit para..." → sugerencia
  const suggestMatch = msgLower.match(/\b(qu[ée]\s+me\s+pongo|outfit\s+para|qu[ée]\s+usar|c[óo]mo\s+me\s+visto|vestirme\s+para|ropa\s+para)\s*(.+)?/i);
  if (suggestMatch) {
    const occasion = suggestMatch[2]?.trim() || null;
    return { isOutfit: true, type: 'suggest', occasion };
  }

  // "mi guardarropa" / "mis prendas" → ver resumen
  if (/\b(mi\s+guardarropa|mis\s+prendas|que\s+ropa\s+tengo|inventario\s+de\s+ropa|closet|armario)\b/i.test(msgLower)) {
    return { isOutfit: true, type: 'view_wardrobe' };
  }

  return { isOutfit: false, type: 'none' };
}

// ═══════════════════════════════════════════════════════════════
// PARSEO DE RESPUESTAS DE VISION
// ═══════════════════════════════════════════════════════════════

/**
 * Parsear la respuesta de Gemini Vision para análisis de prenda
 * @param {string} rawResponse
 * @returns {{ items: object[], context: string, error: string|null }}
 */
function parseGarmentAnalysis(rawResponse) {
  try {
    let jsonStr = rawResponse;
    const jsonMatch = rawResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    const parsed = JSON.parse(jsonStr.trim());
    const items = (parsed.items || [parsed]).map(item => ({
      type: (item.type || 'prenda').toLowerCase(),
      color: item.color || 'desconocido',
      secondaryColor: item.secondary_color || null,
      pattern: item.pattern || 'liso',
      style: item.style || 'casual',
      season: item.season || 'todo_el_año',
      material: item.material || null,
      brand: item.brand || null,
      condition: item.condition || 'bueno',
      description: item.description || `${item.type || 'Prenda'} ${item.color || ''}`.trim(),
    }));

    console.log(`[OUTFIT] 👗 Análisis: ${items.length} prendas detectadas, contexto: ${parsed.context || 'display'}`);
    return { items, context: parsed.context || 'display', error: null };
  } catch (e) {
    console.error(`[OUTFIT] ❌ Error parseando análisis de prenda:`, e.message);
    return { items: [], context: 'unknown', error: e.message };
  }
}

/**
 * Parsear la opinión de outfit
 * @param {string} rawResponse
 * @returns {object}
 */
function parseOutfitOpinion(rawResponse) {
  try {
    let jsonStr = rawResponse;
    const jsonMatch = rawResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonStr = jsonMatch[1];

    return JSON.parse(jsonStr.trim());
  } catch (e) {
    console.error(`[OUTFIT] ❌ Error parseando opinión:`, e.message);
    return null;
  }
}

/**
 * Formatear la opinión de outfit en mensaje natural para WhatsApp
 * @param {object} opinion - Resultado de parseOutfitOpinion
 * @returns {string}
 */
function formatOutfitOpinion(opinion) {
  if (!opinion) return `No pude analizar bien el outfit 🤔 ¿Podés enviar otra foto con mejor luz?`;

  let msg = '';
  const rating = opinion.overall_rating || 5;

  // Rating con emojis
  if (rating >= 8) msg += `🔥 *¡Wow!* `;
  else if (rating >= 6) msg += `👌 *Se ve bien.* `;
  else if (rating >= 4) msg += `🤔 *Mmm...* `;
  else msg += `😬 *Sinceramente...* `;

  msg += `${rating}/10\n\n`;

  if (opinion.compliment) msg += `✨ ${opinion.compliment}\n`;
  if (opinion.color_harmony) msg += `🎨 Colores: ${opinion.color_harmony}\n`;
  if (opinion.fit) msg += `📐 Fit: ${opinion.fit}\n`;
  if (opinion.suggestion) msg += `\n💡 *Sugerencia:* ${opinion.suggestion}`;
  if (opinion.occasion_suitable) msg += `\n\n👔 Sirve para: ${opinion.occasion_suitable.join(', ')}`;

  return msg;
}

/**
 * Formatear resumen del guardarropa para WhatsApp
 * @param {object[]} wardrobe
 * @returns {string}
 */
function formatWardrobeSummary(wardrobe) {
  if (!wardrobe || wardrobe.length === 0) {
    return `Tu guardarropa está vacío 🤷‍♀️\n\nEnviame fotos de tu ropa con "guardar" y voy armando tu closet virtual!`;
  }

  // Agrupar por tipo
  const byType = {};
  for (const item of wardrobe) {
    const type = item.type || 'otro';
    if (!byType[type]) byType[type] = [];
    byType[type].push(item);
  }

  let msg = `👗 *Tu Guardarropa Virtual* (${wardrobe.length} prendas)\n\n`;

  for (const [type, items] of Object.entries(byType)) {
    msg += `*${type.charAt(0).toUpperCase() + type.slice(1)}* (${items.length})\n`;
    for (const item of items.slice(0, 5)) { // Max 5 por tipo en resumen
      msg += `  • ${item.color}${item.pattern && item.pattern !== 'liso' ? ` (${item.pattern})` : ''} — ${item.style}\n`;
    }
    if (items.length > 5) msg += `  ... y ${items.length - 5} más\n`;
    msg += '\n';
  }

  msg += `📸 Enviame más fotos con "guardar" para ampliar tu closet!`;
  return msg;
}

/**
 * Formatear confirmación de prendas guardadas
 * @param {object[]} items - Prendas analizadas y guardadas
 * @returns {string}
 */
function formatGarmentSaved(items) {
  if (items.length === 1) {
    const item = items[0];
    return `✅ *Guardé en tu guardarropa:*\n\n` +
      `👗 ${item.description}\n` +
      `🎨 Color: ${item.color}${item.secondaryColor ? ` + ${item.secondaryColor}` : ''}\n` +
      `✂️ Estilo: ${item.style} | Temporada: ${item.season}\n\n` +
      `Ya la tengo en cuenta para sugerirte outfits 😊`;
  }

  let msg = `✅ *Guardé ${items.length} prendas en tu guardarropa:*\n\n`;
  for (const item of items) {
    msg += `• ${item.description}\n`;
  }
  msg += `\nYa las tengo en cuenta para combinaciones 😊`;
  return msg;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Prompts
  buildGarmentAnalysisPrompt,
  buildOutfitOpinionPrompt,
  buildOutfitSuggestionPrompt,

  // Detección
  detectOutfitCommand,

  // Parseo
  parseGarmentAnalysis,
  parseOutfitOpinion,

  // Formateo
  formatOutfitOpinion,
  formatWardrobeSummary,
  formatGarmentSaved,

  // Constantes
  GARMENT_TYPES,
  STYLES,
  SEASONS,
  OCCASIONS,
};
