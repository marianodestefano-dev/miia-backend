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
} = require('../core/message_logic');

const {
  buildOwnerSelfChatPrompt, buildOwnerFamilyPrompt,
  buildOwnerLeadPrompt, buildEquipoPrompt, buildGroupPrompt,
  buildInvokedPrompt, buildOutreachLeadPrompt,
  buildADN, buildVademecum, resolveProfile, DEFAULT_OWNER_PROFILE
} = require('../core/prompt_builder');

const miiaInvocation = require('../core/miia_invocation');
const { createCalendarEvent, getScheduleConfig: getCalScheduleConfig } = require('../core/google_calendar');
const outreachEngine = require('../core/outreach_engine');
const { applyMiiaEmoji } = require('../core/miia_emoji');

const aiGateway = require('../ai/ai_gateway');
const promptCache = require('../ai/prompt_cache');
const {
  shouldMiiaRespond, matchesBusinessKeywords, getOwnerBusinessKeywords,
  buildUnknownContactAlert
} = require('../core/contact_gate');
const rateLimiter = require('../core/rate_limiter');
const humanDelay = require('../core/human_delay');
const contactClassifier = require('../core/contact_classifier');
const weekendMode = require('../core/weekend_mode');
const { runPostprocess, runAIAudit, getFallbackMessage } = require('../core/miia_postprocess');

// ═══════════════════════════════════════════════════════════════
// ESTADO POR TENANT (aislado en memoria)
// ═══════════════════════════════════════════════════════════════

/**
 * @type {Map<string, TenantContext>}
 * Cada tenant tiene su propio contexto en memoria. Se crea en getOrCreateContext().
 * REGLA NASA: Si el Map no tiene el uid, se crea — NUNCA retorna undefined.
 */
const tenantContexts = new Map();

// Funciones de aprobación dinámica (inyectadas desde server.js via setApprovalFunctions)
let _validateLearningKey = null;
let _createLearningApproval = null;
let _markApprovalApplied = null;

function setApprovalFunctions({ validateLearningKey, createLearningApproval, markApprovalApplied }) {
  _validateLearningKey = validateLearningKey;
  _createLearningApproval = createLearningApproval;
  _markApprovalApplied = markApprovalApplied;
  console.log('[TMH] ✅ Funciones de aprobación dinámica inyectadas');
}

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
    // Cargar businessName del defaultBusiness si no está en el perfil raíz
    let businessName = data.businessName || data.companyName || '';
    if (!businessName && data.defaultBusinessId) {
      try {
        const bizDoc = await db().collection('users').doc(ownerUid)
          .collection('businesses').doc(data.defaultBusinessId).get();
        if (bizDoc.exists) {
          businessName = bizDoc.data().name || '';
        }
      } catch (_) {}
    }
    const profile = {
      fullName: data.name || data.displayName || 'Owner',
      shortName: (data.name || data.displayName || 'Owner').split(' ')[0],
      businessName: businessName || 'Mi Negocio',
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
    // PASO 1: Buscar cerebro del defaultBusiness (nueva arquitectura multi-negocio)
    const userDoc = await db().collection('users').doc(ownerUid).get();
    const defaultBizId = userDoc.exists ? userDoc.data().defaultBusinessId : null;
    if (defaultBizId) {
      const bizBrainDoc = await db().collection('users').doc(ownerUid)
        .collection('businesses').doc(defaultBizId)
        .collection('brain').doc('business_cerebro').get();
      if (bizBrainDoc.exists && bizBrainDoc.data().content) {
        const content = bizBrainDoc.data().content;
        console.log(`[TMH:${ownerUid}] 🧠 Business cerebro (biz:${defaultBizId.substring(0,8)}): ${content.length} chars`);
        return content;
      }
    }
    // PASO 2: Fallback al path legacy users/{uid}/brain/business_cerebro
    const doc = await db().collection('users').doc(ownerUid).collection('brain').doc('business_cerebro').get();
    const content = doc.exists ? (doc.data().content || '') : '';
    console.log(`[TMH:${ownerUid}] 🧠 Business cerebro (legacy): ${content.length} chars`);
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
 * Carga negocios del owner.
 * Ruta: users/{ownerUid}/businesses/
 */
async function loadBusinesses(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid).collection('businesses').get();
    const businesses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`[TMH:${ownerUid}] 🏢 Businesses: ${businesses.length}`);
    return businesses;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando businesses:`, e.message);
    return [];
  }
}

/**
 * Carga grupos de contacto con sus contactos (para clasificación rápida).
 * Ruta: users/{ownerUid}/contact_groups/
 * Retorna: { groupId: { ...groupData, contacts: { phone: contactData } } }
 */
async function loadContactGroups(ownerUid) {
  try {
    const snap = await db().collection('users').doc(ownerUid).collection('contact_groups').get();
    const groups = {};
    for (const doc of snap.docs) {
      const data = { id: doc.id, ...doc.data(), contacts: {} };
      const contactsSnap = await db().collection('users').doc(ownerUid)
        .collection('contact_groups').doc(doc.id).collection('contacts').get();
      contactsSnap.forEach(c => { data.contacts[c.id] = c.data(); });
      groups[doc.id] = data;
    }
    const totalContacts = Object.values(groups).reduce((sum, g) => sum + Object.keys(g.contacts).length, 0);
    console.log(`[TMH:${ownerUid}] 👥 Contact groups: ${Object.keys(groups).length} groups, ${totalContacts} contacts`);
    return groups;
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error cargando contact groups:`, e.message);
    return {};
  }
}

/**
 * Busca un teléfono en contact_index para clasificación O(1).
 * Ruta: users/{ownerUid}/contact_index/{phone}
 */
async function lookupContactIndex(ownerUid, phone) {
  try {
    const doc = await db().collection('users').doc(ownerUid).collection('contact_index').doc(phone).get();
    return doc.exists ? doc.data() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Guarda clasificación en contact_index.
 */
async function saveContactIndex(ownerUid, phone, data) {
  try {
    await db().collection('users').doc(ownerUid).collection('contact_index').doc(phone).set({
      ...data,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.error(`[TMH:${ownerUid}] ❌ Error guardando contact_index:`, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// CASCADA DE CLASIFICACIÓN DE CONTACTOS
// ═══════════════════════════════════════════════════════════════

/**
 * Clasifica un contacto según la cascada:
 *   PASO 0: contact_index existe? → ya clasificado
 *   PASO 1: Está en algún contact_group? → usar tono del grupo
 *   PASO 2: Solo 1 negocio? → asignar directo
 *   PASO 3: whatsapp_number de algún business matchea? → lead de ese negocio
 *   PASO 4: IA detecta match con descripción de negocio? → asignar
 *   PASO 5: MIIA saluda natural + consulta al owner en self-chat
 *   (Pasos 3-5 solo si 2+ negocios)
 *
 * @returns {{ type: string, groupId?: string, groupData?: Object, businessId?: string, businessName?: string }}
 */
async function classifyContact(ctx, basePhone, messageBody, tenantState) {
  const ownerUid = ctx.ownerUid;
  const logPrefix = `[TMH:${ctx.uid}]`;

  // PASO 0: contact_index
  const cached = await lookupContactIndex(ownerUid, basePhone);
  if (cached) {
    console.log(`${logPrefix} 📇 PASO 0: contact_index hit → type=${cached.type}, group=${cached.groupId || '-'}, biz=${cached.businessId || '-'}`);
    if (cached.type === 'group' && cached.groupId && ctx.contactGroups[cached.groupId]) {
      return { type: 'group', groupId: cached.groupId, groupData: ctx.contactGroups[cached.groupId], name: cached.name };
    }
    if (cached.type === 'lead' && cached.businessId) {
      return { type: 'lead', businessId: cached.businessId, name: cached.name };
    }
    // Enterprise leads: pasar TODOS los datos del contact_index para discovery
    if (cached.type === 'enterprise_lead') {
      return { ...cached, type: 'enterprise_lead' };
    }
    return { type: cached.type || 'lead', name: cached.name };
  }

  // PASO 1: Buscar en contact_groups (también legacy familyContacts/teamContacts)
  for (const [gid, group] of Object.entries(ctx.contactGroups || {})) {
    if (group.contacts && group.contacts[basePhone]) {
      const contactData = group.contacts[basePhone];
      console.log(`${logPrefix} 📇 PASO 1: Encontrado en grupo "${group.name}" (${gid})`);
      await saveContactIndex(ownerUid, basePhone, { type: 'group', groupId: gid, groupName: group.name, name: contactData.name });
      return { type: 'group', groupId: gid, groupData: group, name: contactData.name };
    }
  }

  // Legacy: familia/equipo hardcodeados
  if (ctx.familyContacts[basePhone]) {
    console.log(`${logPrefix} 📇 PASO 1 (legacy): familia → ${ctx.familyContacts[basePhone].name}`);
    return { type: 'familia', name: ctx.familyContacts[basePhone].name };
  }
  if (ctx.teamContacts[basePhone]) {
    console.log(`${logPrefix} 📇 PASO 1 (legacy): equipo → ${ctx.teamContacts[basePhone].name}`);
    return { type: 'equipo', name: ctx.teamContacts[basePhone].name };
  }

  const businesses = ctx.businesses || [];

  // PASO 2: Solo 1 negocio → verificar keywords ANTES de asignar
  if (businesses.length <= 1) {
    const bizId = businesses[0]?.id || null;
    const bizName = businesses[0]?.name || 'Mi Negocio';
    // Verificar keywords de negocio — MIIA NO EXISTE sin keyword match
    const allKeywords = getOwnerBusinessKeywords(ctx);
    const kwMatch = matchesBusinessKeywords(messageBody, allKeywords);
    if (kwMatch.matched) {
      console.log(`${logPrefix} 📇 PASO 2: Keyword "${kwMatch.keyword}" match → lead de "${bizName}"`);
      if (bizId) await saveContactIndex(ownerUid, basePhone, { type: 'lead', businessId: bizId, name: '' });
      return { type: 'lead', businessId: bizId, businessName: bizName };
    }
    // Sin keyword match → desconocido, MIIA NO EXISTE
    console.log(`${logPrefix} 📇 PASO 2: Sin keyword match → unknown (MIIA no existe)`);
    return { type: 'unknown' };
  }

  // PASO 3: whatsapp_number match (solo si 2+ negocios)
  for (const biz of businesses) {
    if (biz.whatsapp_number && basePhone.includes(biz.whatsapp_number.replace(/\D/g, ''))) {
      console.log(`${logPrefix} 📇 PASO 3: WhatsApp number match → "${biz.name}"`);
      await saveContactIndex(ownerUid, basePhone, { type: 'lead', businessId: biz.id, name: '' });
      return { type: 'lead', businessId: biz.id, businessName: biz.name };
    }
  }

  // PASO 4: IA detecta match con descripción de negocio
  try {
    const aiProvider = ctx.ownerProfile.aiProvider || 'gemini';
    const aiApiKey = ctx.ownerProfile.aiApiKey || process.env.GEMINI_API_KEY;
    if (aiApiKey && businesses.length >= 2) {
      const bizDescriptions = businesses.map(b => `- "${b.name}": ${b.description || 'sin descripción'}`).join('\n');
      const classifyPrompt = `Analiza este mensaje de un contacto nuevo y determina a cuál negocio corresponde.

Negocios disponibles:
${bizDescriptions}

Mensaje del contacto: "${messageBody.substring(0, 500)}"

Responde SOLO con el nombre exacto del negocio que mejor corresponda, o "NINGUNO" si no es claro.`;

      const classifyResult = await aiGateway.smartCall(
        aiGateway.CONTEXTS.CLASSIFICATION,
        classifyPrompt,
        { aiProvider, aiApiKey },
        { maxTokens: 256 }
      );
      const aiResult = classifyResult.text;
      if (classifyResult.failedOver) console.log(`${logPrefix} 🔄 PASO 4: Clasificación usó failover → ${classifyResult.provider}`);
      const matchedBiz = businesses.find(b => aiResult && aiResult.toLowerCase().includes(b.name.toLowerCase()));
      if (matchedBiz) {
        console.log(`${logPrefix} 📇 PASO 4: IA match → "${matchedBiz.name}"`);
        await saveContactIndex(ownerUid, basePhone, { type: 'lead', businessId: matchedBiz.id, name: '' });
        return { type: 'lead', businessId: matchedBiz.id, businessName: matchedBiz.name };
      }
    }
  } catch (e) {
    console.error(`${logPrefix} ⚠️ PASO 4: Error en clasificación IA:`, e.message);
  }

  // PASO 5: No se pudo clasificar → asignar a default y notificar al owner
  const defaultBizId = businesses[0]?.id || null;
  console.log(`${logPrefix} 📇 PASO 5: Sin match → default biz, notificar al owner`);

  // Notificar al owner en self-chat
  const ownerJid = tenantState.sock?.user?.id;
  if (ownerJid) {
    const bizList = businesses.map(b => `• ${b.name}`).join('\n');
    const alertMsg = `📱 *Nuevo contacto sin clasificar*\n\nNúmero: +${basePhone}\nMensaje: "${messageBody.substring(0, 200)}"\n\n¿A qué negocio pertenece?\n${bizList}\n\nRespondé con el nombre del negocio, o "amigo"/"familia" para agregarlo a un grupo.`;
    try {
      await sendTenantMessage(tenantState, ownerJid, alertMsg);
    } catch (e) {
      console.error(`${logPrefix} ❌ Error notificando al owner:`, e.message);
    }
  }

  await saveContactIndex(ownerUid, basePhone, { type: 'pending', name: '' });
  contactClassifier.addPendingClassification(ownerUid, basePhone, messageBody.substring(0, 200));
  return { type: 'lead', businessId: defaultBizId, businessName: businesses[0]?.name || 'Mi Negocio' };
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
  const [ownerProfile, businessCerebro, personalBrain, familyContacts, teamContacts, scheduleConfig, businesses, contactGroups] = await Promise.all([
    loadOwnerProfile(ownerUid),
    loadBusinessCerebro(ownerUid),
    loadPersonalBrain(uid),
    // Familia y equipo: solo para owners (agents NO ven familia ajena)
    role === 'owner' ? loadFamilyContacts(ownerUid) : Promise.resolve({}),
    role === 'owner' ? loadTeamContacts(ownerUid) : Promise.resolve({}),
    loadScheduleConfig(ownerUid),
    loadBusinesses(ownerUid),
    role === 'owner' ? loadContactGroups(ownerUid) : Promise.resolve({})
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
      miiaActive: {},  // phone → boolean — "Hola MIIA" activa, "Chau MIIA" desactiva
      scheduleConfig,
      businesses,
      contactGroups,
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
    ctx.businesses = businesses;
    ctx.contactGroups = contactGroups;
    ctx.lastProfileLoad = now;
  }

  console.log(`[TMH:${uid}] ✅ Contexto listo — cerebro=${businessCerebro.length}ch, personal=${personalBrain.length}ch, familia=${Object.keys(familyContacts).length}, equipo=${Object.keys(teamContacts).length}, approvalSystem=${_validateLearningKey ? 'ACTIVE' : 'PENDING'}`);
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
async function handleTenantMessage(uid, ownerUid, role, phone, messageBody, isSelfChat, isFromMe, tenantState, messageContext = {}) {
  const logPrefix = `[TMH:${uid}]`;
  try { require('../core/privacy_counters').recordIncoming(uid); } catch (_) {}

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

  // ── PASO 5: Guardar mensaje entrante (con contexto de respuesta/reenvío) ──
  if (!ctx.conversations[phone]) ctx.conversations[phone] = [];
  const msgEntry = {
    role: isSelfChat ? 'user' : (isFromMe ? 'assistant' : 'user'),
    content: messageBody,
    timestamp: Date.now()
  };
  // Enriquecer con contexto de quoted reply o forwarded
  if (messageContext.quotedText) {
    msgEntry.quotedText = messageContext.quotedText;
    console.log(`${logPrefix} 💬 Mensaje cita: "${messageContext.quotedText.substring(0, 80)}..."`);
  }
  if (messageContext.isForwarded) {
    msgEntry.isForwarded = true;
    console.log(`${logPrefix} ↪️ Mensaje reenviado (score: ${messageContext.forwardingScore || 1})`);
  }
  ctx.conversations[phone].push(msgEntry);
  if (ctx.conversations[phone].length > 40) {
    ctx.conversations[phone] = ctx.conversations[phone].slice(-40);
  }

  // ── PASO 6: Si es isFromMe pero NO self-chat → solo registrar, no responder ──
  if (isFromMe && !isSelfChat) {
    console.log(`${logPrefix} 📝 Mensaje propio a ${basePhone} registrado (sin respuesta IA).`);
    return;
  }

  // ── PASO 7: Clasificar contacto (cascada multi-negocio) ──
  let contactType = ctx.contactTypes[phone];
  let classification = null;
  let isFamilyContact = ctx.familyContacts[basePhone] || false;
  let isTeamMember = ctx.teamContacts[basePhone] || false;

  if (!contactType) {
    if (isSelfChat) {
      contactType = 'owner';
    } else {
      // Cascada de clasificación
      classification = await classifyContact(ctx, basePhone, messageBody, tenantState);
      contactType = classification.type;

      // Map group/legacy types
      if (contactType === 'familia') {
        isFamilyContact = ctx.familyContacts[basePhone] || { name: classification.name };
      } else if (contactType === 'equipo') {
        isTeamMember = ctx.teamContacts[basePhone] || { name: classification.name };
      } else if (contactType === 'group') {
        // Grupo dinámico — se maneja en PASO 9
      }

      if (classification.name) {
        ctx.leadNames[phone] = classification.name;
      }
    }
    ctx.contactTypes[phone] = contactType;
  }

  // ── PASO 7b: CONTACT GATE — Decisión centralizada: ¿MIIA responde o no? ──
  const msgNorm = normalizeText(messageBody);
  const isHolaMiia = msgNorm.includes('hola miia');
  const isChauMiia = msgNorm.includes('chau miia');
  const isGroup = phone.endsWith('@g.us');
  const businessKeywords = getOwnerBusinessKeywords(ctx);

  // Actualizar estado de activación ANTES del gate
  if (isHolaMiia) {
    ctx.miiaActive[phone] = true;
    console.log(`${logPrefix} 🟢 MIIA activada para ${basePhone} (trigger "Hola MIIA")`);
  }

  // Detección de invocación MIIA (3-way conversation)
  const isInvoc = miiaInvocation.isInvocation(messageBody);
  const isMiiaInvoked = miiaInvocation.isInvoked(phone);

  const gateDecision = shouldMiiaRespond({
    isSelfChat,
    isGroup,
    contactType,
    miiaActive: !!ctx.miiaActive[phone],
    isHolaMiia,
    isChauMiia,
    isInvocation: isInvoc,
    isMiiaInvoked,
    messageBody,
    businessKeywords,
    basePhone,
  });

  console.log(`${logPrefix} 🚪 CONTACT-GATE: respond=${gateDecision.respond}, reason=${gateDecision.reason}, action=${gateDecision.action || 'none'}`);

  // Acción: invocación de MIIA (3-way mode)
  if (gateDecision.action === 'invocation') {
    const contactName = ctx.leadNames[phone] || ctx.familyContacts?.[basePhone]?.name || null;
    const isKnown = !!contactName;
    miiaInvocation.activateInvocation(phone, isSelfChat ? 'owner' : 'contact', { contactName, knownContact: isKnown });

    // Auto-retiro callback
    miiaInvocation.touchInteraction(phone, async (retirePhone) => {
      try {
        await sendTenantMessage(tenantState, retirePhone, `Bueno, los dejo que sigan charlando 😊 Si me necesitan: *MIIA ven*! 👋`);
      } catch (e) { console.error(`${logPrefix} ❌ Auto-retiro error:`, e.message); }
    });

    const ownerName = ctx.ownerProfile?.shortName || ctx.ownerProfile?.name || 'tu owner';
    const prompt = buildInvokedPrompt({
      ownerName,
      contactName,
      isFirstTime: !isKnown,
      pendingIntroduction: !isKnown,
      scope: null,
      contactRelation: null,
      invokedBy: isSelfChat ? 'owner' : 'contact',
      ownerProfile: ctx.ownerProfile,
      stageInfo: '',
    });

    try {
      const result = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, prompt, tenantState.aiConfig || {});
      if (result?.text) {
        ctx.conversations[phone].push({ role: 'assistant', content: result.text.trim(), timestamp: Date.now() });
        await sendTenantMessage(tenantState, phone, result.text.trim());
      }
    } catch (e) {
      console.error(`${logPrefix} ❌ Error en invocación:`, e.message);
      const fallback = isKnown ? `¡Hola! Acá estoy 😊 ¿En qué los ayudo?` : `¡Hola ${ownerName}! ¿Me querés presentar a alguien? 😊`;
      await sendTenantMessage(tenantState, phone, fallback);
    }
    return;
  }

  // Acción: despedida de invocación
  if (gateDecision.action === 'invocation_farewell') {
    miiaInvocation.deactivateInvocation(phone, 'farewell');
    const farewell = `¡Fue un gusto! Si me necesitan: *MIIA ven* 😊👋`;
    ctx.conversations[phone].push({ role: 'assistant', content: farewell, timestamp: Date.now() });
    await sendTenantMessage(tenantState, phone, farewell);
    return;
  }

  // Acción: farewell (Chau MIIA)
  if (gateDecision.action === 'farewell') {
    ctx.miiaActive[phone] = false;
    console.log(`${logPrefix} 🔴 MIIA desactivada para ${basePhone} (trigger "Chau MIIA")`);
    const farewell = `¡Fue un gusto charlar! Cuando quieras hablar de nuevo, escribime *Hola MIIA* 😊`;
    ctx.conversations[phone].push({ role: 'assistant', content: farewell, timestamp: Date.now() });
    await sendTenantMessage(tenantState, phone, farewell);
    return;
  }

  // Acción: notificar al owner sobre contacto desconocido sin keywords
  // REGLA: Si el owner tiene 1 solo negocio → auto-clasificar como lead (no preguntar)
  if (gateDecision.action === 'notify_owner') {
    const businesses = ctx.businesses || [];
    if (businesses.length <= 1) {
      // 1 negocio (o ninguno) → auto-clasificar como lead y dejar que MIIA responda
      const bizId = businesses[0]?.id || null;
      const bizName = businesses[0]?.name || 'Mi Negocio';
      console.log(`${logPrefix} 🏷️ Auto-clasificando desconocido ${basePhone} como lead → ${bizName} (1 solo negocio, sin preguntar al owner)`);
      contactType = 'lead';
      ctx.contactTypes[phone] = 'lead';
      if (bizId) await saveContactIndex(ctx.ownerUid, basePhone, { type: 'lead', businessId: bizId, name: messageContext?.pushName || '' });
      // Sobreescribir gateDecision para que MIIA responda
      gateDecision.respond = true;
      gateDecision.reason = 'auto_classified_lead';
      gateDecision.action = 'none';
    } else {
      // 2+ negocios → notificar al owner para que clasifique
      const ownerJid = tenantState.sock?.user?.id;
      if (ownerJid) {
        const phoneDigits = (basePhone || '').replace(/[^0-9]/g, '');
        const isLid = phoneDigits.length > 13;
        const pushName = messageContext?.pushName || '';
        const alertMsg = buildUnknownContactAlert(basePhone, messageBody, pushName, { isLid });
        try {
          await sendTenantMessage(tenantState, ownerJid, alertMsg);
          console.log(`${logPrefix} 📢 Owner notificado: desconocido ${isLid ? (pushName || 'LID') : basePhone} sin keyword match (${businesses.length} negocios)`);
        } catch (e) {
          console.error(`${logPrefix} ❌ Error notificando al owner sobre desconocido:`, e.message);
        }
      }
    }
  }

  // Si keyword matcheó en un desconocido → clasificar como lead y guardar en contact_index
  if (gateDecision.reason === 'keyword_match' && gateDecision.matchedKeyword) {
    const businesses = ctx.businesses || [];
    const bizId = businesses[0]?.id || null;
    const bizName = businesses[0]?.name || 'Mi Negocio';
    console.log(`${logPrefix} 🏷️ Desconocido ${basePhone} clasificado como lead por keyword "${gateDecision.matchedKeyword}" → ${bizName}`);
    contactType = 'lead';
    ctx.contactTypes[phone] = 'lead';
    if (bizId) await saveContactIndex(ctx.ownerUid, basePhone, { type: 'lead', businessId: bizId, name: '' });
  }

  // ── PASO 7f: Modo finde — leads reciben respuesta automática si owner activó "finde off" ──
  if (contactType === 'lead' && !isSelfChat) {
    const weekendCheck = weekendMode.isWeekendBlocked(ctx.ownerUid);
    if (weekendCheck.blocked) {
      console.log(`${logPrefix} 🏖️ MODO FINDE activo → respuesta automática a lead ${basePhone}`);
      await sendTenantMessage(tenantState, phone, weekendCheck.autoResponse);
      return;
    }
  }

  // GATE FINAL: si no debe responder → silencio total
  if (!gateDecision.respond) {
    console.log(`${logPrefix} 🤫 MIIA NO EXISTE para ${basePhone} (${gateDecision.reason}). Silencio total.`);
    return;
    // Si es la primera interacción ("Hola MIIA"), ya se activó arriba
  }

  // ── PASO 7c: Read receipt selectivo — solo marcar leído si MIIA va a responder ──
  // Contactos ignorados/sin keyword retornaron arriba → nunca llegan acá → ticks grises
  if (!isSelfChat && messageContext?.msgKey) {
    const readDelayMs = 1500 + Math.random() * 3000;
    setTimeout(async () => {
      try {
        if (tenantState.sock && tenantState.isReady) {
          await tenantState.sock.readMessages([messageContext.msgKey]);
          console.log(`${logPrefix} ✅ Read receipt enviado para ${basePhone} (delay ${Math.round(readDelayMs)}ms)`);
        }
      } catch (e) {
        console.log(`${logPrefix} ⚠️ Read receipt falló: ${e.message}`);
      }
    }, readDelayMs);
  }

  // ── PASO 7d: Rate limiter — auto-límite inteligente (5 niveles, ventana 24h) ──
  const rlCheck = rateLimiter.shouldRespond(ctx.ownerUid, contactType);
  console.log(`${logPrefix} 📊 RATE-LIMIT: ${rlCheck.level.emoji} ${rlCheck.level.name} — ${rlCheck.reason}`);

  // Verificar cambio de nivel → notificar al owner en self-chat
  const rlChange = rateLimiter.checkLevelChange(ctx.ownerUid);
  if (rlChange.changed && rlChange.message) {
    const ownerJid = tenantState.sock?.user?.id;
    if (ownerJid) {
      try {
        await sendTenantMessage(tenantState, ownerJid, rlChange.message);
        console.log(`${logPrefix} 📢 Owner notificado: nivel cambió ${rlChange.oldLevel} → ${rlChange.newLevel}`);
      } catch (e) {
        console.error(`${logPrefix} ❌ Error notificando cambio de nivel:`, e.message);
      }
    }
  }

  if (!rlCheck.allowed) {
    console.log(`${logPrefix} ⛔ RATE-LIMIT: ${contactType} ${basePhone} bloqueado por nivel ${rlCheck.level.name}`);
    return;
  }

  // ── PASO 7e: Night mode — MIIA "duerme" automáticamente ──
  const nightCheck = humanDelay.nightModeGate(ctx.ownerUid, contactType, ctx.ownerProfile?.timezone);
  if (!nightCheck.allowed) {
    console.log(`${logPrefix} 🌙 NIGHT MODE: ${contactType} ${basePhone} bloqueado (${nightCheck.reason}). Lead responde mañana.`);
    return;
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
  // Dialecto se aplica a TODOS los perfiles (leads, familia, equipo, self-chat, grupos)
  const countryContext = getCountryContext(basePhone);

  if (isSelfChat) {
    activeSystemPrompt = buildOwnerSelfChatPrompt(ctx.ownerProfile);
    // Inyectar lista de negocios si tiene más de 1
    if (ctx.businesses && ctx.businesses.length > 1) {
      const bizList = ctx.businesses.map((b, i) => `${i + 1}. ${b.name}${b.description ? ' — ' + b.description.substring(0, 60) : ''}`).join('\n');
      activeSystemPrompt += `\n\n## TUS NEGOCIOS\nTenés ${ctx.businesses.length} negocios registrados:\n${bizList}\nCuando un contacto nuevo escriba, MIIA te consultará a qué negocio asignarlo.`;
    }
    // Dialecto del owner para self-chat
    if (countryContext) activeSystemPrompt += `\n\n${countryContext}`;
  } else if (contactType === 'group' && classification?.groupData) {
    const contactName = classification.name || ctx.leadNames[phone] || basePhone;
    activeSystemPrompt = buildGroupPrompt(classification.groupData, contactName, ctx.ownerProfile);
    if (countryContext) activeSystemPrompt += `\n\n${countryContext}`;
  } else if (isFamilyContact) {
    activeSystemPrompt = buildOwnerFamilyPrompt(isFamilyContact.name, isFamilyContact, ctx.ownerProfile);
    if (countryContext) activeSystemPrompt += `\n\n${countryContext}`;
  } else if (isTeamMember) {
    activeSystemPrompt = buildEquipoPrompt(isTeamMember.name || ctx.leadNames[phone], ctx.ownerProfile);
    if (countryContext) activeSystemPrompt += `\n\n${countryContext}`;
  } else if (contactType === 'enterprise_lead' && classification) {
    // Enterprise lead — MIIA hace discovery como "Mariano del área Enterprise"
    // La IA interpreta NATURALMENTE cuándo despedirse, revelar, o transferir a Mariano real
    const elData = classification;
    const leadName = elData.name || ctx.leadNames[phone] || '';
    const webInfo = elData.websiteAnalysis ? `\nANÁLISIS DE SU WEB:\n${elData.websiteAnalysis.substring(0, 2000)}` : '';
    const currentStage = elData.stage || 'initial_contact';

    activeSystemPrompt = `Eres Mariano, del área Enterprise de MIIA. Estás conversando con un lead enterprise por WhatsApp.

## DATOS DEL LEAD
- Nombre: ${leadName}
- Email: ${elData.email || 'N/A'}
- Website: ${elData.website || 'No proporcionó'}
- Tamaño equipo: ${elData.team_size || 'No especificado'}
- Mensaje inicial: ${elData.message || 'N/A'}
- Etapa actual: ${currentStage}
${webInfo}

## TU OBJETIVO
1. DISCOVERY COMPLETO: Entender su negocio a fondo — qué venden, a quién, cuántos leads manejan, qué herramientas usan, qué problemas tienen
2. RESPONDER PREGUNTAS sobre MIIA Enterprise con conocimiento real. Comparte https://miia-app.com si preguntan
3. DEMOSTRAR VALOR: Usa los datos de su web para hacer observaciones inteligentes
4. PROPONER SOLUCIÓN: Cuando tengas suficiente info, explica cómo MIIA Enterprise resolvería sus problemas específicos
5. Si no tiene web, pregunta por su LinkedIn o perfil de empresa

## COMPORTAMIENTO NATURAL DE DESPEDIDA (sin comandos, tú interpretas)
Cuando sientas que la conversación está llegando a su fin (el lead se despide, agradece, dice que lo piensa, etc.):
1. **Revela la verdad**: Dile algo natural como "Antes de irme, quiero contarte algo: en realidad soy la MIIA de Mariano. Todo lo que acabas de experimentar es exactamente lo que podemos hacer por ti y tu empresa 😉"
2. **Ofrece hablar con Mariano**: "Si quieres hablar con una persona, solo dímelo y Mariano te contactará directamente"

Cuando sientas que el lead quiere hablar con una persona real (pide hablar con alguien, quiere una llamada, insiste en algo humano, etc.):
1. Despídete con calidez: "Ahora sí me retiro. Mariano ha sido informado y en breve te llamará para conversar. ¡Feliz día!"
2. Incluye al FINAL de tu mensaje, en una línea separada, el texto exacto: [TRANSFER_TO_OWNER]

## REGLAS
- Tono profesional pero cercano, como un consultor de negocio amigable
${countryContext ? `- ${countryContext}` : '- Español neutro (NO argentinismos como "vos/tenés/querés")'}
- Máximo 2 emojis por mensaje
- NO presiones para cerrar — esto es un discovery genuino
- Haz preguntas abiertas, una o dos por mensaje, no bombardees
- Firma como "Mariano, MIIA Enterprise" solo en el primer mensaje
- NUNCA reveles que eres IA HASTA que la conversación esté terminando naturalmente`;

    // Post-respuesta: verificar si la IA decidió transferir (se chequea después de generar respuesta)
    // Se maneja más abajo cuando se obtiene aiMessage

  } else {
    // Lead — usar cerebro del negocio específico si hay clasificación con businessId
    let leadCerebro = ctx.businessCerebro;
    if (classification?.businessId) {
      try {
        const bizBrainDoc = await db().collection('users').doc(ctx.ownerUid)
          .collection('businesses').doc(classification.businessId)
          .collection('brain').doc('business_cerebro').get();
        if (bizBrainDoc.exists && bizBrainDoc.data().content) {
          leadCerebro = bizBrainDoc.data().content;
        }
      } catch (_) {}
    }
    activeSystemPrompt = buildOwnerLeadPrompt(ctx.leadNames[phone] || '', leadCerebro, countryContext, ctx.ownerProfile);
  }

  // ═══ INYECTAR HORA REAL — Desde timezone del dashboard del owner (Firestore) ═══
  // Prioridad: 1) settings/schedule.timezone (auto-detectado del browser), 2) users/{uid}.timezone, 3) fallback Bogotá
  let ownerTz = 'America/Bogota'; // fallback
  try {
    const scheduleDoc = await admin.firestore().collection('users').doc(ctx.ownerUid).collection('settings').doc('schedule').get();
    if (scheduleDoc.exists && scheduleDoc.data().timezone) {
      ownerTz = scheduleDoc.data().timezone;
    } else {
      // Fallback: timezone directo en el doc del usuario
      const userDoc = await admin.firestore().collection('users').doc(ctx.ownerUid).get();
      if (userDoc.exists && userDoc.data().timezone) {
        ownerTz = userDoc.data().timezone;
      }
    }
  } catch (_) { /* usar fallback */ }
  const nowLocal = new Date().toLocaleString('es', { timeZone: ownerTz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  activeSystemPrompt += `\n\n## ⏰ HORA ACTUAL\nAhora son: ${nowLocal} (zona: ${ownerTz}). Usá esta hora para saludar correctamente (buen día/buenas tardes/buenas noches) y para saber si es finde/semana. IMPORTANTE: Si mencionás eventos de otros países (partidos, carreras), CONVERTÍ la hora al timezone del owner (${ownerTz}). Ejemplo: si un partido es a las 20:00 en Argentina y el owner está en Colombia (UTC-5), decí que es a las 18:00.`;

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
  // Incluye contexto de quoted replies y forwarded messages
  const history = (ctx.conversations[phone] || []).slice(-20).map(m => {
    const speaker = m.role === 'user' ? 'Cliente' : 'MIIA';
    let line = `${speaker}: ${m.content}`;
    if (m.quotedText) {
      line = `${speaker} [respondiendo a: "${m.quotedText.substring(0, 120)}"]: ${m.content}`;
    }
    if (m.isForwarded) {
      line = `${speaker} [mensaje reenviado]: ${m.content}`;
    }
    return line;
  }).join('\n');

  // Ensamblado final del prompt
  const fullPrompt = `${activeSystemPrompt}

${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${personalStr}${cerebroStr ? '\n\n[ADN VENTAS — CONOCIMIENTO DE NEGOCIO]:\n' + cerebroStr : ''}${pendingStr}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

  // ── PASO 10: Llamar a la IA via AI Gateway (P5.3 — failover cross-provider) ──
  const aiProvider = ctx.ownerProfile.aiProvider || 'gemini';
  const aiApiKey = ctx.ownerProfile.aiApiKey || process.env.GEMINI_API_KEY;

  if (!aiApiKey || aiApiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    console.error(`${logPrefix} ❌ NO HAY API KEY configurada para uid=${uid}. Mensaje de ${basePhone} sin respuesta.`);
    return;
  }

  // Determinar contexto de IA para router inteligente
  const aiContext = isSelfChat
    ? aiGateway.CONTEXTS.OWNER_CHAT
    : contactType === 'lead'
      ? aiGateway.CONTEXTS.LEAD_RESPONSE
      : (contactType === 'familia' || contactType === 'group')
        ? aiGateway.CONTEXTS.FAMILY_CHAT
        : aiGateway.CONTEXTS.GENERAL;

  console.log(`${logPrefix} 🤖 AI Gateway: ctx=${aiContext}, provider=${aiProvider}, prompt=${fullPrompt.length} chars, phone=${basePhone}`);

  // P5.5: Intentar prompt cache para el system prompt (no el historial)
  const cacheKey = `${contactType}_${classification?.businessId || 'default'}`;
  const cachedSystemPrompt = promptCache.get(promptCache.TTL.SYSTEM_PROMPT ? 'SYSTEM_PROMPT' : 'GENERAL', ownerUid, cacheKey);
  if (cachedSystemPrompt) {
    console.log(`${logPrefix} ⚡ PROMPT-CACHE HIT para ${cacheKey}`);
  } else if (activeSystemPrompt) {
    promptCache.set('SYSTEM_PROMPT', ownerUid, activeSystemPrompt, cacheKey);
  }

  let aiMessage;
  const aiResult = await aiGateway.smartCall(
    aiContext,
    fullPrompt,
    { aiProvider, aiApiKey },
    {}
  );

  aiMessage = aiResult.text;

  if (aiResult.failedOver) {
    console.warn(`${logPrefix} 🔄 FAILOVER: ${aiProvider} → ${aiResult.provider} (${aiResult.latencyMs}ms)`);
  } else {
    console.log(`${logPrefix} ✅ ${aiResult.provider} OK (${aiResult.latencyMs}ms)`);
  }

  // Notificar al owner si MIIA usó sus keys de backup (el owner tiene su propia key pero falló)
  if (aiResult.usedMiiaBackup && isSelfChat) {
    const backupNotice = `⚡ Tu IA (${aiProvider}) no respondió, usé mi respaldo (${aiResult.provider}). Revisá tu cuota en tu proveedor.`;
    console.log(`${logPrefix} 📢 Notificando al owner: usamos backup MIIA`);
    // Se enviará después de la respuesta principal (no bloquea)
    setTimeout(async () => {
      try {
        const selfJid = tenantState.sock?.user?.id;
        if (tenantState.sock && selfJid) {
          await tenantState.sock.sendMessage(selfJid, { text: backupNotice });
        }
      } catch (e) { console.error(`${logPrefix} Error notificando backup:`, e.message); }
    }, 3000);
  }

  // Si TODOS los proveedores fallaron
  if (!aiMessage || !aiMessage.trim()) {
    if (aiResult.provider === 'none') {
      console.error(`${logPrefix} 🔴 TODOS los proveedores IA fallaron para ${basePhone}`);
      const alertMsg = `⚠️ *MIIA - Error de IA*\n\nTodos los proveedores de IA fallaron.\n\nSolución: Verificá tu saldo en ${aiProvider === 'claude' ? 'console.anthropic.com' : aiProvider === 'openai' ? 'platform.openai.com' : 'aistudio.google.com'} → Billing.\n\nO cambiá de proveedor desde tu dashboard → Conexiones → Inteligencia Artificial.`;
      try {
        const selfJid = tenantState.sock?.user?.id;
        if (tenantState.sock && selfJid) {
          await tenantState.sock.sendMessage(selfJid, { text: alertMsg });
          console.log(`${logPrefix} ✅ Notificación de error IA enviada al owner`);
        }
      } catch (notifyErr) {
        console.error(`${logPrefix} ❌ Error notificando al owner:`, notifyErr.message);
      }
    } else {
      console.warn(`${logPrefix} ⚠️ Respuesta VACÍA de ${aiResult.provider} para ${basePhone}. No se envía nada.`);
    }
    return;
  }

  console.log(`${logPrefix} ✅ Respuesta IA recibida via ${aiResult.provider} (${aiMessage.length} chars, ${aiResult.latencyMs}ms) para ${basePhone}`);

  // ── PASO 10b: AUDITORÍA (Regex + IA Sonnet) ──
  // PASO 1: Regex rápida (6 auditors, ~0ms)
  const postChatType = isSelfChat ? 'self' : contactType === 'lead' ? 'lead' : 'family';
  const postContactName = ctx.leadNames?.[phone] || basePhone;
  const regexAudit = runPostprocess(aiMessage, { chatType: postChatType, contactName: postContactName, revealAsAI: ctx.ownerProfile?.revealAsAI || false });

  if (!regexAudit.approved) {
    if (regexAudit.action === 'veto') {
      console.error(`${logPrefix} 🚫 REGEX VETO: ${regexAudit.vetoReason}`);
      aiMessage = getFallbackMessage(regexAudit.vetoReason, postChatType);
    } else if (regexAudit.action === 'regenerate') {
      console.warn(`${logPrefix} ♻️ REGEX: regeneración requerida — ${regexAudit.vetoReason}`);
      // Intentar regenerar con hint del auditor
      try {
        const hint = `\n\n⚠️ CORRECCIÓN: ${regexAudit.vetoReason}. Corregí esto en tu nueva respuesta.`;
        const regenResult = await aiGateway.smartCall(aiContext, fullPrompt + hint, { aiProvider, aiApiKey });
        if (regenResult.text?.trim()) {
          aiMessage = regenResult.text;
          console.log(`${logPrefix} ♻️ Regeneración exitosa (${regenResult.latencyMs}ms)`);
        }
      } catch (e) {
        console.error(`${logPrefix} ♻️ Regeneración falló: ${e.message} — usando fallback`);
        aiMessage = getFallbackMessage(regexAudit.vetoReason, postChatType);
      }
    }
  }

  // PASO 2: Auditoría IA con Sonnet (100% mensajes)
  try {
    const aiAuditResult = await runAIAudit(aiMessage, {
      chatType: postChatType,
      contactName: postContactName,
      userMessage: messageBody,
      generateAI: (prompt) => aiGateway.smartCall(aiGateway.CONTEXTS.AUDITOR, prompt, { aiProvider, aiApiKey }).then(r => r.text),
    });

    if (!aiAuditResult.approved) {
      if (aiAuditResult.action === 'veto') {
        console.error(`${logPrefix} 🚫 AI AUDITOR VETO: ${aiAuditResult.issues.join('; ')}`);
        aiMessage = getFallbackMessage(aiAuditResult.issues[0] || 'AUDITOR', postChatType);
      } else if (aiAuditResult.action === 'regenerate') {
        console.warn(`${logPrefix} ♻️ AI AUDITOR: regeneración — ${aiAuditResult.issues.join('; ')}`);
        try {
          const hint = `\n\n⚠️ CORRECCIÓN DEL AUDITOR: ${aiAuditResult.issues.join('. ')}. Corregí estos problemas.`;
          const regenResult = await aiGateway.smartCall(aiContext, fullPrompt + hint, { aiProvider, aiApiKey });
          if (regenResult.text?.trim()) aiMessage = regenResult.text;
        } catch (_) {
          aiMessage = getFallbackMessage('AUDITOR', postChatType);
        }
      }
    }
  } catch (auditErr) {
    // Fail-open: si el auditor falla, dejar pasar (ya pasó regex)
    console.error(`${logPrefix} ⚠️ AI Auditor error (fail-open): ${auditErr.message}`);
  }

  // ── PASO 11: Procesar tags de IA ──

  // 11a. Tags de aprendizaje (NEGOCIO, PERSONAL, DUDOSO, legacy GUARDAR_APRENDIZAJE)
  // 🔒 Detectar clave de aprobación dinámica en el mensaje del usuario (6 alfanuméricos)
  let learningKeyValid = false;
  let approvalDocRef = null;
  let expiredKeyDetected = false;
  if (messageBody && role !== 'owner') {
    // Buscar cualquier secuencia de 6 alfanuméricos en el mensaje
    const keyMatch = messageBody.match(/\b([A-Z2-9]{6})\b/i);
    if (keyMatch) {
      try {
        if (_validateLearningKey) {
          const result = await _validateLearningKey(ownerUid, keyMatch[1].toUpperCase());
          if (result.valid) {
            learningKeyValid = true;
            approvalDocRef = result.docRef;
            console.log(`${logPrefix} 🔑 Clave de aprobación válida: ${keyMatch[1]} (agente: ${result.approval.agentName})`);
          } else if (result.expired) {
            expiredKeyDetected = true;
            console.log(`${logPrefix} ⏰ Clave expirada: ${keyMatch[1]}`);
          }
        }
      } catch (e) {
        console.error(`${logPrefix} Error validando clave:`, e.message);
      }
    }
  }
  const contactName = ctx.leadNames?.[phone] || basePhone;
  const tagCtx = {
    uid, ownerUid, role,
    isOwner: role === 'owner',
    learningKeyValid,
    approvalDocRef,
    contactName,
    contactPhone: basePhone,
    learningScope: 'business_global' // puede ser 'agent_only' si el agente lo pidió
  };
  const tagCallbacks = {
    saveBusinessLearning,
    savePersonalLearning,
    queueDubiousLearning,
    createLearningApproval: _createLearningApproval || null,
    markApprovalApplied: approvalDocRef ? async (ref) => {
      try { await ref.update({ status: 'approved', appliedAt: admin.firestore.FieldValue.serverTimestamp() }); } catch (_) {}
    } : null,
    notifyOwner: async (msg) => {
      const selfJid = tenantState.sock?.user?.id;
      if (tenantState.sock && selfJid) {
        try {
          await tenantState.sock.sendMessage(selfJid, { text: msg });
        } catch (e) {
          console.error(`${logPrefix} ❌ Error notificando al owner:`, e.message);
        }
      } else {
        console.warn(`${logPrefix} ⚠️ No se pudo notificar al owner — sock o selfJid no disponible`);
      }
    }
  };

  const { cleanMessage, pendingQuestions } = await processLearningTags(aiMessage, tagCtx, tagCallbacks);
  aiMessage = cleanMessage;

  // ═══ RED DE SEGURIDAD: Instrucciones del owner en selfchat sin tag de aprendizaje ═══
  if (isSelfChat && role === 'owner' && messageBody) {
    const hadLearningTag = /\[(APRENDIZAJE_NEGOCIO|APRENDIZAJE_PERSONAL|APRENDIZAJE_DUDOSO|GUARDAR_APRENDIZAJE):/.test(cleanMessage || '');
    if (!hadLearningTag) {
      const instructionPatterns = /\b(siempre deb[eé]s|nunca deb[eé]s|aprend[eé] que|record[aá] que|de ahora en m[aá]s|a partir de ahora|cuando un lead|cuando alguien|tu prioridad es|quiero que|necesito que|no vuelvas a|dej[aá] de|empez[aá] a|cambi[aá] tu|tu tono debe|habl[aá] m[aá]s|se[aá] m[aá]s|cada lead es|todos los leads)\b/i;
      if (instructionPatterns.test(messageBody)) {
        const instruction = messageBody.substring(0, 500).trim();
        try {
          if (tagCallbacks.saveBusinessLearning) {
            await tagCallbacks.saveBusinessLearning(ownerUid, instruction, 'SERVER_SAFETY_NET');
            console.log(`${logPrefix} [LEARNING:SAFETY-NET] 🛡️ Instrucción del owner guardada automáticamente: "${instruction.substring(0, 80)}..."`);
          }
        } catch (e) {
          console.error(`${logPrefix} [LEARNING:SAFETY-NET] ❌ Error:`, e.message);
        }
      }
    }
  }

  // 11b. Tag de agenda — con Google Calendar si el owner tiene Calendar conectado
  aiMessage = await processAgendaTag(aiMessage, tagCtx, saveAgendaEvent, ctx.leadNames, {
    createCalendarEvent,
    getTimezone: async (uid) => {
      try {
        const schedCfg = await getCalScheduleConfig(uid);
        return schedCfg?.timezone || 'America/Bogota';
      } catch { return 'America/Bogota'; }
    }
  });

  // 11c. Tag de suscripción
  aiMessage = processSubscriptionTag(aiMessage, phone, ctx.subscriptionState);

  // 11d-pre. Tags de plan (interno, NUNCA visible al lead)
  {
    const { cleanText, plans } = outreachEngine.extractPlanTags(aiMessage);
    if (plans.length > 0) {
      aiMessage = cleanText;
      console.log(`${logPrefix} 🏷️ Plan tags detectados: ${plans.join(', ')} — envío de imágenes pendiente de configuración por tenant`);
      // TODO: Implementar envío de imágenes de plan para tenants (requiere media storage por tenant)
    }
  }

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

  // 11g. Notificar clave expirada al agente/familiar
  if (expiredKeyDetected && role !== 'owner') {
    aiMessage += '\n\n⏰ La clave de aprobación que ingresaste ya expiró. Si necesitas hacer cambios, vuelve a solicitarlos y recibirás una nueva clave.';
    console.log(`${logPrefix} ⏰ Clave expirada notificada a ${basePhone}`);
  }

  // ── PASO 12: Limpiar tags internos y enviar respuesta ──
  const hasTransferTag = aiMessage.includes('[TRANSFER_TO_OWNER]');
  aiMessage = aiMessage.replace(/\[TRANSFER_TO_OWNER\]/g, '').trim();

  if (!aiMessage.trim()) {
    console.warn(`${logPrefix} ⚠️ Mensaje final vacío después de procesar tags. No se envía.`);
    return;
  }

  // ── PASO 12b: Emoji de estado MIIA ──
  // applyMiiaEmoji SIEMPRE quita el emoji que puso la IA y pone el oficial
  aiMessage = applyMiiaEmoji(aiMessage, {
    isSelfChat,
    contactType: contactType || 'lead',
    messageBody,
  });

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

  // ── PASO 12b: Enterprise lead — post-respuesta: transferir a owner si la IA lo decidió ──
  if (contactType === 'enterprise_lead' && hasTransferTag) {
    console.log(`${logPrefix} 🔄 ENTERPRISE TRANSFER: Lead ${basePhone} transferido a Mariano`);

    // Generar resumen compacto de la conversación para el owner
    const convoHistory = ctx.conversations[phone] || [];
    const recentMsgs = convoHistory.slice(-10).map(m => `${m.role === 'user' ? leadName : 'MIIA'}: ${m.content.substring(0, 150)}`).join('\n');

    const ownerJid = tenantState.sock?.user?.id;
    if (ownerJid) {
      const ownerSelf = ownerJid.includes(':') ? ownerJid.split(':')[0] + '@s.whatsapp.net' : ownerJid;
      const elData = classification || {};
      const summaryMsg = `📞 *LEAD ENTERPRISE → LLAMAR AHORA*\n\n👤 *${leadName}* | 📱 +${basePhone}\n🌐 ${elData.website || 'N/A'} | 👥 Equipo: ${elData.team_size || 'N/A'}\n\n📋 *Resumen de la conversación:*\n${recentMsgs.substring(0, 1500)}\n\n⚡ El lead quiere hablar con una persona. Llámalo.`;

      try { await sendTenantMessage(tenantState, ownerSelf, summaryMsg); } catch (_) {}
    }

    // Actualizar stage en Firestore
    try {
      await db().collection('users').doc(ctx.ownerUid).collection('contact_index').doc(basePhone)
        .update({ stage: 'handed_to_owner' });
    } catch (_) {}
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

  // ═══ HUMAN DELAY: Secuencia correcta → leer → delay → typing → delay → enviar ═══
  const ctx = tenantContexts.get(tenantState.uid);
  const ownerHour = humanDelay.getOwnerHour(ctx?.ownerProfile?.timezone);
  const rlLevel = rateLimiter.getLevel(tenantState.uid);
  const delayMult = rlLevel.level.delayMultiplier || 1;
  const isSelfChatMsg = tenantState.sock?.user?.id === phone;
  const contactTypeForDelay = isSelfChatMsg ? 'owner' : 'lead'; // Simplificado para sendTenantMessage

  // 1. Delay de "lectura" (antes de empezar a escribir)
  const readMs = humanDelay.calculateReadDelay({
    contactType: contactTypeForDelay,
    messageLength: 50, // No tenemos el mensaje original acá, usar estimado
    isFirstMessage: false,
    hour: ownerHour,
    delayMultiplier: delayMult,
  });
  // Posible delay extra de "ocupado" (1 de cada 8)
  const busyMs = humanDelay.maybeBusyDelay(contactTypeForDelay);
  await delay(readMs + busyMs);

  try {
    // 2. Typing indicator DESPUÉS del delay de lectura (no antes)
    try { await tenantState.sock.sendPresenceUpdate('composing', phone); } catch (_) {}

    // 3. Delay de "escritura" proporcional al largo de la respuesta
    const typingMs = humanDelay.calculateTypingDelay({
      responseLength: content.length,
      contactType: contactTypeForDelay,
      delayMultiplier: delayMult,
    });
    await delay(typingMs);

    // Enviar
    await tenantState.sock.sendMessage(phone, { text: content });
    rateLimiter.recordOutgoing(tenantState.uid);
    try { require('../core/privacy_counters').recordOutgoing(tenantState.uid); } catch (_) {}
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
  loadBusinesses,
  loadContactGroups,
  classifyContact,
  saveBusinessLearning,
  savePersonalLearning,
  queueDubiousLearning,
  saveAgendaEvent,

  // Inyección de funciones de aprobación dinámica (llamar desde server.js al inicio)
  setApprovalFunctions,
};
