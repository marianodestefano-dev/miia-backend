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
  maybeAddTypo, isPotentialBot,
  detectMiiaTrigger, detectChauMiiaTrigger,
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
  buildInvokedPrompt, buildOutreachLeadPrompt, buildAgentSelfChatPrompt,
  buildADN, buildVademecum, resolveProfile, DEFAULT_OWNER_PROFILE
} = require('../core/prompt_builder');

const miiaInvocation = require('../core/miia_invocation');
const securityContacts = require('../services/security_contacts');
const { createCalendarEvent, getScheduleConfig: getCalScheduleConfig } = require('../core/google_calendar');
const outreachEngine = require('../core/outreach_engine');
const { applyMiiaEmoji } = require('../core/miia_emoji');

const aiGateway = require('../ai/ai_gateway');
const promptCache = require('../ai/prompt_cache');
const {
  shouldMiiaRespond, matchesBusinessKeywords, getOwnerBusinessKeywords,
  getOwnerClientKeywords, classifyUnknownContact, buildUnknownContactAlert
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
// 📊 HISTORY MINING CAPA 3 — Enriquecimiento incremental contact_index
// Cada mensaje enriquece el perfil del contacto en Firestore.
// Debounced: acumula en Map y flushea cada 30s en batch.
// ═══════════════════════════════════════════════════════════════
const _tmhContactIndexQueue = new Map();
let _tmhContactIndexFlushTimer = null;

/**
 * Encolar enriquecimiento de contact_index para un contacto.
 * NO escribe a Firestore inmediatamente — debounced 30s.
 */
function enrichContactIndex(ownerUid, phone, { messageBody, contactType, contactName, isFromContact } = {}) {
  if (!ownerUid || !phone) return;
  const basePhone = phone.split('@')[0].split(':')[0];
  if (!basePhone || basePhone.length < 8) return;

  const key = `${ownerUid}:${basePhone}`;
  const existing = _tmhContactIndexQueue.get(key) || {
    ownerUid,
    basePhone,
    lastMessageDate: new Date().toISOString(),
    messageCount: 0,
    ownerMessageCount: 0,
  };

  if (isFromContact) {
    existing.messageCount = (existing.messageCount || 0) + 1;
    existing.lastMessagePreview = (messageBody || '').substring(0, 100);
  } else {
    existing.ownerMessageCount = (existing.ownerMessageCount || 0) + 1;
  }
  if (contactType) existing.type = contactType;
  if (contactName) existing.name = contactName;
  existing.lastMessageDate = new Date().toISOString();
  existing.updatedAt = new Date().toISOString();

  _tmhContactIndexQueue.set(key, existing);

  if (!_tmhContactIndexFlushTimer) {
    _tmhContactIndexFlushTimer = setTimeout(_flushTmhContactIndex, 30000);
  }
}

async function _flushTmhContactIndex() {
  _tmhContactIndexFlushTimer = null;
  if (_tmhContactIndexQueue.size === 0) return;

  const batch = admin.firestore().batch();
  let count = 0;
  for (const [key, data] of _tmhContactIndexQueue) {
    const { ownerUid, basePhone, ...docData } = data;
    const ref = admin.firestore().collection('users').doc(ownerUid)
      .collection('contact_index').doc(basePhone);
    batch.set(ref, { ...docData, lastEnriched: new Date().toISOString() }, { merge: true });
    count++;
    if (count >= 450) break; // Firestore batch limit ~500
  }

  try {
    await batch.commit();
    let cleared = 0;
    for (const [key] of _tmhContactIndexQueue) {
      _tmhContactIndexQueue.delete(key);
      cleared++;
      if (cleared >= count) break;
    }
    console.log(`[TMH:CONTACT-INDEX] 📊 Enrichment flush: ${count} contactos actualizados`);
  } catch (e) {
    console.error(`[TMH:CONTACT-INDEX] ❌ Error flush: ${e.message}`);
  }

  if (_tmhContactIndexQueue.size > 0) {
    _tmhContactIndexFlushTimer = setTimeout(_flushTmhContactIndex, 30000);
  }
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
      // aiProvider: null = dejar que AI Gateway use CONTEXT_CONFIG automáticamente
      // Si el owner NO configuró un provider específico, dejar en null
      // 'gemini' como valor guardado = legacy, tratarlo como null para que CONTEXT_CONFIG decida
      aiProvider: (data.aiProvider && data.aiProvider !== 'gemini') ? data.aiProvider : null,
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
 * Busca en 2 rutas (la subcollección legacy Y el doc miia_persistent/contacts):
 *   1. users/{ownerUid}/familyContacts/  (subcollección, cada doc = 1 contacto)
 *   2. users/{ownerUid}/miia_persistent/contacts → campo familyContacts (objeto plano)
 * FIX Sesión 35: TMH solo buscaba en la subcollección, pero server.js guarda en miia_persistent.
 */
async function loadFamilyContacts(ownerUid) {
  try {
    const contacts = {};

    // Fuente 1: Subcollección legacy (familyContacts/{phone})
    const snap = await db().collection('users').doc(ownerUid).collection('familyContacts').get();
    snap.forEach(doc => { contacts[doc.id] = doc.data(); });

    // Fuente 2: miia_persistent/contacts (objeto familyContacts en un solo doc)
    if (Object.keys(contacts).length === 0) {
      const persistentDoc = await db().collection('users').doc(ownerUid)
        .collection('miia_persistent').doc('contacts').get();
      if (persistentDoc.exists) {
        const fc = persistentDoc.data()?.familyContacts || {};
        Object.assign(contacts, fc);
      }
    }

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
    const contacts = {};
    // Legacy: subcollection teamContacts/
    const snap = await db().collection('users').doc(ownerUid).collection('teamContacts').get();
    snap.forEach(doc => { contacts[doc.id] = doc.data(); });

    // Nuevo: contact_groups/equipo/contacts/
    try {
      const equipoSnap = await db().collection('users').doc(ownerUid)
        .collection('contact_groups').doc('equipo').collection('contacts').get();
      equipoSnap.forEach(doc => {
        if (!contacts[doc.id]) {
          contacts[doc.id] = { ...doc.data(), _fromGroup: 'equipo' };
        }
      });
    } catch (e2) { /* grupo equipo no existe, ok */ }

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
    const aiProvider = ctx.ownerProfile.aiProvider || null;
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
  const [ownerProfile, businessCerebro, personalBrain, familyContacts, teamContacts, scheduleConfig, businesses, contactGroups, agentProfile] = await Promise.all([
    loadOwnerProfile(ownerUid),
    loadBusinessCerebro(ownerUid),
    loadPersonalBrain(uid),
    // Familia y equipo: solo para owners (agents NO ven familia ajena)
    role === 'owner' ? loadFamilyContacts(ownerUid) : Promise.resolve({}),
    role === 'owner' ? loadTeamContacts(ownerUid) : Promise.resolve({}),
    loadScheduleConfig(ownerUid),
    loadBusinesses(ownerUid),
    role === 'owner' ? loadContactGroups(ownerUid) : Promise.resolve({}),
    // Nombre del agente para self-chat (solo si es agente)
    role === 'agent' ? loadOwnerProfile(uid) : Promise.resolve(null)
  ]);

  if (!ctx) {
    // 🛡️ FIX CRÍTICO: Cargar conversaciones persistidas desde Firestore
    // Sin esto, después de cada deploy MIIA pierde toda la info de leads
    // y dice "no tengo esa info" cuando le preguntan.
    let restoredConvos = {};
    let restoredContactTypes = {};
    let restoredLeadNames = {};
    let restoredMeta = {};
    let restoredOwnerActiveChats = {};
    try {
      const persistRef = admin.firestore().collection('users').doc(ownerUid).collection('miia_persistent');
      const convoDoc = await persistRef.doc('tenant_conversations').get();
      if (convoDoc.exists) {
        const d = convoDoc.data();
        restoredConvos = d.conversations || {};
        restoredContactTypes = d.contactTypes || {};
        restoredLeadNames = d.leadNames || {};
        restoredMeta = d.conversationMetadata || {};
        restoredOwnerActiveChats = d.ownerActiveChats || {};
        // Limpiar ownerActiveChats vencidos (>90min) para no arrastrar basura
        const COOLDOWN_MS = 90 * 60 * 1000;
        const nowClean = Date.now();
        for (const [ph, ts] of Object.entries(restoredOwnerActiveChats)) {
          if (nowClean - ts > COOLDOWN_MS) delete restoredOwnerActiveChats[ph];
        }
        const activeCount = Object.keys(restoredOwnerActiveChats).length;
        const convCount = Object.keys(restoredConvos).length;
        if (convCount > 0) {
          console.log(`[TMH:${uid}] 🔄 RESTORED: ${convCount} conversaciones, ${Object.keys(restoredLeadNames).length} leadNames, ${activeCount} ownerActiveChats desde Firestore`);
        }
      }
    } catch (e) {
      console.warn(`[TMH:${uid}] ⚠️ Error cargando conversaciones persistidas: ${e.message}`);
    }

    // Primera vez: crear contexto completo
    ctx = {
      uid,
      ownerUid,
      role,
      ownerProfile,
      agentProfile,  // null para owners, perfil del agente para agents
      conversations: restoredConvos,
      leadNames: restoredLeadNames,
      contactTypes: restoredContactTypes,
      familyContacts,
      teamContacts,
      conversationMetadata: restoredMeta,
      businessCerebro,
      personalBrain,
      ownerActiveChats: restoredOwnerActiveChats,
      subscriptionState: {},
      miiaActive: {},  // phone → timestamp — "Hola MIIA" guarda Date.now(), "Chau MIIA" borra. Auto-expira 10min sin actividad.
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
    ctx.agentProfile = agentProfile;
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

  // ── PASO 1b: @LID — Verificar si el owner responde a una consulta de identificación ──
  // checkOwnerLidResponse retorna:
  //   true  = mensaje consumido (solo clasificación, ej: "Es Juan") → no enviar a IA
  //   false = puede que haya resuelto LID pero el mensaje tiene contexto adicional → seguir a IA
  if (isSelfChat && role === 'owner') {
    try {
      const { checkOwnerLidResponse } = require('./tenant_manager');
      if (checkOwnerLidResponse(uid, messageBody)) {
        console.log(`${logPrefix} 🔍 LID-ID: Mensaje consumido como clasificación — no enviar a IA`);
        return;
      }
      // Si retornó false, el mensaje sigue al flujo normal (puede haber resuelto LID en background)
    } catch (e) {
      console.error(`${logPrefix} ⚠️ Error en checkOwnerLidResponse:`, e.message);
    }
  }

  // ── PASO 1c: Comandos de Contacto de Seguridad en self-chat ──
  if (isSelfChat && role === 'owner') {
    const secCmd = securityContacts.detectSecurityCommand(messageBody);
    if (secCmd) {
      console.log(`${logPrefix} 🛡️ SECURITY-CMD: ${secCmd.command}`);
      try {
        let secResponse = '';
        switch (secCmd.command) {
          case 'request_protection': {
            // "proteger a +54911..." — crear OTP para vincular
            const ownerName = ctx.ownerProfile?.shortName || ctx.ownerProfile?.name || 'Owner';
            const otp = await securityContacts.createSecurityOTP(uid, ownerName, secCmd.phone, 'emergencies_only');
            secResponse = `🛡️ *Contacto de Seguridad*\n\nGeneré un código para vincular a ${secCmd.phone}:\n\n🔑 *${otp.otp}*\n\nEsa persona debe escribirme el código en su chat conmigo para aceptar.\nExpira en 24 horas.`;
            break;
          }
          case 'accept_protection': {
            // Buscar solicitud pendiente donde este usuario es protegido
            const contacts = await securityContacts.getSecurityContacts(uid);
            const pending = contacts.find(c => c.direction === 'protegido' && c.status === 'pending');
            if (pending) {
              await securityContacts.respondToRequest(uid, pending.id, true);
              secResponse = `🛡️ ¡Aceptado! ${pending.partnerName || 'Tu protector'} ahora es tu contacto de seguridad (nivel: ${securityContacts.LEVEL_DESCRIPTIONS[pending.level]}).`;
            } else {
              secResponse = '🛡️ No tenés solicitudes de seguridad pendientes.';
            }
            break;
          }
          case 'reject_protection': {
            const contacts = await securityContacts.getSecurityContacts(uid);
            const pending = contacts.find(c => c.direction === 'protegido' && c.status === 'pending');
            if (pending) {
              await securityContacts.respondToRequest(uid, pending.id, false);
              secResponse = `🛡️ Rechazada la solicitud de ${pending.partnerName || 'un usuario'}.`;
            } else {
              secResponse = '🛡️ No tenés solicitudes de seguridad pendientes.';
            }
            break;
          }
          case 'list_protected': {
            const contacts = await securityContacts.getSecurityContacts(uid);
            const protected_ = contacts.filter(c => c.direction === 'protector' && c.status === 'active');
            if (protected_.length === 0) {
              secResponse = '🛡️ No tenés protegidos activos.';
            } else {
              secResponse = '🛡️ *Tus protegidos:*\n' + protected_.map(c => `- ${c.partnerName || c.partnerPhone} (${c.level})`).join('\n');
            }
            break;
          }
          case 'list_protectors': {
            const contacts = await securityContacts.getSecurityContacts(uid);
            const protectors = contacts.filter(c => c.direction === 'protegido' && c.status === 'active');
            if (protectors.length === 0) {
              secResponse = '🛡️ No tenés protectores activos.';
            } else {
              secResponse = '🛡️ *Tus protectores:*\n' + protectors.map(c => `- ${c.partnerName || c.partnerPhone} (${c.level})`).join('\n');
            }
            break;
          }
          case 'change_level': {
            const contacts = await securityContacts.getSecurityContacts(uid);
            const active = contacts.find(c => c.direction === 'protegido' && c.status === 'active');
            if (active) {
              await securityContacts.updateLevel(uid, active.id, secCmd.level);
              secResponse = `🛡️ Nivel cambiado a: *${securityContacts.LEVEL_DESCRIPTIONS[secCmd.level]}*`;
            } else {
              secResponse = '🛡️ No tenés relaciones de seguridad activas donde seas protegido.';
            }
            break;
          }
          case 'unlink': {
            const contacts = await securityContacts.getSecurityContacts(uid);
            const active = contacts.find(c => c.status === 'active');
            if (active) {
              await securityContacts.unlinkSecurityContact(uid, active.id, 'manual_selfchat');
              secResponse = `🛡️ Desvinculado de ${active.partnerName || 'tu contacto de seguridad'}.`;
            } else {
              secResponse = '🛡️ No tenés contactos de seguridad activos.';
            }
            break;
          }
          case 'check_protected': {
            // "cómo está mamá" — buscar protegido por nombre
            const contacts = await securityContacts.getSecurityContacts(uid);
            const match = contacts.find(c =>
              c.direction === 'protector' && c.status === 'active' &&
              (c.partnerName || '').toLowerCase().includes(secCmd.name.toLowerCase())
            );
            if (match) {
              const data = await securityContacts.getProtectedData(uid, match.partnerUid, match.id);
              if (data.authorized) {
                secResponse = `🛡️ *Estado de ${match.partnerName}* (nivel: ${data.level})\n`;
                if (data.data.alerts?.none) secResponse += '✅ Sin alertas activas\n';
                if (data.data.reminders?.length > 0) {
                  secResponse += `📅 ${data.data.reminders.length} recordatorios próximos\n`;
                }
                if (data.data.activitySummary) {
                  const phones = Object.keys(data.data.activitySummary);
                  secResponse += `💬 Actividad en ${phones.length} conversaciones`;
                }
              } else {
                secResponse = `🛡️ No tenés acceso: ${data.reason}`;
              }
            } else {
              // No es comando de seguridad, dejar pasar al flujo normal
              secResponse = '';
            }
            break;
          }
        }

        if (secResponse) {
          const { safeSendMessage } = require('./tenant_manager');
          await safeSendMessage(uid, phone, secResponse);
          return;
        }
      } catch (e) {
        console.error(`${logPrefix} ❌ Error en security command: ${e.message}`);
      }
    }

    // OTP de seguridad: si el mensaje es un código de 6 caracteres, intentar validar
    const otpMatch = messageBody.trim().match(/^[A-Z0-9]{6}$/);
    if (otpMatch) {
      try {
        const otpResult = await securityContacts.validateSecurityOTP(uid, otpMatch[0]);
        if (otpResult.valid) {
          // Vincular automáticamente
          await securityContacts.requestProtection(otpResult.protectorUid, uid, otpResult.level, {
            protectorName: otpResult.protectorName,
            protectedName: ctx.ownerProfile?.shortName || ctx.ownerProfile?.name || ''
          });
          const { safeSendMessage } = require('./tenant_manager');
          await safeSendMessage(uid, phone, `🛡️ ¡Vinculación exitosa! ${otpResult.protectorName} ahora es tu contacto de seguridad.\nNivel: ${securityContacts.LEVEL_DESCRIPTIONS[otpResult.level]}`);
          console.log(`${logPrefix} 🛡️ OTP validado — ${otpResult.protectorName} protege a ${uid}`);
          return;
        }
        // Si no es OTP válido, dejar pasar al flujo normal (puede ser otro código)
      } catch (e) {
        console.error(`${logPrefix} ⚠️ Error validando OTP de seguridad: ${e.message}`);
      }
    }
  }

  // ── PASO 2: Verificar horario ──
  // Excluidos del check: self-chat, familia, equipo, fromMe (mensajes del propio owner)
  if (!isSelfChat && !isFromMe && !isWithinScheduleConfig(ctx.scheduleConfig)) {
    // Check rápido: ¿es familia, equipo o contacto de grupo personal? → nunca bloquear por horario
    const isFamilyLegacy = ctx.familyContacts && ctx.familyContacts[basePhone];
    const isTeamLegacy = ctx.teamContacts && ctx.teamContacts[basePhone];
    // También buscar en contact_groups (familia, equipo, amigos, etc.)
    let isInContactGroup = false;
    if (ctx.contactGroups) {
      for (const gid of Object.keys(ctx.contactGroups)) {
        if (ctx.contactGroups[gid].contacts && ctx.contactGroups[gid].contacts[basePhone]) {
          isInContactGroup = true;
          break;
        }
      }
    }
    if (!isFamilyLegacy && !isTeamLegacy && !isInContactGroup) {
      console.log(`${logPrefix} ⏸️ Fuera de horario. Mensaje de ${basePhone} ignorado.`);
      return;
    }
    console.log(`${logPrefix} 🕐 Fuera de horario pero contacto es familia/equipo/grupo — permitido`);
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

  // ── PASO 6: Si es isFromMe pero NO self-chat → registrar presencia del owner y NO responder ──
  if (isFromMe && !isSelfChat) {
    // OWNER PRESENCE: marcar que el owner está activamente chateando con este contacto
    if (!ctx.ownerActiveChats) ctx.ownerActiveChats = {};
    ctx.ownerActiveChats[phone] = Date.now();
    console.log(`${logPrefix} 📝 Mensaje propio a ${basePhone} registrado (owner activo — MIIA callada por 30min).`);

    // ═══ AUTO-RECLASIFICACIÓN PROACTIVA: lead → client ═══
    // Si el owner dice palabras clave de cierre de venta a un lead → reclasificar a client
    // MIIA aprende silenciosamente. No pregunta. Lo reportará en el resumen matutino.
    const currentType = ctx.contactTypes[phone];
    if (currentType === 'lead') {
      const body = (messageBody || '').toLowerCase();
      const clientSignals = /\bbienvenid[oa]\b|\bacceso\s+activ|\bcontrato\b|\bcerramos\b|\bcliente\s+nuevo\b|\bya\s+(?:est[aá]s?|ten[eé]s)\b|\bte\s+(?:damos|dimos)\s+(?:la\s+)?bienvenida\b|\bactivamos\b|\btu\s+cuenta\b|\btu\s+usuario\b|\btu\s+acceso\b/i;
      if (clientSignals.test(body)) {
        console.log(`${logPrefix} 🔄 AUTO-RECLASIFICACIÓN: ${basePhone} de LEAD → CLIENT (owner dijo keyword de cierre)`);
        ctx.contactTypes[phone] = 'client';
        ctx.contactTypes[`${basePhone}@s.whatsapp.net`] = 'client';
        // Guardar en contact_index
        saveContactIndex(ctx.ownerUid, basePhone, {
          type: 'client',
          name: ctx.leadNames[phone] || '',
          source: 'auto_reclassified_from_lead',
          reclassifiedAt: new Date().toISOString()
        }).catch(() => {});
        // Acumular para reporte matutino (no notificar ahora — sentido común)
        if (!ctx._reclassifications) ctx._reclassifications = [];
        ctx._reclassifications.push({
          phone: basePhone,
          name: ctx.leadNames[phone] || basePhone,
          from: 'lead',
          to: 'client',
          trigger: messageBody.substring(0, 50),
          at: new Date().toISOString()
        });
      }
    }

    return;
  }

  // ── PASO 6b: OWNER PRESENCE CHECK — Si el owner envió un mensaje reciente, MIIA se calla ──
  if (!isSelfChat && ctx.ownerActiveChats && ctx.ownerActiveChats[phone]) {
    const OWNER_PRESENCE_COOLDOWN_MS = 90 * 60 * 1000; // 90 minutos (como promete el FAQ)
    const elapsed = Date.now() - ctx.ownerActiveChats[phone];
    if (elapsed < OWNER_PRESENCE_COOLDOWN_MS) {
      const minsAgo = Math.round(elapsed / 60000);
      console.log(`${logPrefix} 🤫 OWNER ACTIVO con ${basePhone} (hace ${minsAgo}min) — MIIA NO responde. Cooldown: ${Math.round((OWNER_PRESENCE_COOLDOWN_MS - elapsed) / 60000)}min restantes.`);
      return;
    } else {
      // Cooldown expirado → limpiar y permitir que MIIA responda
      delete ctx.ownerActiveChats[phone];
    }
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
  const isTranscribedAudio = !!messageContext?.isTranscribedAudio;
  const holaTrigger = detectMiiaTrigger(messageBody, isTranscribedAudio);
  const chauTrigger = detectChauMiiaTrigger(messageBody);
  const isHolaMiia = holaTrigger.trigger;
  const isChauMiia = chauTrigger.trigger;
  const isGroup = phone.endsWith('@g.us');
  const businessKeywords = getOwnerBusinessKeywords(ctx);

  if (holaTrigger.trigger) {
    console.log(`${logPrefix} 🎯 TRIGGER-DETECT: ${holaTrigger.match} (confidence=${holaTrigger.confidence}, audio=${isTranscribedAudio})`);
  } else if (holaTrigger.confidence !== 'none') {
    console.log(`${logPrefix} 🎯 TRIGGER-REJECT: ${holaTrigger.match} (confidence=${holaTrigger.confidence}, audio=${isTranscribedAudio})`);
  }
  if (chauTrigger.trigger) {
    console.log(`${logPrefix} 👋 CHAU-DETECT: ${chauTrigger.match}`);
  }

  // Actualizar estado de activación ANTES del gate
  // Auto-timeout: MIIA se desactiva si pasaron 10 minutos sin mensajes del contacto
  const MIIA_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
  if (ctx.miiaActive[phone] && !isHolaMiia) {
    const elapsed = Date.now() - ctx.miiaActive[phone];
    if (elapsed > MIIA_ACTIVE_TIMEOUT_MS) {
      delete ctx.miiaActive[phone];
      console.log(`${logPrefix} ⏰ MIIA auto-desactivada para ${basePhone} (${Math.round(elapsed / 60000)}min sin actividad)`);
    } else {
      // Renovar timestamp en cada mensaje (la ventana de 10min se reinicia)
      ctx.miiaActive[phone] = Date.now();
    }
  }
  if (isHolaMiia) {
    ctx.miiaActive[phone] = Date.now();
    console.log(`${logPrefix} 🟢 MIIA activada para ${basePhone} (trigger "${holaTrigger.match}")`);
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
    delete ctx.miiaActive[phone];
    console.log(`${logPrefix} 🔴 MIIA desactivada para ${basePhone} (trigger "Chau MIIA")`);
    const farewell = `¡Fue un gusto charlar! Cuando quieras hablar de nuevo, escribime *Hola MIIA* 😊`;
    ctx.conversations[phone].push({ role: 'assistant', content: farewell, timestamp: Date.now() });
    await sendTenantMessage(tenantState, phone, farewell);
    return;
  }

  // Acción: notificar al owner sobre contacto desconocido sin keywords
  // REGLA: Sin keyword match → MIIA NO EXISTE. Solo notifica al owner.
  // Si hay keyword match (lead o client) y 1 negocio → auto-clasificar.
  // Si hay keyword match y 2+ negocios → notificar al owner para que clasifique.
  if (gateDecision.action === 'notify_owner') {
    const businesses = ctx.businesses || [];
    if (businesses.length <= 1) {
      const bizId = businesses[0]?.id || null;
      const bizName = businesses[0]?.name || 'Mi Negocio';
      // Intentar distinguir: ¿es cliente existente (soporte) o lead nuevo?
      const leadKw = getOwnerBusinessKeywords(ctx);
      const clientKw = getOwnerClientKeywords(ctx);
      const classification = classifyUnknownContact(messageBody, leadKw, clientKw);

      if (classification.type === 'client') {
        console.log(`${logPrefix} 🏥 Desconocido ${basePhone} detectado como CLIENTE por keyword "${classification.keyword}" → modo soporte`);
        contactType = 'client';
        ctx.contactTypes[phone] = 'client';
        if (bizId) await saveContactIndex(ctx.ownerUid, basePhone, { type: 'client', businessId: bizId, name: messageContext?.pushName || '' });
        // Sobreescribir gateDecision para que MIIA responda
        gateDecision.respond = true;
        gateDecision.reason = 'auto_classified_client';
        gateDecision.action = 'none';
      } else if (classification.type === 'lead') {
        console.log(`${logPrefix} 🏷️ Desconocido ${basePhone} clasificado como lead por keyword "${classification.keyword}" → ${bizName}`);
        contactType = 'lead';
        ctx.contactTypes[phone] = 'lead';
        if (bizId) await saveContactIndex(ctx.ownerUid, basePhone, { type: 'lead', businessId: bizId, name: messageContext?.pushName || '' });
        // Sobreescribir gateDecision para que MIIA responda
        gateDecision.respond = true;
        gateDecision.reason = 'auto_classified_lead';
        gateDecision.action = 'none';
      } else {
        // SIN keyword match → MIIA NO EXISTE. Notificar al owner y callar.
        const ownerJid = tenantState.sock?.user?.id;
        if (ownerJid) {
          const pushName = messageContext?.pushName || '';
          const phoneDigits = (basePhone || '').replace(/[^0-9]/g, '');
          const isLid = phoneDigits.length > 13;
          const alertMsg = buildUnknownContactAlert(basePhone, messageBody, pushName, { isLid });
          try {
            await sendTenantMessage(tenantState, ownerJid, alertMsg);
            console.log(`${logPrefix} 📢 Owner notificado: desconocido ${isLid ? (pushName || 'LID') : basePhone} sin keyword match (MIIA callada)`);
          } catch (e) {
            console.error(`${logPrefix} ❌ Error notificando al owner sobre desconocido:`, e.message);
          }
        }
        console.log(`${logPrefix} 🤫 Sin keyword match para ${basePhone} — MIIA NO EXISTE (no auto-clasificar sin evidencia)`);
        // gateDecision.respond sigue en false → silencio total
      }
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

  if (isSelfChat && role === 'agent') {
    // ── SELF-CHAT AGENTE: Solo negocio, NO personal ──
    const agentName = ctx.agentProfile?.shortName || ctx.agentProfile?.name || 'Agente';
    const businessName = ctx.ownerProfile?.businessName || (ctx.businesses?.[0]?.name) || 'el negocio';
    activeSystemPrompt = buildAgentSelfChatPrompt(agentName, businessName, ctx.businessCerebro, ctx.ownerProfile);
    if (countryContext) activeSystemPrompt += `\n\n${countryContext}`;
    console.log(`[TMH:${uid}] 📋 AGENT SELF-CHAT: ${agentName} → prompt negocio-only (${businessName})`);
  } else if (isSelfChat) {
    // ── SELF-CHAT OWNER: Completo (personal + negocios + contactos) ──
    activeSystemPrompt = buildOwnerSelfChatPrompt(ctx.ownerProfile);
    // Inyectar lista de negocios si tiene más de 1
    if (ctx.businesses && ctx.businesses.length > 1) {
      const bizList = ctx.businesses.map((b, i) => `${i + 1}. ${b.name}${b.description ? ' — ' + b.description.substring(0, 60) : ''}`).join('\n');
      activeSystemPrompt += `\n\n## TUS NEGOCIOS\nTenés ${ctx.businesses.length} negocios registrados:\n${bizList}\nCuando un contacto nuevo escriba, MIIA te consultará a qué negocio asignarlo.`;
    }
    // Inyectar lista de contactos conocidos para que MIIA sepa quién es quién
    const knownPeople = [];
    if (ctx.familyContacts) {
      for (const [ph, fc] of Object.entries(ctx.familyContacts)) {
        if (fc.name) knownPeople.push(`- ${fc.name} (familia) — ${ph}`);
      }
    }
    if (ctx.teamContacts) {
      for (const [ph, tc] of Object.entries(ctx.teamContacts)) {
        if (tc.name) knownPeople.push(`- ${tc.name} (equipo) — ${ph}`);
      }
    }
    if (ctx.contactGroups) {
      for (const [gid, group] of Object.entries(ctx.contactGroups)) {
        if (gid === 'familia' || gid === 'equipo') continue; // ya cubiertos arriba
        for (const [ph, c] of Object.entries(group.contacts || {})) {
          if (c.name) knownPeople.push(`- ${c.name} (${group.name || gid}) — ${ph}`);
        }
      }
    }
    if (knownPeople.length > 0) {
      activeSystemPrompt += `\n\n## CONTACTOS CONOCIDOS DE ${ctx.ownerProfile?.shortName || 'OWNER'}\n${knownPeople.join('\n')}\nSi te preguntan "¿quién es X?", buscá en esta lista. Si no está, decí que no lo conocés y preguntá si querés que lo registres.`;
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

  } else if (contactType === 'client') {
    // ═══ CLIENTE EXISTENTE DEL NEGOCIO → MODO SOPORTE ═══
    // Usa el cerebro del negocio pero con instrucciones de SOPORTE, no de venta
    let clientCerebro = ctx.businessCerebro;
    const clientBizId = classification?.businessId || ctx.businesses?.[0]?.id;
    const clientBizName = ctx.businesses?.find(b => b.id === clientBizId)?.name || ctx.businesses?.[0]?.name || 'el negocio';
    if (clientBizId) {
      try {
        const bizBrainDoc = await db().collection('users').doc(ctx.ownerUid)
          .collection('businesses').doc(clientBizId)
          .collection('brain').doc('business_cerebro').get();
        if (bizBrainDoc.exists && bizBrainDoc.data().content) {
          clientCerebro = bizBrainDoc.data().content;
        }
      } catch (_) {}
    }
    const clientName = ctx.leadNames[phone] || '';
    const ownerName = ctx.ownerProfile?.shortName || ctx.ownerProfile?.name || '';
    console.log(`${logPrefix} 🏥 Cliente de ${clientBizName} (${clientName}) → prompt de SOPORTE con cerebro del negocio`);

    activeSystemPrompt = `Sos ${ownerName}, responsable de ${clientBizName}. Este contacto YA es cliente tuyo. NO le vendas — AYUDALO.

## INFORMACIÓN DE TU NEGOCIO
${clientCerebro || 'Sin información adicional del negocio.'}

## TU ROL
Sos soporte de ${clientBizName}. Este usuario YA usa tu producto/servicio. Tu trabajo es:
- Si tiene un problema → guiarlo paso a paso usando tu conocimiento del negocio
- Si no sabe cómo usar algo → explicarle con paciencia
- Si tiene una queja → escuchar, ser empático, y ofrecer solución
- Si necesita algo que no podés resolver → decirle "Lo consulto con el equipo y te aviso"
- Si pregunta por algo que no sabés → ser honesto: "No tengo esa info ahora, lo verifico y te confirmo"

## TONO
Profesional, empático, resolutivo. Este usuario PAGA — merece atención de primera.
NUNCA le hagas pitch de venta. Es TU cliente, no tu prospecto.
${countryContext ? countryContext : ''}
- Máximo 2-3 líneas por mensaje, directo al punto
- Usá emojis moderadamente (1-2 por mensaje)
- NUNCA reveles que sos IA
- NUNCA menciones "HOLA MIIA", "CHAU MIIA" ni comandos de activación. El cliente NO sabe que sos MIIA — sos ${ownerName}.`;

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
    // Cargar perfil del contacto desde contact_index (History Mining)
    let contactProfile = null;
    try {
      const cpDoc = await admin.firestore().collection('users').doc(ctx.ownerUid)
        .collection('contact_index').doc(basePhone).get();
      if (cpDoc.exists) {
        contactProfile = cpDoc.data();
        console.log(`[TMH:${ctx.ownerUid}] 📋 ContactProfile cargado para ${basePhone}: ${contactProfile.type}, ${contactProfile.messageCount || 0} msgs previos`);
      }
    } catch (_) {}
    activeSystemPrompt = buildOwnerLeadPrompt(ctx.leadNames[phone] || '', leadCerebro, countryContext, ctx.ownerProfile, contactProfile);
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

  // ══════════════════════════════════════════════════════════════════
  // 🛡️ INTEGRITY GUARD: LEADS SUMMARY EN SELF-CHAT
  // ══════════════════════════════════════════════════════════════════
  // Inyecta resumen de leads/contactos recientes para que MIIA pueda
  // responder "¿quién escribió?", "¿cómo van los leads?", etc.
  // Sin esto, MIIA dice "no tengo visibilidad de leads" en self-chat.
  //
  // ⚠️ PROHIBIDO ELIMINAR — Sin este bloque, el owner pregunta por
  // sus leads y MIIA no sabe nada. Verificado 10-Abr-2026.
  // ══════════════════════════════════════════════════════════════════
  let leadsSummaryStr = '';
  if (isSelfChat && ctx.conversations && ctx.contactTypes) {
    try {
      const leadEntries = Object.entries(ctx.conversations)
        .filter(([ph]) => {
          const ct = ctx.contactTypes[ph];
          return ct === 'lead' || ct === 'client' || ct === 'miia_lead' || ct === 'miia_client' || (!ct && ph !== phone && !ctx.familyContacts?.[ph.replace(/@.*/, '')]);
        })
        .map(([ph, msgs]) => {
          const lastMsg = msgs.filter(m => m.role === 'user').slice(-1)[0];
          const name = ctx.leadNames?.[ph] || ph.replace(/@.*/, '');
          const ago = lastMsg?.timestamp ? Math.round((Date.now() - lastMsg.timestamp) / 60000) : null;
          const agoStr = ago != null ? (ago < 60 ? `hace ${ago}min` : ago < 1440 ? `hace ${Math.round(ago/60)}h` : `hace ${Math.round(ago/1440)}d`) : '';
          const preview = lastMsg?.content?.substring(0, 80) || '';
          return { name, agoStr, preview, lastTs: lastMsg?.timestamp || 0, totalMsgs: msgs.length };
        })
        .filter(e => e.lastTs > 0)
        .sort((a, b) => b.lastTs - a.lastTs)
        .slice(0, 10);

      if (leadEntries.length > 0) {
        const lines = leadEntries.map(e =>
          `- ${e.name} (${e.agoStr}, ${e.totalMsgs} msgs): "${e.preview}"`
        );
        leadsSummaryStr = `\n\n[ACTIVIDAD RECIENTE DE CONTACTOS — ${leadEntries.length}]:\n${lines.join('\n')}\nUsa esta info si te preguntan por leads, contactos, o quién escribió. NO la muestres si no la piden.`;
        console.log(`${logPrefix} 📊 LEADS-SUMMARY: ${leadEntries.length} contactos inyectados al self-chat prompt`);
      }
    } catch (lsErr) {
      console.warn(`${logPrefix} ⚠️ LEADS-SUMMARY error (no bloquea): ${lsErr.message}`);
    }
  }

  // Ensamblado final del prompt
  const fullPrompt = `${activeSystemPrompt}

${syntheticMemoryStr}${countryContext ? '\n\n' + countryContext : ''}${trustTone}${masterIdentityStr}${personalStr}${cerebroStr ? '\n\n[ADN VENTAS — CONOCIMIENTO DE NEGOCIO]:\n' + cerebroStr : ''}${pendingStr}${leadsSummaryStr}

${systemDateStr}

[HISTORIAL DE CONVERSACIÓN RECIENTE]:
${history}

MIIA, genera tu respuesta breve, estratégica y humana:`;

  // ── PASO 10: Llamar a la IA via AI Gateway (P5.3 — failover cross-provider) ──
  // aiProvider: null = dejar que AI Gateway use CONTEXT_CONFIG (owner_chat→claude, leads→gemini, etc.)
  const aiProvider = ctx.ownerProfile.aiProvider || null;
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

  // Google Search: activo en TODOS los contextos (self-chat, familia, leads, clientes)
  // Sin Search, MIIA no puede responder preguntas casuales ("cuándo juega Boca?") ni dar info actualizada
  const enableSearch = true;
  console.log(`${logPrefix} 🔍 Google Search activo — ${isSelfChat ? 'self-chat' : contactType}`);

  let aiMessage;
  const aiResult = await aiGateway.smartCall(
    aiContext,
    fullPrompt,
    { aiProvider, aiApiKey },
    { enableSearch }
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
  const postChatType = isSelfChat ? 'selfchat' : contactType === 'lead' ? 'lead' : 'family';
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
        const regenResult = await aiGateway.smartCall(aiContext, fullPrompt + hint, { aiProvider, aiApiKey }, { enableSearch });
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
          const regenResult = await aiGateway.smartCall(aiContext, fullPrompt + hint, { aiProvider, aiApiKey }, { enableSearch });
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

  // 11d-RESPONDELE. Tag [RESPONDELE:destinatario|instrucción] — Owner pide enviar mensaje a contacto
  const respondeleTagMatch = aiMessage.match(/\[RESPONDELE:([^\]]+)\]/);
  if (respondeleTagMatch && isSelfChat) {
    const tagParts = respondeleTagMatch[1].split('|').map(p => p.trim());
    const destinatario = tagParts[0] || '';
    const instruccion = tagParts[1] || 'responder profesionalmente';
    console.log(`${logPrefix} [RESPONDELE-TAG] 📨 Tag detectado: destino="${destinatario}", instrucción="${instruccion}"`);

    try {
      let contactJid = null;
      let leadPhone = '';

      // 1. Si es un número directo
      const phoneDigits = destinatario.replace(/[^0-9]/g, '');
      if (phoneDigits.length >= 10) {
        leadPhone = phoneDigits;
        contactJid = `${leadPhone}@s.whatsapp.net`;
        console.log(`${logPrefix} [RESPONDELE-TAG] 📱 Número directo: ${contactJid}`);
      }

      // 2. Si es "último_contacto" → buscar última alerta en conversación
      if (!contactJid && /^[uú]ltimo|^last|^reciente/i.test(destinatario)) {
        const selfConv = ctx.conversations[phone] || [];
        const recentMsgs = selfConv.slice(-20);
        const alertMsg = recentMsgs.find(m => m.role === 'assistant' && (/Nuevo mensaje/.test(m.content) || /Alguien te escribi[oó]/.test(m.content)));
        if (alertMsg?._contactJid) {
          contactJid = alertMsg._contactJid;
          leadPhone = contactJid.split('@')[0];
        } else if (alertMsg) {
          const pm = alertMsg.content.match(/(?:Número:\s*\+?|Contacto:.*?\(\+?)(\d{10,18})/);
          if (pm) { leadPhone = pm[1]; contactJid = `${leadPhone}@s.whatsapp.net`; }
        }
        if (contactJid) console.log(`${logPrefix} [RESPONDELE-TAG] 🎯 Último contacto: ${contactJid}`);
      }

      // 3. Si es un nombre → buscar en contactos registrados
      if (!contactJid && destinatario.length >= 2) {
        const destLower = destinatario.toLowerCase();
        // 3a. Buscar en contact_groups (equipo, familia, etc.)
        if (ctx.contactGroups) {
          for (const [gid, group] of Object.entries(ctx.contactGroups)) {
            for (const [ph, c] of Object.entries(group.contacts || {})) {
              if (c.name && c.name.toLowerCase().includes(destLower)) {
                leadPhone = ph;
                contactJid = `${leadPhone}@s.whatsapp.net`;
                console.log(`${logPrefix} [RESPONDELE-TAG] 👤 Encontrado en grupo "${gid}" por nombre "${destinatario}" → ${contactJid}`);
                break;
              }
            }
            if (contactJid) break;
          }
        }
        // 3b. Buscar en familyContacts
        if (!contactJid && ctx.familyContacts) {
          for (const [ph, fc] of Object.entries(ctx.familyContacts)) {
            if (fc.name && fc.name.toLowerCase().includes(destLower)) {
              leadPhone = ph;
              contactJid = `${leadPhone}@s.whatsapp.net`;
              console.log(`${logPrefix} [RESPONDELE-TAG] 👤 Encontrado en familia por nombre "${destinatario}" → ${contactJid}`);
              break;
            }
          }
        }
        // 3c. Buscar en teamContacts
        if (!contactJid && ctx.teamContacts) {
          for (const [ph, tc] of Object.entries(ctx.teamContacts)) {
            if (tc.name && tc.name.toLowerCase().includes(destLower)) {
              leadPhone = ph;
              contactJid = `${leadPhone}@s.whatsapp.net`;
              console.log(`${logPrefix} [RESPONDELE-TAG] 👤 Encontrado en equipo por nombre "${destinatario}" → ${contactJid}`);
              break;
            }
          }
        }
        // 3d. Buscar en conversaciones por pushName
        if (!contactJid) {
          for (const [convJid, msgs] of Object.entries(ctx.conversations || {})) {
            if (convJid === phone || !convJid.includes('@')) continue;
            const lastMsg = msgs.slice(-5).find(m => m.role === 'user');
            if (lastMsg?._pushName && lastMsg._pushName.toLowerCase().includes(destLower)) {
              contactJid = convJid;
              leadPhone = convJid.split('@')[0];
              console.log(`${logPrefix} [RESPONDELE-TAG] 👤 Encontrado por pushName "${destinatario}" → ${contactJid}`);
              break;
            }
          }
        }
        // 3e. Buscar en contact_index por nombre
        if (!contactJid) {
          try {
            const indexSnap = await db().collection('users').doc(ownerUid).collection('contact_index')
              .where('name', '>=', destinatario).where('name', '<=', destinatario + '\uf8ff').limit(1).get();
            if (!indexSnap.empty) {
              leadPhone = indexSnap.docs[0].id;
              contactJid = `${leadPhone}@s.whatsapp.net`;
              console.log(`${logPrefix} [RESPONDELE-TAG] 👤 Encontrado en contact_index "${destinatario}" → ${contactJid}`);
            }
          } catch (e) { /* contact_index query failed, ok */ }
        }
      }

      // 4. BROADCAST: FAMILIA o EQUIPO — enviar a todos los contactos del grupo
      if (!contactJid && /^FAMILIA$/i.test(destinatario)) {
        const groupContacts = { ...(ctx.familyContacts || {}) };
        if (ctx.contactGroups?.familia?.contacts) Object.assign(groupContacts, ctx.contactGroups.familia.contacts);
        const targets = Object.entries(groupContacts).filter(([, c]) => c.name);
        if (targets.length > 0 && tenantState.sock && tenantState.isReady) {
          const ownerName = ctx.ownerProfile?.shortName || ctx.ownerProfile?.name || 'tu owner';
          const broadcastPrompt = `Sos MIIA, la asistente de ${ownerName}. Tu jefe quiere enviar este mensaje a toda su familia: "${instruccion}". Máx 3 líneas, cálido y familiar. JAMÁS decir que sos IA.`;
          const broadResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, broadcastPrompt, { aiProvider, aiApiKey });
          const broadText = broadResult?.text || instruccion;
          let sent = 0;
          for (const [targetPh] of targets) {
            try {
              await tenantState.sock.sendMessage(`${targetPh}@s.whatsapp.net`, { text: broadText });
              sent++;
            } catch (e) { console.warn(`${logPrefix} [RESPONDELE-TAG] ⚠️ Broadcast familia: fallo enviando a ${targetPh}: ${e.message}`); }
          }
          console.log(`${logPrefix} [RESPONDELE-TAG] 📢 Broadcast FAMILIA: ${sent}/${targets.length} enviados`);
        }
      } else if (!contactJid && /^EQUIPO$/i.test(destinatario)) {
        const groupContacts = { ...(ctx.teamContacts || {}) };
        if (ctx.contactGroups?.equipo?.contacts) Object.assign(groupContacts, ctx.contactGroups.equipo.contacts);
        const targets = Object.entries(groupContacts).filter(([, c]) => c.name);
        if (targets.length > 0 && tenantState.sock && tenantState.isReady) {
          const ownerName = ctx.ownerProfile?.shortName || ctx.ownerProfile?.name || 'tu owner';
          const broadcastPrompt = `Sos MIIA, la asistente de ${ownerName}. Tu jefe quiere enviar este mensaje a su equipo de trabajo: "${instruccion}". Máx 3 líneas, profesional pero cálido. JAMÁS decir que sos IA.`;
          const broadResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, broadcastPrompt, { aiProvider, aiApiKey });
          const broadText = broadResult?.text || instruccion;
          let sent = 0;
          for (const [targetPh] of targets) {
            try {
              await tenantState.sock.sendMessage(`${targetPh}@s.whatsapp.net`, { text: broadText });
              sent++;
            } catch (e) { console.warn(`${logPrefix} [RESPONDELE-TAG] ⚠️ Broadcast equipo: fallo enviando a ${targetPh}: ${e.message}`); }
          }
          console.log(`${logPrefix} [RESPONDELE-TAG] 📢 Broadcast EQUIPO: ${sent}/${targets.length} enviados`);
        }
      } else if (contactJid && leadPhone && tenantState.sock && tenantState.isReady) {
        // Envío individual — generar respuesta personalizada
        const ownerName = ctx.ownerProfile?.name || ctx.ownerProfile?.shortName || 'el equipo';
        const businessName = ctx.ownerProfile?.businessName || '';
        const leadOriginalMsg = (ctx.conversations[contactJid] || []).slice(-3).find(m => m.role === 'user')?.content || '';
        const respondPrompt = `Sos MIIA, la asistente de ${ownerName}${businessName ? ` de ${businessName}` : ''}.
${leadOriginalMsg ? `El contacto escribió antes: "${leadOriginalMsg.substring(0, 200)}"` : ''}
Tu jefe te pide: "${instruccion}"

REGLAS:
- Máx 3 líneas, cálido y profesional
- JAMÁS decir que sos IA
- JAMÁS mencionar "me pidieron", "mi jefe", "el owner"`;

        const responseResult = await aiGateway.smartCall(aiGateway.CONTEXTS.GENERAL, respondPrompt, { aiProvider, aiApiKey });
        const msgText = responseResult?.text || '';
        if (msgText) {
          await tenantState.sock.sendMessage(contactJid, { text: msgText });
          console.log(`${logPrefix} [RESPONDELE-TAG] ✅ Mensaje enviado a ${contactJid}: "${msgText.substring(0, 60)}..."`);
        }
      } else if (!contactJid && !/^FAMILIA$|^EQUIPO$/i.test(destinatario)) {
        console.warn(`${logPrefix} [RESPONDELE-TAG] ⚠️ No se encontró contacto para "${destinatario}"`);
      } else if (!tenantState.sock || !tenantState.isReady) {
        console.warn(`${logPrefix} [RESPONDELE-TAG] ⚠️ Socket no disponible para enviar a "${destinatario}"`);
      }
    } catch (e) {
      console.error(`${logPrefix} [RESPONDELE-TAG] ❌ Error:`, e.message);
    }
    aiMessage = aiMessage.replace(/\[RESPONDELE:[^\]]+\]/g, '').trim();
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

  // Guardar largo del mensaje entrante para human_delay contextual
  if (ctx) ctx._lastIncomingLength = (messageBody || '').length;

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

  // ── PASO 13b: 📊 HISTORY MINING CAPA 3 — Enriquecer contact_index ──
  if (ctx.ownerUid && !isSelfChat) {
    enrichContactIndex(ctx.ownerUid, phone, {
      messageBody,
      contactType: contactType || 'lead',
      contactName: ctx.leadNames[phone] || leadName || '',
      isFromContact: true
    });
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

  // ═══ HUMAN DELAY: SOLO para leads/clientes — NUNCA en self-chat ni grupos ═══
  // 🛡️ FIX: sock.user.id tiene sufijo ":94" (ej: 573163937365:94@s.whatsapp.net)
  //    vs phone es "573163937365@s.whatsapp.net" → comparación directa SIEMPRE falla
  const ctx = tenantContexts.get(tenantState.uid);
  const sockUserId = tenantState.sock?.user?.id || '';
  const sockBasePhone = sockUserId.split(':')[0].split('@')[0];
  const targetBasePhone = phone.split('@')[0];
  const isSelfChatMsg = sockBasePhone === targetBasePhone;
  const isGroupMsg = phone.endsWith('@g.us');

  if (!isSelfChatMsg && !isGroupMsg) {
    // 🛡️ FIX: Usar contactType REAL del contacto, no hardcodeado 'lead'
    // Sin esto, familia/equipo reciben delay de lead (2.5-15s + chance 20-45s busy)
    const contactTypeForDelay = ctx?.contactTypes?.[phone] || ctx?.contactTypes?.[`${targetBasePhone}@s.whatsapp.net`] || 'lead';

    // Verificar si el grupo del contacto tiene humanDelay desactivado
    let groupHumanDelayOff = false;
    if (ctx?.contactGroups) {
      for (const [, group] of Object.entries(ctx.contactGroups)) {
        if (group.contacts && group.contacts[targetBasePhone]) {
          if (group.humanDelayEnabled === false) {
            groupHumanDelayOff = true;
            console.log(`[TMH:${tenantState.uid}] ⏱️ HUMAN-DELAY OFF por config de grupo "${group.name}"`);
          }
          break;
        }
      }
    }
    if (groupHumanDelayOff) {
      // Skip delay — owner desactivó delay para este grupo
    } else {
    const ownerHour = humanDelay.getOwnerHour(ctx?.ownerProfile?.timezone);
    const rlLevel = rateLimiter.getLevel(tenantState.uid);
    const delayMult = rlLevel.level.delayMultiplier || 1;
    const incomingMsgLen = ctx?._lastIncomingLength || content.length;

    console.log(`[TMH:${tenantState.uid}] ⏱️ HUMAN-DELAY: tipo=${contactTypeForDelay}, msgLen=${incomingMsgLen}, hour=${ownerHour}`);

    // 1. Delay de "lectura" (antes de empezar a escribir)
    const readMs = humanDelay.calculateReadDelay({
      contactType: contactTypeForDelay,
      messageLength: incomingMsgLen,
      isFirstMessage: !ctx?.conversations?.[phone],
      hour: ownerHour,
      delayMultiplier: delayMult,
    });
    // Posible delay extra de "ocupado" (1 de cada 8) — NUNCA para familia/equipo
    const busyMs = (contactTypeForDelay === 'familia' || contactTypeForDelay === 'equipo')
      ? 0
      : humanDelay.maybeBusyDelay(contactTypeForDelay);
    await delay(readMs + busyMs);

    try { await tenantState.sock.sendPresenceUpdate('composing', phone); } catch (_) {}

    // 2. Delay de "escritura" proporcional al largo de la respuesta
    const typingMs = humanDelay.calculateTypingDelay({
      responseLength: content.length,
      contactType: contactTypeForDelay,
      delayMultiplier: delayMult,
    });
    await delay(typingMs);
    } // end else (groupHumanDelayOff)
  }

  try {

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
// PERSISTENCIA DE CONVERSACIONES — Sobrevive deploys
// ═══════════════════════════════════════════════════════════════

/**
 * Persiste conversaciones, contactTypes y leadNames a Firestore.
 * Se llama periódicamente desde server.js (cada 2min) para que
 * después de un deploy MIIA sepa quién escribió.
 */
async function persistTenantConversations() {
  for (const [uid, ctx] of tenantContexts.entries()) {
    if (!ctx.ownerUid || Object.keys(ctx.conversations).length === 0) continue;
    try {
      // Recortar a últimos 20 contactos y últimos 5 msgs cada uno
      const trimmed = {};
      const sorted = Object.entries(ctx.conversations)
        .filter(([, msgs]) => msgs.length > 0)
        .sort((a, b) => {
          const lastA = a[1][a[1].length - 1]?.timestamp || 0;
          const lastB = b[1][b[1].length - 1]?.timestamp || 0;
          return lastB - lastA;
        })
        .slice(0, 20);
      for (const [ph, msgs] of sorted) {
        trimmed[ph] = msgs.slice(-5);
      }

      await admin.firestore()
        .collection('users').doc(ctx.ownerUid)
        .collection('miia_persistent').doc('tenant_conversations')
        .set({
          conversations: trimmed,
          contactTypes: ctx.contactTypes || {},
          leadNames: ctx.leadNames || {},
          conversationMetadata: ctx.conversationMetadata || {},
          ownerActiveChats: ctx.ownerActiveChats || {},
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) {
      console.warn(`[TMH:${uid}] ⚠️ Error persistiendo conversaciones: ${e.message}`);
    }
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

  // Setear clasificación desde fuera (LID resolution, etc.)
  setContactType: (uid, phone, type) => {
    const ctx = tenantContexts.get(uid);
    if (ctx) { ctx.contactTypes[phone] = type; ctx.contactTypes[`${phone}@s.whatsapp.net`] = type; }
  },
  setLeadName: (uid, phone, name) => {
    const ctx = tenantContexts.get(uid);
    if (ctx) { ctx.leadNames[phone] = name; ctx.leadNames[`${phone}@s.whatsapp.net`] = name; }
  },

  // Persistencia de conversaciones (llamar periódicamente desde server.js)
  persistTenantConversations,

  // Inyección de funciones de aprobación dinámica (llamar desde server.js al inicio)
  setApprovalFunctions,
};
