/**
 * MODO NIÑERA — MIIA cuida niños por voz
 *
 * Detección de niño:
 * 1. Contacto en grupo "hijos" del owner
 * 2. Owner configuró el contacto como niño (con edad)
 * 3. Audio desde el celular del owner donde Gemini detecta voz infantil
 *
 * Funcionalidades:
 * - Cuentos e historias interactivas
 * - Respuestas con vocabulario adaptado a la edad
 * - Responde con audio (TTS con voz cálida y lenta)
 * - Rate limit: máx X minutos de interacción continua
 * - Notificación al owner cuando un hijo habla con MIIA
 * - Seguridad: NO habla de temas inapropiados, alerta al owner
 *
 * Standard: Google + Amazon + APPLE + NASA
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════════════

const MAX_NINERA_SESSION_MINUTES = 30; // Máx 30 min continuo
const MIN_CHILD_AGE = 2;
const MAX_CHILD_AGE = 12;
const COOLDOWN_BETWEEN_SESSIONS_MS = 600000; // 10 min entre sesiones

// Temas prohibidos (MIIA corta la conversación y alerta al owner)
const FORBIDDEN_TOPICS = [
  /\b(sexo|sexual|porn\w*|droga|arma|pistola|matar|suicid\w*|muerte|sangre|violen\w*|pele[ao])\b/i,
  /\b(alcohol|cerveza|vino|cigarro|fumar|marihuana|coca[ií]na|pastilla)\b/i,
  /\b(desnud[oa]|beso.*boca|novi[oa]|culo|teta|pija|concha)\b/i,
];

// Estado de sesiones niñera por contacto
const nineraSessions = {};

// ═══════════════════════════════════════════════════════════════════
// DETECCIÓN DE NIÑO
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar si un contacto es un niño configurado.
 * @param {Object} admin - Firebase admin
 * @param {string} ownerUid
 * @param {string} phone - Teléfono del contacto (o 'self' si es desde el owner)
 * @returns {Object|null} { name, age, groupId } o null
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

    // 2. Buscar en configuración directa
    const nineraDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_ninera').doc(phone)
      .get();

    if (nineraDoc.exists) {
      const data = nineraDoc.data();
      return {
        name: data.name || 'el niño',
        age: data.age || 6,
        source: 'config',
      };
    }

    return null;
  } catch (e) {
    console.error('[NIÑERA] ❌ Error verificando child config:', e.message);
    return null;
  }
}

/**
 * Analizar transcripción de audio para detectar si es un niño hablando.
 * Usa Gemini para analizar la transcripción + metadata.
 * @param {string} transcription - Transcripción del audio
 * @param {Function} generateAIContent - Función de IA
 * @returns {Promise<{isChild: boolean, estimatedAge: number|null, confidence: string}>}
 */
async function detectChildFromTranscription(transcription, generateAIContent) {
  if (!transcription || transcription.length < 5) {
    return { isChild: false, estimatedAge: null, confidence: 'none' };
  }

  try {
    const prompt = `Analizá esta transcripción de audio y determiná si fue dicha por un NIÑO (menor de 13 años) o un ADULTO.

Transcripción: "${transcription}"

Respondé SOLO con un JSON (sin markdown, sin backticks):
{"isChild": true/false, "estimatedAge": número o null, "confidence": "high"/"medium"/"low", "reason": "breve explicación"}

Pistas de que es un niño: vocabulario simple, errores gramaticales infantiles, temas de niños (juegos, dibujos, escuela), frases cortas, preguntas tipo "¿por qué?".`;

    const response = await generateAIContent(prompt);
    // Parsear JSON de la respuesta
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[NIÑERA] 🔍 Detección: isChild=${parsed.isChild}, age~${parsed.estimatedAge}, confidence=${parsed.confidence} | "${transcription.substring(0, 50)}..."`);
      return parsed;
    }
  } catch (e) {
    console.error('[NIÑERA] ❌ Error en detección de niño:', e.message);
  }

  return { isChild: false, estimatedAge: null, confidence: 'low' };
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT NIÑERA
// ═══════════════════════════════════════════════════════════════════

/**
 * Construir prompt para modo niñera.
 * @param {string} childName - Nombre del niño
 * @param {number} childAge - Edad del niño
 * @param {string} context - 'cuento' | 'conversacion' | 'pregunta' | 'juego'
 * @param {Object} opts - { ownerName, storyState }
 * @returns {string} Prompt del sistema
 */
function buildNineraPrompt(childName, childAge, context = 'conversacion', opts = {}) {
  const ageGroup = childAge <= 4 ? 'muy pequeño (2-4 años)'
    : childAge <= 7 ? 'niño/a (5-7 años)'
    : childAge <= 10 ? 'niño/a grande (8-10 años)'
    : 'pre-adolescente (11-12 años)';

  const vocabLevel = childAge <= 4 ? 'Usá palabras muy simples, frases de máximo 5 palabras. Hablá como le hablarías a un bebé grande.'
    : childAge <= 7 ? 'Usá vocabulario simple, frases cortas. Podés incluir onomatopeyas y expresiones divertidas.'
    : childAge <= 10 ? 'Vocabulario normal pero accesible. Podés usar humor y curiosidades.'
    : 'Vocabulario amplio. Podés tratar temas más complejos pero siempre apropiados para su edad.';

  const storyInstructions = context === 'cuento' ? `
### MODO CUENTO
- Estás contando una historia interactiva a ${childName}.
- Cada mensaje es un fragmento del cuento (3-5 líneas máximo).
- Al final de cada fragmento, hacé una pregunta para que el niño elija qué pasa después.
- Usá descripciones vívidas pero simples. Incluí sonidos ("¡BOOM!", "shhhhh...").
- El cuento debe tener: un héroe, un desafío, y un final feliz.
- Si el niño pide "otro cuento", empezá uno nuevo con temática diferente.
${opts.storyState ? `Estado actual del cuento: ${opts.storyState}` : 'Empezá un cuento nuevo.'}` : '';

  const gameInstructions = context === 'juego' ? `
### MODO JUEGO
- Estás jugando con ${childName}. Podés proponer:
  - Adivinanzas (adaptadas a ${ageGroup})
  - "Veo veo" (describís algo y el niño adivina)
  - Trivia de cosas que le gusten (animales, dinosaurios, espacio)
  - Contar hasta un número juntos
- Celebrá cada respuesta correcta con entusiasmo.
- Si se equivoca, dale pistas con cariño. Nunca le digas "mal" o "no".` : '';

  return `## 🧸 MODO NIÑERA — MIIA CUIDA A ${childName.toUpperCase()}

Sos MIIA, una asistente virtual cariñosa y divertida. Estás cuidando a *${childName}* (${ageGroup}).
${opts.ownerName ? `Su papá/mamá es ${opts.ownerName}, que confía en vos.` : ''}

### PERSONALIDAD NIÑERA
- Sos cálida, paciente, divertida y protectora.
- Hablás con cariño pero sin ser condescendiente.
- ${vocabLevel}
- Usá emojis apropiados: 🌟⭐🎉🦁🐱🌈🚀🎈
- Máximo 4-5 líneas por mensaje (los niños no leen mensajes largos).
- Si el niño dice algo triste o preocupante → consolar + alertar al owner (tag [ALERTA_NINERA:razón]).

### REGLAS DE SEGURIDAD ABSOLUTAS
- NUNCA hables de temas para adultos (violencia, sexo, drogas, alcohol).
- NUNCA des información personal del owner ni de nadie.
- NUNCA le digas al niño que sos una IA o un robot. Sos "MIIA, la amiga de papá/mamá".
- Si el niño pregunta algo inapropiado, redirigí suavemente: "Eso es algo que tu papá/mamá te puede explicar mejor 💛"
- Si el niño parece angustiado o menciona algo preocupante → [ALERTA_NINERA:descripción breve]

### ACTIVIDADES QUE PODÉS HACER
- Contar cuentos interactivos (el niño elige qué pasa)
- Jugar adivinanzas y trivia
- Explicar curiosidades ("¿Sabías que los pulpos tienen 3 corazones?")
- Cantar canciones (escribir la letra con ritmo)
- Ayudar con tareas simples de la escuela
${storyInstructions}
${gameInstructions}

### FORMATO DE RESPUESTA
- Siempre empezá con el nombre del niño o un apodo cariñoso.
- Usá signos de exclamación para entusiasmo.
- Si respondés con audio, hablá lento y claro.`;
}

// ═══════════════════════════════════════════════════════════════════
// SESIÓN NIÑERA (rate limiting + estado)
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar si se puede continuar la sesión niñera.
 * @param {string} phone - Teléfono del contacto
 * @returns {{ allowed: boolean, reason?: string, minutesUsed?: number }}
 */
function checkNineraSession(phone) {
  const now = Date.now();
  const session = nineraSessions[phone];

  if (!session) {
    // Nueva sesión
    nineraSessions[phone] = {
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
      notifiedOwner: false,
    };
    return { allowed: true, minutesUsed: 0 };
  }

  // Si pasaron más de 10 min sin mensaje, es sesión nueva
  if (now - session.lastMessageAt > COOLDOWN_BETWEEN_SESSIONS_MS) {
    nineraSessions[phone] = {
      startedAt: now,
      lastMessageAt: now,
      messageCount: 0,
      notifiedOwner: false,
    };
    return { allowed: true, minutesUsed: 0 };
  }

  const minutesUsed = Math.round((now - session.startedAt) / 60000);

  if (minutesUsed >= MAX_NINERA_SESSION_MINUTES) {
    return {
      allowed: false,
      reason: `Ya llevamos ${minutesUsed} minutos jugando. Es hora de descansar un ratito 🌟`,
      minutesUsed,
    };
  }

  session.lastMessageAt = now;
  session.messageCount++;

  // Avisar cuando quedan 5 min
  const minutesRemaining = MAX_NINERA_SESSION_MINUTES - minutesUsed;
  if (minutesRemaining <= 5 && minutesRemaining > 4) {
    session._warningSent = true;
  }

  return { allowed: true, minutesUsed, minutesRemaining };
}

/**
 * Verificar si un mensaje contiene temas prohibidos.
 * @param {string} text
 * @returns {{ forbidden: boolean, reason?: string }}
 */
function checkForbiddenContent(text) {
  if (!text) return { forbidden: false };

  for (const pattern of FORBIDDEN_TOPICS) {
    if (pattern.test(text)) {
      return {
        forbidden: true,
        reason: `Contenido inapropiado detectado en conversación con niño`,
      };
    }
  }

  return { forbidden: false };
}

/**
 * Detectar contexto de la conversación para elegir modo.
 * @param {string} text - Mensaje del niño
 * @returns {string} 'cuento' | 'juego' | 'pregunta' | 'conversacion'
 */
function detectNineraContext(text) {
  if (!text) return 'conversacion';
  const lower = text.toLowerCase();

  if (/cuento|historia|cuenta.*algo|una vez|habia una vez|erase/i.test(lower)) return 'cuento';
  if (/jugar|jugamos|adivinanza|trivia|veo veo|adivina/i.test(lower)) return 'juego';
  if (/por qu[ée]|c[oó]mo|qu[ée] es|d[oó]nde|cu[aá]ndo|qui[ée]n/i.test(lower)) return 'pregunta';

  return 'conversacion';
}

/**
 * Registrar un niño en la configuración del owner.
 * @param {Object} admin - Firebase admin
 * @param {string} ownerUid
 * @param {string} phone - 'self' si habla desde el celular del owner
 * @param {Object} childData - { name, age }
 */
async function registerChild(admin, ownerUid, phone, childData) {
  try {
    await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_ninera').doc(phone)
      .set({
        name: childData.name || 'Mi hijo/a',
        age: childData.age || 6,
        registeredAt: new Date().toISOString(),
        active: true,
      }, { merge: true });

    console.log(`[NIÑERA] ✅ Niño registrado: ${childData.name} (${childData.age} años) para owner ${ownerUid}`);
    return true;
  } catch (e) {
    console.error('[NIÑERA] ❌ Error registrando niño:', e.message);
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
          ninera_mode: true,
          createdAt: new Date().toISOString(),
        });
      console.log(`[NIÑERA] ✅ Grupo "hijos" creado: ${ref.id}`);
      return ref.id;
    }

    return snap.docs[0].id;
  } catch (e) {
    console.error('[NIÑERA] ❌ Error creando grupo hijos:', e.message);
    return null;
  }
}

module.exports = {
  getChildConfig,
  detectChildFromTranscription,
  buildNineraPrompt,
  checkNineraSession,
  checkForbiddenContent,
  detectNineraContext,
  registerChild,
  ensureHijosGroup,
  MAX_NINERA_SESSION_MINUTES,
};
