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
const featureAnnouncer = require('../core/feature_announcer');
const securityContacts = require('../services/security_contacts');
const { createCalendarEvent, getScheduleConfig: getCalScheduleConfig, checkCalendarAvailability } = require('../core/google_calendar');
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
const { validatePreSend } = require('../core/miia_validator');

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
// FUZZY PHONE LOOKUP — BUG1-FIX
// ═══════════════════════════════════════════════════════════════

/**
 * Busca un teléfono en un objeto de contactos con matching fuzzy.
 * Resuelve el problema de formatos inconsistentes (LID→phone, con/sin prefijo país).
 *
 * Intento 1: match exacto contacts[basePhone]
 * Intento 2: suffix match — últimos 10 dígitos (cubre variantes de código país)
 * Intento 3: Argentina celular — normalizar 549XX → 54XX y viceversa
 *
 * @param {Object} contacts - { phone: data }
 * @param {string} basePhone - Teléfono a buscar (ya sin @s.whatsapp.net)
 * @returns {{ key: string, data: Object } | null}
 */
function fuzzyPhoneLookup(contacts, basePhone) {
  if (!contacts || !basePhone) return null;

  // Intento 1: exacto
  if (contacts[basePhone]) {
    return { key: basePhone, data: contacts[basePhone] };
  }

  const digits = basePhone.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;

  // Intento 2: suffix match — últimos 10 dígitos
  const suffix = digits.slice(-10);
  for (const [key, data] of Object.entries(contacts)) {
    const keyDigits = key.replace(/[^0-9]/g, '');
    if (keyDigits.length >= 10 && keyDigits.slice(-10) === suffix) {
      return { key, data };
    }
  }

  // Intento 3: Argentina celular — 549XXXXXXXXXX ↔ 54XXXXXXXXXXX
  // Formato con 9 (celular): 5491164431700 → sin 9: 541164431700
  // Y viceversa
  if (digits.startsWith('549') && digits.length >= 12) {
    const without9 = '54' + digits.substring(3);
    if (contacts[without9]) return { key: without9, data: contacts[without9] };
  } else if (digits.startsWith('54') && !digits.startsWith('549') && digits.length >= 11) {
    const with9 = '549' + digits.substring(2);
    if (contacts[with9]) return { key: with9, data: contacts[with9] };
  }

  return null;
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
  // BUG1-FIX: Usar fuzzyPhoneLookup para resolver formatos inconsistentes (LID→phone, 549XX vs 54XX)
  for (const [gid, group] of Object.entries(ctx.contactGroups || {})) {
    if (group.contacts) {
      const exactMatch = group.contacts[basePhone];
      const fuzzyMatch = !exactMatch ? fuzzyPhoneLookup(group.contacts, basePhone) : null;
      const contactData = exactMatch || fuzzyMatch?.data;
      if (contactData) {
        const matchKey = exactMatch ? basePhone : fuzzyMatch.key;
        console.log(`${logPrefix} 📇 PASO 1: Encontrado en grupo "${group.name}" (${gid})${fuzzyMatch ? ` [FUZZY: ${basePhone}→${matchKey}]` : ''}`);
        await saveContactIndex(ownerUid, basePhone, { type: 'group', groupId: gid, groupName: group.name, name: contactData.name });
        return { type: 'group', groupId: gid, groupData: group, name: contactData.name };
      }
    }
  }

  // Legacy: familia/equipo hardcodeados — con fuzzy matching
  const familyMatch = fuzzyPhoneLookup(ctx.familyContacts, basePhone);
  if (familyMatch) {
    console.log(`${logPrefix} 📇 PASO 1 (legacy): familia → ${familyMatch.data.name}${familyMatch.key !== basePhone ? ` [FUZZY: ${basePhone}→${familyMatch.key}]` : ''}`);
    return { type: 'familia', name: familyMatch.data.name };
  }
  const teamMatch = fuzzyPhoneLookup(ctx.teamContacts, basePhone);
  if (teamMatch) {
    console.log(`${logPrefix} 📇 PASO 1 (legacy): equipo → ${teamMatch.data.name}${teamMatch.key !== basePhone ? ` [FUZZY: ${basePhone}→${teamMatch.key}]` : ''}`);
    return { type: 'equipo', name: teamMatch.data.name };
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

  // ═══ TRY/CATCH GLOBAL — Protección contra crash silencioso ═══
  // Sin esto, un error no capturado en cualquier tag handler = MIIA se calla y el owner no sabe por qué
  try {

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
    // BUG1-FIX: Usar fuzzyPhoneLookup para que LIDs resueltos y variantes de formato matcheen
    const isFamilyLegacy = ctx.familyContacts && !!fuzzyPhoneLookup(ctx.familyContacts, basePhone);
    const isTeamLegacy = ctx.teamContacts && !!fuzzyPhoneLookup(ctx.teamContacts, basePhone);
    // También buscar en contact_groups (familia, equipo, amigos, etc.)
    let isInContactGroup = false;
    if (ctx.contactGroups) {
      for (const gid of Object.keys(ctx.contactGroups)) {
        if (ctx.contactGroups[gid].contacts && (ctx.contactGroups[gid].contacts[basePhone] || fuzzyPhoneLookup(ctx.contactGroups[gid].contacts, basePhone))) {
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
  // BUG1-FIX: Usar fuzzyPhoneLookup para detectar familia/equipo con formatos inconsistentes
  const familyLookup = fuzzyPhoneLookup(ctx.familyContacts, basePhone);
  const teamLookup = fuzzyPhoneLookup(ctx.teamContacts, basePhone);
  let isFamilyContact = familyLookup?.data || false;
  let isTeamMember = teamLookup?.data || false;

  if (!contactType) {
    if (isSelfChat) {
      contactType = 'owner';
    } else {
      // Cascada de clasificación
      classification = await classifyContact(ctx, basePhone, messageBody, tenantState);
      contactType = classification.type;

      // Map group/legacy types
      if (contactType === 'familia') {
        isFamilyContact = familyLookup?.data || { name: classification.name };
      } else if (contactType === 'equipo') {
        isTeamMember = teamLookup?.data || { name: classification.name };
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
        // ═══ SMART CLASSIFICATION: Buscar en TODAS las fuentes antes de preguntar al owner ═══
        const pushName = messageContext?.pushName || '';
        const phoneDigits = (basePhone || '').replace(/[^0-9]/g, '');
        const isLid = phoneDigits.length > 13;
        let smartClassified = false;

        // 1. Buscar en contact_groups (familia, equipo, amigos)
        if (!smartClassified && ctx.contactGroups) {
          for (const [groupId, group] of Object.entries(ctx.contactGroups)) {
            const contacts = group.contacts || {};
            if (contacts[basePhone]) {
              console.log(`${logPrefix} 🔍 SMART-CLASS: ${basePhone} encontrado en grupo "${group.name || groupId}"`);
              contactType = groupId === 'familia' ? 'familia' : groupId === 'equipo' ? 'equipo' : 'group';
              ctx.contactTypes[phone] = contactType;
              await saveContactIndex(ctx.ownerUid, basePhone, { type: contactType, groupId, name: pushName || contacts[basePhone].name || '' });
              gateDecision.respond = false; // Grupos requieren "Hola MIIA"
              gateDecision.reason = 'smart_classified_group';
              gateDecision.action = 'none';
              smartClassified = true;
              break;
            }
          }
        }

        // 2. Buscar en agenda del owner (¿tiene cita con este número hoy?)
        if (!smartClassified) {
          try {
            const agendaSnap = await require('firebase-admin').firestore()
              .collection('users').doc(ctx.ownerUid).collection('miia_agenda')
              .where('contactPhone', '==', basePhone)
              .where('status', '==', 'pending')
              .limit(1).get();
            if (!agendaSnap.empty) {
              const evt = agendaSnap.docs[0].data();
              console.log(`${logPrefix} 🔍 SMART-CLASS: ${basePhone} tiene cita agendada "${evt.reason}" → clasificar como lead`);
              contactType = 'lead';
              ctx.contactTypes[phone] = 'lead';
              const bizId = ctx.businesses?.[0]?.id || null;
              await saveContactIndex(ctx.ownerUid, basePhone, { type: 'lead', businessId: bizId, name: pushName || evt.contactName || '' });
              gateDecision.respond = true;
              gateDecision.reason = 'smart_classified_agenda';
              gateDecision.action = 'none';
              smartClassified = true;
            }
          } catch (agErr) {
            console.warn(`${logPrefix} ⚠️ SMART-CLASS agenda check error: ${agErr.message}`);
          }
        }

        // 3. Buscar en conversaciones pasadas (¿MIIA habló con este número antes?)
        if (!smartClassified && ctx.conversations[phone] && ctx.conversations[phone].length > 0) {
          console.log(`${logPrefix} 🔍 SMART-CLASS: ${basePhone} tiene ${ctx.conversations[phone].length} mensajes previos → clasificar como lead`);
          contactType = 'lead';
          ctx.contactTypes[phone] = 'lead';
          const bizId = ctx.businesses?.[0]?.id || null;
          await saveContactIndex(ctx.ownerUid, basePhone, { type: 'lead', businessId: bizId, name: pushName || '' });
          gateDecision.respond = true;
          gateDecision.reason = 'smart_classified_history';
          gateDecision.action = 'none';
          smartClassified = true;
        }

        // 4. Si nada funcionó → MIIA NO EXISTE. Notificar al owner con contexto enriquecido.
        if (!smartClassified) {
          const ownerJid = tenantState.sock?.user?.id;
          if (ownerJid) {
            const alertMsg = buildUnknownContactAlert(basePhone, messageBody, pushName, { isLid });
            try {
              await sendTenantMessage(tenantState, ownerJid, alertMsg);
              console.log(`${logPrefix} 📢 Owner notificado: desconocido ${isLid ? (pushName || 'LID') : basePhone} sin match en ninguna fuente (MIIA callada)`);
            } catch (e) {
              console.error(`${logPrefix} ❌ Error notificando al owner sobre desconocido:`, e.message);
            }
          }
          console.log(`${logPrefix} 🤫 SMART-CLASS: Sin match para ${basePhone} en keywords, grupos, agenda ni historial — MIIA NO EXISTE`);
          // gateDecision.respond sigue en false → silencio total
        }
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
  // 🔒 MIIA CENTER (A5pMESWlfmPWCoCPRbwy85EzUzy2) es 24/7 — NUNCA night mode
  const isMiiaCenterTenant = ctx.ownerUid === 'A5pMESWlfmPWCoCPRbwy85EzUzy2';
  if (isMiiaCenterTenant) {
    console.log(`${logPrefix} 🌐 MIIA CENTER 24/7: night mode bypassed para ${contactType} ${basePhone}`);
  } else {
    const nightCheck = humanDelay.nightModeGate(ctx.ownerUid, contactType, ctx.ownerProfile?.timezone);
    if (!nightCheck.allowed) {
      console.log(`${logPrefix} 🌙 NIGHT MODE: ${contactType} ${basePhone} bloqueado (${nightCheck.reason}). Lead responde mañana.`);
      return;
    }
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
    // Inyectar eventos pendientes del día con sus IDs internos (para CANCELAR/MOVER preciso)
    try {
      const now = new Date();
      const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
      const twoDaysOut = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const evtSnap = await db().collection('users').doc(ownerUid).collection('miia_agenda')
        .where('status', '==', 'pending')
        .where('scheduledFor', '>=', now.toISOString())
        .where('scheduledFor', '<=', twoDaysOut.toISOString())
        .orderBy('scheduledFor', 'asc').limit(15).get();
      if (!evtSnap.empty) {
        const evtList = evtSnap.docs.map(d => {
          const e = d.data();
          const dateLocal = e.scheduledForLocal || e.scheduledFor || '';
          const contact = e.contactName || e.contactPhone || '';
          return `  - [ID:${d.id}] ${dateLocal} | ${e.reason || '(sin título)'}${contact && contact !== 'self' ? ` | con ${contact}` : ''}`;
        }).join('\n');
        activeSystemPrompt += `\n\n## EVENTOS PENDIENTES (próximas 48h)\n${evtList}\n\nCuando te pidan CANCELAR o MOVER un evento, usá el ID interno así:\n[CANCELAR_EVENTO:ID:docId|fecha|modo] o [MOVER_EVENTO:ID:docId|fecha_vieja|fecha_nueva]\nEsto evita confusiones entre eventos similares.`;
      }
    } catch (evtErr) {
      console.warn(`${logPrefix} ⚠️ Error inyectando eventos en prompt: ${evtErr.message}`);
    }

    // Dialecto del owner para self-chat
    if (countryContext) activeSystemPrompt += `\n\n${countryContext}`;

    // ═══ "QUÉ PODÉS HACER" — Listar capacidades directamente (sin IA) ═══
    if (messageBody && featureAnnouncer.isCapabilitiesQuery(messageBody)) {
      const capMsg = featureAnnouncer.buildCapabilitiesSummary();
      await safeSendMessage(phone, capMsg, { isSelfChat: true, skipEmoji: true });
      console.log(`${logPrefix} 📋 CAPABILITIES: Categorías listadas para tenant owner`);
      return;
    }
    if (messageBody && featureAnnouncer.isCategoryDetailQuery(messageBody)) {
      const detail = featureAnnouncer.buildCategoryDetail(messageBody);
      if (detail) {
        await safeSendMessage(phone, detail, { isSelfChat: true, skipEmoji: true });
        console.log(`${logPrefix} 📋 CAPABILITIES: Detalle de categoría para tenant owner`);
        return;
      }
    }
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

  // 11d-HARTAZGO. Tag [HARTAZGO_CONFIRMADO:contactName] — Contacto harto → affinity 0 + silencio
  const hartazgoMatch = aiMessage.match(/\[HARTAZGO_CONFIRMADO:([^\]]+)\]/);
  if (hartazgoMatch) {
    const hartazgoName = hartazgoMatch[1].trim();
    aiMessage = aiMessage.replace(/\[HARTAZGO_CONFIRMADO:[^\]]+\]/g, '').trim();
    console.log(`${logPrefix} [HARTAZGO-TMH] 📛 HARTAZGO confirmado: ${hartazgoName} (${phone}) → silencio`);
    // Guardar en contact_index como silenciado
    try {
      await db().collection('users').doc(ownerUid).collection('contact_index').doc(basePhone)
        .set({ silenced: true, silenceReason: 'hartazgo', silencedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.log(`${logPrefix} [HARTAZGO-TMH] ✅ Contacto marcado como silenciado en Firestore`);
    } catch (e) {
      console.error(`${logPrefix} [HARTAZGO-TMH] ❌ Error guardando silencio:`, e.message);
    }
    // Notificar al owner en self-chat
    await sendToOwnerSelfChat(`📛 *${hartazgoName}* expresó hartazgo y confirmó. Lo silencié. Te sugiero hablarle personalmente.`);
  }

  // 11d-SILENCIAR. Tag [SILENCIAR_LEAD:contactName] — Lead preguntó si es IA → silencio + aviso owner
  const silenciarMatch = aiMessage.match(/\[SILENCIAR_LEAD:([^\]]+)\]/);
  if (silenciarMatch) {
    const leadNameSilenced = silenciarMatch[1].trim();
    aiMessage = aiMessage.replace(/\[SILENCIAR_LEAD:[^\]]+\]/g, '').trim();
    console.log(`${logPrefix} [SILENCIAR-TMH] 🤫 Lead ${leadNameSilenced} (${phone}) preguntó si es IA → silenciando`);
    // Guardar en contact_index como silenciado
    try {
      await db().collection('users').doc(ownerUid).collection('contact_index').doc(basePhone)
        .set({ silenced: true, silenceReason: 'ai_question', silencedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } catch (e) {
      console.error(`${logPrefix} [SILENCIAR-TMH] ❌ Error:`, e.message);
    }
    // Notificar al owner en self-chat
    await sendToOwnerSelfChat(`🤫 El lead *${leadNameSilenced}* insistió en saber si somos IA/bot. Me silencié para no comprometer la identidad. Te sugiero responderle vos directamente.`);
    // NO enviar la respuesta de MIIA al lead — silencio total
    return;
  }

  // 11d-COTIZACION. Tag [GENERAR_COTIZACION_PDF:{json}] — Generar y enviar cotización PDF
  const cotizTagIdx = aiMessage.indexOf('[GENERAR_COTIZACION_PDF:');
  if (cotizTagIdx !== -1) {
    const jsonStart = cotizTagIdx + '[GENERAR_COTIZACION_PDF:'.length;
    let jsonEnd = -1;
    let depth = 0;
    for (let i = jsonStart; i < aiMessage.length; i++) {
      if (aiMessage[i] === '{') depth++;
      else if (aiMessage[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
    }
    if (jsonEnd !== -1) {
      let pdfOk = false;
      try {
        const cotizacionGenerator = require('../services/cotizacion_generator');
        const jsonStr = aiMessage.substring(jsonStart, jsonEnd);
        console.log(`${logPrefix} [COTIZ-TMH] JSON detectado: ${jsonStr.substring(0, 300)}`);
        const cotizData = JSON.parse(jsonStr);
        // Validación server-side: moneda correcta según país del lead
        const PAIS_MONEDA_MAP = {
          'COLOMBIA': 'COP', 'CHILE': 'CLP', 'MEXICO': 'MXN',
          'ESPAÑA': 'EUR', 'ESPANA': 'EUR',
          'REPUBLICA_DOMINICANA': 'USD', 'ARGENTINA': 'USD', 'INTERNACIONAL': 'USD',
        };
        if (!cotizData.pais || cotizData.pais === 'INTERNACIONAL') {
          const leadPrefix = basePhone.substring(0, 4);
          if (leadPrefix.startsWith('57')) cotizData.pais = 'COLOMBIA';
          else if (leadPrefix.startsWith('56')) cotizData.pais = 'CHILE';
          else if (leadPrefix.startsWith('52')) cotizData.pais = 'MEXICO';
          else if (leadPrefix.startsWith('54')) cotizData.pais = 'ARGENTINA';
          else if (leadPrefix.startsWith('34')) cotizData.pais = 'ESPAÑA';
          else if (/^1(809|829|849)/.test(basePhone)) cotizData.pais = 'REPUBLICA_DOMINICANA';
        }
        const expectedMoneda = PAIS_MONEDA_MAP[cotizData.pais];
        if (expectedMoneda && cotizData.moneda !== expectedMoneda) {
          console.warn(`${logPrefix} [COTIZ-TMH] ⚠️ Moneda incorrecta: ${cotizData.moneda} → forzando ${expectedMoneda}`);
          cotizData.moneda = expectedMoneda;
        }
        if (cotizData.moneda === 'EUR' && cotizData.modalidad !== 'anual') {
          cotizData.modalidad = 'anual';
        }
        // Datos del owner para footer
        try {
          const ownerDoc = await db().collection('users').doc(ownerUid).get();
          if (ownerDoc.exists) {
            const od = ownerDoc.data();
            cotizData.ownerName = od.name || od.displayName || 'Asesor';
            cotizData.ownerEmail = od.email || '';
            cotizData.ownerPhone = od.whatsapp || od.phone || '';
          }
        } catch (oe) { console.warn(`${logPrefix} [COTIZ-TMH] No se pudo leer owner:`, oe.message); }
        if (!cotizData.nombre || cotizData.nombre === 'Cliente' || cotizData.nombre === 'Lead') {
          cotizData.nombre = basePhone || cotizData.nombre;
        }
        // Enviar PDF — usa sendTenantMessage como safeSendMessage
        const safeSend = async (to, content) => {
          if (typeof content === 'string') await sendTenantMessage(tenantState, to, content);
          else if (tenantState.sock) await tenantState.sock.sendMessage(to, content);
        };
        await cotizacionGenerator.enviarCotizacionWA(safeSend, phone, cotizData, isSelfChat);
        pdfOk = true;
        console.log(`${logPrefix} [COTIZ-TMH] ✅ PDF enviado a ${phone}`);
      } catch (e) {
        console.error(`${logPrefix} [COTIZ-TMH] ❌ Error PDF:`, e.message);
      }
      let textoAntes = aiMessage.substring(0, cotizTagIdx).trim();
      if (pdfOk) {
        ctx.conversations[phone].push({ role: 'assistant', content: '📄 [Cotización PDF enviada. No volver a enviarla a menos que lo pidan.]', timestamp: Date.now() });
        aiMessage = textoAntes;
      } else {
        aiMessage = textoAntes + (textoAntes ? '\n\n' : '') + 'Hubo un problema generando el PDF de cotización. Intenta de nuevo en un momento.';
      }
    }
  } else {
    aiMessage = aiMessage.replace(/\[GENERAR_COTIZACION_PDF(?::[^\]]*)?\]/g, '').trim();
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

  // 11d-SHEETS. Tags [SHEET_*] / [DOC_*] — Google Sheets & Docs desde WhatsApp (solo self-chat)
  if (isSelfChat && ownerUid) {
    try {
      const sheetsIntegration = require('../integrations/google_sheets_integration');
      const sheetDocTags = sheetsIntegration.detectSheetTags(aiMessage);
      if (sheetDocTags.length > 0) {
        console.log(`${logPrefix} [SHEETS-TAG] 📊 ${sheetDocTags.length} tag(s): ${sheetDocTags.map(t => t.tag).join(', ')}`);
        const selfJid = tenantState.sock?.user?.id;
        const sendResult = async (msg) => {
          if (tenantState.sock && selfJid) {
            try { await tenantState.sock.sendMessage(selfJid, { text: msg }); } catch (e) { console.error(`${logPrefix} [SHEETS-TAG] ❌ Send error:`, e.message); }
          }
        };
        for (const { tag, params } of sheetDocTags) {
          try {
            switch (tag) {
              case 'SHEET_LEER': {
                const [spreadsheetId, range] = params;
                const data = await sheetsIntegration.readSheet(ownerUid, spreadsheetId, range || 'Sheet1');
                const preview = (data.values || []).slice(0, 15).map(r => r.join(' | ')).join('\n');
                await sendResult(`📊 *Datos* (${data.totalRows || 0} filas):\n\n${preview}${(data.totalRows || 0) > 15 ? `\n\n... y ${data.totalRows - 15} más` : ''}`);
                break;
              }
              case 'SHEET_ESCRIBIR': {
                const [spreadsheetId, range, rawData] = params;
                const rows = rawData.split(';').map(r => r.split(',').map(c => c.trim()));
                await sheetsIntegration.writeSheet(ownerUid, spreadsheetId, range, rows);
                await sendResult(`✅ Datos escritos en la hoja (rango: ${range})`);
                break;
              }
              case 'SHEET_APPEND': {
                const [spreadsheetId, range, rawData] = params;
                const rows = rawData.split(';').map(r => r.split(',').map(c => c.trim()));
                const result = await sheetsIntegration.appendSheet(ownerUid, spreadsheetId, range, rows);
                await sendResult(`✅ ${result.updatedRows} fila(s) agregada(s)`);
                break;
              }
              case 'SHEET_CREAR': {
                const [title] = params;
                const result = await sheetsIntegration.createSpreadsheet(ownerUid, title);
                await sendResult(`✅ Hoja creada: *${title}*\n📎 ${result.url}`);
                break;
              }
              case 'SHEET_ANALIZAR': {
                const [spreadsheetId, question] = params;
                const data = await sheetsIntegration.readSheet(ownerUid, spreadsheetId, 'Sheet1');
                const analysis = await sheetsIntegration.analyzeSheetData(data.values, question || '', aiGateway);
                await sendResult(`📊 *Análisis IA:*\n\n${analysis}`);
                break;
              }
              case 'DOC_CREAR': {
                const [title, content] = params;
                const result = await sheetsIntegration.createDocument(ownerUid, title, content || '');
                await sendResult(`✅ Documento creado: *${title}*\n📎 ${result.url}`);
                break;
              }
              case 'DOC_LEER': {
                const [documentId] = params;
                const data = await sheetsIntegration.readDocument(ownerUid, documentId);
                const preview = (data.content || '').substring(0, 2000);
                await sendResult(`📄 *Documento:*\n\n${preview}${data.content.length > 2000 ? '\n\n... (truncado)' : ''}`);
                break;
              }
              case 'DOC_APPEND': {
                const [documentId, text] = params;
                await sheetsIntegration.appendDocument(ownerUid, documentId, text);
                await sendResult(`✅ Texto agregado al documento`);
                break;
              }
            }
          } catch (tagErr) {
            console.error(`${logPrefix} [SHEETS-TAG] ❌ ${tag}: ${tagErr.message}`);
            await sendResult(`❌ Error con ${tag}: ${tagErr.message}`).catch(() => {});
          }
        }
        // Strip all sheet/doc tags
        aiMessage = aiMessage
          .replace(/\[SHEET_LEER:[^\]]+\]/g, '').replace(/\[SHEET_ESCRIBIR:[^\]]+\]/g, '')
          .replace(/\[SHEET_APPEND:[^\]]+\]/g, '').replace(/\[SHEET_CREAR:[^\]]+\]/g, '')
          .replace(/\[SHEET_ANALIZAR:[^\]]+\]/g, '').replace(/\[DOC_CREAR:[^\]]+\]/g, '')
          .replace(/\[DOC_LEER:[^\]]+\]/g, '').replace(/\[DOC_APPEND:[^\]]+\]/g, '')
          .trim();
      }
    } catch (sheetsErr) {
      console.error(`${logPrefix} [SHEETS-TAG] ❌ Module error:`, sheetsErr.message);
    }
  }

  // 11d-RESERVATIONS. Tags [BUSCAR_RESERVA] / [RESERVAR] / [CANCELAR_RESERVA] / [RATING_RESERVA] (solo self-chat)
  if (isSelfChat && ownerUid) {
    try {
      const reservationsIntegration = require('../integrations/reservations_integration');
      const reservationTags = reservationsIntegration.detectReservationTags(aiMessage);
      if (reservationTags.length > 0) {
        console.log(`${logPrefix} [RESERVATIONS-TAG] 🍽️ ${reservationTags.length} tag(s): ${reservationTags.map(t => t.tag).join(', ')}`);
        const selfJid = tenantState.sock?.user?.id;
        const sendResult = async (msg) => {
          if (tenantState.sock && selfJid) {
            try { await tenantState.sock.sendMessage(selfJid, { text: msg }); } catch (e) { console.error(`${logPrefix} [RESERVATIONS-TAG] ❌ Send:`, e.message); }
          }
        };
        for (const { tag, params } of reservationTags) {
          try {
            switch (tag) {
              case 'BUSCAR_RESERVA': {
                const [type, zone, date, time, partySize] = params;
                const results = await reservationsIntegration.searchBusinesses(
                  { type, zone, date, time, partySize: parseInt(partySize) || 0, ownerCity: zone, ownerCountry: '' },
                  aiGateway
                );
                await sendResult(reservationsIntegration.formatSearchResults(results));
                break;
              }
              case 'RESERVAR': {
                const [businessPhone, date, time, partySize, notes] = params;
                const reservation = await reservationsIntegration.createReservation(ownerUid, {
                  businessName: businessPhone, businessPhone, date, time,
                  partySize: parseInt(partySize) || 1, notes: notes || '', source: 'manual'
                });
                await sendResult(`✅ *Reserva creada*\n📍 ${reservation.businessName}\n📅 ${date} a las ${time}\n👥 ${partySize || 1} persona(s)`);
                break;
              }
              case 'CANCELAR_RESERVA': {
                await reservationsIntegration.cancelReservation(ownerUid, params[0]);
                await sendResult(`✅ Reserva cancelada`);
                break;
              }
              case 'RATING_RESERVA': {
                const result = await reservationsIntegration.rateReservation(ownerUid, params[0], parseInt(params[1]));
                await sendResult(`⭐ *${result.businessName}* calificado con ${params[1]}/5`);
                break;
              }
            }
          } catch (tagErr) {
            console.error(`${logPrefix} [RESERVATIONS-TAG] ❌ ${tag}: ${tagErr.message}`);
            await sendResult(`❌ Error: ${tagErr.message}`).catch(() => {});
          }
        }
        aiMessage = aiMessage
          .replace(/\[BUSCAR_RESERVA:[^\]]+\]/g, '').replace(/\[RESERVAR:[^\]]+\]/g, '')
          .replace(/\[CANCELAR_RESERVA:[^\]]+\]/g, '').replace(/\[RATING_RESERVA:[^\]]+\]/g, '')
          .trim();
      }
    } catch (resErr) {
      console.error(`${logPrefix} [RESERVATIONS-TAG] ❌ Module error:`, resErr.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 11d-FLAGS: Tracking de acciones ejecutadas (para PROMESA ROTA detector)
  // Estas flags se setean en true cuando un tag se procesa exitosamente
  // ═══════════════════════════════════════════════════════════════
  let _emailTagProcessed = false;
  let _agendaTagProcessed = false;
  let _tareaTagProcessed = false;

  // ═══════════════════════════════════════════════════════════════
  // 11d-EMAIL. Tags [ENVIAR_EMAIL:], [ENVIAR_CORREO:], [LEER_INBOX], [EMAIL_LEER:], [EMAIL_ELIMINAR:], [EMAIL_ELIMINAR_EXCEPTO:]
  // Migrado desde server.js para que TODOS los tenants puedan enviar/leer emails
  // ═══════════════════════════════════════════════════════════════
  if (ownerUid) {
    try {
      const gmailIntegration = require('../integrations/gmail_integration');
      const emailManager = require('../services/email_manager');
      const mailService = require('../services/mail_service');
      const { getOAuth2Client } = require('../core/google_calendar');

      // Helper: enviar al self-chat del owner
      const sendToOwnerSelfChat = async (msg) => {
        const selfJid = tenantState.sock?.user?.id;
        if (selfJid && tenantState.sock) {
          const ownerSelf = selfJid.includes(':') ? selfJid.split(':')[0] + '@s.whatsapp.net' : selfJid;
          try { await tenantState.sock.sendMessage(ownerSelf, { text: msg }); } catch (e) { console.error(`${logPrefix} [EMAIL-TMH] ❌ Send to self error:`, e.message); }
        }
      };

      // ── TAG [ENVIAR_CORREO:email|asunto|cuerpo] — MIIA envía email al lead via Gmail API / SMTP ──
      const enviarCorreoMatch = aiMessage.match(/\[ENVIAR_CORREO:([^|]+)\|([^|]+)\|([^\]]+)\]/);
      if (enviarCorreoMatch && !isSelfChat) {
        const emailTo = enviarCorreoMatch[1].trim();
        const emailSubject = enviarCorreoMatch[2].trim();
        const emailBody = enviarCorreoMatch[3].trim();
        aiMessage = aiMessage.replace(/\[ENVIAR_CORREO:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [EMAIL-TMH] 📧 Enviando correo a ${emailTo} — Asunto: "${emailSubject}" (lead ${phone})`);
        try {
          const emailFromName = ctx.ownerProfile?.businessName ? `${ctx.ownerProfile.businessName} - MIIA` : 'MIIA';
          let emailResult = { success: false, error: 'No configurado' };

          // Intentar Gmail API primero
          try {
            const ownerDoc = await db().collection('users').doc(ownerUid).get();
            if (ownerDoc.exists && ownerDoc.data()?.googleTokens) {
              emailResult = await gmailIntegration.sendGmailEmail(ownerUid, getOAuth2Client, emailTo, emailSubject, emailBody, emailFromName);
            }
          } catch (gmailErr) {
            console.warn(`${logPrefix} [EMAIL-TMH] ⚠️ Gmail API send falló, intentando SMTP: ${gmailErr.message}`);
          }

          // Fallback: SMTP
          if (!emailResult.success) {
            emailResult = await mailService.sendGenericEmail(emailTo, emailSubject, emailBody, { fromName: emailFromName });
          }

          if (emailResult.success) {
            _emailTagProcessed = true;
            console.log(`${logPrefix} [EMAIL-TMH] ✅ Correo enviado exitosamente a ${emailTo}`);
            await sendToOwnerSelfChat(`📧 Email enviado a *${emailTo}* — Asunto: "${emailSubject}" (lead ${basePhone})`);
          } else {
            console.error(`${logPrefix} [EMAIL-TMH] ❌ Error enviando correo a ${emailTo}: ${emailResult.error}`);
            await sendToOwnerSelfChat(`❌ No pude enviar email a ${emailTo}. Error: ${emailResult.error}. Lead ${basePhone} pidió: "${emailSubject}"`);
          }
        } catch (emailErr) {
          console.error(`${logPrefix} [EMAIL-TMH] ❌ Excepción enviando correo:`, emailErr.message);
        }
      } else if (enviarCorreoMatch) {
        aiMessage = aiMessage.replace(/\[ENVIAR_CORREO:[^\]]+\]/g, '').trim();
      }

      // ── TAG [ENVIAR_EMAIL:to|subject|body] — Owner envía email desde self-chat ──
      const enviarEmailMatch = aiMessage.match(/\[ENVIAR_EMAIL:([^|]+)\|([^|]+)\|([^\]]+)\]/);
      if (enviarEmailMatch && isSelfChat) {
        const emailTo = enviarEmailMatch[1].trim();
        const emailSubject = enviarEmailMatch[2].trim();
        const emailBody = enviarEmailMatch[3].trim();
        aiMessage = aiMessage.replace(/\[ENVIAR_EMAIL:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [EMAIL-TMH] 📧 Owner envía email a ${emailTo}: "${emailSubject}"`);
        try {
          const fromName = ctx.ownerProfile?.name || 'MIIA';
          let emailResult = { success: false, error: 'No configurado' };

          // Intentar Gmail API primero
          try {
            const ownerDoc = await db().collection('users').doc(ownerUid).get();
            if (ownerDoc.exists && ownerDoc.data()?.googleTokens) {
              emailResult = await gmailIntegration.sendGmailEmail(ownerUid, getOAuth2Client, emailTo, emailSubject, emailBody, fromName);
              if (emailResult.success) console.log(`${logPrefix} [EMAIL-TMH] ✅ Gmail API: Email enviado a ${emailTo}`);
            }
          } catch (gmailSendErr) {
            console.warn(`${logPrefix} [EMAIL-TMH] ⚠️ Gmail API send falló, intentando SMTP: ${gmailSendErr.message}`);
          }

          // Fallback: SMTP via emailManager
          if (!emailResult.success) {
            emailResult = await emailManager.sendEmail(emailTo, emailSubject, emailBody, fromName);
            if (emailResult.success) console.log(`${logPrefix} [EMAIL-TMH] ✅ SMTP: Email enviado a ${emailTo}`);
          }

          if (emailResult.success) {
            _emailTagProcessed = true;
            if (!aiMessage) aiMessage = `📧 Listo, le envié el correo a ${emailTo} — Asunto: "${emailSubject}"`;
          } else {
            console.error(`${logPrefix} [EMAIL-TMH] ❌ Error: ${emailResult.error}`);
            if (!aiMessage) aiMessage = `❌ No pude enviar el correo a ${emailTo}: ${emailResult.error}`;
          }
        } catch (emailErr) {
          console.error(`${logPrefix} [EMAIL-TMH] ❌ Excepción: ${emailErr.message}`);
          if (!aiMessage) aiMessage = `❌ Error enviando correo: ${emailErr.message}`;
        }
      } else if (enviarEmailMatch) {
        aiMessage = aiMessage.replace(/\[ENVIAR_EMAIL:[^\]]+\]/g, '').trim();
      }

      // ── TAG [LEER_INBOX] — Owner lee su bandeja de entrada ──
      if (aiMessage.includes('[LEER_INBOX]') && isSelfChat) {
        aiMessage = aiMessage.replace(/\[LEER_INBOX\]/g, '').trim();
        console.log(`${logPrefix} [EMAIL-TMH] 📬 Owner solicita leer inbox`);
        try {
          let usedGmail = false;
          try {
            const ownerDoc = await db().collection('users').doc(ownerUid).get();
            if (ownerDoc.exists && ownerDoc.data()?.googleTokens) {
              const gmailResult = await gmailIntegration.getUnreadEmails(ownerUid, getOAuth2Client, { maxResults: 10 });
              if (!gmailResult.error && gmailResult.emails.length >= 0) {
                const adaptedEmails = gmailResult.emails.map(e => ({
                  uid: e.id, fromName: e.from.replace(/<[^>]+>/, '').trim() || e.from,
                  from: e.from, subject: e.subject, date: e.date, snippet: e.snippet,
                  hasAttachments: false, _gmailId: e.id, _threadId: e.threadId, _source: 'gmail_api',
                }));
                emailManager.cacheEmails(ownerUid, adaptedEmails, { _source: 'gmail_api' });
                aiMessage = emailManager.formatEmailList(adaptedEmails, gmailResult.summary.total || adaptedEmails.length);
                usedGmail = true;
                console.log(`${logPrefix} [EMAIL-TMH] ✅ Gmail API: ${adaptedEmails.length} emails via OAuth`);
              }
            }
          } catch (gmailErr) {
            console.warn(`${logPrefix} [EMAIL-TMH] ⚠️ Gmail API falló, intentando IMAP: ${gmailErr.message}`);
          }

          if (!usedGmail) {
            const imapConfig = await emailManager.getOwnerImapConfig(ownerUid);
            if (!imapConfig) {
              aiMessage = '📭 Para gestionar tu correo, conectá Google Calendar desde el dashboard (Conexiones → Google). Es un solo click y MIIA accede a tu Gmail automáticamente.';
            } else {
              const result = await emailManager.fetchUnreadEmails(imapConfig, 10);
              if (result.success) {
                emailManager.cacheEmails(ownerUid, result.emails, imapConfig);
                aiMessage = emailManager.formatEmailList(result.emails, result.count || result.emails.length);
              } else {
                aiMessage = `❌ Error leyendo tu inbox: ${result.error}`;
              }
            }
          }
        } catch (inboxErr) {
          console.error(`${logPrefix} [EMAIL-TMH] ❌ Excepción leyendo inbox: ${inboxErr.message}`);
          aiMessage = `❌ Error accediendo a tu correo: ${inboxErr.message}`;
        }
      }

      // ── TAG [EMAIL_LEER:2,5] — Owner lee contenido de emails específicos ──
      const emailLeerMatch = aiMessage.match(/\[EMAIL_LEER:([^\]]+)\]/);
      if (emailLeerMatch && isSelfChat) {
        const indices = emailLeerMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
        aiMessage = aiMessage.replace(/\[EMAIL_LEER:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [EMAIL-TMH] 📖 Owner quiere leer emails: ${indices.join(', ')}`);
        const cached = emailManager.getCachedEmails(ownerUid);
        if (!cached || !cached.emails.length) {
          aiMessage = '⚠️ No tengo emails en caché. Primero decime "leé mi inbox" o "qué correos tengo".';
        } else if (cached.imapConfig?._source === 'gmail_api') {
          const results = [];
          for (const idx of indices) {
            const email = cached.emails[idx - 1];
            if (!email) { results.push(`*${idx}.* ❌ No existe ese correo en la lista`); continue; }
            try {
              const fullEmail = await gmailIntegration.getFullEmail(ownerUid, getOAuth2Client, email._gmailId);
              if (fullEmail.success && fullEmail.body) {
                const body = fullEmail.body.substring(0, 800).replace(/\n{3,}/g, '\n\n');
                results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${body}`);
              } else {
                results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${email.snippet || '(Sin contenido)'}`);
              }
            } catch (gmailReadErr) {
              console.warn(`${logPrefix} [EMAIL-TMH] ⚠️ Gmail getFullEmail falló: ${gmailReadErr.message}`);
              results.push(`*${idx}. De: ${email.fromName}*\n📋 _${email.subject}_\n\n${email.snippet || '(Sin contenido)'}`);
            }
          }
          aiMessage = results.join('\n\n---\n\n');
        } else {
          aiMessage = emailManager.formatEmailContent(cached.emails, indices);
        }
      }

      // ── TAG [EMAIL_ELIMINAR:1,3,4] — Owner elimina emails ──
      const emailEliminarMatch = aiMessage.match(/\[EMAIL_ELIMINAR:([^\]]+)\]/);
      if (emailEliminarMatch && isSelfChat) {
        const indices = emailEliminarMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
        aiMessage = aiMessage.replace(/\[EMAIL_ELIMINAR:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [EMAIL-TMH] 🗑️ Owner quiere eliminar emails: ${indices.join(', ')}`);
        const cached = emailManager.getCachedEmails(ownerUid);
        if (!cached || !cached.emails.length) {
          aiMessage = '⚠️ No tengo emails en caché. Primero decime "leé mi inbox" para ver tus correos.';
        } else if (cached.imapConfig?._source === 'gmail_api') {
          const gmailIdsToDelete = indices.map(i => cached.emails[i - 1]?._gmailId).filter(id => id != null);
          if (gmailIdsToDelete.length === 0) {
            aiMessage = '⚠️ Los números que indicaste no corresponden a emails de la lista.';
          } else {
            try {
              const delResult = await gmailIntegration.trashEmails(ownerUid, getOAuth2Client, gmailIdsToDelete);
              if (delResult.success) {
                console.log(`${logPrefix} [EMAIL-TMH] ✅ Gmail: ${delResult.deleted} emails eliminados`);
                emailManager.clearCache(ownerUid);
                aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Tu bandeja está más limpia ahora.`;
              } else {
                aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
              }
            } catch (delErr) {
              console.error(`${logPrefix} [EMAIL-TMH] ❌ Gmail excepción eliminando: ${delErr.message}`);
              aiMessage = `❌ Error: ${delErr.message}`;
            }
          }
        } else {
          const uidsToDelete = indices.map(i => cached.emails[i - 1]?.uid).filter(uid => uid != null);
          if (uidsToDelete.length === 0) {
            aiMessage = '⚠️ Los números que indicaste no corresponden a emails de la lista.';
          } else {
            try {
              const delResult = await emailManager.deleteEmails(cached.imapConfig, uidsToDelete);
              if (delResult.success) {
                emailManager.clearCache(ownerUid);
                aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Tu bandeja está más limpia ahora.`;
              } else {
                aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
              }
            } catch (delErr) {
              console.error(`${logPrefix} [EMAIL-TMH] ❌ IMAP excepción eliminando: ${delErr.message}`);
              aiMessage = `❌ Error: ${delErr.message}`;
            }
          }
        }
      }

      // ── TAG [EMAIL_ELIMINAR_EXCEPTO:2,5] — Owner elimina todos MENOS los indicados ──
      const emailExceptoMatch = aiMessage.match(/\[EMAIL_ELIMINAR_EXCEPTO:([^\]]+)\]/);
      if (emailExceptoMatch && isSelfChat) {
        const keepIndices = emailExceptoMatch[1].split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
        aiMessage = aiMessage.replace(/\[EMAIL_ELIMINAR_EXCEPTO:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [EMAIL-TMH] 🗑️ Owner quiere eliminar todos EXCEPTO: ${keepIndices.join(', ')}`);
        const cached = emailManager.getCachedEmails(ownerUid);
        if (!cached || !cached.emails.length) {
          aiMessage = '⚠️ No tengo emails en caché. Primero decime "leé mi inbox".';
        } else if (cached.imapConfig?._source === 'gmail_api') {
          const gmailIdsToDelete = cached.emails
            .map((e, i) => ({ gmailId: e._gmailId, index: i + 1 }))
            .filter(e => !keepIndices.includes(e.index)).map(e => e.gmailId).filter(id => id != null);
          if (gmailIdsToDelete.length === 0) {
            aiMessage = '✅ No hay emails para eliminar — todos están en la lista de conservar.';
          } else {
            try {
              const delResult = await gmailIntegration.trashEmails(ownerUid, getOAuth2Client, gmailIdsToDelete);
              if (delResult.success) {
                emailManager.clearCache(ownerUid);
                aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Conservé los que pediste (${keepIndices.join(', ')}).`;
              } else {
                aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
              }
            } catch (delErr) {
              console.error(`${logPrefix} [EMAIL-TMH] ❌ Gmail excepción: ${delErr.message}`);
              aiMessage = `❌ Error: ${delErr.message}`;
            }
          }
        } else {
          const uidsToDelete = cached.emails
            .map((e, i) => ({ uid: e.uid, index: i + 1 }))
            .filter(e => !keepIndices.includes(e.index)).map(e => e.uid).filter(uid => uid != null);
          if (uidsToDelete.length === 0) {
            aiMessage = '✅ No hay emails para eliminar — todos están en la lista de conservar.';
          } else {
            try {
              const delResult = await emailManager.deleteEmails(cached.imapConfig, uidsToDelete);
              if (delResult.success) {
                emailManager.clearCache(ownerUid);
                aiMessage = `🗑️ Listo, eliminé ${delResult.deleted} correo${delResult.deleted > 1 ? 's' : ''}. Conservé los que pediste (${keepIndices.join(', ')}).`;
              } else {
                aiMessage = `❌ Error eliminando correos: ${delResult.error}`;
              }
            } catch (delErr) {
              console.error(`${logPrefix} [EMAIL-TMH] ❌ IMAP excepción: ${delErr.message}`);
              aiMessage = `❌ Error: ${delErr.message}`;
            }
          }
        }
      }
    } catch (emailModuleErr) {
      console.error(`${logPrefix} [EMAIL-TMH] ❌ Module error:`, emailModuleErr.message);
      // Strip any email tags to prevent raw tags from reaching the user
      aiMessage = aiMessage.replace(/\[ENVIAR_CORREO:[^\]]+\]/g, '').replace(/\[ENVIAR_EMAIL:[^\]]+\]/g, '')
        .replace(/\[LEER_INBOX\]/g, '').replace(/\[EMAIL_LEER:[^\]]+\]/g, '')
        .replace(/\[EMAIL_ELIMINAR:[^\]]+\]/g, '').replace(/\[EMAIL_ELIMINAR_EXCEPTO:[^\]]+\]/g, '').trim();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 11d-AGENDA. Tags [AGENDAR_EVENTO:], [SOLICITAR_TURNO:], [CONSULTAR_AGENDA]
  // Migrado desde server.js para que TODOS los tenants puedan agendar
  // ═══════════════════════════════════════════════════════════════
  if (ownerUid) {
    try {
      const { getOAuth2Client } = require('../core/google_calendar');

      // Helper para obtener timezone desde país
      const getTimezoneForCountry = (country) => {
        const TZ_MAP = {
          'CO': 'America/Bogota', 'AR': 'America/Argentina/Buenos_Aires', 'MX': 'America/Mexico_City',
          'CL': 'America/Santiago', 'PE': 'America/Lima', 'EC': 'America/Guayaquil',
          'VE': 'America/Caracas', 'US': 'America/New_York', 'ES': 'Europe/Madrid',
          'BR': 'America/Sao_Paulo', 'DO': 'America/Santo_Domingo', 'UY': 'America/Montevideo',
          'PY': 'America/Asuncion', 'BO': 'America/La_Paz', 'CR': 'America/Costa_Rica',
          'PA': 'America/Panama', 'GT': 'America/Guatemala', 'HN': 'America/Tegucigalpa',
          'SV': 'America/El_Salvador', 'NI': 'America/Managua',
        };
        return TZ_MAP[country] || 'America/Bogota';
      };

      // Helper: enviar al self-chat del owner
      const sendToOwnerSelfChat = async (msg) => {
        const selfJid = tenantState.sock?.user?.id;
        if (selfJid && tenantState.sock) {
          const ownerSelf = selfJid.includes(':') ? selfJid.split(':')[0] + '@s.whatsapp.net' : selfJid;
          try { await tenantState.sock.sendMessage(ownerSelf, { text: msg }); } catch (e) { console.error(`${logPrefix} [AGENDA-TMH] ❌ Send to self error:`, e.message); }
        }
      };

      // ── TAG [AGENDAR_EVENTO:contacto|fecha|razón|hint|modo|ubicación] ──
      const agendarMatch = aiMessage.match(/\[AGENDAR_EVENTO:([^\]]+)\]/g);
      if (agendarMatch) {
        for (const tag of agendarMatch) {
          const inner = tag.replace('[AGENDAR_EVENTO:', '').replace(']', '');
          const parts = inner.split('|').map(p => p.trim());
          if (parts.length >= 3) {
            const [contacto, fecha, razon, hint, modo, ubicacion] = parts;
            const contactName = contacto;
            let calendarOk = false;
            let meetLink = null;
            const eventMode = (modo || 'presencial').toLowerCase();

            // 1. Crear evento en Google Calendar
            try {
              const parsedDate = new Date(fecha);
              const ownerPhone = getBasePhone(tenantState.sock?.user?.id || '');
              const ownerCountry = getCountryFromPhone(ownerPhone);
              const ownerTz = getTimezoneForCountry(ownerCountry);
              if (!isNaN(parsedDate)) {
                const hourMatch = fecha.match(/(\d{1,2}):(\d{2})/);
                const startH = hourMatch ? parseInt(hourMatch[1]) : 10;
                const startMin = hourMatch ? parseInt(hourMatch[2]) : 0;
                const calResult = await createCalendarEvent({
                  summary: razon || 'Evento MIIA',
                  dateStr: fecha.split('T')[0],
                  startHour: startH,
                  startMinute: startMin,
                  endHour: startH + 1,
                  endMinute: startMin,
                  description: `Agendado por MIIA para ${contactName}. ${hint || ''}`.trim(),
                  uid: ownerUid,
                  timezone: ownerTz,
                  eventMode: eventMode,
                  location: eventMode === 'presencial' ? (ubicacion || '') : '',
                  phoneNumber: (eventMode === 'telefono' || eventMode === 'telefónico') ? (ubicacion || contacto) : '',
                  reminderMinutes: 10
                });
                calendarOk = true;
                meetLink = calResult.meetLink || null;
                var calendarEventId = calResult.eventId || null;
                console.log(`${logPrefix} [AGENDA-TMH] 📅 Calendar: "${razon}" el ${fecha} para ${contactName} modo=${eventMode} calEventId=${calendarEventId}`);
              }
            } catch (calErr) {
              console.warn(`${logPrefix} [AGENDA-TMH] ⚠️ Calendar no disponible: ${calErr.message}. Guardando solo en Firestore.`);
              if (/no conectado|no tokens|googleTokens/i.test(calErr.message)) {
                await sendToOwnerSelfChat(
                  `⚠️ *Google Calendar no está conectado*\n\n` +
                  `Agendé "${razon}" el ${fecha} en mi base de datos, pero NO pude sincronizarlo con tu Google Calendar.\n\n` +
                  `👉 Para conectarlo, andá a tu *Dashboard → Conexiones → Google Calendar* y aprobá los permisos.`
                );
              }
            }

            // 2. Timezone del owner
            const ownerPhone = getBasePhone(tenantState.sock?.user?.id || '');
            const ownerCountry = getCountryFromPhone(ownerPhone);
            const effectiveTimezone = getTimezoneForCountry(ownerCountry);

            // 3. Guardar en Firestore
            try {
              let scheduledForUTC = fecha;
              try {
                const parsedLocal = new Date(fecha);
                if (!isNaN(parsedLocal)) {
                  const localStr = new Date().toLocaleString('en-US', { timeZone: effectiveTimezone });
                  const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
                  const offsetMs = new Date(localStr) - new Date(utcStr);
                  scheduledForUTC = new Date(parsedLocal.getTime() - offsetMs).toISOString();
                  console.log(`${logPrefix} [AGENDA-TMH] 🕐 Fecha local: ${fecha} (${effectiveTimezone}) → UTC: ${scheduledForUTC}`);
                }
              } catch (tzErr) {
                console.warn(`${logPrefix} [AGENDA-TMH] ⚠️ Error timezone: ${tzErr.message}`);
              }

              const isExternalContact = contacto && contacto !== 'self' && /^\d{8,15}$/.test(contacto.replace(/\D/g, ''));
              const resolvedContactPhone = isExternalContact ? contacto : (isSelfChat ? 'self' : (basePhone || phone || contacto));

              await db().collection('users').doc(ownerUid).collection('miia_agenda').add({
                contactPhone: resolvedContactPhone,
                contactName: contactName,
                mentionedContact: contacto,
                scheduledFor: scheduledForUTC,
                scheduledForLocal: fecha,
                ownerTimezone: effectiveTimezone,
                reason: razon,
                promptHint: hint || '',
                eventMode: eventMode,
                eventLocation: ubicacion || '',
                meetLink: meetLink || '',
                status: 'pending',
                calendarSynced: calendarOk,
                calendarEventId: calendarEventId || null,
                remindContact: !isSelfChat || isExternalContact,
                reminderMinutes: 10,
                requestedBy: phone,
                createdAt: new Date().toISOString(),
                source: isSelfChat ? 'owner_selfchat' : 'contact_request'
              });
              _agendaTagProcessed = true;
              console.log(`${logPrefix} [AGENDA-TMH] ✅ Evento guardado en Firestore`);
            } catch (e) {
              console.error(`${logPrefix} [AGENDA-TMH] ❌ Error guardando en Firestore:`, e.message);
            }

            // 4. Notificar al owner si no es self-chat
            if (!isSelfChat) {
              const calStatus = calendarOk ? '📅 Calendar ✅' : '⚠️ Calendar no conectado';
              const modeLabel = eventMode === 'virtual' ? '📹 Virtual' : (eventMode === 'telefono' || eventMode === 'telefónico') ? '📞 Telefónico' : '📍 Presencial';
              await sendToOwnerSelfChat(
                `📅 *${contactName}* pidió agendar:\n"${razon}" — ${fecha}\nModo: ${modeLabel}${ubicacion ? ` — ${ubicacion}` : ''}\n${calStatus}` +
                (!calendarOk ? `\n\n💡 Conectá tu Calendar desde Dashboard → Conexiones.` : '')
              );
            }
          }
        }
        aiMessage = aiMessage.replace(/\[AGENDAR_EVENTO:[^\]]+\]/g, '').trim();
      }

      // ── TAG [SOLICITAR_TURNO:contacto|fecha|razón|hint|modo|ubicación] ──
      const solicitarMatch = aiMessage.match(/\[SOLICITAR_TURNO:([^\]]+)\]/g);
      if (solicitarMatch) {
        for (const tag of solicitarMatch) {
          const inner = tag.replace('[SOLICITAR_TURNO:', '').replace(']', '');
          const parts = inner.split('|').map(p => p.trim());
          if (parts.length >= 3) {
            const [contacto, fecha, razon, hint, modo, ubicacion] = parts;
            const contactName = contacto;
            const eventMode = (modo || 'presencial').toLowerCase();
            const modeEmoji = eventMode === 'virtual' ? '📹' : (eventMode === 'telefono' || eventMode === 'telefónico') ? '📞' : '📍';
            const modeLabel = eventMode === 'virtual' ? 'Virtual (Meet)' : (eventMode === 'telefono' || eventMode === 'telefónico') ? 'Telefónico' : 'Presencial';

            const ownerPhone = getBasePhone(tenantState.sock?.user?.id || '');
            const ownerCountry = getCountryFromPhone(ownerPhone);
            const ownerTz = getTimezoneForCountry(ownerCountry);

            let scheduledForUTC = fecha;
            try {
              const parsedLocal = new Date(fecha);
              if (!isNaN(parsedLocal)) {
                const localStr = new Date().toLocaleString('en-US', { timeZone: ownerTz });
                const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
                const offsetMs = new Date(localStr) - new Date(utcStr);
                scheduledForUTC = new Date(parsedLocal.getTime() - offsetMs).toISOString();
              }
            } catch (tzErr) {
              console.warn(`${logPrefix} [SOLICITAR_TURNO-TMH] ⚠️ Error timezone: ${tzErr.message}`);
            }

            // Guardar solicitud pendiente
            let appointmentId = null;
            try {
              const docRef = await db().collection('users').doc(ownerUid).collection('pending_appointments').add({
                contactPhone: contacto,
                contactJid: phone,
                contactName: contactName,
                scheduledFor: scheduledForUTC,
                scheduledForLocal: fecha,
                ownerTimezone: ownerTz,
                reason: razon,
                hint: hint || '',
                eventMode: eventMode,
                eventLocation: ubicacion || '',
                status: 'waiting_approval',
                requestedBy: phone,
                createdAt: new Date().toISOString()
              });
              appointmentId = docRef.id;
              _agendaTagProcessed = true;
              console.log(`${logPrefix} [SOLICITAR_TURNO-TMH] 📋 Solicitud ${appointmentId} creada`);
            } catch (e) {
              console.error(`${logPrefix} [SOLICITAR_TURNO-TMH] ❌ Error guardando solicitud:`, e.message);
            }

            // Notificar al owner en self-chat
            const approvalMsg = `📋 *SOLICITUD DE TURNO* (ID: ${appointmentId ? appointmentId.slice(-6) : '???'})\n\n` +
              `👤 *Contacto*: ${contactName}\n📅 *Fecha*: ${fecha}\n📝 *Motivo*: ${razon}\n` +
              `${modeEmoji} *Modo*: ${modeLabel}${ubicacion ? ` — ${ubicacion}` : ''}\n\n` +
              `Responde:\n✅ *"aprobar"* → agenda como está\n🕐 *"mover a las 16:00"* → cambia horario\n❌ *"rechazar"* → MIIA avisa al contacto` +
              (hint ? `\n\n💬 Nota del contacto: ${hint}` : '');

            await sendToOwnerSelfChat(approvalMsg);
          }
        }
        aiMessage = aiMessage.replace(/\[SOLICITAR_TURNO:[^\]]+\]/g, '').trim();
      }

      // ── TAG [CONSULTAR_AGENDA] — MIIA consulta agenda del owner ──
      if (aiMessage.includes('[CONSULTAR_AGENDA]') && isSelfChat) {
        console.log(`${logPrefix} [AGENDA-TMH] 📅 Tag CONSULTAR_AGENDA detectado`);
        aiMessage = aiMessage.replace(/\[CONSULTAR_AGENDA\]/g, '').trim();
        try {
          const ownerPhone = getBasePhone(tenantState.sock?.user?.id || '');
          const ownerCountry = getCountryFromPhone(ownerPhone);
          const ownerTz = getTimezoneForCountry(ownerCountry);
          const now = new Date();
          const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

          const agendaSnap = await db().collection('users').doc(ownerUid).collection('miia_agenda')
            .where('status', '==', 'pending')
            .where('scheduledFor', '>=', now.toISOString())
            .where('scheduledFor', '<=', in7days.toISOString())
            .orderBy('scheduledFor', 'asc').limit(20).get();

          let agendaItems = [];
          if (!agendaSnap.empty) {
            agendaItems = agendaSnap.docs.map(d => {
              const e = d.data();
              const dateLocal = e.scheduledForLocal || e.scheduledFor || '';
              const modeEmoji = e.eventMode === 'virtual' ? '📹' : e.eventMode === 'telefono' ? '📞' : '📍';
              const contact = e.contactName || e.contactPhone || '';
              return `  ${modeEmoji} [ID:${d.id}] ${dateLocal} | ${e.reason || '(sin título)'} | ${contact && contact !== 'self' ? `con ${contact}` : ''}`;
            });
          }

          if (agendaItems.length > 0) {
            aiMessage = `📅 *Tu agenda (próximos 7 días):*\n\n${agendaItems.join('\n')}\n\n_(Usá el ID interno para cancelar o mover eventos)_`;
          } else {
            aiMessage = '📅 No tenés eventos agendados en los próximos 7 días.';
          }
        } catch (agendaErr) {
          console.error(`${logPrefix} [AGENDA-TMH] ❌ Error consultando agenda: ${agendaErr.message}`);
          aiMessage = '❌ Error consultando tu agenda. Intentá de nuevo.';
        }
      }

      // ── TAG [CANCELAR_EVENTO:razón|fecha_aprox|modo] / [ELIMINAR_EVENTO:...] — Eliminar evento ──
      aiMessage = aiMessage.replace(/\[ELIMINAR_EVENTO:/g, '[CANCELAR_EVENTO:');
      const cancelMatch = aiMessage.match(/\[CANCELAR_EVENTO:([^\]]+)\]/);
      if (cancelMatch && isSelfChat) {
        const cancelParts = cancelMatch[1].split('|').map(p => p.trim());
        const [searchReason, searchDate, cancelMode] = cancelParts;
        const mode = (cancelMode || 'silencioso').toLowerCase();
        console.log(`${logPrefix} [CANCELAR-TMH] 🗑️ Buscando: "${searchReason}" cerca de ${searchDate || 'hoy'} modo=${mode}`);
        try {
          let found = null;

          // ═══ FAST-PATH: Si viene con ID: → buscar directamente por docId ═══
          const docIdMatch = (searchReason || '').match(/^ID:(\S+)/i);
          if (docIdMatch) {
            const docId = docIdMatch[1];
            console.log(`${logPrefix} [CANCELAR-TMH] 🎯 Búsqueda por docId: ${docId}`);
            const docRef = db().collection('users').doc(ownerUid).collection('miia_agenda').doc(docId);
            const docSnap = await docRef.get();
            if (docSnap.exists && docSnap.data().status === 'pending') {
              found = { doc: docSnap, data: docSnap.data() };
              console.log(`${logPrefix} [CANCELAR-TMH] ✅ Encontrado por docId: "${found.data.reason}"`);
            } else {
              console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ DocId ${docId} no existe o no está pending`);
            }
          }

          // ═══ SCORING FALLBACK: Si no vino con ID: o no se encontró ═══
          if (!found) {
            const searchDateObj = searchDate ? new Date(searchDate) : new Date();
            const dayStart = new Date(searchDateObj); dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(searchDateObj); dayEnd.setHours(23, 59, 59, 999);

            const snap = await db().collection('users').doc(ownerUid).collection('miia_agenda')
              .where('status', '==', 'pending')
              .where('scheduledFor', '>=', dayStart.toISOString())
              .where('scheduledFor', '<=', dayEnd.toISOString())
              .orderBy('scheduledFor', 'asc').limit(10).get();

            const reasonLower = (searchReason || '').toLowerCase();
            const reasonWords = reasonLower.split(/\s+/).filter(w => w.length > 2);

            let bestScore = 0;
            for (const doc of snap.docs) {
              const evt = doc.data();
              const evtReason = (evt.reason || '').toLowerCase();
              const evtContact = (evt.contactName || '').toLowerCase();
              let score = 0;

              if (evtReason === reasonLower) {
                score = 100;
              } else {
                const evtWords = `${evtReason} ${evtContact}`.split(/\s+/).filter(w => w.length > 2);
                let matchedWords = 0;
                for (const word of reasonWords) {
                  if (evtReason.includes(word) || evtContact.includes(word)) matchedWords++;
                }
                const forwardMatch = reasonWords.length > 0 ? matchedWords / reasonWords.length : 0;
                let reverseMatched = 0;
                for (const word of evtWords) {
                  if (reasonLower.includes(word)) reverseMatched++;
                }
                const reverseMatch = evtWords.length > 0 ? reverseMatched / evtWords.length : 0;
                score = Math.round((forwardMatch * 60 + reverseMatch * 40));
              }

              console.log(`${logPrefix} [CANCELAR-TMH] 📊 Score "${evt.reason}" (docId:${doc.id}) = ${score}`);
              if (score > bestScore) {
                bestScore = score;
                found = { doc, data: evt };
              }
            }

            if (found && bestScore < 45) {
              console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ Mejor match "${found.data.reason}" score=${bestScore} < 45 — RECHAZADO`);
              found = null;
            }
          }

          // ═══ PASO A: Intentar eliminar de Google Calendar DIRECTAMENTE ═══
          // Esto es lo que el owner realmente ve. Si no borramos de Calendar, MIIA MIENTE.
          let calendarDeleted = false;
          try {
            const { getOAuth2Client: getCalClient } = require('../core/google_calendar');
            const gTokens = await db().collection('users').doc(ownerUid).get();
            if (gTokens.exists && gTokens.data()?.googleTokens) {
              const oauth2 = getCalClient();
              oauth2.setCredentials(gTokens.data().googleTokens);
              const { google } = require('googleapis');
              const cal = google.calendar({ version: 'v3', auth: oauth2 });

              // Si tenemos calendarEventId directo, borrar por ID
              if (found && found.data.calendarEventId) {
                try {
                  await cal.events.delete({ calendarId: 'primary', eventId: found.data.calendarEventId });
                  calendarDeleted = true;
                  console.log(`${logPrefix} [CANCELAR-TMH] 📅 Eliminado de Google Calendar por eventId`);
                } catch (delErr) {
                  console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ Delete por eventId falló: ${delErr.message}`);
                }
              }

              // Si NO se borró por ID, buscar en Google Calendar por texto + fecha
              if (!calendarDeleted) {
                const calSearchDate = searchDate ? new Date(searchDate) : new Date();
                const timeMin = new Date(calSearchDate); timeMin.setHours(0, 0, 0, 0);
                const timeMax = new Date(calSearchDate); timeMax.setHours(23, 59, 59, 999);
                try {
                  const calEvents = await cal.events.list({
                    calendarId: 'primary',
                    timeMin: timeMin.toISOString(),
                    timeMax: timeMax.toISOString(),
                    singleEvents: true,
                    q: searchReason.replace(/[🎉🎂📍]/g, '').trim().substring(0, 50), // limpiar emojis para búsqueda
                  });
                  const items = calEvents.data.items || [];
                  console.log(`${logPrefix} [CANCELAR-TMH] 📅 Búsqueda Calendar: ${items.length} eventos encontrados para "${searchReason}"`);

                  // Si hay duplicados (>1 match), borrar solo UNO (el último = el duplicado)
                  if (items.length > 1) {
                    const toDelete = items[items.length - 1]; // último = probable duplicado
                    await cal.events.delete({ calendarId: 'primary', eventId: toDelete.id });
                    calendarDeleted = true;
                    console.log(`${logPrefix} [CANCELAR-TMH] 📅 Duplicado eliminado de Calendar: "${toDelete.summary}" (id: ${toDelete.id})`);
                  } else if (items.length === 1) {
                    await cal.events.delete({ calendarId: 'primary', eventId: items[0].id });
                    calendarDeleted = true;
                    console.log(`${logPrefix} [CANCELAR-TMH] 📅 Evento eliminado de Calendar: "${items[0].summary}" (id: ${items[0].id})`);
                  } else {
                    console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ No se encontró en Google Calendar`);
                  }
                } catch (searchErr) {
                  console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ Búsqueda Calendar falló: ${searchErr.message}`);
                }
              }
            } else {
              console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ Sin googleTokens — no se puede borrar de Calendar`);
            }
          } catch (calModErr) {
            console.error(`${logPrefix} [CANCELAR-TMH] ❌ Error módulo Calendar: ${calModErr.message}`);
          }

          // ═══ PASO B: Actualizar Firestore (si encontró match) ═══
          if (found) {
            await found.doc.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelMode: mode });
            console.log(`${logPrefix} [CANCELAR-TMH] ✅ Firestore: "${found.data.reason}" marcado cancelled`);
          }

          // ═══ PASO C: Mensaje al owner — HONESTO sobre lo que pasó ═══
          if (calendarDeleted) {
            console.log(`${logPrefix} [CANCELAR-TMH] ✅ COMPLETO: Evento eliminado de Calendar + Firestore`);
            // Notificar al contacto si modo=avisar
            if (mode === 'avisar' && found?.data?.contactPhone && found.data.contactPhone !== 'self') {
              const contactJid = found.data.contactPhone.includes('@') ? found.data.contactPhone : `${found.data.contactPhone}@s.whatsapp.net`;
              const contactName = found.data.contactName || 'Contacto';
              try {
                await tenantState.sock.sendMessage(contactJid, {
                  text: `📅 Hola ${contactName}, te aviso que ${found?.data?.reason || 'el evento'} programado para el ${found?.data?.scheduledForLocal || 'la fecha indicada'} fue cancelado. Disculpa las molestias. 🙏`
                });
              } catch (notifyErr) {
                console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ Error notificando: ${notifyErr.message}`);
              }
            }
            if (!aiMessage.replace(/\[CANCELAR_EVENTO:[^\]]+\]/g, '').trim()) {
              aiMessage = `✅ Listo, eliminé el evento de tu calendario.`;
            }
          } else if (found) {
            // Firestore actualizado pero Calendar NO — ser HONESTO
            console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ Solo Firestore actualizado, Calendar NO borrado`);
            if (!aiMessage.replace(/\[CANCELAR_EVENTO:[^\]]+\]/g, '').trim()) {
              aiMessage = `⚠️ Marqué "${found.data.reason}" como cancelado en mi agenda, pero no pude eliminarlo de Google Calendar. Puede que tengas que borrarlo manualmente desde el calendario.`;
            }
          } else if (!calendarDeleted) {
            // Ni Firestore ni Calendar — NADA se borró
            console.warn(`${logPrefix} [CANCELAR-TMH] ⚠️ No se encontró evento para "${searchReason}" ni en Firestore ni en Calendar`);
            if (!aiMessage.replace(/\[CANCELAR_EVENTO:[^\]]+\]/g, '').trim()) {
              aiMessage = `⚠️ No encontré un evento con "${searchReason}" para eliminar. ¿Podés darme más detalles?`;
            }
          }
        } catch (cancelErr) {
          console.error(`${logPrefix} [CANCELAR-TMH] ❌ Error:`, cancelErr.message);
        }
        aiMessage = aiMessage.replace(/\[CANCELAR_EVENTO:[^\]]+\]/g, '').trim();
      }

      // ── TAG [MOVER_EVENTO:razón|fecha_vieja|fecha_nueva] — Mover evento ──
      const moverMatch = aiMessage.match(/\[MOVER_EVENTO:([^\]]+)\]/);
      if (moverMatch && isSelfChat) {
        const moverParts = moverMatch[1].split('|').map(p => p.trim());
        const [mSearchReason, mOldDate, mNewDate] = moverParts;
        console.log(`${logPrefix} [MOVER-TMH] 🔄 Buscando "${mSearchReason}" en ${mOldDate} → mover a ${mNewDate}`);
        try {
          let found = null;

          // ═══ FAST-PATH: Si viene con ID: → buscar directamente por docId ═══
          const mDocIdMatch = (mSearchReason || '').match(/^ID:(\S+)/i);
          if (mDocIdMatch) {
            const docId = mDocIdMatch[1];
            console.log(`${logPrefix} [MOVER-TMH] 🎯 Búsqueda por docId: ${docId}`);
            const docRef = db().collection('users').doc(ownerUid).collection('miia_agenda').doc(docId);
            const docSnap = await docRef.get();
            if (docSnap.exists && docSnap.data().status === 'pending') {
              found = { doc: docSnap, data: docSnap.data() };
              console.log(`${logPrefix} [MOVER-TMH] ✅ Encontrado por docId: "${found.data.reason}"`);
            } else {
              console.warn(`${logPrefix} [MOVER-TMH] ⚠️ DocId ${docId} no existe o no está pending`);
            }
          }

          // ═══ SCORING FALLBACK: Si no vino con ID: o no se encontró ═══
          if (!found) {
            const searchDateObj = mOldDate ? new Date(mOldDate) : new Date();
            const dayStart = new Date(searchDateObj); dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(searchDateObj); dayEnd.setHours(23, 59, 59, 999);

            const snap = await db().collection('users').doc(ownerUid).collection('miia_agenda')
              .where('status', '==', 'pending')
              .where('scheduledFor', '>=', dayStart.toISOString())
              .where('scheduledFor', '<=', dayEnd.toISOString())
              .orderBy('scheduledFor', 'asc').limit(10).get();

            const reasonLower = (mSearchReason || '').toLowerCase();
            const mReasonWords = reasonLower.split(/\s+/).filter(w => w.length > 2);
            let mBestScore = 0;
            for (const doc of snap.docs) {
              const evt = doc.data();
              const evtReason = (evt.reason || '').toLowerCase();
              const evtContact = (evt.contactName || '').toLowerCase();
              let score = 0;
              if (evtReason === reasonLower) {
                score = 100;
              } else {
                const evtWords = `${evtReason} ${evtContact}`.split(/\s+/).filter(w => w.length > 2);
                let matchedWords = 0;
                for (const word of mReasonWords) {
                  if (evtReason.includes(word) || evtContact.includes(word)) matchedWords++;
                }
                const forwardMatch = mReasonWords.length > 0 ? matchedWords / mReasonWords.length : 0;
                let reverseMatched = 0;
                for (const word of evtWords) {
                  if (reasonLower.includes(word)) reverseMatched++;
                }
                const reverseMatch = evtWords.length > 0 ? reverseMatched / evtWords.length : 0;
                score = Math.round((forwardMatch * 60 + reverseMatch * 40));
              }
              console.log(`${logPrefix} [MOVER-TMH] 📊 Score "${evt.reason}" (docId:${doc.id}) = ${score}`);
              if (score > mBestScore) {
                mBestScore = score;
                found = { doc, data: evt };
              }
            }
            if (found && mBestScore < 45) {
              console.warn(`${logPrefix} [MOVER-TMH] ⚠️ Mejor match "${found.data.reason}" score=${mBestScore} < 45 — RECHAZADO`);
              found = null;
            }
          }

          if (found && mNewDate) {
            const ownerPhone = getBasePhone(tenantState.sock?.user?.id || '');
            const ownerCountry = getCountryFromPhone(ownerPhone);
            const ownerTz = getTimezoneForCountry(ownerCountry);
            let newScheduledUTC = mNewDate;
            try {
              const parsedLocal = new Date(mNewDate);
              if (!isNaN(parsedLocal)) {
                const localStr = new Date().toLocaleString('en-US', { timeZone: ownerTz });
                const utcStr = new Date().toLocaleString('en-US', { timeZone: 'UTC' });
                const offsetMs = new Date(localStr) - new Date(utcStr);
                newScheduledUTC = new Date(parsedLocal.getTime() - offsetMs).toISOString();
              }
            } catch (tzErr) { /* usar original */ }

            // FIX Sesión 42M-F: movedFrom puede ser undefined si el evento no tiene scheduledForLocal
            const previousTime = found.data.scheduledForLocal || found.data.scheduledFor || mOldDate || 'desconocido';

            await found.doc.ref.update({
              scheduledFor: newScheduledUTC, scheduledForLocal: mNewDate,
              movedFrom: previousTime, movedAt: new Date().toISOString(),
              preReminderSent: false
            });
            console.log(`${logPrefix} [MOVER-TMH] ✅ Movido en Firestore: "${found.data.reason}" de ${previousTime} → ${mNewDate}`);

            // MOVER también en Google Calendar
            let calendarMoved = false;
            try {
              const { getCalendarClient } = require('../core/google_calendar');
              const { cal, calId } = await getCalendarClient(ownerUid);

              // Parsear nueva hora
              const newHourMatch = mNewDate.match(/(\d{1,2}):(\d{2})/);
              const newH = newHourMatch ? parseInt(newHourMatch[1]) : 10;
              const newMin = newHourMatch ? parseInt(newHourMatch[2]) : 0;
              const newDateStr = mNewDate.split('T')[0];
              const newStartDT = `${newDateStr}T${String(newH).padStart(2,'0')}:${String(newMin).padStart(2,'0')}:00`;
              const newEndDT = `${newDateStr}T${String(newH + 1).padStart(2,'0')}:${String(newMin).padStart(2,'0')}:00`;

              // FAST-PATH: Si tenemos calendarEventId, mover directo por ID
              if (found.data.calendarEventId) {
                try {
                  await cal.events.patch({
                    calendarId: calId, eventId: found.data.calendarEventId,
                    resource: {
                      start: { dateTime: newStartDT, timeZone: ownerTz },
                      end: { dateTime: newEndDT, timeZone: ownerTz }
                    }
                  });
                  calendarMoved = true;
                  console.log(`${logPrefix} [MOVER-TMH] ✅ Movido en Calendar por calendarEventId → ${newStartDT}`);
                } catch (patchErr) {
                  console.warn(`${logPrefix} [MOVER-TMH] ⚠️ Patch por calendarEventId falló: ${patchErr.message}`);
                }
              }

              // FALLBACK: Buscar en Calendar por texto + rango del día viejo
              if (!calendarMoved) {
                const searchDateObj = mOldDate ? new Date(mOldDate) : new Date();
                const calDayStart = new Date(searchDateObj); calDayStart.setHours(0, 0, 0, 0);
                const calDayEnd = new Date(searchDateObj); calDayEnd.setHours(23, 59, 59, 999);
                const searchText = (found.data.reason || mSearchReason).replace(/[🎉🎂📍🎈]/g, '').trim().substring(0, 50);

                const calEvents = await cal.events.list({
                  calendarId: calId, timeMin: calDayStart.toISOString(), timeMax: calDayEnd.toISOString(),
                  singleEvents: true, q: searchText
                });
                const calItems = (calEvents.data?.items || []).filter(e => e.status !== 'cancelled');
                if (calItems.length > 0) {
                  const calEvt = calItems[0];
                  await cal.events.patch({
                    calendarId: calId, eventId: calEvt.id,
                    resource: {
                      start: { dateTime: newStartDT, timeZone: ownerTz },
                      end: { dateTime: newEndDT, timeZone: ownerTz }
                    }
                  });
                  calendarMoved = true;
                  console.log(`${logPrefix} [MOVER-TMH] ✅ Movido en Calendar por text search: "${calEvt.summary}" → ${newStartDT}`);
                } else {
                  console.warn(`${logPrefix} [MOVER-TMH] ⚠️ No encontré evento en Google Calendar para mover: "${searchText}"`);
                }
              }
            } catch (calMoveErr) {
              console.warn(`${logPrefix} [MOVER-TMH] ⚠️ Error moviendo en Calendar: ${calMoveErr.message}`);
            }

            _agendaTagProcessed = true;

            if (!aiMessage.replace(/\[MOVER_EVENTO:[^\]]+\]/g, '').trim()) {
              if (calendarMoved) {
                aiMessage = `✅ Moví "${found.data.reason}" de ${previousTime} a ${mNewDate} (agenda y Google Calendar actualizados).`;
              } else {
                aiMessage = `✅ Moví "${found.data.reason}" de ${previousTime} a ${mNewDate} en mi agenda, pero no pude actualizarlo en Google Calendar.`;
              }
            }
          } else if (!found) {
            console.warn(`${logPrefix} [MOVER-TMH] ⚠️ No se encontró evento para "${mSearchReason}"`);
          }
        } catch (moverErr) {
          console.error(`${logPrefix} [MOVER-TMH] ❌ Error:`, moverErr.message);
        }
        aiMessage = aiMessage.replace(/\[MOVER_EVENTO:[^\]]+\]/g, '').trim();
      }

      // ── TAG [PROPONER_HORARIO:duración] — MIIA propone slots libres del Calendar ──
      const proponerMatch = aiMessage.match(/\[PROPONER_HORARIO(?::(\d+))?\]/);
      if (proponerMatch) {
        const duration = parseInt(proponerMatch[1]) || 60;
        aiMessage = aiMessage.replace(/\[PROPONER_HORARIO(?::\d+)?\]/g, '').trim();
        try {
          // proposeCalendarSlot local — usa checkCalendarAvailability exportado de google_calendar
          const schedCfg = await getCalScheduleConfig(ownerUid);
          const workStart = schedCfg?.workStartHour || 9;
          const workEnd = schedCfg?.workEndHour || 18;
          const proposals = [];
          for (let d = 0; d < 3 && proposals.length < 5; d++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + d);
            const day = targetDate.getDay();
            if (day === 0 || day === 6) continue;
            const dateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;
            try {
              const avail = await checkCalendarAvailability(dateStr, ownerUid);
              for (const slot of avail.freeSlots) {
                const [startStr] = slot.split(' - ');
                const startHour = parseInt(startStr);
                if (startHour < workStart || startHour + Math.ceil(duration / 60) > workEnd) continue;
                proposals.push({ display: `${dateStr} de ${startHour}:00 a ${startHour + Math.ceil(duration / 60)}:00` });
                if (proposals.length >= 5) break;
              }
            } catch (e) { console.warn(`${logPrefix} [PROPONER-TMH] ⚠️ ${dateStr}: ${e.message}`); }
          }
          if (proposals.length > 0) {
            const slotsText = proposals.map((p, i) => `${i + 1}. ${p.display}`).join('\n');
            aiMessage += `\n\n📅 *Horarios disponibles (${duration} min):*\n${slotsText}\n\n¿Cuál te queda mejor?`;
            console.log(`${logPrefix} [PROPONER-TMH] ✅ ${proposals.length} slots propuestos`);
          } else {
            aiMessage += '\n\n📅 No encontré horarios libres en los próximos días. ¿Querés que busque más adelante?';
            console.log(`${logPrefix} [PROPONER-TMH] ⚠️ Sin slots disponibles`);
          }
        } catch (propErr) {
          console.error(`${logPrefix} [PROPONER-TMH] ❌ Error:`, propErr.message);
        }
      }

      // ── TAG [RECORDAR_OWNER:fecha|mensaje] — Contacto dice "recuérdale al owner que..." ──
      const recordOwnerMatch = aiMessage.match(/\[RECORDAR_OWNER:([^|]+)\|([^\]]+)\]/);
      if (recordOwnerMatch) {
        const recordFecha = recordOwnerMatch[1].trim();
        const recordMsg = recordOwnerMatch[2].trim();
        aiMessage = aiMessage.replace(/\[RECORDAR_OWNER:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [RECORDAR-TMH] ⏰ Recordatorio para owner: "${recordMsg}" → ${recordFecha}`);
        try {
          const selfJid = tenantState.sock?.user?.id;
          const ownerNotifyPhone = selfJid ? (selfJid.includes(':') ? selfJid.split(':')[0] + '@s.whatsapp.net' : selfJid) : null;
          await db().collection('users').doc(ownerUid).collection('miia_agenda').add({
            type: 'recordatorio_contacto',
            from: basePhone,
            fromName: basePhone,
            message: recordMsg,
            scheduledFor: recordFecha,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            notifyTarget: 'owner',
            notifyPhone: ownerNotifyPhone,
            contactPhone: 'self'
          });
          console.log(`${logPrefix} [RECORDAR-TMH] ✅ Recordatorio agendado para owner`);
        } catch (e) {
          console.error(`${logPrefix} [RECORDAR-TMH] ❌ Error:`, e.message);
        }
      }

      // ── TAG [RECORDAR_CONTACTO:fecha|mensaje] — Contacto dice "recuérdame que..." ──
      const recordContactoMatch = aiMessage.match(/\[RECORDAR_CONTACTO:([^|]+)\|([^\]]+)\]/);
      if (recordContactoMatch) {
        const recordFecha = recordContactoMatch[1].trim();
        const recordMsg = recordContactoMatch[2].trim();
        aiMessage = aiMessage.replace(/\[RECORDAR_CONTACTO:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [RECORDAR-TMH] ⏰ Recordatorio para contacto ${basePhone}: "${recordMsg}" → ${recordFecha}`);
        try {
          await db().collection('users').doc(ownerUid).collection('miia_agenda').add({
            type: 'recordatorio_contacto',
            from: basePhone,
            fromName: basePhone,
            message: recordMsg,
            scheduledFor: recordFecha,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            notifyTarget: 'contact',
            notifyPhone: phone
          });
          console.log(`${logPrefix} [RECORDAR-TMH] ✅ Recordatorio agendado para contacto`);
        } catch (e) {
          console.error(`${logPrefix} [RECORDAR-TMH] ❌ Error:`, e.message);
        }
      }

      // ── TAG [ALERTA_OWNER:mensaje] — MIIA pide acción manual del owner ──
      const alertaOwnerMatch = aiMessage.match(/\[ALERTA_OWNER:([^\]]+)\]/);
      if (alertaOwnerMatch) {
        const alertMsg = alertaOwnerMatch[1].trim();
        aiMessage = aiMessage.replace(/\[ALERTA_OWNER:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [ALERTA-TMH] 📢 Lead ${phone}: ${alertMsg}`);
        await sendToOwnerSelfChat(`📢 *Acción requerida* — Lead ${basePhone}:\n${alertMsg}`);
      }

      // ── TAG [MENSAJE_PARA_OWNER:mensaje] — Contacto dice "dile al owner que..." ──
      const msgOwnerMatch = aiMessage.match(/\[MENSAJE_PARA_OWNER:([^\]]+)\]/);
      if (msgOwnerMatch) {
        const msgForOwner = msgOwnerMatch[1].trim();
        aiMessage = aiMessage.replace(/\[MENSAJE_PARA_OWNER:[^\]]+\]/g, '').trim();
        console.log(`${logPrefix} [DILE-A-TMH] 📩 ${basePhone} → Owner: "${msgForOwner}"`);
        await sendToOwnerSelfChat(`📩 *${basePhone}* te dice:\n"${msgForOwner}"`);
      }

      // ── TAG [CREAR_TAREA:título|fecha|notas] — Google Tasks ──
      try {
        const googleTasks = require('../integrations/google_tasks_integration');
        const taskTag = googleTasks.parseTaskTag(aiMessage);
        if (taskTag && isSelfChat) {
          aiMessage = aiMessage.replace(taskTag.rawTag, '').trim();
          console.log(`${logPrefix} [TASKS-TMH] 📋 Creando tarea: "${taskTag.title}"`);
          try {
            await googleTasks.createTask(ownerUid, getOAuth2Client, admin, {
              title: taskTag.title, dueDate: taskTag.dueDate, notes: taskTag.notes || 'Creada por MIIA'
            });
            _tareaTagProcessed = true;
            console.log(`${logPrefix} [TASKS-TMH] ✅ Tarea creada`);
          } catch (e) {
            console.error(`${logPrefix} [TASKS-TMH] ❌ Error creando tarea:`, e.message);
          }
        }

        // ── TAG [LISTAR_TAREAS] ──
        if (googleTasks.parseListTasksTag(aiMessage) && isSelfChat) {
          aiMessage = aiMessage.replace(/\[LISTAR_TAREAS\]/g, '').trim();
          try {
            const tasks = await googleTasks.listTasks(ownerUid, getOAuth2Client, admin);
            const formattedTasks = googleTasks.formatTasksList(tasks);
            await sendToOwnerSelfChat(formattedTasks);
          } catch (e) {
            console.error(`${logPrefix} [TASKS-TMH] ❌ Error listando tareas:`, e.message);
          }
        }

        // ── TAG [COMPLETAR_TAREA:título] ──
        const completeTag = googleTasks.parseCompleteTaskTag(aiMessage);
        if (completeTag && isSelfChat) {
          aiMessage = aiMessage.replace(completeTag.rawTag, '').trim();
          try {
            await googleTasks.completeTask(ownerUid, getOAuth2Client, admin, { titleMatch: completeTag.titleMatch });
            console.log(`${logPrefix} [TASKS-TMH] ✅ Tarea completada`);
          } catch (e) {
            console.error(`${logPrefix} [TASKS-TMH] ❌ Error completando tarea:`, e.message);
          }
        }
      } catch (tasksModErr) {
        console.warn(`${logPrefix} [TASKS-TMH] ⚠️ Module error:`, tasksModErr.message);
      }

    } catch (agendaModuleErr) {
      console.error(`${logPrefix} [AGENDA-TMH] ❌ Module error:`, agendaModuleErr.message);
      aiMessage = aiMessage.replace(/\[AGENDAR_EVENTO:[^\]]+\]/g, '').replace(/\[SOLICITAR_TURNO:[^\]]+\]/g, '')
        .replace(/\[CONSULTAR_AGENDA\]/g, '').replace(/\[RECORDAR_OWNER:[^\]]+\]/g, '')
        .replace(/\[RECORDAR_CONTACTO:[^\]]+\]/g, '').replace(/\[ALERTA_OWNER:[^\]]+\]/g, '')
        .replace(/\[MENSAJE_PARA_OWNER:[^\]]+\]/g, '').replace(/\[CREAR_TAREA:[^\]]+\]/g, '')
        .replace(/\[LISTAR_TAREAS\]/g, '').replace(/\[COMPLETAR_TAREA:[^\]]+\]/g, '')
        .replace(/\[CANCELAR_EVENTO:[^\]]+\]/g, '').replace(/\[ELIMINAR_EVENTO:[^\]]+\]/g, '')
        .replace(/\[MOVER_EVENTO:[^\]]+\]/g, '').replace(/\[PROPONER_HORARIO(?::\d+)?\]/g, '').trim();
    }
  }

  // 11d-FINAL. Limpiar tags residuales (correo maestro, cotización sin procesar, etc.)
  aiMessage = cleanResidualTags(aiMessage);

  // ═══════════════════════════════════════════════════════════════
  // 11d-PROMESA-ROTA. Detectar cuando MIIA dice "ya lo hice" sin haber emitido tag
  // Si MIIA confirma una acción pero NO emitió el tag → la acción NO se ejecutó → PROMESA ROTA
  // En vez de dejar pasar la mentira, reemplazamos la confirmación falsa por honestidad
  // ═══════════════════════════════════════════════════════════════
  {
    const msgLower = aiMessage.toLowerCase();
    const originalMsg = messageBody?.toLowerCase() || '';

    // Detectar si el owner pidió una acción
    const pidioEmail = /\b(correo|email|mail|mand[aá]le?\s*(un\s*)?(correo|email|mail)|env[ií]a(le|r)?.*correo)\b/i.test(originalMsg);
    const pidioAgendar = /\b(agend[aá]|record[aá]|cumplea[nñ]os|reuni[oó]n|cita|turno|a\s*las\s*\d)/i.test(originalMsg);
    const pidioTarea = /\b(tarea|to.?do|pendiente|lista\s+de)\b/i.test(originalMsg);

    // Detectar si MIIA confirma la acción
    const confirmaEjecucion = /\b(ya\s*(lo\s*)?(mand[eé]|envi[eé]|agend[eé]|cre[eé]|hice|est[aá]\s*(saliendo|listo|enviado|agendado))|listo.*✅|en\s*camino|correo.*saliendo|ya\s*qued[oó]|ya.*agendad[oa])\b/i.test(msgLower);

    // Verificar si la acción fue REALMENTE ejecutada por los bloques 11d-*
    // Usamos las flags _emailTagProcessed, _agendaTagProcessed, _tareaTagProcessed
    // que se setean en true SOLO cuando el tag se procesó Y la acción tuvo éxito
    // NOTA: NO buscar tags en aiMessage porque ya fueron strippeados por los bloques de arriba

    if (pidioEmail && confirmaEjecucion && !_emailTagProcessed) {
      console.error(`${logPrefix} 🚨 [PROMESA-ROTA] MIIA dice que envió email pero NO emitió [ENVIAR_CORREO:] — CORRIGIENDO`);
      aiMessage = aiMessage.replace(/ya\s*(lo\s*)?(mand[eé]|envi[eé]).*?(✅|📧|correo|email)[^.!]*[.!]?/gi, '').trim();
      aiMessage += '\n\n⚠️ Necesito que me confirmes los datos para poder enviar el correo correctamente. ¿A qué email lo mando, con qué asunto y qué quieres que diga?';
    }

    if (pidioAgendar && confirmaEjecucion && !_agendaTagProcessed) {
      console.error(`${logPrefix} 🚨 [PROMESA-ROTA] MIIA dice que agendó pero NO emitió [AGENDAR_EVENTO:] — CORRIGIENDO`);
      aiMessage = aiMessage.replace(/ya\s*(lo\s*)?(agend[eé]|cre[eé]).*?(✅|📅|agendad[oa]|memoria)[^.!]*[.!]?/gi, '').trim();
      aiMessage += '\n\n⚠️ Para agendarlo de verdad en tu calendario, necesito confirmar: ¿la fecha y hora exactas?';
    }

    if (pidioTarea && confirmaEjecucion && !_tareaTagProcessed) {
      console.error(`${logPrefix} 🚨 [PROMESA-ROTA] MIIA dice que creó tarea pero NO emitió [CREAR_TAREA:] — CORRIGIENDO`);
    }
  }

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

  // ── PASO 12a: VALIDADOR PRE-ENVÍO — última barrera contra mentiras y leaks ──
  {
    const validation = validatePreSend(aiMessage, {
      isSelfChat,
      chatType: contactType || 'lead',
      executionFlags: {
        email: _emailTagProcessed,
        agenda: _agendaTagProcessed,
        tarea: _tareaTagProcessed,
      },
      logPrefix,
    });
    if (validation.wasModified) {
      console.warn(`${logPrefix} [VALIDATOR] Mensaje corregido: ${validation.issues.join(', ')}`);
      aiMessage = validation.message;
    }
  }

  // ── PASO 12b: Emoji de estado MIIA ──
  // applyMiiaEmoji SIEMPRE quita el emoji que puso la IA y pone el oficial
  // Contar acciones ejecutadas para emoji 🤹‍��️ (multi-acción = MIIA trabajando a full)
  const actionsExecuted = [_emailTagProcessed, _agendaTagProcessed, _tareaTagProcessed].filter(Boolean).length;
  aiMessage = applyMiiaEmoji(aiMessage, {
    isSelfChat,
    contactType: contactType || 'lead',
    messageBody,
    isMultiAction: actionsExecuted >= 2,
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

  } catch (fatalErr) {
    // ═══ CATCH GLOBAL — MIIA NUNCA se queda callada ═══
    console.error(`${logPrefix} 🔥 ERROR FATAL en handleTenantMessage para ${phone}: ${fatalErr.message}`);
    console.error(`${logPrefix} 🔥 Stack: ${fatalErr.stack}`);
    // Intentar enviar mensaje de error al usuario para que sepa que pasó algo
    try {
      if (tenantState?.sock && tenantState.isReady) {
        const errorMsg = isSelfChat
          ? `⚠️ Tuve un error interno procesando tu mensaje. Por favor intentá de nuevo. (Error: ${fatalErr.message?.substring(0, 100)})`
          : '⚠️ Disculpa, tuve un problema técnico. ¿Podrías repetir tu mensaje?';
        await tenantState.sock.sendMessage(phone, { text: errorMsg });
      }
    } catch (sendErr) {
      console.error(`${logPrefix} 🔥 No pude ni enviar error al usuario: ${sendErr.message}`);
    }
  }
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
    const sentMsg = await tenantState.sock.sendMessage(phone, { text: content });
    rateLimiter.recordOutgoing(tenantState.uid);
    try { require('../core/privacy_counters').recordOutgoing(tenantState.uid); } catch (_) {}

    // ═══ BUG3b-FIX: Registrar msgId enviado para prevenir auto-respuesta ═══
    // Si MIIA envía al self-chat, Baileys lo ve como fromMe=true y puede re-procesarlo.
    // Guardamos el msgId para ignorarlo en messages.upsert.
    const sentMsgId = sentMsg?.key?.id;
    if (sentMsgId) {
      if (!tenantState._sentMsgIds) tenantState._sentMsgIds = new Set();
      tenantState._sentMsgIds.add(sentMsgId);
      // Cleanup: mantener máx 200 entries
      if (tenantState._sentMsgIds.size > 200) {
        const arr = [...tenantState._sentMsgIds];
        tenantState._sentMsgIds = new Set(arr.slice(-100));
      }
    }

    console.log(`[TMH:${tenantState.uid}] 📤 Mensaje enviado a ${phone} (${content.length} chars)${sentMsgId ? ` msgId=${sentMsgId.substring(0, 12)}...` : ''}`);
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
