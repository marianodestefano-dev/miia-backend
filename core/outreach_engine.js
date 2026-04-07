'use strict';

/**
 * OUTREACH_ENGINE.JS — Motor de contacto proactivo de leads desde screenshots
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * FLUJO:
 *   1. Owner envía screenshot de HubSpot/CRM por WhatsApp + "hacete cargo"
 *   2. Gemini Vision extrae leads: nombre, teléfono, estado, país
 *   3. MIIA valida, clasifica por país, construye cola de envíos
 *   4. Cola procesa con delay aleatorio (anti-ban WhatsApp)
 *   5. MIIA envía mensaje personalizado + documento CO/OP + sigue conversación
 *   6. Follow-up automático al día siguiente si no respondieron
 *   7. Reportes al owner en self-chat
 *
 * TAGS INTERNOS (NUNCA visibles al lead):
 *   [ENVIAR_PLAN:esencial] → envía imagen Plan Esencial
 *   [ENVIAR_PLAN:pro] → envía imagen Plan Pro
 *   [ENVIAR_PLAN:titanium] → envía imagen Plan Titanium
 *   [ENVIAR_PLAN:todos] → envía las 3 imágenes
 *   [ENVIAR_PRESENTACION] → envía PDF de presentación CO/OP según país
 */

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const DELAY_MIN_MS = 45 * 1000;  // 45 segundos mínimo entre mensajes
const DELAY_MAX_MS = 90 * 1000;  // 90 segundos máximo
const MAX_LEADS_PER_BATCH = 20;  // Máximo leads por tanda (seguridad WhatsApp)
const MAX_FOLLOWUPS = 2;         // Máximo 2 follow-ups por lead
const FOLLOWUP_HOURS = 24;      // Horas entre follow-ups
const SAFE_HOURS = { start: 9, end: 18 }; // Horario seguro para contactar (hora LOCAL del lead)

// Prefijos telefónicos → país
const COUNTRY_BY_PREFIX = {
  '57': { code: 'CO', name: 'Colombia', document: 'CO', timezone: 'America/Bogota' },
  '54': { code: 'AR', name: 'Argentina', document: 'OP', timezone: 'America/Argentina/Buenos_Aires' },
  '56': { code: 'CL', name: 'Chile', document: 'OP', timezone: 'America/Santiago' },
  '52': { code: 'MX', name: 'México', document: 'OP', timezone: 'America/Mexico_City' },
  '51': { code: 'PE', name: 'Perú', document: 'OP', timezone: 'America/Lima' },
  '593': { code: 'EC', name: 'Ecuador', document: 'OP', timezone: 'America/Guayaquil' },
  '503': { code: 'SV', name: 'El Salvador', document: 'OP', timezone: 'America/El_Salvador' },
  '504': { code: 'HN', name: 'Honduras', document: 'OP', timezone: 'America/Tegucigalpa' },
  '502': { code: 'GT', name: 'Guatemala', document: 'OP', timezone: 'America/Guatemala' },
  '506': { code: 'CR', name: 'Costa Rica', document: 'OP', timezone: 'America/Costa_Rica' },
  '507': { code: 'PA', name: 'Panamá', document: 'OP', timezone: 'America/Panama' },
  '505': { code: 'NI', name: 'Nicaragua', document: 'OP', timezone: 'America/Managua' },
  '1809': { code: 'DO', name: 'Rep. Dominicana', document: 'OP', timezone: 'America/Santo_Domingo' },
  '1829': { code: 'DO', name: 'Rep. Dominicana', document: 'OP', timezone: 'America/Santo_Domingo' },
  '1849': { code: 'DO', name: 'Rep. Dominicana', document: 'OP', timezone: 'America/Santo_Domingo' },
  '34': { code: 'ES', name: 'España', document: 'OP', timezone: 'Europe/Madrid' },
  '1': { code: 'US', name: 'Estados Unidos', document: 'OP', timezone: 'America/New_York' },
};

// Estrategias por estado de HubSpot/CRM
const STRATEGY_BY_STATE = {
  'hql': {
    priority: 1,
    approach: 'primer_contacto',
    tone: 'Primer contacto. Presentarse como el equipo del owner, profesional pero cercano. Enviar documento de presentación.',
    sendPresentation: true,
  },
  'nuevo': {
    priority: 1,
    approach: 'primer_contacto',
    tone: 'Primer contacto. Presentarse como el equipo del owner, profesional pero cercano. Enviar documento de presentación.',
    sendPresentation: true,
  },
  'llamar': {
    priority: 0, // Máxima prioridad
    approach: 'post_llamada',
    tone: 'Lead caliente que no contestó llamada. Decir "intentamos contactarte, te escribo por acá". Más directo y resolutivo.',
    sendPresentation: true,
  },
  'no asiste': {
    priority: 2,
    approach: 're_engagement',
    tone: 'Re-engagement suave. "Sé que estás ocupado/a, te dejo info por si te interesa cuando tengas un momento". Sin presión.',
    sendPresentation: true,
  },
  'envio wp': {
    priority: 3,
    approach: 'followup',
    tone: 'Ya se les mandó WhatsApp antes. Follow-up inteligente: "¿Pudiste ver lo que te envié? ¿Tenés alguna duda?"',
    sendPresentation: false,
  },
};

// ═══════════════════════════════════════════════════════════════
// ESTADO EN MEMORIA — Cola de outreach
// ═══════════════════════════════════════════════════════════════

/**
 * Cola de outreach activa
 * {
 *   id: string (uuid),
 *   ownerUid: string,
 *   leads: [{ name, phone, country, state, strategy, status, sentAt, followups }],
 *   createdAt: timestamp,
 *   status: 'pending' | 'processing' | 'completed',
 *   stats: { total, sent, responded, failed }
 * }
 */
const activeQueues = new Map(); // ownerUid → queue

// ═══════════════════════════════════════════════════════════════
// PARSEO DE SCREENSHOT (Gemini Vision)
// ═══════════════════════════════════════════════════════════════

/**
 * Prompt para Gemini Vision: extraer leads de un screenshot de CRM/HubSpot
 * @returns {string}
 */
function buildScreenshotParserPrompt() {
  return `Analiza esta imagen de un CRM o sistema de gestión de leads.
Extrae TODOS los contactos/leads visibles en formato JSON.

Por cada contacto encontrado, devuelve:
{
  "name": "Nombre completo del contacto",
  "phone": "Número de teléfono con código de país (formato: +57XXXXXXXXXX)",
  "state": "Estado del lead (ej: 'HQL', 'Llamar', 'No asiste', 'Envio WP', etc.)",
  "extra": "Cualquier dato adicional visible (empresa, email, cargo, especialidad, etc.)"
}

REGLAS:
- Los números deben incluir el código de país. Si no tiene +, inferirlo del formato.
- Si el número tiene paréntesis o guiones, limpiarlos: +57(312)561-8404 → +573125618404
- Si hay columnas adicionales (email, empresa, fecha), incluirlas en "extra".
- Si no puedes leer algún dato, pon null.
- Devuelve SOLO el JSON array, sin texto adicional.

Devuelve un JSON array: [{ "name": "...", "phone": "...", "state": "...", "extra": "..." }, ...]`;
}

/**
 * Parsear la respuesta de Gemini Vision y limpiar teléfonos
 * @param {string} rawResponse - Respuesta cruda de Gemini
 * @returns {{ leads: object[], errors: string[] }}
 */
function parseScreenshotResponse(rawResponse) {
  const errors = [];
  let leads = [];

  try {
    // Extraer JSON del response (puede venir envuelto en markdown ```json ... ```)
    let jsonStr = rawResponse;
    const jsonMatch = rawResponse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // Intentar parsear array directamente
    const parsed = JSON.parse(jsonStr.trim());
    if (!Array.isArray(parsed)) {
      errors.push('La respuesta de Vision no es un array');
      return { leads, errors };
    }

    for (const item of parsed) {
      const lead = {
        name: item.name || 'Sin nombre',
        phone: cleanPhoneNumber(item.phone),
        state: normalizeState(item.state),
        extra: item.extra || null,
        country: null,
        document: null,
        strategy: null,
      };

      // Validar teléfono
      if (!lead.phone || lead.phone.length < 8) {
        errors.push(`Teléfono inválido para ${lead.name}: "${item.phone}"`);
        continue;
      }

      // Clasificar país
      const countryInfo = detectCountry(lead.phone);
      lead.country = countryInfo;
      lead.document = countryInfo?.document || 'OP';

      // Asignar estrategia
      lead.strategy = STRATEGY_BY_STATE[lead.state] || STRATEGY_BY_STATE['nuevo'];

      // Estado de outreach
      lead.status = 'pending';
      lead.sentAt = null;
      lead.followups = 0;
      lead.responded = false;

      leads.push(lead);
    }

    console.log(`[OUTREACH] 📊 Screenshot parseado: ${leads.length} leads extraídos, ${errors.length} errores`);
  } catch (e) {
    errors.push(`Error parseando JSON de Vision: ${e.message}`);
    console.error(`[OUTREACH] ❌ Error parseando screenshot:`, e.message);
  }

  return { leads, errors };
}

/**
 * Limpiar número de teléfono: quitar +, paréntesis, guiones, espacios
 * @param {string} phone
 * @returns {string}
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';
  return phone.replace(/[^0-9]/g, '');
}

/**
 * Normalizar estado del CRM
 * @param {string} state
 * @returns {string}
 */
function normalizeState(state) {
  if (!state) return 'nuevo';
  const norm = state.toLowerCase().trim()
    .replace(/\[hql\]/i, '')
    .replace(/nuevo\s+contacto\s+conseguido/i, '')
    .trim();

  if (/hql|nuevo|new/i.test(state)) return 'hql';
  if (/llamar|call/i.test(state)) return 'llamar';
  if (/no\s+asiste|no\s+show|ausente/i.test(state)) return 'no asiste';
  if (/envio?\s+wp|whatsapp|enviado/i.test(state)) return 'envio wp';
  return norm || 'nuevo';
}

/**
 * Detectar país por prefijo telefónico
 * @param {string} phone - Número limpio (solo dígitos)
 * @returns {object|null}
 */
function detectCountry(phone) {
  if (!phone) return null;

  // Probar prefijos de mayor a menor longitud (1829 antes que 1)
  const prefixLengths = [4, 3, 2, 1];
  for (const len of prefixLengths) {
    const prefix = phone.substring(0, len);
    if (COUNTRY_BY_PREFIX[prefix]) {
      return COUNTRY_BY_PREFIX[prefix];
    }
  }

  console.warn(`[OUTREACH] ⚠️ País no detectado para teléfono: ${phone}`);
  return { code: 'XX', name: 'Desconocido', document: 'OP', timezone: 'UTC' };
}

// ═══════════════════════════════════════════════════════════════
// COLA DE OUTREACH
// ═══════════════════════════════════════════════════════════════

/**
 * Crear una nueva cola de outreach a partir de leads parseados
 * @param {string} ownerUid
 * @param {object[]} leads - Leads parseados
 * @returns {object} Queue creada
 */
function createOutreachQueue(ownerUid, leads) {
  if (leads.length > MAX_LEADS_PER_BATCH) {
    console.warn(`[OUTREACH] ⚠️ Batch de ${leads.length} leads excede el máximo (${MAX_LEADS_PER_BATCH}). Truncando.`);
    leads = leads.slice(0, MAX_LEADS_PER_BATCH);
  }

  // Ordenar por prioridad (menor = más urgente)
  leads.sort((a, b) => (a.strategy?.priority || 99) - (b.strategy?.priority || 99));

  const queue = {
    id: `outreach_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    ownerUid,
    leads,
    createdAt: Date.now(),
    status: 'pending',
    stats: {
      total: leads.length,
      sent: 0,
      responded: 0,
      failed: 0,
    },
  };

  activeQueues.set(ownerUid, queue);
  console.log(`[OUTREACH] 📋 Cola creada: ${queue.id} — ${leads.length} leads, ordenados por prioridad`);
  return queue;
}

/**
 * Obtener delay aleatorio entre mensajes (anti-ban)
 * @returns {number} Milisegundos
 */
function getRandomDelay() {
  return DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
}

/**
 * Procesar la cola de outreach lead por lead
 *
 * @param {object} queue - La cola
 * @param {function} sendMessageFn - async (phone, text) => void
 * @param {function} sendMediaFn - async (phone, mediaPath, caption) => void
 * @param {function} generateAIFn - async (prompt) => string
 * @param {object} ownerProfile - Perfil del owner
 * @param {function} reportFn - async (text) => void — reportar al owner en self-chat
 * @param {object} opts - { contactIndex, businessCerebro, webScrapeData, youtubeData }
 */
async function processOutreachQueue(queue, sendMessageFn, sendMediaFn, generateAIFn, ownerProfile, reportFn, opts = {}) {
  if (queue.status === 'processing') {
    console.warn(`[OUTREACH] ⚠️ Cola ${queue.id} ya está en proceso`);
    return;
  }

  queue.status = 'processing';
  const ownerName = ownerProfile?.name || ownerProfile?.shortName || 'el equipo';
  const businessName = ownerProfile?.businessName || 'nuestro negocio';

  console.log(`[OUTREACH] 🚀 Iniciando procesamiento de cola ${queue.id} — ${queue.leads.length} leads`);
  await reportFn(`📤 Iniciando contacto con ${queue.leads.length} leads. Te voy avisando...`);

  for (let i = 0; i < queue.leads.length; i++) {
    const lead = queue.leads[i];

    // Verificar si ya existe en contact_index (no re-contactar)
    if (opts.contactIndex && opts.contactIndex[lead.phone]) {
      console.log(`[OUTREACH] ⏭️ ${lead.name} (${lead.phone}) ya existe en contact_index. Saltando.`);
      lead.status = 'skipped';
      await reportFn(`⏭️ ${lead.name} ya está en mis contactos, lo salté.`);
      continue;
    }

    // Delay entre mensajes (no el primero)
    if (i > 0) {
      const delay = getRandomDelay();
      console.log(`[OUTREACH] ⏳ Esperando ${Math.round(delay / 1000)}s antes de contactar a ${lead.name}...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      // Generar mensaje personalizado
      const prompt = buildOutreachPrompt(lead, ownerName, businessName, opts);
      const message = await generateAIFn(prompt);

      if (!message) {
        console.error(`[OUTREACH] ❌ IA no generó mensaje para ${lead.name}`);
        lead.status = 'failed';
        queue.stats.failed++;
        continue;
      }

      // Construir JID
      const jid = `${lead.phone}@s.whatsapp.net`;

      // Enviar mensaje de texto
      await sendMessageFn(jid, message.trim());
      console.log(`[OUTREACH] ✅ Mensaje enviado a ${lead.name} (${lead.phone}) — estrategia: ${lead.strategy?.approach || 'default'}`);

      // Enviar documento de presentación si la estrategia lo pide
      if (lead.strategy?.sendPresentation && sendMediaFn) {
        const docType = lead.document; // 'CO' o 'OP'
        try {
          await sendMediaFn(jid, `PRESENTACION_${docType}`, null);
          console.log(`[OUTREACH] 📄 Presentación ${docType} enviada a ${lead.name}`);
        } catch (mediaErr) {
          console.error(`[OUTREACH] ⚠️ Error enviando presentación a ${lead.name}:`, mediaErr.message);
        }
      }

      lead.status = 'sent';
      lead.sentAt = Date.now();
      queue.stats.sent++;

      // Reportar al owner
      const countryName = lead.country?.name || 'Desconocido';
      await reportFn(`✅ Contacté a *${lead.name}* (${countryName}) — ${lead.strategy?.approach || 'contacto directo'}`);

    } catch (err) {
      console.error(`[OUTREACH] ❌ Error contactando a ${lead.name} (${lead.phone}):`, err.message);
      lead.status = 'failed';
      queue.stats.failed++;
      await reportFn(`❌ No pude contactar a ${lead.name}: ${err.message}`);
    }
  }

  queue.status = 'completed';

  // Resumen final
  const summary = `📊 *Resumen de outreach*\n\n` +
    `Total: ${queue.stats.total} leads\n` +
    `Contactados: ${queue.stats.sent}\n` +
    `Fallidos: ${queue.stats.failed}\n` +
    `Saltados (ya existían): ${queue.leads.filter(l => l.status === 'skipped').length}\n\n` +
    `Los que no respondan, les hago follow-up mañana. ¿Dale?`;

  await reportFn(summary);
  console.log(`[OUTREACH] 🏁 Cola ${queue.id} completada — sent=${queue.stats.sent}, failed=${queue.stats.failed}`);
}

/**
 * Construir prompt para generar el mensaje de outreach personalizado
 * @param {object} lead
 * @param {string} ownerName
 * @param {string} businessName
 * @param {object} opts - { businessCerebro, webScrapeData, youtubeData }
 * @returns {string}
 */
function buildOutreachPrompt(lead, ownerName, businessName, opts = {}) {
  const strategy = lead.strategy || STRATEGY_BY_STATE['nuevo'];
  const countryName = lead.country?.name || 'Latinoamérica';

  let webContext = '';
  if (opts.webScrapeData) {
    webContext = `\n\nINFO DE LA WEB DEL NEGOCIO (datos actualizados):\n${opts.webScrapeData.substring(0, 2000)}`;
  }

  let youtubeContext = '';
  if (opts.youtubeData && opts.youtubeData.length > 0) {
    const videoList = opts.youtubeData.slice(0, 5).map(v => `- "${v.title}": ${v.url}`).join('\n');
    youtubeContext = `\n\nVIDEOS DE YOUTUBE DEL NEGOCIO (puedes recomendar si aplica):\n${videoList}`;
  }

  return `Eres ${ownerName} o parte del equipo de ${businessName}. Vas a escribirle a un lead por WhatsApp.

DATOS DEL LEAD:
- Nombre: ${lead.name}
- País: ${countryName}
- Estado en CRM: ${lead.state}
- Info adicional: ${lead.extra || 'ninguna'}

ESTRATEGIA: ${strategy.tone}

REGLAS ABSOLUTAS:
- NUNCA reveles que eres IA, bot, o asistente automatizado
- NUNCA uses lenguaje genérico de marketing ("estimado cliente", "le informamos")
- Habla como una persona REAL del equipo de ${businessName}
- Mensaje de MÁXIMO 3-4 líneas. Natural, directo, personalizado al lead
- Si el lead es de ${countryName}, usa expresiones naturales de ese país
- Termina con una pregunta abierta que invite a responder
- NO uses hashtags, NO uses emojis excesivos (máx 1-2)
${webContext}
${youtubeContext}

Genera SOLO el mensaje de WhatsApp, nada más.`;
}

// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE TAGS DE PLAN (para server.js)
// ═══════════════════════════════════════════════════════════════

/**
 * Detecta tags [ENVIAR_PLAN:X] en la respuesta de la IA
 * Los ELIMINA del texto y devuelve qué planes enviar
 *
 * @param {string} text - Respuesta de la IA
 * @returns {{ cleanText: string, plans: string[] }}
 */
function extractPlanTags(text) {
  if (!text) return { cleanText: '', plans: [] };

  const plans = [];
  let cleanText = text;

  // Detectar [ENVIAR_PLAN:X]
  const planMatches = text.matchAll(/\[ENVIAR_PLAN:(esencial|pro|titanium|todos)\]/gi);
  for (const match of planMatches) {
    const plan = match[1].toLowerCase();
    if (plan === 'todos') {
      plans.push('esencial', 'pro', 'titanium');
    } else {
      plans.push(plan);
    }
    cleanText = cleanText.replace(match[0], '');
  }

  // Detectar [ENVIAR_PRESENTACION]
  const presMatch = text.match(/\[ENVIAR_PRESENTACION(?::([A-Z]{2}))?\]/i);
  if (presMatch) {
    plans.push(`presentacion_${presMatch[1] || 'OP'}`);
    cleanText = cleanText.replace(presMatch[0], '');
  }

  // Limpiar espacios residuales
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  if (plans.length > 0) {
    console.log(`[OUTREACH] 🏷️ Tags de plan detectados: ${plans.join(', ')}`);
  }

  return { cleanText, plans };
}

/**
 * Marcar lead como "respondió" en la cola activa
 * @param {string} ownerUid
 * @param {string} phone - Teléfono del lead (limpio, sin @s.whatsapp.net)
 * @returns {boolean}
 */
function markLeadResponded(ownerUid, phone) {
  const queue = activeQueues.get(ownerUid);
  if (!queue) return false;

  const lead = queue.leads.find(l => l.phone === phone);
  if (lead && !lead.responded) {
    lead.responded = true;
    lead.status = 'responded';
    queue.stats.responded++;
    console.log(`[OUTREACH] 💬 Lead ${lead.name} (${phone}) respondió!`);
    return true;
  }
  return false;
}

/**
 * Obtener leads que necesitan follow-up (no respondieron después de FOLLOWUP_HOURS)
 * @param {string} ownerUid
 * @returns {object[]}
 */
function getLeadsForFollowup(ownerUid) {
  const queue = activeQueues.get(ownerUid);
  if (!queue || queue.status !== 'completed') return [];

  const now = Date.now();
  const followupThreshold = FOLLOWUP_HOURS * 60 * 60 * 1000;

  return queue.leads.filter(lead =>
    lead.status === 'sent' &&
    !lead.responded &&
    lead.followups < MAX_FOLLOWUPS &&
    lead.sentAt &&
    (now - lead.sentAt) >= followupThreshold
  );
}

/**
 * Obtener cola activa de un owner
 * @param {string} ownerUid
 * @returns {object|null}
 */
function getActiveQueue(ownerUid) {
  return activeQueues.get(ownerUid) || null;
}

// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE COMANDO DE OUTREACH EN SELF-CHAT
// ═══════════════════════════════════════════════════════════════

/**
 * Detecta si el owner está pidiendo outreach proactivo
 * "hacete cargo" / "preséntate" / "contactalos" + imagen
 *
 * @param {string} message
 * @param {boolean} hasImage - Si el mensaje viene con una imagen
 * @returns {boolean}
 */
function isOutreachCommand(message, hasImage) {
  if (!message) return false;
  if (!hasImage) return false; // Requiere imagen

  const outreachPatterns = [
    /\b(hac[ée]te\s+cargo|hazte\s+cargo)\b/i,
    /\b(pres[ée]ntate|presentate)\b/i,
    /\b(contact[áa]los|contactalos|escr[ií]beles|escribeles)\b/i,
    /\b(encarg[áa]te|encargate)\b/i,
    /\b(son\s+leads?|estos?\s+(son\s+)?leads?)\b/i,
    /\b(m[áa]nda(le)?s?\s+(un\s+)?mensaje)\b/i,
  ];

  for (const pattern of outreachPatterns) {
    if (pattern.test(message)) return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Parseo
  buildScreenshotParserPrompt,
  parseScreenshotResponse,
  cleanPhoneNumber,
  normalizeState,
  detectCountry,

  // Cola
  createOutreachQueue,
  processOutreachQueue,
  getRandomDelay,
  getActiveQueue,
  markLeadResponded,
  getLeadsForFollowup,

  // Tags
  extractPlanTags,

  // Detección
  isOutreachCommand,
  buildOutreachPrompt,

  // Constantes (para testing/config)
  COUNTRY_BY_PREFIX,
  STRATEGY_BY_STATE,
  MAX_LEADS_PER_BATCH,
  SAFE_HOURS,
};
