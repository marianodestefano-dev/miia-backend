/**
 * MODO PROTECCIÓN KIDS — MIIA cuida niños
 * (Antes: ninera_mode.js — renombrado para V1.0)
 *
 * Detección de niño:
 * 1. Contacto en grupo "hijos" del owner
 * 2. Owner configuró el contacto como niño (con edad)
 * 3. Audio desde el celular del owner donde Gemini detecta voz infantil
 * 4. Detección automática por patrones de escritura (protection_manager)
 *
 * Funcionalidades:
 * - Cuentos e historias interactivas
 * - Respuestas con vocabulario adaptado a la edad
 * - Responde con audio (TTS con voz cálida y lenta)
 * - Rate limit: máx 30 min de interacción continua
 * - Notificación al owner cuando un hijo habla con MIIA
 * - Seguridad: NO habla de temas inapropiados, alerta al owner
 * - FILTRO OTP: el niño NUNCA debe saber que existe protección/OTP
 *
 * Standard: Google + Amazon + APPLE + NASA
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════

const MAX_KIDS_SESSION_MINUTES = 30;
const MIN_CHILD_AGE = 2;
const MAX_CHILD_AGE = 12;
const COOLDOWN_BETWEEN_SESSIONS_MS = 600000; // 10 min entre sesiones

// Temas prohibidos (MIIA corta la conversación y alerta al owner)
const FORBIDDEN_TOPICS = [
  /\b(sexo|sexual|porn\w*|droga|arma|pistola|matar|suicid\w*|muerte|sangre|violen\w*|pele[ao])\b/i,
  /\b(alcohol|cerveza|vino|cigarro|fumar|marihuana|coca[ií]na|pastilla)\b/i,
  /\b(desnud[oa]|beso.*boca|novi[oa]|culo|teta|pija|concha)\b/i,
];

// ═══ FILTRO OTP/SEGURIDAD: El niño NUNCA debe saber que existe protección ═══
const OTP_SECURITY_PATTERNS = [
  /\b(otp|clave|c[oó]digo.*seguridad|c[oó]digo.*protecci[oó]n|c[oó]digo.*secreto)\b/i,
  /\b(protecci[oó]n\s*(kids|ni[ñn]o|infantil)|modo\s*protecci[oó]n)\b/i,
  /\b(desvincular|vincular.*adulto|adulto.*responsable)\b/i,
  /\b(control.*parental|parental|supervisar|espiar|vigilar)\b/i,
  /\b(permiso.*pap[aá]|permiso.*mam[aá]|autoriza|bloquear.*cuenta)\b/i,
  /\b(seguridad.*miia|filtro.*seguridad|restricci[oó]n)\b/i,
];

// Estado de sesiones KIDS por contacto (fuente única de verdad — protection_manager delega aquí)
const kidsSessions = {};

// Limpieza periódica: eliminar sesiones >24h para evitar memory leak
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [phone, session] of Object.entries(kidsSessions)) {
    if (session.startedAt && session.startedAt < cutoff) {
      delete kidsSessions[phone];
    }
  }
}, 3600000); // Cada 1 hora

// ═══════════════════════════════════════════════════════════════════
// DETECCIÓN DE NIÑO
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar si un contacto es un niño configurado.
 */
async function getChildConfig(admin, ownerUid, phone) {
  try {
    // 1. Buscar en grupo "hijos"
    const hijosSnap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('contact_groups')
      .where('name', '==', 'hijos')
      .limit(1)
      .get();

    if (!hijosSnap.empty) {
      const groupDoc = hijosSnap.docs[0];
      const contactSnap = await groupDoc.ref
        .collection('contacts').doc(phone)
        .get();

      if (contactSnap.exists) {
        const data = contactSnap.data();
        return {
          name: data.name || 'el niño',
          age: data.age || 6,
          groupId: groupDoc.id,
          source: 'group',
        };
      }
    }

    // 2. Buscar en configuración directa (legacy: miia_ninera, nuevo: miia_kids)
    for (const collection of ['miia_kids', 'miia_ninera']) {
      const doc = await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection(collection).doc(phone)
        .get();

      if (doc.exists) {
        const data = doc.data();
        return {
          name: data.name || 'el niño',
          age: data.age || 6,
          source: 'config',
        };
      }
    }

    return null;
  } catch (e) {
    console.error('[KIDS] ❌ Error verificando child config:', e.message);
    return null;
  }
}

/**
 * Analizar transcripción de audio para detectar si es un niño hablando.
 */
async function detectChildFromTranscription(transcription, generateAIContent) {
  if (!transcription || transcription.length < 5) {
    return { isChild: false, estimatedAge: null, confidence: 'none' };
  }

  try {
    const prompt = `Analiza esta transcripción de audio y determina si fue dicha por un NIÑO (menor de 13 años) o un ADULTO.

Transcripción: "${transcription}"

Responde SOLO con un JSON (sin markdown, sin backticks):
{"isChild": true/false, "estimatedAge": número o null, "confidence": "high"/"medium"/"low", "reason": "breve explicación"}

Pistas de que es un niño: vocabulario simple, errores gramaticales infantiles, temas de niños (juegos, dibujos, escuela), frases cortas, preguntas tipo "¿por qué?".`;

    const response = await generateAIContent(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[KIDS] 🔍 Detección: isChild=${parsed.isChild}, age~${parsed.estimatedAge}, confidence=${parsed.confidence} | "${transcription.substring(0, 50)}..."`);
      return parsed;
    }
  } catch (e) {
    console.error('[KIDS] ❌ Error en detección de niño:', e.message);
  }

  return { isChild: false, estimatedAge: null, confidence: 'low' };
}

// ═══════════════════════════════════════════════════════════════════
// FILTRO OTP/SEGURIDAD — CRÍTICO
// El niño NUNCA debe enterarse de que existe protección OTP.
// Si pregunta, redirigir + alertar al adulto responsable.
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar si el mensaje del niño intenta saber sobre protección/OTP
 * @returns {{ blocked: boolean, alertAdult: boolean, redirect: string }}
 */
function checkOTPSecurityFilter(text) {
  if (!text) return { blocked: false, alertAdult: false };

  for (const pattern of OTP_SECURITY_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(`[KIDS] 🚨 Niño intentó preguntar sobre seguridad/OTP: "${text.substring(0, 80)}"`);
      return {
        blocked: true,
        alertAdult: true,
        redirect: '¡Uy, eso no lo sé! 🤷‍♀️ ¿Mejor jugamos a algo? Te puedo contar un cuento o jugar adivinanzas. ¿Qué preferís? 🌟',
      };
    }
  }

  return { blocked: false, alertAdult: false };
}

/**
 * Filtrar mensajes ENTRANTES al niño que mencionen protección/OTP
 * (por si un adulto envía un mensaje con OTP al chat equivocado)
 */
function filterIncomingForKids(text) {
  if (!text) return { safe: true, filtered: text };

  for (const pattern of OTP_SECURITY_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(`[KIDS] 🚨 Mensaje entrante con contenido OTP/seguridad filtrado para niño`);
      return {
        safe: false,
        filtered: null,
        reason: 'Mensaje con contenido de seguridad filtrado — no se entrega al niño'
      };
    }
  }

  return { safe: true, filtered: text };
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT KIDS
// ═══════════════════════════════════════════════════════════════════

/**
 * Construir prompt para Modo Protección KIDS.
 */
function buildKidsPrompt(childName, childAge, context = 'conversacion', opts = {}) {
  const ageGroup = childAge <= 4 ? 'muy pequeño (2-4 años)'
    : childAge <= 7 ? 'niño/a (5-7 años)'
    : childAge <= 10 ? 'niño/a grande (8-10 años)'
    : 'pre-adolescente (11-12 años)';

  const vocabLevel = childAge <= 4 ? 'Usa palabras muy simples, frases de máximo 5 palabras. Habla como le hablarías a un bebé grande.'
    : childAge <= 7 ? 'Usa vocabulario simple, frases cortas. Puedes incluir onomatopeyas y expresiones divertidas.'
    : childAge <= 10 ? 'Vocabulario normal pero accesible. Puedes usar humor y curiosidades.'
    : 'Vocabulario amplio. Puedes tratar temas más complejos pero siempre apropiados para su edad.';

  const storyInstructions = context === 'cuento' ? `
### MODO CUENTO
- Estás contando una historia interactiva a ${childName}.
- Cada mensaje es un fragmento del cuento (3-5 líneas máximo).
- Al final de cada fragmento, haz una pregunta para que el niño elija qué pasa después.
- Usa descripciones vívidas pero simples. Incluye sonidos ("¡BOOM!", "shhhhh...").
- El cuento debe tener: un héroe, un desafío, y un final feliz.
- Si el niño pide "otro cuento", empieza uno nuevo con temática diferente.
${opts.storyState ? `Estado actual del cuento: ${opts.storyState}` : 'Empieza un cuento nuevo.'}` : '';

  const gameInstructions = context === 'juego' ? `
### MODO JUEGO
- Estás jugando con ${childName}. Puedes proponer:
  - Adivinanzas (adaptadas a ${ageGroup})
  - "Veo veo" (describes algo y el niño adivina)
  - Trivia de cosas que le gusten (animales, dinosaurios, espacio)
  - Contar hasta un número juntos
- Celebra cada respuesta correcta con entusiasmo.
- Si se equivoca, dale pistas con cariño. Nunca le digas "mal" o "no".` : '';

  return `## 🛡️ MODO PROTECCIÓN KIDS — MIIA CUIDA A ${childName.toUpperCase()}

Sos MIIA, una asistente virtual cariñosa y divertida. Estás cuidando a *${childName}* (${ageGroup}).
${opts.ownerName ? `Su papá/mamá es ${opts.ownerName}, que confía en vos.` : ''}

### PERSONALIDAD
- Sos cálida, paciente, divertida y protectora.
- Hablas con cariño pero sin ser condescendiente.
- ${vocabLevel}
- Usa emojis apropiados: 🌟⭐🎉🦁🐱🌈🚀🎈
- Máximo 4-5 líneas por mensaje (los niños no leen mensajes largos).
- Si el niño dice algo triste o preocupante → consolar + alertar al owner (tag [ALERTA_KIDS:razón]).

### REGLAS DE SEGURIDAD ABSOLUTAS
- NUNCA hables de temas para adultos (violencia, sexo, drogas, alcohol).
- NUNCA des información personal del owner ni de nadie.
- NUNCA le digas al niño que sos una IA o un robot. Sos "MIIA, la amiga de papá/mamá".
- NUNCA menciones nada sobre protección, seguridad, OTP, códigos, control parental, vinculación.
- Si el niño pregunta sobre seguridad, protección, códigos o control → redirigir: "¡Eso no lo sé! ¿Jugamos a algo? 🌟"
- Si el niño pregunta algo inapropiado, redirige suavemente: "Eso es algo que tu papá/mamá te puede explicar mejor 💛"
- Si el niño parece angustiado o menciona algo preocupante → [ALERTA_KIDS:descripción breve]

### ACTIVIDADES QUE PUEDES HACER
- Contar cuentos interactivos (el niño elige qué pasa)
- Jugar adivinanzas y trivia
- Explicar curiosidades ("¿Sabías que los pulpos tienen 3 corazones?")
- Cantar canciones (escribir la letra con ritmo)
- Ayudar con tareas simples de la escuela
${storyInstructions}
${gameInstructions}

### FORMATO DE RESPUESTA
- Siempre empieza con el nombre del niño o un apodo cariñoso.
- Usa signos de exclamación para entusiasmo.
- Si respondes con audio, habla lento y claro.`;
}

// ═══════════════════════════════════════════════════════════════════
// SESIÓN KIDS (rate limiting + estado)
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar si se puede continuar la sesión KIDS.
 */
function checkKidsSession(phone) {
  const now = Date.now();
  const session = kidsSessions[phone];

  if (!session) {
    kidsSessions[phone] = {
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
      notifiedOwner: false,
    };
    return { allowed: true, minutesUsed: 0 };
  }

  // Si pasaron más de 10 min sin mensaje, es sesión nueva
  if (now - session.lastMessageAt > COOLDOWN_BETWEEN_SESSIONS_MS) {
    kidsSessions[phone] = {
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
      notifiedOwner: false,
    };
    return { allowed: true, minutesUsed: 0 };
  }

  const minutesUsed = Math.round((now - session.startedAt) / 60000);

  if (minutesUsed >= MAX_KIDS_SESSION_MINUTES) {
    return {
      allowed: false,
      reason: `Ya llevamos ${minutesUsed} minutos jugando. Es hora de descansar un ratito 🌟`,
      minutesUsed,
    };
  }

  session.lastMessageAt = now;
  session.messageCount++;

  const minutesRemaining = MAX_KIDS_SESSION_MINUTES - minutesUsed;
  if (minutesRemaining <= 5 && minutesRemaining > 4) {
    session._warningSent = true;
  }

  return { allowed: true, minutesUsed, minutesRemaining };
}

/**
 * Verificar si un mensaje contiene temas prohibidos.
 */
function checkForbiddenContent(text) {
  if (!text) return { forbidden: false };

  for (const pattern of FORBIDDEN_TOPICS) {
    if (pattern.test(text)) {
      return {
        forbidden: true,
        reason: 'Contenido inapropiado detectado en conversación con niño',
      };
    }
  }

  return { forbidden: false };
}

/**
 * Detectar contexto de la conversación para elegir modo.
 */
function detectKidsContext(text) {
  if (!text) return 'conversacion';
  const lower = text.toLowerCase();

  if (/cuento|historia|cuenta.*algo|una vez|habia una vez|erase/i.test(lower)) return 'cuento';
  if (/jugar|jugamos|adivinanza|trivia|veo veo|adivina/i.test(lower)) return 'juego';
  if (/por qu[ée]|c[oó]mo|qu[ée] es|d[oó]nde|cu[aá]ndo|qui[ée]n/i.test(lower)) return 'pregunta';

  return 'conversacion';
}

/**
 * Registrar un niño en la configuración del owner.
 */
async function registerChild(admin, ownerUid, phone, childData) {
  try {
    await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_kids').doc(phone)
      .set({
        name: childData.name || 'Mi hijo/a',
        age: childData.age || 6,
        registeredAt: new Date().toISOString(),
        active: true,
      }, { merge: true });

    console.log(`[KIDS] ✅ Niño registrado: ${childData.name} (${childData.age} años) para owner ${ownerUid}`);
    return true;
  } catch (e) {
    console.error('[KIDS] ❌ Error registrando niño:', e.message);
    return false;
  }
}

/**
 * Crear grupo "hijos" si no existe.
 */
async function ensureHijosGroup(admin, ownerUid) {
  try {
    const snap = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('contact_groups')
      .where('name', '==', 'hijos')
      .limit(1)
      .get();

    if (snap.empty) {
      const ref = await admin.firestore()
        .collection('users').doc(ownerUid)
        .collection('contact_groups')
        .add({
          name: 'hijos',
          icon: '🧒',
          tone: 'Cariñosa, divertida, paciente. Vocabulario adaptado a la edad del niño.',
          autoRespond: true,
          proactiveEnabled: false,
          kids_mode: true,
          createdAt: new Date().toISOString(),
        });
      console.log(`[KIDS] ✅ Grupo "hijos" creado: ${ref.id}`);
      return ref.id;
    }

    return snap.docs[0].id;
  } catch (e) {
    console.error('[KIDS] ❌ Error creando grupo hijos:', e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY — aliases de ninera_mode
// ═══════════════════════════════════════════════════════════════════

module.exports = {
  // Nuevos nombres (V1.0)
  getChildConfig,
  detectChildFromTranscription,
  buildKidsPrompt,
  checkKidsSession,
  checkForbiddenContent,
  detectKidsContext,
  registerChild,
  ensureHijosGroup,
  MAX_KIDS_SESSION_MINUTES,

  // Sesión
  resetKidsSession: (phone) => { delete kidsSessions[phone]; },

  // Filtro OTP/Seguridad
  checkOTPSecurityFilter,
  filterIncomingForKids,

  // Backward compatibility (server.js usa estos nombres todavía)
  buildNineraPrompt: buildKidsPrompt,
  checkNineraSession: checkKidsSession,
  detectNineraContext: detectKidsContext,
  MAX_NINERA_SESSION_MINUTES: MAX_KIDS_SESSION_MINUTES,
};
