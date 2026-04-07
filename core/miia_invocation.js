'use strict';

/**
 * MIIA_INVOCATION.JS — Sistema de invocación de MIIA en chats 1-on-1
 *
 * STANDARD: Google + Amazon + Apple + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * CONCEPTO: MIIA puede ser "invocada" en un chat entre el owner y un contacto.
 * Esto crea una conversación de 3: MIIA + Owner + Contacto.
 * MIIA entra como INVITADA con scope limitado y se retira sola tras inactividad.
 *
 * TRIGGERS DE INVOCACIÓN:
 *   "MIIA estás?" / "MIIA estas?" / "Estás MIIA?" / "Estas MIIA?"
 *   "MIIA ven" / "Ven MIIA"
 *
 * TRIGGERS DE DESPEDIDA:
 *   "Chau MIIA" / "Bye MIIA" / "Adiós MIIA" / "Adios MIIA"
 *
 * FLUJO:
 *   1. Owner o contacto invoca a MIIA
 *   2. MIIA detecta si conoce al contacto
 *   3a. Primera vez → pide presentación al owner
 *   3b. Ya lo conoce → saluda a ambos
 *   4. Owner da scope (opcional): "estábamos hablando de X" / "ayudanos con..."
 *   5. MIIA ayuda SOLO dentro del scope
 *   6. Contacto pregunta fuera de scope → MIIA redirige con gracia
 *   7. 10 min sin interacción → auto-retiro
 *   8. Owner o contacto dice "Chau MIIA" → MIIA se despide
 *
 * AUTOVENTA: MIIA aprende del contacto para futura venta de MIIA como producto.
 */

// ═══════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════

const AUTO_RETIRE_MS = 10 * 60 * 1000; // 10 minutos sin interacción → auto-retiro

// Regex para detectar invocación — case insensitive, con/sin signos
const INVOCATION_PATTERNS = [
  /\bmiia\s+(est[áa]s|ven)\b/i,
  /\b(est[áa]s|ven)\s+miia\b/i,
  /\bmiia\s+(est[áa]s\s*\??)\b/i,
  /\b(est[áa]s\s*\??)\s+miia\b/i,
  /\bmiia\s+ven[ií]?\b/i,
  /\bven[ií]?\s+miia\b/i,
];

// Regex para detectar despedida — case insensitive
const FAREWELL_PATTERNS = [
  /\b(chau|chao|adi[óo]s|bye|nos\s+vemos)\s+miia\b/i,
  /\bmiia\s+(chau|chao|adi[óo]s|bye)\b/i,
];

// Patrones para detectar relación cuando el owner presenta al contacto
const RELATIONSHIP_PATTERNS = {
  familia: [
    /\bmi\s+(mam[áa]|pap[áa]|hermano|hermana|t[ií]o|t[ií]a|primo|prima|abuelo|abuela|suegro|suegra|cu[ñn]ado|cu[ñn]ada|esposo|esposa|novio|novia|pareja|hijo|hija|sobrino|sobrina)\b/i,
    /\bes\s+mi\s+(mam[áa]|pap[áa]|hermano|hermana|t[ií]o|t[ií]a)\b/i,
  ],
  amigos: [
    /\bmi\s+(amigo|amiga|compa|compadre|comadre|parcero|parcera|pana|bro|brother)\b/i,
    /\bes\s+mi\s+(amigo|amiga)\b/i,
    /\b(amigo|amiga)\s+m[ií][oa]?\b/i,
  ],
  equipo: [
    /\bmi\s+(socio|socia|colega|compa[ñn]ero|compa[ñn]era|empleado|empleada|asistente|secretario|secretaria)\b/i,
    /\bes\s+(del|de)\s+(equipo|trabajo|oficina)\b/i,
  ],
  lead: [
    /\b(un|una)\s+(cliente|paciente|lead|prospecto|interesado|interesada)\b/i,
    /\bes\s+(cliente|paciente)\b/i,
  ],
};

// Patrones para detectar que el owner da scope/contexto
const SCOPE_PATTERNS = [
  /\b(est[áa]bamos|ven[ií]amos)\s+(hablando|charlando|discutiendo|viendo)\s+(de|sobre|del)\s+(.+)/i,
  /\b(mira|mir[áa]|revisa|lee|fijate)\s+(este|esta|esto|el|la|los|las)\s+(.+)/i,
  /\b(ayud[áa]nos|ayudanos|ayuda)\s+(con|en)\s+(.+)/i,
  /\b(necesitamos|queremos)\s+(que|tu\s+ayuda)\s+(.+)/i,
  /\bmiia[,:]?\s+(ayud[áa]nos|fijate|mira|revisa)\s+(.+)/i,
];

// ═══════════════════════════════════════════════════════════════
// ESTADO EN MEMORIA — Por teléfono del contacto
// ═══════════════════════════════════════════════════════════════

/**
 * Estado de invocación por contacto:
 * {
 *   invoked: true/false,
 *   scope: "ayuda con presupuesto" | null,
 *   invokedAt: timestamp,
 *   invokedBy: "owner" | "contact",
 *   lastInteraction: timestamp,
 *   contactName: "Lala",
 *   contactRelation: "amigos" | "familia" | "equipo" | null,
 *   knownContact: true/false,
 *   pendingIntroduction: true/false,
 *   autoRetireTimer: setTimeout ref
 * }
 */
const invocationState = new Map(); // phone → state

// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE TRIGGERS
// ═══════════════════════════════════════════════════════════════

/**
 * Detecta si un mensaje es una invocación de MIIA
 * @param {string} message - Texto del mensaje
 * @returns {boolean}
 */
function isInvocation(message) {
  if (!message) return false;
  const clean = message.trim().replace(/[!¡?¿.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const pattern of INVOCATION_PATTERNS) {
    if (pattern.test(clean)) return true;
  }
  return false;
}

/**
 * Detecta si un mensaje es una despedida de MIIA
 * @param {string} message - Texto del mensaje
 * @returns {boolean}
 */
function isFarewell(message) {
  if (!message) return false;
  const clean = message.trim().replace(/[!¡?¿.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const pattern of FAREWELL_PATTERNS) {
    if (pattern.test(clean)) return true;
  }
  return false;
}

/**
 * Detecta la relación del contacto a partir de lo que dice el owner
 * "Ella es mi amiga" → "amigos"
 * "Es mi mamá" → "familia"
 * @param {string} message
 * @returns {{ relation: string|null, name: string|null }}
 */
function detectRelationship(message) {
  if (!message) return { relation: null, name: null };

  for (const [relation, patterns] of Object.entries(RELATIONSHIP_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        // Intentar extraer nombre: buscar lo que viene después de ":", "se llama", o un nombre propio
        const nameMatch = message.match(/(?:se\s+llama|es|ac[áa]|aqu[ií])\s+(?:mi\s+\w+\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?)/);
        const name = nameMatch ? nameMatch[1].trim() : null;
        console.log(`[INVOCATION] 🏷️ Relación detectada: ${relation}${name ? `, nombre: ${name}` : ''}`);
        return { relation, name };
      }
    }
  }

  return { relation: null, name: null };
}

/**
 * Detecta si el owner está dando scope/contexto para la conversación
 * "Estábamos hablando de un viaje" → "un viaje"
 * "Ayudanos con el presupuesto" → "el presupuesto"
 * @param {string} message
 * @returns {string|null} El scope detectado, o null
 */
function detectScope(message) {
  if (!message) return null;

  for (const pattern of SCOPE_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      // El scope es el último grupo capturado
      const scope = match[match.length - 1]?.trim();
      if (scope && scope.length > 2) {
        console.log(`[INVOCATION] 🎯 Scope detectado: "${scope}"`);
        return scope;
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// GESTIÓN DE ESTADO
// ═══════════════════════════════════════════════════════════════

/**
 * Activar invocación de MIIA en un chat
 * @param {string} phone - JID del contacto
 * @param {string} invokedBy - "owner" | "contact"
 * @param {object} opts - { contactName, knownContact }
 * @returns {object} Estado de invocación
 */
function activateInvocation(phone, invokedBy, opts = {}) {
  const existing = invocationState.get(phone);

  // Limpiar timer anterior si existe
  if (existing?.autoRetireTimer) {
    clearTimeout(existing.autoRetireTimer);
  }

  const state = {
    invoked: true,
    scope: null,
    invokedAt: Date.now(),
    invokedBy,
    lastInteraction: Date.now(),
    contactName: opts.contactName || existing?.contactName || null,
    contactRelation: existing?.contactRelation || null,
    knownContact: opts.knownContact || false,
    pendingIntroduction: !opts.knownContact,
    autoRetireTimer: null,
  };

  invocationState.set(phone, state);
  console.log(`[INVOCATION] 🟢 MIIA invocada por ${invokedBy} en chat con ${phone}${state.contactName ? ` (${state.contactName})` : ''}`);
  return state;
}

/**
 * Desactivar invocación (despedida o auto-retiro)
 * @param {string} phone
 * @param {string} reason - "farewell" | "auto_retire" | "manual"
 */
function deactivateInvocation(phone, reason = 'farewell') {
  const state = invocationState.get(phone);
  if (state?.autoRetireTimer) {
    clearTimeout(state.autoRetireTimer);
  }

  if (state) {
    state.invoked = false;
    state.scope = null;
    state.autoRetireTimer = null;
  }

  console.log(`[INVOCATION] 🔴 MIIA desactivada en chat con ${phone} (reason: ${reason})`);
}

/**
 * Registrar interacción (resetea el timer de auto-retiro)
 * @param {string} phone
 * @param {function} onAutoRetire - Callback cuando MIIA se retira sola
 */
function touchInteraction(phone, onAutoRetire) {
  const state = invocationState.get(phone);
  if (!state || !state.invoked) return;

  state.lastInteraction = Date.now();

  // Resetear timer de auto-retiro
  if (state.autoRetireTimer) {
    clearTimeout(state.autoRetireTimer);
  }

  state.autoRetireTimer = setTimeout(() => {
    console.log(`[INVOCATION] ⏰ Auto-retiro por inactividad en chat con ${phone}`);
    deactivateInvocation(phone, 'auto_retire');
    if (typeof onAutoRetire === 'function') {
      onAutoRetire(phone, state.contactName);
    }
  }, AUTO_RETIRE_MS);
}

/**
 * Establecer scope de la conversación
 * @param {string} phone
 * @param {string} scope
 */
function setScope(phone, scope) {
  const state = invocationState.get(phone);
  if (!state) return;
  state.scope = scope;
  console.log(`[INVOCATION] 🎯 Scope establecido para ${phone}: "${scope}"`);
}

/**
 * Registrar nombre y relación del contacto (post-presentación)
 * @param {string} phone
 * @param {string} name
 * @param {string} relation - "amigos" | "familia" | "equipo" | "lead"
 */
function setContactInfo(phone, name, relation) {
  const state = invocationState.get(phone);
  if (!state) return;
  state.contactName = name;
  state.contactRelation = relation;
  state.knownContact = true;
  state.pendingIntroduction = false;
  console.log(`[INVOCATION] 📇 Contacto registrado: ${name} → grupo ${relation}`);
}

/**
 * Obtener estado de invocación
 * @param {string} phone
 * @returns {object|null}
 */
function getInvocationState(phone) {
  return invocationState.get(phone) || null;
}

/**
 * ¿MIIA está invocada en este chat?
 * @param {string} phone
 * @returns {boolean}
 */
function isInvoked(phone) {
  const state = invocationState.get(phone);
  return state?.invoked === true;
}

/**
 * Determina si un mensaje del contacto está FUERA del scope de MIIA
 * (para redirigir al owner con gracia)
 *
 * @param {string} message - Mensaje del contacto
 * @param {string} scope - Scope actual (puede ser null = sin scope)
 * @returns {{ outOfScope: boolean, reason: string }}
 */
function checkScope(message, scope) {
  // Sin scope → MIIA solo saluda y espera, todo fuera de scope
  if (!scope) {
    return { outOfScope: true, reason: 'no_scope_set' };
  }

  // Con scope → la IA decide si el mensaje está relacionado (delegado al prompt)
  // Aquí solo detectamos pedidos claramente personales de asistencia
  const personalAssistancePatterns = [
    /\bmiia\b.*\b(buscame|buscá|búscame|agrégame|agéndame|recordame|acordate|avisame|mandame|envíame|envíale|organizame)\b/i,
    /\b(pod[ée]s|puedes|podr[ií]as)\s+(buscarme|agendarme|recordarme|avisarme|mandarme|organizarme|ayudarme\s+con\s+mi)\b/i,
  ];

  for (const pattern of personalAssistancePatterns) {
    if (pattern.test(message)) {
      return { outOfScope: true, reason: 'personal_assistance_request' };
    }
  }

  return { outOfScope: false, reason: 'within_scope' };
}

/**
 * Detecta si el contacto muestra interés en MIIA como producto (momento de autoventa)
 * @param {string} message
 * @returns {{ interested: boolean, trigger: string|null }}
 */
function detectAutoventaOpportunity(message) {
  if (!message) return { interested: false, trigger: null };

  const autoventaPatterns = [
    { pattern: /\bc[óo]mo\s+(hac[ée]s|funciona|sab[ée]s)\b/i, trigger: 'curiosidad_funcional' },
    { pattern: /\b(incre[ií]ble|genial|wow|wao|guau|impresionante)\b/i, trigger: 'admiracion' },
    { pattern: /\bquiero\s+(una?|algo)\s+(como|as[ií]|igual)\b/i, trigger: 'deseo_directo' },
    { pattern: /\b(existe|hay|tienen|venden)\s+(algo|un\w*)\s+(como|as[ií]|para\s+m[ií])\b/i, trigger: 'consulta_producto' },
    { pattern: /\b(sos|eres)\s+(una?\s+)?(ia|inteligencia|robot|bot|asistente)\b/i, trigger: 'pregunta_identidad' },
    { pattern: /\byo\s+(tambi[ée]n\s+)?(quiero|necesito|quisiera)\b.*\b(asistente|ayuda|organiz)/i, trigger: 'necesidad_expresada' },
  ];

  for (const { pattern, trigger } of autoventaPatterns) {
    if (pattern.test(message)) {
      console.log(`[INVOCATION] 💰 Oportunidad de autoventa detectada: ${trigger}`);
      return { interested: true, trigger };
    }
  }

  return { interested: false, trigger: null };
}

/**
 * Extrae learnings del contacto para futuras oportunidades de venta
 * @param {string} message - Mensaje del contacto
 * @returns {string[]} Lista de aprendizajes detectados
 */
function extractContactLearnings(message) {
  if (!message || message.length < 10) return [];

  const learnings = [];
  const patterns = [
    { pattern: /\b(soy|trabajo\s+(como|en|de))\s+(.+)/i, type: 'profesion' },
    { pattern: /\b(tengo|manejo|dirijo)\s+(un\w*\s+)?(consultorio|cl[ií]nica|negocio|empresa|tienda|restaurante|oficina)\b/i, type: 'negocio' },
    { pattern: /\bsiempre\s+(me\s+olvido|se\s+me\s+olvida|pierdo|me\s+cuesta)\b.*$/i, type: 'pain_point' },
    { pattern: /\b(necesito|busco|quiero)\s+(organizar|automatizar|mejorar|controlar)\b/i, type: 'pain_point' },
    { pattern: /\bme\s+(gusta|encanta|interesa|apasiona)\s+(.+)/i, type: 'interes' },
  ];

  for (const { pattern, type } of patterns) {
    const match = message.match(pattern);
    if (match) {
      learnings.push(`[${type}] ${match[0].substring(0, 100)}`);
    }
  }

  return learnings;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Detección
  isInvocation,
  isFarewell,
  detectRelationship,
  detectScope,
  detectAutoventaOpportunity,
  extractContactLearnings,
  checkScope,

  // Estado
  activateInvocation,
  deactivateInvocation,
  touchInteraction,
  setScope,
  setContactInfo,
  getInvocationState,
  isInvoked,

  // Constantes (para testing)
  AUTO_RETIRE_MS,
  INVOCATION_PATTERNS,
  FAREWELL_PATTERNS,
  RELATIONSHIP_PATTERNS,
};
