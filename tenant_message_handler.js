/**
 * TENANT_MESSAGE_HANDLER.JS — Orquestador de mensajes para owners y agents
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, exhaustive logging, zero silent failures)
 *
 * Este módulo reemplaza processTenantMessage() en tenant_manager.js para dar a cada
 * owner y agent la experiencia COMPLETA de MIIA: self-chat, familia, equipo, leads,
 * tags de aprendizaje, cotizaciones, agenda, etc.
 *
 * ARQUITECTURA DE CONOCIMIENTO (4 capas):
 *   1. ADN — Estilo personal de comunicación (por persona, viaja con el usuario)
 *   2. VIDA PERSONAL — Datos privados: familia, agenda, deportes (por persona, 100% privado)
 *   3. CEREBRO — Conocimiento de negocio compartido owner+agents (por owner)
 *   4. CEREBRO MAESTRO — Fusión en runtime: ADN + CEREBRO + contexto conversación
 *
 * SEGURIDAD: Cada tenant está completamente aislado.
 *   - Propio socket de WhatsApp
 *   - Propias rutas en Firestore
 *   - NUNCA ve datos de admin (Mariano) ni de otros tenants
 *
 * DEPENDENCIAS:
 *   - message_logic.js (funciones puras)
 *   - prompt_builder.js (construcción de prompts parametrizados)
 *   - ai_client.js (llamadas multi-provider)
 *   - Firebase Admin (Firestore)
 */

const admin = require('firebase-admin');
const {
  normalizeText, maybeAddTypo, isPotentialBot,
  isWithinScheduleConfig, getCountryContext, getCountryFromPhone,
  detectNegativeSentiment, isOptOut,
  processLearningTags, processAgendaTag, processSubscriptionTag,
  cleanResidualTags, splitMessage,
  getBasePhone, toJid, delay,
  MIIA_CIERRE, MSG_SUSCRIPCION
} = require('./message_logic');

const {
  buildOwnerSelfChatPrompt, buildOwnerFamilyPrompt,
  buildOwnerLeadPrompt, buildEquipoPrompt,
  buildADN, buildVademecum, resolveProfile, DEFAULT_OWNER_PROFILE
} = require('./prompt_builder');

const { callAI } = require('./ai_client');

// ═══════════════════════════════════════════════════════════════
// ESTADO POR TENANT (aislado en memoria)
// ═══════════════════════════════════════════════════════════════

/**
 * @type {Map<string, TenantContext>}
 * Cada tenant tiene su propio contexto en memoria. Se crea en getOrCreateContext().
 * REGLA NASA: Si el Map no tiene el uid, se crea — NUNCA retorna undefined.
 */
const tenantContexts = new Map();

// ═══════════════════════════════════════════════════════════════
// FIRESTORE HELPERS — Cada función loguea TODO (éxito y error)
// ═══════════════════════════════════════════════════════════════

// Lazy init — admin.firestore() no está disponible hasta que server.js llame initializeApp()
let _db;
function db() { if (!_db) _db = admin.firestore(); return _db; }

/**
 * Carga el perfil del owner desde Firestore.
 * Si no existe, retorna defaults y loguea WARNING (no falla silenciosamente).
 * @param {string} ownerUid
 * @returns {Promise<Object>} ownerProfile compatible con prompt_builder
 */
async function loadOwnerProfile(ownerUid) {
  try {
    const doc = await db().collection('users').doc(ownerUid).get();
    if (!doc.exists) {
      console.warn(`[TMH:${ownerUid}] ⚠️ Owner no encontrado en Firestore — usando defaults`);
      return { ...DEFAULT_OWNER_PROFILE };
    }
    const data = doc.data();
    const profile = {
      fullName: data.name || data.displayName || 'Owner',
      shortName: (data.name || data.displayName || 'Owner').split(' ')[0],
      businessName: data.businessName || data.companyName || 'Mi Negocio',
      role: data.businessRole || 'Director/a',
      country: data.country || 'Colombia',
      demoLink: data.demoLink || '',
      hasCustomPricing: false, // Solo admin (Mariano) tiene pricing custom
      aiProvider: data.aiProvider || 'gemini',
      aiApiKey: data.aiApiKey || data.geminiApiKey || process.env.GEMINI_API_KEY,
    };
    console.log(`[TMH:${ownerUid}] ✅ Perfil cargado: ${profile.fullName} (${profile.businessName})`);
    return profile;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando perfil de Firestore:`, e.message);
    return { ...DEFAULT_OWNER_PROFILE };
  }
}

/**
 * Carga el cerebro de negocio compartido (owner+agents leen el mismo).
 * Ruta: users/{ownerUid}/brain/business_cerebro
 */
async function loadBusinessCerebro(ownerUid) {
  try {
    const doc = await db().collection('users').doc(ownerUid).collection('brain').doc('business_cerebro').get();
    const content = doc.exists ? (doc.data().content || '') : '';
    console.log(`[TMH:${ownerUid}] 🧠 Business cerebro: ${content.length} chars`);
    return content;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando business_cerebro:`, e.message);
    return '';
  }
}

/**
 * Carga datos personales privados. SOLO el propio uid puede leerlos.
 * Ruta: users/{uid}/personal/personal_brain
 */
async function loadPersonalBrain(uid) {
  try {
    const doc = await db().collection('users').doc(uid).collection('personal').doc('personal_brain').get();
    const content = doc.exists ? (doc.data().content || '') : '';
    console.log(`[TMH:${uid}] 🔒 Personal brain: ${content.length} chars`);
    return content;
  } catch (e) {
    console.error(`[TMH:${uid}] ❌ Error cargando personal_brain:`, e.message);
    return '';
  }
}

/**
 * Carga contactos de familia del owner (solo owner los ve, agents NO).
 * Ruta: users/{ownerUid}/familyContacts/
 */
async function loadFamilyContacts(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid).collection('familyContacts').get();
    const contacts = {};
    snap.forEach(doc => { contacts[doc.id] = doc.data(); });
    console.log(`[TMH:${ownerUid}] 👨‍👩‍👧 Family contacts: ${Object.keys(contacts).length}`);
    return contacts;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando family contacts:`, e.message);
    return {};
  }
}

/**
 * Carga contactos de equipo del owner (solo owner los ve, agents NO).
 * Ruta: users/{ownerUid}/teamContacts/
 */
async function loadTeamContacts(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid).collection('teamContacts').get();
    const contacts = {};
    snap.forEach(doc => { contacts[doc.id] = doc.data(); });
    console.log(`[TMH:${ownerUid}] 👥 Team contacts: ${Object.keys(contacts).length}`);
    return contacts;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando team contacts:`, e.message);
    return {};
  }
}

/**
 * Carga schedule config del owner.
 * Ruta: users/{ownerUid}/settings/schedule
 */
async function loadScheduleConfig(ownerUid) {
  try {
    const doc = await db().collection('users').doc(ownerUid).collection('settings').doc('schedule').get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando schedule:`, e.message);
    return null;
  }
}

/**
 * Guarda aprendizaje de negocio (business_cerebro).
 * Agents y owners escriben al MISMO cerebro del owner.
 */
async function saveBusinessLearning(ownerUid, text, source) {
  const ref = db().collection('users').doc(ownerUid).collection('brain').doc('business_cerebro');
  try {
    const doc = await ref.get();
    const current = doc.exists ? (doc.data().content || '') : '';
    const updated = current + `\n[${new Date().toISOString()} | ${source}]: ${text}`;
    await ref.set({ content: updated, updatedAt: new Date().toISOString() }, { merge: true });
    console.log(`[TMH:${ownerUid}] ✅ Business learning guardado (${text.length} chars)`);
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error guardando business learning:`, e.message);
    throw e; // Re-throw: caller debe saber que falló (NASA: fail loudly)
  }
}

/**
 * Guarda aprendizaje personal (personal_brain).
 * Cada persona escribe SOLO en su propio brain.
 */
async function savePersonalLearning(uid, text, source) {
  const ref = db().collection('users').doc(uid).collection('personal').doc('personal_brain');
  try {
    const doc = await ref.get();
    const current = doc.exists ? (doc.data().content || '') : '';
    const updated = current + `\n[${new Date().toISOString()} | ${source}]: ${text}`;
    await ref.set({ content: updated, updatedAt: new Date().toISOString() }, { merge: true });
    console.log(`[TMH:${uid}] ✅ Personal learning guardado (${text.length} chars)`);
  } catch (e) {
    console.error(`[TMH:${uid}] ❌ Error guardando personal learning:`, e.message);
    throw e;
  }
}

/**
 * Encola aprendizaje dudoso para aprobación del owner en self-chat.
 * Ruta: users/{ownerUid}/pending_learnings/
 */
async function queueDubiousLearning(ownerUid, sourceUid, text) {
  try {
    await db().collection('users').doc(ownerUid).collection('pending_learnings').add({
      text,
      sourceUid,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    console.log(`[TMH:${ownerUid}] ❓ Dubious learning encolado (fuente: ${sourceUid})`);
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error encolando dubious learning:`, e.message);
    throw e;
  }
}

/**
 * Guarda evento en agenda del owner.
 * Ruta: users/{ownerUid}/miia_agenda/
 */
async function saveAgendaEvent(ownerUid, eventData) {
  try {
    await db().collection('users').doc(ownerUid).collection('miia_agenda').add(eventData);
    console.log(`[TMH:${ownerUid}] 📅 Evento guardado: ${eventData.reason}`);
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error guardando evento:`, e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// CONTEXTO DEL TENANT — Inicialización y cache con TTL
// ═══════════════════════════════════════════════════════════════

const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Obtiene o crea el contexto del tenant.
 * Carga perfil de Firestore si es la primera vez o si expiró el cache.
 * REGLA NASA: SIEMPRE retorna un contexto válido. Si Firestore falla, usa defaults.
 */
async function getOrCreateContext(uid, ownerUid, role) {
  let ctx = tenantContexts.get(uid);
  const now = Date.now();

  // Si existe y cache vigente, retornar
  if (ctx && (now - ctx.lastProfileLoad) < PROFILE_CACHE_TTL) {
    return ctx;
  }

  console.log(`[TMH:${uid}] 🔄 ${ctx ? 'Refrescando' : 'Inicializando'} contexto (role=${role}, ownerUid=${ownerUid})...`);

  // Cargar todo en paralelo para eficiencia
  const [ownerProfile, businessCerebro, personalBrain, familyContacts, teamContacts, scheduleConfig] = await Promise.all([
    loadOwnerProfile(ownerUid),
    loadBusinessCerebro(ownerUid),
    loadPersonalBrain(uid),
    // Familia y equipo: solo para owners (agents NO ven familia ajena)
    role === 'owner' ? loadFamilyContacts(ownerUid) : Promise.resolve({}),
    role === 'owner' ? loadTeamContacts(ownerUid) : Promise.resolve({}),
    loadScheduleConfig(ownerUid)
  ]);

  if (!ctx) {
    // Primera vez: crear contexto completo
    ctx = {
      uid,
      ownerUid,
      role,
      ownerProfile,
      conversations: {},
      leadNames: {},
      contactTypes: {},
      familyContacts,
      teamContacts,
      conversationMetadata: {},
      businessCerebro,
      personalBrain,
      subscriptionState: {},
      scheduleConfig,
      lastProfileLoad: now
    };
    tenantContexts.set(uid, ctx);
  } else {
    // Refrescar datos de Firestore pero mantener estado en memoria (conversations, etc.)
    ctx.ownerProfile = ownerProfile;
    ctx.businessCerebro = businessCerebro;
    ctx.personalBrain = personalBrain;
    ctx.familyContacts = familyContacts;
    ctx.teamContacts = teamContacts;
    ctx.scheduleConfig = scheduleConfig;
    ctx.lastProfileLoad = now;
  }

  console.log(`[TMH:${uid}] ✅ Contexto listo — cerebro=${businessCerebro.length}ch, personal=${personalBrain.length}ch, familia=${Object.keys(familyContacts).length}, equipo=${Object.keys(teamContacts).length}`);
  return ctx;
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL — Procesa UN mensaje para UN tenant
// ═══════════════════════════════════════════════════════════════

/**
 * Procesa un mensaje entrante para un tenant (owner o agent).
 * Replica TODA la lógica de processMiiaResponse de server.js pero parametrizada.
 *
 * FLUJO:
 *   1. Obtener/crear contexto → 2. Verificar horario → 3. Filtrar bots →
 *   4. Detectar opt-out → 5. Guardar mensaje → 6. Clasificar contacto →
 *   7. Detectar negatividad → 8. Construir prompt → 9. Llamar IA →
 *   10. Procesar tags → 11. Enviar respuesta → 12. Guardar en historial
 *
 * @param {string} uid - UID del usuario
 * @param {string} ownerUid - UID del owner (= uid si es owner, distinto si es agent)
 * @param {string} role - 'owner' | 'agent'
 * @param {string} phone - JID del remitente (xxx@s.whatsapp.net o xxx@lid)
 * @param {string} messageBody - Texto del mensaje
 * @param {boolean} isSelfChat - Si es self-chat (fromMe=true y chat consigo mismo)
 * @param {boolean} isFromMe - Si el mensaje fue enviado por el propio tenant
 * @param {Object} tenantState - Referencia al tenant en tenant_manager (para sock, io, isReady)
 */
async function handleTenantMessage(uid, ownerUid, role, phone, messageBody, isSelfChat, isFromMe, tenantState) {
  const logPrefix = `[TMH:${uid}]`;

  // ── PASO 1: Obtener contexto ──
  let ctx;
  try {
    ctx = await getOrCreateContext(uid, ownerUid, role);
  } catch (e) {
    console.error(`${logPrefix} ❌ FATAL: No se pudo obtener contexto — mensaje PERDIDO:`, e.message);
    return;
  }

  const basePhone = getBasePhone(phone);

  // ── PASO 2: Verificar horario (no aplica a self-chat) ──
  if (!isSelfChat && !isWithinScheduleConfig(ctx.scheduleConfig)) {
    console.log(`${logPrefix} ⏸️ Fuera de horario. Mensaje de ${basePhone} ignorado.`);
    return;
  }

  // ── PASO 3: Filtrar bots ──
  if (isPotentialBot(messageBody)) {
    console.log(`${logPrefix} 🤖 Bot detectado en mensaje de ${basePhone}. Ignorando.`);
    return;
  }

  // ── PASO 4: Detectar opt-out (solo mensajes entrantes de terceros) ──
  if (!isFromMe && isOptOut(messageBody)) {
    console.log(`${logPrefix} 🚫 Opt-out detectado de ${basePhone}. No se responderá.`);
    // TODO: Marcar en Firestore como opted-out para no enviar follow-ups
    return;
  }

  // ── PASO 5: Guardar mensaje entrante ──
  if (!ctx.conversations[phone]) ctx.conversations[phone] = [];
  ctx.conversations[phone].push({
    role: isSelfChat ? 'user' : (isFromMe ? 'assistant' : 'user'),
    content: messageBody,
    timestamp: Date.now()
  });
  if (ctx.conversations[phone].length > 40) {
    ctx.conversations[phone] = ctx.conversations[phone].slice(-40);
  }

  // ── PASO 6: Si es isFromMe pero NO self-chat → solo registrar, no responder ──
  if (isFromMe && !isSelfChat) {
    console.log(`${logPrefix} 📝 Mensaje propio a ${basePhone} registrado (sin respuesta IA).`);
    return;
  }

  // ── PASO 7: Clasificar contacto ──
  const isFamilyContact = ctx.familyContacts[basePhone] || false;
  const isTeamMember = ctx.teamContacts[basePhone] || false;

  let contactType = ctx.contactTypes[phone];
  if (!contactType) {
    if (isSelfChat) {
      contactType = 'owner';
    } else if (isFamilyContact) {
      contactType = 'familia';
      ctx.leadNames[phone] = isFamilyContact.name || ctx.leadNames[phone] || basePhone;
    } else if (isTeamMember) {
      contactType = 'equipo';
      ctx.leadNames[phone] = isTeamMember.name || ctx.leadNames[phone] || basePhone;
    } else {
      contactType = 'lead';
    }
    ctx.contactTypes[phone] = contactType;
  }

  // ── PASO 8: Detectar negatividad (solo leads, no familia/equipo/self-chat) ──
  if (contactType === 'lead' && !isSelfChat) {
    const sentiment = detectNegativeSentiment(messageBody);
    if (sentiment.type) {
      console.log(`${logPrefix} 😡 ${sentiment.type} detectado de ${basePhone}`);
      ctx.conversations[phone].push({ role: 'assistant', content: sentiment.response, timestamp: Date.now() });

      await sendTenantMessage(tenantState, phone, sentiment.response);

      // Alertar al owner en self-chat
      const ownerJid = tenantState.sock?.user?.id;
      if (ownerJid) {
        const alertType = sentiment.type === 'insulto' ? '⚠️ INSULTO' : '🔔 QUEJA';
        const contactName = ctx.leadNames[phone] || basePhone;
        const alertMsg = `${alertType} recibido de *${contactName}* (+${basePhone})\n\n📩 "${messageBody.substring(0, 300)}"\n\nMIIA respondió con empatía. Considerá contactarlo manualmente.`;
        try {
          await sendTenantMessage(tenantState, ownerJid, alertMsg);
          console.log(`${logPrefix} 📢 Alerta de ${sentiment.type} enviada al owner`);
        } catch (e) {
          console.error(`${logPrefix} ❌ Error enviando alerta de ${sentiment.type} al owner:`, e.message);
        }
      }
      return;
    }
  }

  // ── PASO 9: Construir prompt completo ──
  const profile = resolveProfile(ctx.ownerProfile);
  let activeSystemPrompt = '';
  const countryContext = (contactType === 'lead') ? getCountryContext(basePhone) : '';

  if (isSelfChat) {
    activeSystemPrompt = buildOwnerSelfChatPrompt(ctx.ownerProfile);
  } else if (isFamilyContact) {
    activeSystemPrompt = buildOwnerFamilyPrompt(isFamilyContact.name, isFamilyContact, ctx.ownerProfile);
  } else if (isTeamMember) {
    activeSystemPrompt = buildEquipoPrompt(isTeamMember.name || ctx.leadNames[phone], ctx.ownerProfile);
  } else {
    activeSystemPrompt = buildOwnerLeadPrompt(ctx.leadNames[phone] || '', ctx.businessCerebro, countryContext, ctx.ownerProfile);
  }

  // Sistema de confianza progresiva (solo para leads)
  if (!ctx.conversationMetadata[phone]) ctx.conversationMetadata[phone] = { trustPoints: 0 };
  ctx.conversationMetadata[phone].trustPoints = (ctx.conversationMetadata[phone].trustPoints || 0) + 1;
  let trustTone = '';
  if (contactType === 'lead') {
    const tp = ctx.conversationMetadata[phone].trustPoints;
    trustTone = tp < 5
      ? '\n[CONFIANZA INICIAL]: Sé profesional, amable pero no demasiado familiar aún.'
      : '\n[CONFIANZA ESTABLECIDA]: Puedes ser más cercana y cálida.';
  }

  // Memoria sintética del lead
  const leadSummary = ctx.conversationMetadata[phone]?.summary || '';
  const syntheticMemoryStr = leadSummary ? `\n\n🧠[MEMORIA ACUMULADA DE ESTA PERSONA]:\n${leadSummary}` : '';

  // Identidad del owner
  const masterIdentityStr = profile.shortName
    ? `\n\n[IDENTIDAD DEL MAESTRO]: Tu usuario principal es ${profile.fullName}. Bríndale trato preferencial absoluto.`
    : '';

  // Fecha del sistema
  const systemDateStr = `[FECHA DEL SISTEMA: ${new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}]`;

  // Cerebro de negocio + datos personales privados
  const cerebroStr = ctx.businessCerebro || '';
  const personalStr = (role === 'owner' && ctx.personalBrain) ? `\n\n[DATOS PERSONALES PRIVADOS — SOLO TÚ VES ESTO]:\n${ctx.personalBrain}` : '';

  // Pendientes de aprendizaje dudoso (solo en self-chat del owner)
  let pendingStr = '';
  if (isSelfChat && role === 'owner') {
    try {
      const pendingSnap = await db().collection('users').doc(ownerUid).collection('pending_learnings')
        .where('status', '==', 'pending').limit(5).get();
      if (!pendingSnap.empty) {
        const items = [];
        pendingSnap.forEach(doc => items.push({ id: doc.id, ...doc.data() }));
        pendingStr = `\n\n📋 [APRENDIZAJES PENDIENTES DE TU APROBACIÓN]:
${items.map((it, i) => `${i + 1}. "${it.text}" (fuente: ${it.sourceUid === uid ? 'tú' : 'agente'})`).join('\n')}
Respondé "sí" para guardar todos, "no" para descartar, o indicá cuáles sí/no.`;
        console.log(`${logPrefix} 📋 ${items.length} aprendizajes pendientes inyectados en prompt`);
      }
    } catch (e) {
      console.error(`${logPrefix} ❌ Error leyendo pending_learnings:`, e.message);
      // No falla silenciosamente: el log queda, pero el prompt sigue sin pendientes
    }
  }

  // Historial de conversación reciente (últimos 20 mensajes)
  const history = (ctx.conversations[phone] || []).slice(-20).map(m =>
    `${m.role === 'user' ? 'Cliente' : 'MIIA'}: ${m.content}`
  ).join('\n');

  // Ensamblado final del prompt
  const fullPrompt = `${activeSystemPrompt}

${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${personalStr}${cerebroStr ? '\n\n[ADN VENTAS — CONOCIMIENTO DE NEGOCIO]:\n' + cerebroStr : ''}${pendingStr}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

  // ── PASO 10: Llamar a la IA ──
  const aiProvider = ctx.ownerProfile.aiProvider || 'gemini';
  const aiApiKey = ctx.ownerProfile.aiApiKey || process.env.GEMINI_API_KEY;

  if (!aiApiKey || aiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    console.error(`${logPrefix} ❌ NO HAY API KEY configurada para uid=${uid}. Mensaje de ${basePhone} sin respuesta.`);
    return;
  }

  console.log(`${logPrefix} 🤖 Llamando a ${aiProvider} para ${basePhone} (selfChat=${isSelfChat}, type=${contactType}, promptLen=${fullPrompt.length})...`);

  let aiMessage;
  try {
    aiMessage = await callAI(aiProvider, aiApiKey, fullPrompt);
  } catch (e) {
    console.error(`${logPrefix} ❌ Error llamando a ${aiProvider} para ${basePhone}:`, e.message);
    return;
  }

  if (!aiMessage || !aiMessage.trim()) {
    console.warn(`${logPrefix} ⚠️ Respuesta VACÍA de ${aiProvider} para ${basePhone}. No se envía nada.`);
    return;
  }

  console.log(`${logPrefix} ✅ Respuesta ${aiProvider} recibida (${aiMessage.length} chars) para ${basePhone}`);

  // ── PASO 11: Procesar tags de IA ──

  // 11a. Tags de aprendizaje (NEGOCIO, PERSONAL, DUDOSO, legacy GUARDAR_APRENDIZAJE)
  const tagCtx = { uid, ownerUid, role, isOwner: role === 'owner' };
  const tagCallbacks = {
    saveBusinessLearning,
    savePersonalLearning,
    queueDubiousLearning
  };

  const { cleanMessage, pendingQuestions } = await processLearningTags(aiMessage, tagCtx, tagCallbacks);
  aiMessage = cleanMessage;

  // 11b. Tag de agenda
  aiMessage = await processAgendaTag(aiMessage, tagCtx, saveAgendaEvent, ctx.leadNames);

  // 11c. Tag de suscripción
  aiMessage = processSubscriptionTag(aiMessage, phone, ctx.subscriptionState);

  // 11d. Limpiar tags residuales (correo maestro, cotización sin procesar, etc.)
  aiMessage = cleanResidualTags(aiMessage);

  // 11e. Falso positivo → silenciar lead
  if (aiMessage.includes('[FALSO_POSITIVO]')) {
    aiMessage = aiMessage.replace(/\[FALSO_POSITIVO\]/g, '').trim();
    console.log(`${logPrefix} 🔇 Falso positivo detectado para ${phone}. Conversación borrada.`);
    delete ctx.conversations[phone];
    return;
  }
  aiMessage = aiMessage.replace(/\[ALERTA_HUMANO\]/g, '').trim();

  // 11f. Agregar MIIA_CIERRE para leads (no self-chat, no familia, no equipo)
  if (contactType === 'lead' && !isSelfChat) {
    aiMessage = aiMessage.trimEnd() + MIIA_CIERRE;
  }

  // ── PASO 12: Enviar respuesta ──
  if (!aiMessage.trim()) {
    console.warn(`${logPrefix} ⚠️ Mensaje final vacío después de procesar tags. No se envía.`);
    return;
  }

  // MSG_SPLIT: dividir en 2 mensajes humanos
  const parts = splitMessage(aiMessage);
  if (parts && parts.length >= 2) {
    console.log(`${logPrefix} ✂️ Mensaje dividido en ${parts.length} partes`);
    await sendTenantMessage(tenantState, phone, maybeAddTypo(parts[0]));
    await delay(1500 + Math.floor(Math.random() * 1000));
    await sendTenantMessage(tenantState, phone, maybeAddTypo(parts[1]));
  } else {
    await sendTenantMessage(tenantState, phone, maybeAddTypo(aiMessage));
  }

  // ── PASO 13: Guardar respuesta en historial ──
  ctx.conversations[phone].push({
    role: 'assistant',
    content: aiMessage,
    timestamp: Date.now()
  });
  if (ctx.conversations[phone].length > 40) {
    ctx.conversations[phone] = ctx.conversations[phone].slice(-40);
  }

  // ── PASO 14: Emitir evento a frontend via Socket.IO ──
  if (tenantState.io) {
    tenantState.io.to(`tenant:${uid}`).emit('ai_response', {
      phone,
      message: aiMessage,
      timestamp: Date.now(),
      contactType
    });
  }

  console.log(`${logPrefix} ✅ Respuesta enviada a ${basePhone} (${contactType}, ${aiMessage.length} chars)`);
}

// ═══════════════════════════════════════════════════════════════
// ENVÍO DE MENSAJES — Usa el socket del tenant (NUNCA el admin)
// ═══════════════════════════════════════════════════════════════

/**
 * Envía un mensaje por el socket del tenant.
 * SEGURIDAD: Cada tenant usa SU PROPIO socket — nunca getOwnerSock().
 * Incluye: bloqueo de grupos/status, rate limit por largo, delay humanizado, typing indicator.
 *
 * @param {Object} tenantState - Estado del tenant (sock, isReady, uid)
 * @param {string} phone - JID destino
 * @param {string} content - Texto a enviar
 * @returns {Promise<boolean|null>} true si se envió, null si falló
 */
async function sendTenantMessage(tenantState, phone, content) {
  if (!tenantState || !tenantState.sock || !tenantState.isReady) {
    console.warn(`[TMH:${tenantState?.uid || '?'}] ⚠️ Socket no listo. Mensaje a ${phone} NO ENVIADO.`);
    return null;
  }

  // Bloqueo absoluto: grupos y status
  if (phone.endsWith('@g.us') || phone.includes('status@')) {
    console.log(`[TMH:${tenantState.uid}] 🚫 Envío a grupo/status BLOQUEADO: ${phone}`);
    return null;
  }

  // Recortar mensajes muy largos (máx 1200 chars)
  if (typeof content === 'string' && content.length > 1200) {
    let cutPoint = content.lastIndexOf('\n\n', 1200);
    if (cutPoint < 400) cutPoint = content.lastIndexOf('\n', 1200);
    if (cutPoint < 400) cutPoint = 1200;
    content = content.substring(0, cutPoint).trim();
    console.log(`[TMH:${tenantState.uid}] ✂️ Respuesta recortada a ${content.length} chars para ${phone}`);
  }

  // Delay humanizado antes de escribir (1.5-3 seg)
  const humanDelay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
  await delay(humanDelay);

  try {
    // Typing indicator (best effort, no falla si no funciona)
    try { await tenantState.sock.sendPresenceUpdate('composing', phone); } catch (_) {}

    // Delay de "escritura" proporcional al largo del mensaje
    const typingDelay = Math.min((content.length || 50) * 40, 8000);
    await delay(typingDelay);

    // Enviar
    await tenantState.sock.sendMessage(phone, { text: content });
    console.log(`[TMH:${tenantState.uid}] 📤 Mensaje enviado a ${phone} (${content.length} chars)`);
    return true;
  } catch (e) {
    console.error(`[TMH:${tenantState.uid}] ❌ Error enviando mensaje a ${phone}:`, e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Handler principal
  handleTenantMessage,
  sendTenantMessage,

  // Contexto (para inspección o testing)
  getOrCreateContext,
  tenantContexts,

  // Firestore helpers (para uso externo o testing)
  loadOwnerProfile,
  loadBusinessCerebro,
  loadPersonalBrain,
  saveBusinessLearning,
  savePersonalLearning,
  queueDubiousLearning,
  saveAgendaEvent,
};
