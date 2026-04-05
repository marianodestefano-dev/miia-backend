/**
 * MIIA Emoji Prefix System
 * Determina qué emoji usa MIIA antes de cada mensaje según contexto, fecha y contenido.
 *
 * Formato de salida: "🙍‍♀️: texto del mensaje"
 *
 * REGLA: El emoji se evalúa ANTES de enviar. Prioridad de arriba a abajo (primera coincidencia gana).
 */

const DEFAULT_EMOJI = '🙍‍♀️';

// Estado persistente por owner (en memoria, se resetea con restart)
const emojiState = {
  offendedUntil: null,   // Date ISO — si está ofendida, usar 🙎‍♀️ hasta esa fecha
  happyMessages: 0,      // Contador de mensajes "alegre" restantes
  lastStageUp: null,     // Última vez que subió de stage
  offenseCycleCount: 0,  // Ciclos insulto→disculpa en el día
  offenseCycleDate: '',  // Fecha del conteo (YYYY-MM-DD)
  sleepUntil: null,      // Date ISO — MIIA dormida, solo envía recordatorios sin emoji
};

/**
 * Determinar el emoji correcto para el mensaje de MIIA.
 * @param {string} message - El texto que MIIA va a enviar
 * @param {Object} ctx - Contexto del mensaje
 * @param {string} ctx.trigger - Qué disparó el mensaje: 'reminder', 'greeting', 'farewell', 'learning', 'teaching', 'support', 'sport', 'business', 'general', 'proactive'
 * @param {string} ctx.ownerMood - Detectado del mensaje del owner: 'angry', 'stressed', 'happy', 'sad', 'normal', 'praise', 'bully', 'flirt'
 * @param {string} ctx.ownerCountry - Código país: 'CO', 'AR', 'MX', etc.
 * @param {string} ctx.timezone - Timezone del owner
 * @param {string} ctx.topic - Tema detectado: 'music', 'food', 'cinema', 'work', 'personal', 'error', 'unknown'
 * @param {string} ctx.cinemaSub - Subgénero si topic='cinema': 'scifi', 'terror', 'thriller', 'suspense', 'action', 'romance'
 * @param {boolean} ctx.isRepairing - MIIA está en modo soporte/reparación
 * @param {boolean} ctx.dontKnow - MIIA no sabe la respuesta
 * @param {boolean} ctx.stageUp - MIIA acaba de subir de stage
 * @param {boolean} ctx.isLaw - Lo que dice es LEY (regla firme)
 * @returns {string} Emoji a usar como prefijo
 */
function getMiiaEmoji(message, ctx = {}) {
  const now = new Date();
  const tz = ctx.timezone || 'America/Bogota';
  let localNow;
  try {
    localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  } catch {
    localNow = now;
  }

  // SLEEP MODE: MIIA dormida → sin emoji (los recordatorios van sin prefijo)
  if (emojiState.sleepUntil) {
    if (now < new Date(emojiState.sleepUntil)) {
      return ''; // Sin emoji en modo sleep
    } else {
      emojiState.sleepUntil = null; // Expiró
      emojiState.offenseCycleCount = 0;
    }
  }

  const month = localNow.getMonth() + 1; // 1-12
  const day = localNow.getDate();
  const hour = localNow.getHours();

  // ═══ PRIORIDAD 1: Estados temporales persistentes ═══

  // Ofendida todo el día (bullying/insultos) — hasta que se disculpe o sea 00:01 del día siguiente
  if (emojiState.offendedUntil) {
    const offendedDate = new Date(emojiState.offendedUntil);
    if (now < offendedDate) {
      return '🙎‍♀️';
    } else {
      emojiState.offendedUntil = null; // Expiró
    }
  }

  // Stage up — solo en el mensaje inmediato
  if (ctx.stageUp) {
    emojiState.lastStageUp = now.toISOString();
    return '👸';
  }

  // Alegre/entusiasmada — varios mensajes con emojis aleatorios
  if (emojiState.happyMessages > 0) {
    emojiState.happyMessages--;
    const happyEmojis = ['🙆‍♀️', '🙅‍♀️', '👩‍🚀', '🧙‍♀️'];
    return happyEmojis[Math.floor(Math.random() * happyEmojis.length)];
  }

  // ═══ PRIORIDAD 2: Reacciones al owner (mood) ═══

  if (ctx.ownerMood === 'bully') {
    // offendedUntil ya seteado por detectOwnerMood()
    return '🙎‍♀️';
  }

  if (ctx.ownerMood === 'praise') {
    // Solo en el SIGUIENTE mensaje — activar happy mode
    emojiState.happyMessages = 0; // No multi, solo 1 mensaje
    return '🦸‍♀️';
  }

  if (ctx.ownerMood === 'happy' || ctx.ownerMood === 'excited') {
    emojiState.happyMessages = Math.floor(Math.random() * 4) + 3; // 3-6 mensajes
    const happyEmojis = ['🙆‍♀️', '🙅‍♀️', '👩‍🚀', '🧙‍♀️'];
    return happyEmojis[Math.floor(Math.random() * happyEmojis.length)];
  }

  if (ctx.ownerMood === 'flirt') return '👰‍♀️';
  if (ctx.ownerMood === 'angry') return '🤦‍♀️';
  if (ctx.ownerMood === 'stressed') return '💆‍♀️';
  if (ctx.ownerMood === 'sad') return '🙇‍♀️';

  // ═══ PRIORIDAD 3: Fechas especiales ═══

  // Halloween: semana previa + durante + mañana siguiente (Oct 25 - Nov 1 AM)
  if ((month === 10 && day >= 25) || (month === 11 && day === 1 && hour < 12)) {
    return '🧛‍♀️';
  }

  // Navidad: 24 dic todo el día + 25 dic mañana
  if ((month === 12 && day === 24) || (month === 12 && day === 25 && hour < 12)) {
    return '🎅';
  }

  // Día de la madre por país
  if (_isMothersDayForCountry(month, day, ctx.ownerCountry)) {
    return '🤱';
  }

  // ═══ PRIORIDAD 4: Contexto del mensaje ═══

  if (ctx.isLaw) return '👩‍⚖️';
  if (ctx.isRepairing) return '👩‍🔧';
  if (ctx.dontKnow) return '🤷‍♀️';

  // Triggers específicos
  if (ctx.trigger === 'reminder') return '💁‍♀️';
  if (ctx.trigger === 'greeting' || ctx.trigger === 'farewell') return '🙋‍♀️';
  if (ctx.trigger === 'learning') return '👩‍🎓';
  if (ctx.trigger === 'teaching') return '👩‍🏫';
  if (ctx.trigger === 'error') return '🤦‍♀️';

  // ═══ PRIORIDAD 5: Tema del mensaje ═══

  if (ctx.topic === 'music') return '👩‍🎤';
  if (ctx.topic === 'food') return '👩‍🍳';

  if (ctx.topic === 'cinema') {
    switch (ctx.cinemaSub) {
      case 'scifi': case 'superhero': return '🦹‍♀️';
      case 'terror': case 'horror': return '🧟‍♀️';
      case 'thriller': case 'police': return '👮‍♀️';
      case 'suspense': return '🕵️‍♀️';
      case 'action': return '🥷';
      case 'romance': return '🧖‍♀️';
      default: return '🦹‍♀️'; // default cine
    }
  }

  if (ctx.trigger === 'business' || ctx.topic === 'work') return '👩‍💼';
  if (ctx.trigger === 'general_work') return '👩‍💻';

  // ═══ DEFAULT ═══
  return DEFAULT_EMOJI;
}

/**
 * Aplicar emoji prefix a un mensaje de MIIA.
 * @param {string} message - Texto original
 * @param {Object} ctx - Contexto (ver getMiiaEmoji)
 * @returns {string} Mensaje con emoji prefix
 */
function applyMiiaEmoji(message, ctx = {}) {
  if (!message || typeof message !== 'string') return message;
  // No aplicar a mensajes que ya tienen emoji prefix
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(message.substring(0, 4))) {
    return message;
  }
  const emoji = getMiiaEmoji(message, ctx);
  if (!emoji) return message; // Sleep mode: sin prefijo
  return `${emoji}: ${message}`;
}

/**
 * Detectar mood del owner a partir de su mensaje.
 * @param {string} text - Mensaje del owner/contacto
 * @returns {string} Mood detectado
 */
function detectOwnerMood(text) {
  if (!text || typeof text !== 'string') return 'normal';
  const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Praise
  if (/\b(genia|genial|increible|crack|capo|grosa|espectacular|impresionante|super|sos (la )?mejor|te amo miia|sos una crack)\b/.test(lower)) return 'praise';

  // Bullying/insultos — setear offendedUntil inmediatamente para que el conteo funcione
  if (/\b(inutil|idiota|tonta|estupida|no sabes nada|sos una mierda|pelotuda|boluda|no servis|basura|porqueria|horrible|pesima)\b/.test(lower)) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 1, 0, 0);
    emojiState.offendedUntil = tomorrow.toISOString();
    return 'bully';
  }

  // Enojo (sin insulto directo)
  if (/\b(hiciste mal|error tuyo|la cagaste|te equivocaste|eso esta mal|por que hiciste eso|no era asi|arruinaste)\b/.test(lower)) return 'angry';

  // Flirt
  if (/\b(novia|casate conmigo|te quiero miia|mi novia|sali conmigo|enamorad[ao])\b/.test(lower)) return 'flirt';

  // Estrés
  if (/\b(estresad[ao]|agotad[ao]|no puedo mas|quemad[ao]|burn.?out|colapsad[ao]|exhausto|no doy mas)\b/.test(lower)) return 'stressed';

  // Triste
  if (/\b(triste|deprimid[ao]|mal dia|llorando|angustiad[ao]|decaid[ao])\b/.test(lower)) return 'sad';

  // Feliz/entusiasmado
  if (/\b(feliz|content[ao]|genial dia|increible dia|vamos|siii+|dale que|buenisim[ao])\b/.test(lower)) return 'happy';

  // Disculpa (resetea offended + cuenta ciclo)
  if (/\b(perdon|disculpa|lo siento|perdoname|fue mi culpa|me pase)\b/.test(lower)) {
    if (emojiState.offendedUntil) {
      // Contar ciclo insulto→disculpa
      const todayStr = new Date().toISOString().split('T')[0];
      if (emojiState.offenseCycleDate !== todayStr) {
        emojiState.offenseCycleDate = todayStr;
        emojiState.offenseCycleCount = 0;
      }
      emojiState.offenseCycleCount++;

      if (emojiState.offenseCycleCount >= 5) {
        // SLEEP MODE: MIIA se va a dormir hasta 00:01 del día siguiente
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 1, 0, 0);
        emojiState.sleepUntil = tomorrow.toISOString();
        emojiState.offendedUntil = null;
        return 'sleep'; // Señal especial para el handler
      }
    }
    emojiState.offendedUntil = null; // Reset offended
    return 'apologized'; // Señal para que MIIA agradezca
  }

  return 'normal';
}

/**
 * Detectar tema del mensaje de MIIA para emoji.
 * @param {string} message - Texto de MIIA
 * @param {Object} extraCtx - Contexto adicional del handler
 * @returns {{ topic: string, cinemaSub?: string }}
 */
function detectMessageTopic(message, extraCtx = {}) {
  if (!message || typeof message !== 'string') return { topic: 'general' };
  const lower = message.toLowerCase();

  if (/spotify|playlist|cancion|album|disco|musica|lanzamiento.*(single|ep)|artista/i.test(lower)) return { topic: 'music' };
  if (/receta|cocinar?|ingrediente|almuerzo|cena|comida|plato/i.test(lower)) return { topic: 'food' };

  if (/netflix|hbo|prime\s*video|amazon\s*prime|\bprime\b.*peli|\bserie\b|pelicula|estreno|temporada/i.test(lower)) {
    // Detectar subgénero
    if (/ciencia ficci[oó]n|sci.?fi|super.?hero|marvel|dc|avenger/i.test(lower)) return { topic: 'cinema', cinemaSub: 'scifi' };
    if (/terror|horror|miedo|zombie/i.test(lower)) return { topic: 'cinema', cinemaSub: 'terror' };
    if (/thriller|policial|detective|crimen/i.test(lower)) return { topic: 'cinema', cinemaSub: 'thriller' };
    if (/suspenso|misterio|intriga/i.test(lower)) return { topic: 'cinema', cinemaSub: 'suspense' };
    if (/acci[oó]n|explosion|persecuci/i.test(lower)) return { topic: 'cinema', cinemaSub: 'action' };
    if (/roman[tc]|amor|comedia rom/i.test(lower)) return { topic: 'cinema', cinemaSub: 'romance' };
    return { topic: 'cinema', cinemaSub: 'scifi' }; // default cine
  }

  return { topic: 'general' };
}

/**
 * Día de la madre por país.
 */
function _isMothersDayForCountry(month, day, country) {
  // Argentina: 3er domingo de octubre
  if (country === 'AR' && month === 10) {
    const year = new Date().getFullYear();
    const firstDay = new Date(year, 9, 1).getDay(); // 0=dom
    const thirdSunday = 1 + ((7 - firstDay) % 7) + 14;
    if (day === thirdSunday) return true;
  }
  // Colombia, Ecuador: 2do domingo de mayo
  if (['CO', 'EC'].includes(country) && month === 5) {
    const year = new Date().getFullYear();
    const firstDay = new Date(year, 4, 1).getDay();
    const secondSunday = 1 + ((7 - firstDay) % 7) + 7;
    if (day === secondSunday) return true;
  }
  // México, US: 2do domingo de mayo (mismo cálculo)
  if (['MX', 'US'].includes(country) && month === 5 && day === 10) return true; // México siempre 10 mayo
  // Chile: 2do domingo de mayo
  if (country === 'CL' && month === 5) {
    const year = new Date().getFullYear();
    const firstDay = new Date(year, 4, 1).getDay();
    const secondSunday = 1 + ((7 - firstDay) % 7) + 7;
    if (day === secondSunday) return true;
  }
  // Perú: 2do domingo de mayo
  if (country === 'PE' && month === 5) {
    const year = new Date().getFullYear();
    const firstDay = new Date(year, 4, 1).getDay();
    const secondSunday = 1 + ((7 - firstDay) % 7) + 7;
    if (day === secondSunday) return true;
  }
  // España: 1er domingo de mayo
  if (country === 'ES' && month === 5) {
    const year = new Date().getFullYear();
    const firstDay = new Date(year, 4, 1).getDay();
    const firstSunday = firstDay === 0 ? 1 : 1 + (7 - firstDay);
    if (day === firstSunday) return true;
  }
  return false;
}

/**
 * Resetear estado de ofendida (cuando owner se disculpa).
 */
function resetOffended() {
  emojiState.offendedUntil = null;
}

/**
 * Obtener el mood actual de MIIA para inyectar en el prompt.
 * @returns {string} 'normal' | 'offended' | 'happy'
 */
function getCurrentMiiaMood() {
  if (emojiState.sleepUntil && new Date() < new Date(emojiState.sleepUntil)) {
    return 'sleeping';
  }
  if (emojiState.offendedUntil && new Date() < new Date(emojiState.offendedUntil)) {
    return 'offended';
  }
  if (emojiState.happyMessages > 0) return 'happy';
  return 'normal';
}

/**
 * ¿MIIA está dormida? (modo sleep por exceso de ciclos insulto→disculpa)
 */
function isMiiaSleeping() {
  return emojiState.sleepUntil && new Date() < new Date(emojiState.sleepUntil);
}

/**
 * Obtener info del estado sleep para mensajes de recordatorio.
 */
function getSleepInfo() {
  return {
    sleeping: isMiiaSleeping(),
    sleepUntil: emojiState.sleepUntil,
    offenseCycles: emojiState.offenseCycleCount,
  };
}

module.exports = {
  getMiiaEmoji,
  applyMiiaEmoji,
  detectOwnerMood,
  detectMessageTopic,
  resetOffended,
  getCurrentMiiaMood,
  isMiiaSleeping,
  getSleepInfo,
  DEFAULT_EMOJI,
};
