/**
 * MIIA Emoji Prefix System v2.0
 * Rediseño completo — cada emoji tiene UN significado, no decoración random.
 *
 * Formato de salida: "👱‍♀️: texto del mensaje"
 *
 * SISTEMA BIG EMOJI: Emojis de cambio de estado se envían SOLOS (grandes en WhatsApp)
 * la primera vez en el día. Luego continúan como "emoji: texto".
 *
 * REGLA: El emoji se evalúa ANTES de enviar. Prioridad de arriba a abajo (primera coincidencia gana).
 */

const DEFAULT_EMOJI = '👱‍♀️';

// Estado persistente por owner (en memoria, se resetea con restart)
const emojiState = {
  offendedUntil: null,   // Date ISO — si está ofendida, usar 🙎‍♀️ hasta esa fecha
  happyMessages: 0,      // Contador de mensajes "alegre" restantes
  lastStageUp: null,     // Última vez que subió de stage
  offenseCycleCount: 0,  // Ciclos insulto→disculpa en el día
  offenseCycleDate: '',  // Fecha del conteo (YYYY-MM-DD)
  sleepUntil: null,      // Date ISO — MIIA dormida, solo envía recordatorios sin emoji
  postApologyCooldown: 0, // Msgs restantes de enfriamiento post-perdón. Flirt bloqueado hasta 0.
};

// ═══ BIG EMOJI SYSTEM ═══
// Tracking de emojis grandes ya usados hoy (1 big por emoji por día)
const bigEmojiUsedToday = {};

/**
 * Verificar si un emoji puede lanzarse como BIG (grande solo).
 * Retorna true si es la primera vez hoy para ese emoji.
 * Si retorna true, MARCA el emoji como usado hoy.
 */
function shouldBigEmoji(emoji) {
  if (!BIG_MOOD_EMOJIS.has(emoji)) return false;
  const todayStr = new Date().toISOString().split('T')[0];
  const key = emoji;
  if (bigEmojiUsedToday[key] === todayStr) return false; // Ya se usó hoy
  bigEmojiUsedToday[key] = todayStr;
  return true;
}

/**
 * TABLA DE EMOJIS DE MIIA — Referencia rápida
 *
 * 👱‍♀️  DEFAULT — conversación normal, sin contexto especial
 * 🙋‍♀️  Saluda o se despide (a quien sea)
 * 👩‍💻  Trabajo de secretaria: agenda, email, recordatorio, gestión de lead
 * 👩‍💼  Integración externa (clima, maps, delivery) o ideas/negocios
 * 💁‍♀️  Entrega algo: resultado, PDF, cotización, info pedida
 * 🙎‍♀️  Ofendida (insulto/bully) — BIG
 * 🙍‍♀️  Triste (owner triste, mala noticia) — BIG
 * 👰‍♀️  Le dicen que la quieren — BIG
 * 🙇‍♀️  La regañan (owner enojado con ella) — BIG
 * 🤦‍♀️  Ella reconoce equivocarse sola — BIG
 * 🙅‍♀️  Duda / momento / necesita aclaración — BIG
 * 👩‍🏫  Enseña algo al owner — BIG
 * 👩‍🎓  El owner le enseña y ella aprende — BIG
 * 👩‍🍳  Hablan de comida — BIG
 * 👸    Ropa, moda o dinero — BIG
 * 👩‍⚖️  Respuesta justa, regla firme — BIG
 * 👩‍🎤  Música — BIG
 * 👩‍⚕️  Owner enfermo — BIG
 * 🤵‍♀️  Algo especial (evento, fecha, celebración) — BIG
 * 🧛‍♀️  Halloween — BIG
 * 🎅    Navidad — BIG
 * 🤱    Día de la madre — BIG
 * 🦸‍♀️  Praise momentáneo (algo grandioso) — solo 1 mensaje, luego vuelve a lo que corresponda
 * 🤷‍♀️  No sabe la respuesta
 * 👩‍🔧  Reparando/soporte técnico — BIG
 * 🤹‍♀️  Multi-acción (ejecutando varias cosas a la vez)
 */

/**
 * Determinar el emoji correcto para el mensaje de MIIA.
 * @param {string} message - El texto que MIIA va a enviar
 * @param {Object} ctx - Contexto del mensaje
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

  // Decrementar cooldown post-perdón (cada mensaje acerca a MIIA a aceptar flirt de nuevo)
  if (emojiState.postApologyCooldown > 0) {
    emojiState.postApologyCooldown--;
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

  // ═══ PRIORIDAD 1.5: MIIA CENTER — emojis específicos por tipo de contacto ═══
  if (ctx.chatType === 'miia_client') return '👩‍🔧'; // Soporte técnico
  if (ctx.chatType === 'miia_lead') return '👩‍💻';   // Ventas MIIA

  // ═══ PRIORIDAD 2: Reacciones al owner (mood) ═══

  if (ctx.ownerMood === 'bully') {
    return '🙎‍♀️'; // offendedUntil ya seteado por detectOwnerMood()
  }

  if (ctx.ownerMood === 'praise') {
    return '🦸‍♀️'; // Momentáneo — solo ESTE mensaje, luego vuelve a lo que corresponda
  }

  if (ctx.ownerMood === 'flirt') return '👰‍♀️';
  if (ctx.ownerMood === 'angry') return '🙇‍♀️';   // La regañan → agacha la cabeza
  if (ctx.ownerMood === 'stressed') return '💆‍♀️';
  if (ctx.ownerMood === 'sad') return '🙍‍♀️';      // Triste (diferente de regaño)
  if (ctx.ownerMood === 'sick') return '👩‍⚕️';     // Owner enfermo

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

  // ═══ PRIORIDAD 4: Contexto funcional del mensaje ═══

  if (ctx.isLaw) return '👩‍⚖️';      // Respuesta justa / regla firme
  if (ctx.isRepairing) return '👩‍🔧';  // Reparando/soporte
  if (ctx.dontKnow) return '🤷‍♀️';    // C-342 B.7: "no sé" → shrug (antes 🙅‍♀️ daba sensación de rechazo)
  if (ctx.isMultiAction) return '🤹‍♀️'; // Multi-acción

  // ═══ PRIORIDAD 5: Triggers específicos ═══

  // Saludar o despedirse — levanta la mano
  if (ctx.trigger === 'greeting' || ctx.trigger === 'farewell') return '🙋‍♀️';

  // Entrega algo (resultado, PDF, cotización, info pedida)
  if (ctx.trigger === 'delivery' || ctx.trigger === 'reminder') return '💁‍♀️';

  // Enseña al owner algo
  if (ctx.trigger === 'teaching') return '👩‍🏫';

  // El owner le enseña
  if (ctx.trigger === 'learning') return '👩‍🎓';

  // Error propio — reconoce equivocarse
  if (ctx.trigger === 'error') return '🤦‍♀️';

  // Algo especial (evento, fecha, celebración)
  if (ctx.trigger === 'special' || ctx.trigger === 'sport') return '🤵‍♀️';

  // C-342 B.7: MIIA proactiva (briefing, alerta anticipada, follow-up) — mujer tecnóloga
  if (ctx.trigger === 'proactive') return '👩‍💻';

  // ═══ PRIORIDAD 6: Tema del mensaje — cada emoji = un significado ═══

  // Temas de PERSONA-EMOJI (MIIA adopta rol)
  if (ctx.topic === 'music') return '👩‍🎤';
  if (ctx.topic === 'food') return '👩‍🍳';
  if (ctx.topic === 'fashion' || ctx.topic === 'finance') return '👸'; // Ropa/moda o dinero

  // Trabajo de secretaria: agenda, mail, recordatorio, gestión
  if (ctx.topic === 'office') return '👩‍💻';

  // Integración externa: clima, maps, delivery, noticias, transporte, precios
  if (ctx.topic === 'price' || ctx.topic === 'travel' || ctx.topic === 'weather' ||
      ctx.topic === 'news' || ctx.topic === 'delivery' || ctx.topic === 'transport') return '👩‍💼';

  // Ideas/negocios
  if (ctx.topic === 'business') return '👩‍💼';

  // Salud/enfermo
  if (ctx.topic === 'health' || ctx.topic === 'gym') return '👩‍⚕️';

  // Cine — MIIA adopta el personaje del género
  if (ctx.topic === 'cinema') {
    switch (ctx.cinemaSub) {
      case 'scifi': case 'superhero': return '🦹‍♀️';
      case 'terror': case 'horror': return '🧟‍♀️';
      case 'thriller': case 'police': return '👮‍♀️';
      case 'suspense': return '🕵️‍♀️';
      case 'action': return '🥷';
      case 'romance': return '🧖‍♀️';
      default: return '🦹‍♀️';
    }
  }

  // ═══ PRIORIDAD 7: Temas con EMOJI-OBJETO ═══
  if (ctx.topic === 'study') return '📚';
  if (ctx.topic === 'gaming') return '🎮';
  if (ctx.topic === 'photo') return '📸';
  if (ctx.topic === 'art') return '🎨';
  if (ctx.topic === 'tech') return '⚙️';
  if (ctx.topic === 'pet') return '🐾';
  if (ctx.topic === 'baby') return '👶';
  if (ctx.topic === 'party') return '🎉';
  if (ctx.topic === 'love') return '👰‍♀️'; // Le dicen que la quieren
  if (ctx.topic === 'sleep') return '😴';
  if (ctx.topic === 'coffee') return '☕';
  if (ctx.topic === 'alcohol') return '🍷';

  // ═══ DEFAULT — MIIA normal, relajada ═══
  return DEFAULT_EMOJI;
}

/**
 * Aplicar emoji prefix a un mensaje de MIIA.
 * @param {string} message - Texto original
 * @param {Object} ctx - Contexto (ver getMiiaEmoji)
 * @returns {string} Mensaje con emoji prefix
 */
// Emojis oficiales de MIIA — solo estos cuentan como "ya tiene prefix"
const MIIA_OFFICIAL_EMOJIS = new Set([
  '👱‍♀️', '🙎‍♀️', '👸', '🙆‍♀️', '🙅‍♀️', '👩‍🚀', '🧙‍♀️',
  '🦸‍♀️', '👰‍♀️', '🤦‍♀️', '💆‍♀️', '🙇‍♀️', '🙍‍♀️', '🤹‍♀️',
  '🧛‍♀️', '🎅', '🤱',
  '👩‍⚖️', '👩‍🔧', '🤷‍♀️', '💁‍♀️', '🙋‍♀️', '👩‍🎓', '👩‍🏫',
  '🤵‍♀️', '👩‍💻', '👩‍💼', '👩‍⚕️',
  '👩‍🎤', '👩‍🍳', '🧘‍♀️', '🧳', '🌦️', '📰', '🛒', '🛵', '🚗',
  '📊', '📚', '🎮', '📸', '🎨', '⚙️', '🐾', '👶', '🎉', '💕',
  '😴', '☕', '🍷', '🦹‍♀️', '🧟‍♀️', '👮‍♀️', '🕵️‍♀️', '🥷', '🧖‍♀️',
]);

function applyMiiaEmoji(message, ctx = {}) {
  if (!message || typeof message !== 'string') return message;

  // REGLA ABSOLUTA: SIEMPRE quitar cualquier emoji al inicio que haya puesto la IA (Gemini/Claude)
  // y reemplazar con el emoji OFICIAL correcto según contexto.
  // La IA NO decide el emoji — el sistema lo decide.
  // FIX: Capturar MÚLTIPLES emojis al inicio (ZWJ sequences rotos → 👩💻 en vez de 👩‍💻)
  const emojiPrefixMatch = message.match(/^((?:[\p{Emoji_Presentation}\p{Extended_Pictographic}][\u{FE0F}\u{200D}\u{2640}\u{2642}♀♂]*\s*)+):?\s*/u);
  if (emojiPrefixMatch) {
    // SIEMPRE quitar TODOS los emojis que puso la IA — el sistema pone el correcto
    message = message.substring(emojiPrefixMatch[0].length);
  }

  // ═══ FIX: Quitar emojis oficiales de MIIA DENTRO del cuerpo del mensaje ═══
  // La IA (Gemini/Claude) a veces pone 🤦‍♀️ o 🙍‍♀️ dentro del texto del mensaje.
  // Los emojis de estado de MIIA son SOLO para el prefijo — NUNCA en el cuerpo.
  // Solo limpiar PERSONA-emojis oficiales de MIIA, NO emojis temáticos comunes (❤️, 😊, etc.)
  for (const officialEmoji of MIIA_OFFICIAL_EMOJIS) {
    // Solo quitar persona-emojis (ZWJ sequences con ♀️), no emojis simples/temáticos
    if (officialEmoji.includes('\u200D') || officialEmoji.includes('♀') || officialEmoji.includes('♂')) {
      if (message.includes(officialEmoji)) {
        message = message.split(officialEmoji).join('').replace(/\s{2,}/g, ' ').trim();
      }
    }
  }

  // ═══ C-401 v3: Strip single-only acotado por chatType (reemplaza C-037 strip total) ═══
  // - chatType ∈ ALLOW_TRIPLE_CHATTYPES (family/friend_*/ale_pareja): NO-OP,
  //   preservar texto tal cual. emoji_injector.js ya gateó triples legítimos
  //   para estas audiencias (firmado C-386 A.3 + ratificado C-398.E opción c).
  // - chatType profesional (leads/clients/medilink/miia_lead/owner_selfchat/
  //   follow_up_cold) o unknown: single-only. Reduce repeticiones a la última
  //   y conserva solo el último emoji distinto por posición.
  // BIG EMOJI system intacto: path separado vía bigEmojiUsedToday + guard ZWJ
  // ya aplicado arriba en MIIA_OFFICIAL_EMOJIS strip.
  // Firmas Mariano:
  //   2026-04-23 "Q2 SOLO BIG EMOJI... NO TRIPLE NI SEXTUBLE EMOJIS, ESO NO ME GUSTA"
  //   2026-04-24 noche "SI MIIA QUIERE USAR EMOJIS QUE USE UNO SOLO, NO DEBE
  //                     CONTAMINAR EL CHAT CON CIENTOS DE ELLOS"
  //   2026-04-24 HUECO #1 "ok" (single-only acotado por chatType)
  //   2026-04-24 HUECO #2 "BIG EMOJI ES UN SOLO EMOJI SUELTO QUE IDENTIFICA
  //                        EL INICIO DE UN ESTADO DE MIIA. QUEDA COMO LO
  //                        CREAMOS ASI CON VI"
  const ALLOW_TRIPLE_CHATTYPES = new Set([
    'family', 'friend_argentino', 'friend_colombiano', 'ale_pareja',
  ]);
  const _chatType = ctx.chatType || 'unknown';

  if (!ALLOW_TRIPLE_CHATTYPES.has(_chatType)) {
    // chatType profesional o unknown → aplicar single-only
    const CURATED_EMOJIS = [
      '😅', '😂', '🤣', '😆', // risas/vergüenza
      '🙈', '😬', '🫣',       // disculpa/timidez
      '😊', '🤗', '😉', '☺️', // cortesía exagerada
      '🎉', '✨', '💫', '🌟', // exclamación
      '💪', '👍', '✅', '👌', // afirmación
      '❤️', '💕', '💗',       // corazones excesivos
    ];

    // PASO 1 — reducir repeticiones del mismo emoji a 1 última
    for (const _emoji of CURATED_EMOJIS) {
      const occurrences = message.split(_emoji).length - 1;
      if (occurrences > 1) {
        const lastIdx = message.lastIndexOf(_emoji);
        const before = message.substring(0, lastIdx).split(_emoji).join('');
        const after = message.substring(lastIdx);
        message = before + after;
      }
    }

    // PASO 2 — si hay ≥2 emojis DISTINTOS presentes, conservar solo el
    // último por posición
    const presentEmojis = CURATED_EMOJIS
      .filter((e) => message.includes(e))
      .map((e) => ({ emoji: e, pos: message.lastIndexOf(e) }));
    if (presentEmojis.length > 1) {
      presentEmojis.sort((a, b) => b.pos - a.pos);
      for (let i = 1; i < presentEmojis.length; i++) {
        message = message.split(presentEmojis[i].emoji).join('');
      }
    }

    // PASO 3 — limpieza de espacios múltiples
    message = message.replace(/\s{2,}/g, ' ').trim();
  }
  // (si _chatType ∈ ALLOW_TRIPLE_CHATTYPES → no-op, preservar texto)

  // ═══ C-355 (BUG D): Auto-presentación broadcast → DEFAULT_EMOJI fijo, bypass detectMessageTopic ═══
  // Gemini en presentaciones poéticas usa frases tipo "el arte de acompañarte" → el regex \barte\b
  // de detectMessageTopic devolvía topic='art' → 🎨 spurious. Para broadcasts iniciales el emoji
  // correcto es la identidad base 👱‍♀️. Además limpia emojis-objeto sueltos que Gemini a veces
  // inserta en el cuerpo (🎨🎮📚📸⚙️) — sin ZWJ, así que el strip del cuerpo de arriba no los agarra.
  if (ctx.isAutoPresentation === true) {
    const OBJECT_EMOJIS_TO_STRIP = ['🎨', '🎮', '📚', '📸', '⚙️', '🎉', '💕', '☕', '🍷', '😴'];
    for (const objEmo of OBJECT_EMOJIS_TO_STRIP) {
      if (message.includes(objEmo)) {
        message = message.split(objEmo).join('').replace(/\s{2,}/g, ' ').trim();
      }
    }
    return `${DEFAULT_EMOJI}: ${message}`;
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

  // Praise — algo grandioso
  if (/\b(genia|genial|increible|crack|capo|grosa|espectacular|impresionante|super|sos (la )?mejor|te amo miia|sos una crack)\b/.test(lower)) return 'praise';

  // Bullying/insultos — setear offendedUntil inmediatamente para que el conteo funcione
  if (/\b(inutil|idiota|tonta|estupida|no sabes nada|sos una mierda|pelotuda|boluda|no servis|basura|porqueria|horrible|pesima)\b/.test(lower)) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 1, 0, 0);
    emojiState.offendedUntil = tomorrow.toISOString();
    return 'bully';
  }

  // Enojo/regaño (sin insulto directo) — la están retando
  if (/\b(hiciste mal|error tuyo|la cagaste|te equivocaste|eso esta mal|por que hiciste eso|no era asi|arruinaste)\b/.test(lower)) return 'angry';

  // Disculpa (resetea offended + cuenta ciclo)
  // ANTES de flirt: si MIIA está ofendida, "te quiero perdoname" es disculpa, no coqueteo.
  // El traje de novia viene de contexto limpio, no como escape de una pelea.
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
    emojiState.postApologyCooldown = 10; // 10 msgs de enfriamiento antes de aceptar flirt
    return 'apologized'; // Señal para que MIIA agradezca
  }

  // Flirt — solo en contexto limpio: no viene de una ofensa reciente
  // Si hay cooldown post-perdón activo, "te quiero" es cariño post-pelea, no coqueteo
  if (/\b(novia|casate conmigo|te quiero miia|mi novia|sali conmigo|enamorad[ao])\b/.test(lower)) {
    if (emojiState.postApologyCooldown > 0) return 'normal'; // Todavía enfriando — no flirt
    return 'flirt';
  }

  // Enfermo — owner dice que está mal de salud
  if (/\b(enferm[ao]|resfri[ao]|gripe|fiebre|me siento mal|me duele|dolor de|nauseas|vomit|medico|doctor|hospital|clinica|me enferm)\b/.test(lower)) return 'sick';

  // Estrés
  if (/\b(estresad[ao]|agotad[ao]|no puedo mas|quemad[ao]|burn.?out|colapsad[ao]|exhausto|no doy mas)\b/.test(lower)) return 'stressed';

  // Triste
  if (/\b(triste|deprimid[ao]|mal dia|llorando|angustiad[ao]|decaid[ao])\b/.test(lower)) return 'sad';

  // Feliz/entusiasmado
  if (/\b(feliz|content[ao]|genial dia|increible dia|vamos|siii+|dale que|buenisim[ao])\b/.test(lower)) return 'happy';

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

  // ─── INTEGRACIÓN EXTERNA (👩‍💼): precio, vuelo, clima, noticias, delivery, transporte ───
  if (/precio|oferta|descuento|\bpromo\b|stock|tienda|comprar|producto|mercado/i.test(lower)) return { topic: 'price' };
  if (/vuelo|avion|aeropuerto|pasaje|boarding|escala|reserva.*hotel/i.test(lower)) return { topic: 'travel' };
  if (/clima|lluvia|tormenta|\bsol\b|nublado|temperatura|calor|fr[ií]o|pron[oó]stico/i.test(lower)) return { topic: 'weather' };
  if (/noticia|titular|periódico|periodico|\bdiario\b|actualidad|prensa/i.test(lower)) return { topic: 'news' };
  if (/rappi|pedidosya|pedidos\s*ya|delivery|domicilio|pedir\s+comida/i.test(lower)) return { topic: 'delivery' };
  if (/uber|didi|taxi|cabify|transporte|viaje.*auto|llegada|conductor/i.test(lower)) return { topic: 'transport' };

  // ─── SECRETARIA (👩‍💻): agenda, mail, recordatorio, gestión ───
  if (/agenda|reuni[oó]n|\bcita\b|\bmail\b|correo|email|recordatorio|tarea|pendiente|deadline/i.test(lower)) return { topic: 'office' };

  // ─── ROPA/MODA/DINERO (👸) ───
  if (/ropa|vestido|zapato|camisa|pantalon|falda|moda|outfit|estilo|look|compras|shopping/i.test(lower)) return { topic: 'fashion' };
  if (/\bacci[oó]n\b|bolsa|cripto|bitcoin|inversi[oó]n|dolar|divisa|mercado.*valor|plata|dinero|presupuesto|gastos?|ahorro/i.test(lower)) return { topic: 'finance' };

  // ─── IDEAS/NEGOCIOS (👩‍💼) ───
  if (/negocio|emprendimiento|startup|empresa|sociedad|inversor|plan de negocio|modelo de negocio|idea.*negocio/i.test(lower)) return { topic: 'business' };

  // ─── Temas de vida ───
  if (/spotify|playlist|cancion|album|\bdisco\b|musica|lanzamiento.*(single|ep)|artista/i.test(lower)) return { topic: 'music' };
  if (/receta|cocinar?|ingrediente|almuerzo|\bcena\b|comida|\bplato\b/i.test(lower)) return { topic: 'food' };
  if (/ejercicio|entrena|gym|gimnasio|correr|running|yoga|cardio|dieta|nutri/i.test(lower)) return { topic: 'health' };
  if (/enferm|resfri|gripe|fiebre|dolor|medico|doctor|hospital|clinica|pastilla|remedio/i.test(lower)) return { topic: 'health' };
  if (/estudiar|examen|parcial|tarea.*escuela|universidad|materia|clase/i.test(lower)) return { topic: 'study' };
  if (/juego|gaming|ps[45]|xbox|nintendo|gamer|fortnite|minecraft/i.test(lower)) return { topic: 'gaming' };
  if (/foto|selfie|c[aá]mara|instagram|filtro/i.test(lower)) return { topic: 'photo' };
  if (/pintar|dibujar|\barte\b|museo|exposici/i.test(lower)) return { topic: 'art' };
  if (/programar|c[oó]digo|\bapp\b|software|\bbug\b|server|\bapi\b|base\s*de\s*datos/i.test(lower)) return { topic: 'tech' };
  if (/perro|gato|mascota|veterinari|cachorro|gatito/i.test(lower)) return { topic: 'pet' };
  if (/beb[eé]|embaraz|pañal|pediatr|nene|nena/i.test(lower)) return { topic: 'baby' };
  if (/fiesta|cumplea|celebra|brindis|evento.*social/i.test(lower)) return { topic: 'party' };
  if (/te amo|te quiero|novio|novia|pareja|aniversario|coraz[oó]n/i.test(lower)) return { topic: 'love' };
  if (/dormir|sue[ñn]o|insomnio|siesta|cansad[ao]|descansar/i.test(lower)) return { topic: 'sleep' };
  if (/caf[eé]|cappuccino|latte|espresso|cafeter[ií]a/i.test(lower)) return { topic: 'coffee' };
  if (/vino|cerveza|trago|cocktail|whisky|birra|alcohol|bar\b/i.test(lower)) return { topic: 'alcohol' };

  // ─── Cine/Series ───
  if (/netflix|hbo|prime\s*video|amazon\s*prime|\bprime\b.*peli|\bserie\b|pelicula|estreno|temporada/i.test(lower)) {
    if (/ciencia ficci[oó]n|sci.?fi|super.?hero|marvel|dc|avenger/i.test(lower)) return { topic: 'cinema', cinemaSub: 'scifi' };
    if (/terror|horror|miedo|zombie/i.test(lower)) return { topic: 'cinema', cinemaSub: 'terror' };
    if (/thriller|policial|detective|crimen/i.test(lower)) return { topic: 'cinema', cinemaSub: 'thriller' };
    if (/suspenso|misterio|intriga/i.test(lower)) return { topic: 'cinema', cinemaSub: 'suspense' };
    if (/\bacci[oó]n\b|explosion|persecuci/i.test(lower)) return { topic: 'cinema', cinemaSub: 'action' };
    if (/roman[tc]|amor|comedia rom/i.test(lower)) return { topic: 'cinema', cinemaSub: 'romance' };
    return { topic: 'cinema', cinemaSub: 'scifi' };
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
 * @returns {string} 'normal' | 'offended' | 'happy' | 'sleeping'
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

// Emojis que se envían SOLOS como mensaje grande la primera vez en el día.
// Cada emoji tiene su propio flag diario — pueden activarse varios en un día.
const BIG_MOOD_EMOJIS = new Set([
  '🙎‍♀️',  // Ofendida
  '🙍‍♀️',  // Triste
  '👰‍♀️',  // Le dicen que la quieren
  '🙇‍♀️',  // La regañan
  '🤦‍♀️',  // Reconoce error propio
  '🙅‍♀️',  // Duda / momento
  '👩‍🏫',  // Enseñando
  '👩‍🎓',  // Aprendiendo
  '👩‍🍳',  // Comida
  '👸',    // Ropa/dinero
  '👩‍⚖️',  // Justicia/ley
  '👩‍🎤',  // Música
  '👩‍⚕️',  // Owner enfermo
  '🤵‍♀️',  // Algo especial
  '🧛‍♀️',  // Halloween
  '🎅',    // Navidad
  '🤱',    // Día de la madre
  '👩‍🔧',  // Reparando/soporte
]);

module.exports = {
  getMiiaEmoji,
  applyMiiaEmoji,
  detectOwnerMood,
  detectMessageTopic,
  resetOffended,
  getCurrentMiiaMood,
  isMiiaSleeping,
  getSleepInfo,
  shouldBigEmoji,
  DEFAULT_EMOJI,
  MIIA_OFFICIAL_EMOJIS,
  BIG_MOOD_EMOJIS,
};
