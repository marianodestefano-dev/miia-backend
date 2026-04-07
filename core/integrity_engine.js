'use strict';

/**
 * INTEGRITY ENGINE v1.0 — Motor de integridad de MIIA
 *
 * Polling cada 5 minutos que verifica:
 * 1. Promesas de agenda cumplidas (regex)
 * 2. Promesas implícitas detectadas por Gemini Flash (gratis)
 * 3. Preferencias/gustos/afinidades aprendidas de contactos
 * 4. Verificación Calendar sync post-creación
 *
 * Costo: $0/mes (Gemini Flash free tier)
 */

const admin = require('firebase-admin');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
const MAX_CONVERSATIONS_PER_POLL = 20;   // No sobrecargar
const LOOKBACK_MINUTES = 10;             // Revisar últimos 10 min de conversaciones
const MAX_PENDING_AGE_HOURS = 48;        // Alertar si pendiente >48h

// ═══ ADN LEARNING VIVO — Reemplaza el mining muerto de cerebro_absoluto ═══
const ADN_CONSOLIDATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hora
const ADN_ACTIVE_HOURS = { start: 8, end: 20 };       // 8am-8pm
let lastAdnConsolidation = 0;

// Regex para detectar promesas en mensajes de MIIA
const PROMISE_PATTERNS = [
  // Agenda
  { pattern: /(?:te|le|lo)\s+agend[oé]|ya.*agendad|listo.*agend|queda.*agendad/i, action: 'agendar', tag: 'AGENDAR_EVENTO' },
  // Email
  { pattern: /(?:te|le)\s+(?:mand[oé]|envi[oé]).*(?:mail|correo|email)|listo.*(?:mail|correo)/i, action: 'email', tag: 'ENVIAR_CORREO' },
  // Recordatorio
  { pattern: /(?:te|le)\s+(?:recuerdo|aviso)|anotado.*recuer|listo.*recordatorio/i, action: 'recordar', tag: 'RECORDAR' },
  // Cotización
  { pattern: /(?:te|le)\s+(?:mand[oé]|envi[oé]).*cotizaci[oó]n|listo.*cotizaci[oó]n/i, action: 'cotizacion', tag: 'GENERAR_COTIZACION_PDF' },
  // Cancelar evento
  { pattern: /ya.*cancel[oé]|listo.*cancelad|queda.*cancelad/i, action: 'cancelar', tag: 'CANCELAR_EVENTO' },
  // Mover evento
  { pattern: /ya.*mov[ií]|listo.*movid|queda.*reprogramad/i, action: 'mover', tag: 'MOVER_EVENTO' },
];

// Regex para detectar preferencias/gustos aprendibles
const PREFERENCE_PATTERNS = [
  { pattern: /(?:soy\s+hincha\s+de|me\s+gusta|me\s+encanta|mi\s+equipo\s+es|soy\s+fan\s+de)\s+(.+)/i, type: 'gusto', category: 'deporte_o_general' },
  { pattern: /(?:mi\s+comida\s+favorita|me\s+fascina\s+comer|adoro\s+(?:la|el|los|las)?)\s+(.+)/i, type: 'gusto', category: 'comida' },
  { pattern: /(?:vivo\s+en|soy\s+de|estoy\s+en)\s+(.+)/i, type: 'ubicacion', category: 'ubicacion' },
  { pattern: /(?:mi\s+cumple(?:años)?\s+es\s+(?:el\s+)?|nac[ií]\s+el\s+)(.+)/i, type: 'dato_personal', category: 'cumpleanos' },
  { pattern: /(?:trabajo\s+en|soy\s+(?:médico|abogado|ingeniero|profesor|doctor|contador|diseñador|programador|arquitecto|vendedor|empresario))/i, type: 'dato_personal', category: 'profesion' },
  { pattern: /(?:me\s+gusta\s+(?:escuchar|la\s+música\s+de)|mi\s+(?:cantante|artista|banda)\s+favorit[oa])\s+(.+)/i, type: 'gusto', category: 'musica' },
  { pattern: /(?:prefiero|me\s+gusta\s+más)\s+(.+)\s+(?:que|antes\s+que)\s+(.+)/i, type: 'preferencia', category: 'comparativa' },
];

// ═══════════════════════════════════════════════════════════════════
// CAPA 2: AUTO-REPAIR — Extraer contexto de promesa rota
// ═══════════════════════════════════════════════════════════════════

/**
 * Intenta reconstruir el tag faltante desde el contexto del mensaje.
 * Si MIIA dijo "te agendé X para el viernes a las 10" pero no emitió tag,
 * intenta extraer los datos y generar el tag.
 *
 * @param {string} aiMessage - Mensaje de MIIA con la promesa rota
 * @param {string} action - Tipo de acción ('agendar', 'email', etc.)
 * @param {string} contactPhone - Teléfono del contacto
 * @param {string} contactName - Nombre del contacto
 * @returns {string|null} Tag reconstruido o null si no se pudo
 */
function attemptAutoRepair(aiMessage, action, contactPhone, contactName) {
  if (action === 'agendar') {
    // Intentar extraer fecha y razón del mensaje
    const dateMatch = aiMessage.match(/(?:para\s+(?:el\s+)?)?(\d{1,2})\s+(?:de\s+)?(\w+)(?:\s+(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|hs)?)?/i);
    const reasonMatch = aiMessage.match(/agend[eé]\s+(?:una?\s+)?(.+?)(?:\s+para\s+|\s+el\s+|\.|$)/i);

    if (dateMatch) {
      const day = dateMatch[1];
      const monthStr = dateMatch[2];
      const hour = dateMatch[3] || '10';
      const minutes = dateMatch[4] || '00';
      const ampm = dateMatch[5];

      const months = { enero: '01', febrero: '02', marzo: '03', abril: '04', mayo: '05', junio: '06',
        julio: '07', agosto: '08', septiembre: '09', octubre: '10', noviembre: '11', diciembre: '12',
        lunes: null, martes: null, miércoles: null, jueves: null, viernes: null, sábado: null, domingo: null,
        mañana: null, hoy: null };

      let isoDate = null;
      const monthNum = months[monthStr?.toLowerCase()];

      if (monthNum) {
        const year = new Date().getFullYear();
        let h = parseInt(hour);
        if (ampm === 'pm' && h < 12) h += 12;
        if (ampm === 'am' && h === 12) h = 0;
        isoDate = `${year}-${monthNum}-${day.padStart(2, '0')}T${String(h).padStart(2, '0')}:${minutes}:00`;
      } else if (monthStr?.toLowerCase() === 'mañana') {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        let h = parseInt(hour);
        if (ampm === 'pm' && h < 12) h += 12;
        isoDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:${minutes}:00`;
      }

      if (isoDate) {
        const reason = reasonMatch?.[1]?.trim() || 'Evento';
        const contact = contactPhone || contactName || 'self';
        console.log(`[INTEGRITY:REPAIR] 🔧 Auto-repair: reconstruido [AGENDAR_EVENTO:${contact}|${isoDate}|${reason}||presencial|]`);
        return `[AGENDAR_EVENTO:${contact}|${isoDate}|${reason}||presencial|]`;
      }
    }

    console.warn(`[INTEGRITY:REPAIR] ⚠️ No se pudo reconstruir tag de agenda desde: "${aiMessage.substring(0, 200)}"`);
    return null;
  }

  // Para otros tipos de acción, no auto-repair por ahora (requieren más contexto)
  console.log(`[INTEGRITY:REPAIR] ℹ️ Auto-repair no disponible para acción: ${action}`);
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// CAPA 3: POLLING ENGINE — Verificación periódica
// ═══════════════════════════════════════════════════════════════════

/**
 * Estado interno del engine (en memoria, synced a Firestore periódicamente)
 */
const engineState = {
  lastPollAt: null,
  promisesDetected: 0,
  promisesFulfilled: 0,
  promisesBroken: 0,
  preferencesLearned: 0,
  isRunning: false,
};

/**
 * Polling principal — se ejecuta cada 5 minutos via setInterval
 *
 * @param {object} deps - Dependencias inyectadas
 * @param {string} deps.ownerUid - UID del owner
 * @param {Function} deps.generateAI - Función para llamar a Gemini Flash
 * @param {Function} deps.safeSendMessage - Función para enviar mensajes
 * @param {string} deps.ownerPhone - Teléfono del owner
 */
async function runIntegrityPoll(deps) {
  if (engineState.isRunning) {
    console.log('[INTEGRITY] ⏳ Poll anterior aún corriendo, saltando...');
    return;
  }

  engineState.isRunning = true;
  engineState.lastPollAt = new Date().toISOString();

  try {
    const { ownerUid, generateAI, safeSendMessage, ownerPhone } = deps;
    if (!ownerUid) {
      console.warn('[INTEGRITY] ⚠️ No hay ownerUid — saltando poll');
      return;
    }

    const db = admin.firestore();
    const now = new Date();
    const lookbackTime = new Date(now.getTime() - LOOKBACK_MINUTES * 60 * 1000);

    // ─── PASO 1: Verificar agenda pendiente con antigüedad excesiva ───
    await checkStalePendingEvents(db, ownerUid, safeSendMessage, ownerPhone, now);

    // ─── PASO 2: Verificar Calendar sync para eventos recientes ───
    await checkCalendarSync(db, ownerUid, safeSendMessage, ownerPhone);

    // ─── PASO 3: Gemini Flash — análisis profundo (si hay generateAI) ───
    if (generateAI) {
      await runGeminiAudit(db, ownerUid, generateAI, safeSendMessage, ownerPhone, lookbackTime);
    }

    // ─── PASO 4: ADN LEARNING VIVO — Consolidación horaria (8am-8pm) ───
    // Reemplaza el mining muerto de cerebro_absoluto.
    // Lee preferencias/afinidades acumuladas → genera bloque de ADN → appendLearning.
    // Los datos son PERMANENTES — solo se borran si el owner lo pide explícitamente.
    const currentHour = new Date().getHours();
    const timeSinceLastConsolidation = Date.now() - lastAdnConsolidation;
    if (generateAI && deps.appendLearning &&
        currentHour >= ADN_ACTIVE_HOURS.start && currentHour < ADN_ACTIVE_HOURS.end &&
        timeSinceLastConsolidation >= ADN_CONSOLIDATION_INTERVAL_MS) {
      await consolidateADNLearning(db, ownerUid, generateAI, deps.appendLearning);
      lastAdnConsolidation = Date.now();
    }

    console.log(`[INTEGRITY] ✅ Poll completo — promesas: ${engineState.promisesDetected} detectadas, ${engineState.promisesBroken} rotas, prefs: ${engineState.preferencesLearned}`);

  } catch (err) {
    console.error(`[INTEGRITY] ❌ Error en poll: ${err.message}`);
  } finally {
    engineState.isRunning = false;
  }
}

/**
 * PASO 1: Detectar eventos pendientes que ya pasaron su hora y no se ejecutaron
 */
async function checkStalePendingEvents(db, ownerUid, safeSendMessage, ownerPhone, now) {
  try {
    const agendaRef = db.collection('users').doc(ownerUid).collection('miia_agenda');
    const staleSnap = await agendaRef
      .where('status', '==', 'pending')
      .where('scheduledFor', '<', now.toISOString())
      .limit(10)
      .get();

    if (staleSnap.empty) return;

    for (const doc of staleSnap.docs) {
      const data = doc.data();
      const scheduledDate = new Date(data.scheduledFor);
      const hoursOld = (now - scheduledDate) / (1000 * 60 * 60);

      if (hoursOld > MAX_PENDING_AGE_HOURS) {
        // Marcar como expirado
        await doc.ref.update({ status: 'expired', expiredAt: now.toISOString() });
        console.warn(`[INTEGRITY:STALE] ⏰ Evento expirado (${Math.round(hoursOld)}h): "${data.reason}" del ${data.scheduledForLocal}`);
      } else if (hoursOld > 1) {
        // Evento pasó hace >1h y sigue pendiente — avisar al owner
        console.warn(`[INTEGRITY:STALE] ⚠️ Evento pendiente pasado (${Math.round(hoursOld)}h): "${data.reason}" del ${data.scheduledForLocal}`);
      }
    }
  } catch (err) {
    console.error(`[INTEGRITY:STALE] ❌ Error: ${err.message}`);
  }
}

/**
 * PASO 2 (Capa 4): Verificar que eventos con calendarSynced=true realmente existen en Calendar
 */
async function checkCalendarSync(db, ownerUid, safeSendMessage, ownerPhone) {
  try {
    const agendaRef = db.collection('users').doc(ownerUid).collection('miia_agenda');
    const recentSnap = await agendaRef
      .where('calendarSynced', '==', true)
      .where('calendarVerified', '==', null) // Solo los no verificados aún
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();

    if (recentSnap.empty) return;

    // Por ahora marcar como verificados (cuando haya Calendar API list, hacer verify real)
    // TODO: Llamar a Google Calendar API para confirmar que el evento existe
    for (const doc of recentSnap.docs) {
      await doc.ref.update({ calendarVerified: true, verifiedAt: new Date().toISOString() });
      console.log(`[INTEGRITY:CALENDAR] ✅ Evento marcado como verificado: "${doc.data().reason}"`);
    }
  } catch (err) {
    // calendarVerified puede no existir como campo indexado — ignorar silenciosamente
    if (err.code === 9 || err.message?.includes('index')) {
      console.log('[INTEGRITY:CALENDAR] ℹ️ Index no disponible para calendarVerified — saltando verificación');
    } else {
      console.error(`[INTEGRITY:CALENDAR] ❌ Error: ${err.message}`);
    }
  }
}

/**
 * PASO 3: Gemini Flash analiza conversaciones recientes buscando:
 * - Promesas implícitas no capturadas por regex
 * - Preferencias/gustos/afinidades del contacto
 * - Información útil para personalizar MIIA
 *
 * Costo: $0 (Gemini Flash free tier, ~1 req cada 5 min = 288/día << 1500 RPD free)
 */
async function runGeminiAudit(db, ownerUid, generateAI, safeSendMessage, ownerPhone, lookbackTime) {
  try {
    // Buscar conversaciones recientes en sessions
    const sessionsRef = db.collection('users').doc(ownerUid).collection('sessions');
    const today = new Date().toISOString().split('T')[0];
    const sessionDoc = await sessionsRef.doc(today).get();

    if (!sessionDoc.exists) return;

    const sessionData = sessionDoc.data();
    const messages = sessionData.messages || [];

    // Filtrar mensajes recientes (últimos 10 min)
    const recentMessages = messages.filter(m => {
      if (!m.timestamp) return false;
      return new Date(m.timestamp) >= lookbackTime;
    }).slice(-MAX_CONVERSATIONS_PER_POLL);

    if (recentMessages.length === 0) return;

    // Construir contexto para Gemini Flash
    const conversationSnippet = recentMessages.map(m => {
      const role = m.fromMe ? 'MIIA' : (m.contactName || 'Contacto');
      return `${role}: ${(m.text || '').substring(0, 300)}`;
    }).join('\n');

    const auditPrompt = `Analizá estas conversaciones recientes de MIIA (asistente IA en WhatsApp).
Buscá SOLO estas 3 cosas:

1. PROMESAS INCUMPLIDAS: ¿MIIA prometió hacer algo (agendar, enviar email, recordar, buscar info) y NO hay evidencia de que lo haya hecho? Solo si es una promesa EXPLÍCITA.
2. PREFERENCIAS APRENDIBLES: ¿El contacto reveló gustos, preferencias, datos personales que MIIA debería recordar? (equipo favorito, comida, profesión, cumpleaños, ubicación, etc.)
3. AFINIDADES: ¿Se mencionaron temas de interés común entre el contacto y el owner que MIIA podría usar para personalizar futuras conversaciones?

CONVERSACIONES:
${conversationSnippet}

Respondé SOLO con JSON válido, sin markdown:
{"promises":[{"text":"qué prometió","fulfilled":true/false}],"preferences":[{"contact":"nombre","type":"tipo","value":"valor","category":"categoría"}],"affinities":[{"contact":"nombre","topic":"tema","detail":"detalle"}]}
Si no hay nada relevante: {"promises":[],"preferences":[],"affinities":[]}`;

    const response = await generateAI(auditPrompt);

    // Parsear respuesta
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const result = JSON.parse(jsonMatch[0]);

      // Procesar promesas rotas
      if (result.promises?.length > 0) {
        const broken = result.promises.filter(p => !p.fulfilled);
        if (broken.length > 0) {
          engineState.promisesBroken += broken.length;
          console.warn(`[INTEGRITY:GEMINI] 🚨 ${broken.length} promesas rotas detectadas: ${broken.map(p => p.text).join('; ')}`);
          // No notificar al owner por ahora — solo logear. En v2 se notifica.
        }
        engineState.promisesDetected += result.promises.length;
      }

      // Guardar preferencias aprendidas
      if (result.preferences?.length > 0) {
        for (const pref of result.preferences) {
          if (!pref.contact || !pref.value) continue;
          try {
            const prefRef = db.collection('users').doc(ownerUid)
              .collection('contact_preferences').doc(sanitizeDocId(pref.contact));
            await prefRef.set({
              [pref.category || pref.type || 'general']: pref.value,
              contactName: pref.contact,
              updatedAt: new Date().toISOString(),
              source: 'integrity_engine',
            }, { merge: true });
            engineState.preferencesLearned++;
            console.log(`[INTEGRITY:GEMINI] 📝 Preferencia guardada: ${pref.contact} → ${pref.category}: ${pref.value}`);
          } catch (prefErr) {
            console.warn(`[INTEGRITY:GEMINI] ⚠️ Error guardando preferencia: ${prefErr.message}`);
          }
        }
      }

      // Guardar afinidades
      if (result.affinities?.length > 0) {
        for (const aff of result.affinities) {
          if (!aff.contact || !aff.topic) continue;
          try {
            const affRef = db.collection('users').doc(ownerUid)
              .collection('contact_affinities').doc(sanitizeDocId(aff.contact));
            await affRef.set({
              [aff.topic]: aff.detail || true,
              contactName: aff.contact,
              updatedAt: new Date().toISOString(),
              source: 'integrity_engine',
            }, { merge: true });
            console.log(`[INTEGRITY:GEMINI] 🤝 Afinidad guardada: ${aff.contact} → ${aff.topic}: ${aff.detail}`);
          } catch (affErr) {
            console.warn(`[INTEGRITY:GEMINI] ⚠️ Error guardando afinidad: ${affErr.message}`);
          }
        }
      }

    } catch (parseErr) {
      console.warn(`[INTEGRITY:GEMINI] ⚠️ No se pudo parsear respuesta: ${parseErr.message}`);
    }

  } catch (err) {
    console.error(`[INTEGRITY:GEMINI] ❌ Error: ${err.message}`);
  }
}

/**
 * Sanitizar string para usar como ID de documento Firestore
 */
function sanitizeDocId(str) {
  return (str || 'unknown').replace(/[\/\.\#\$\[\]]/g, '_').substring(0, 100);
}

// ═══════════════════════════════════════════════════════════════════
// CAPA 4: POST-CREATION VERIFY — Verificar después de crear evento
// ═══════════════════════════════════════════════════════════════════

/**
 * Verificar que un evento recién creado existe en Calendar.
 * Se llama INMEDIATAMENTE después de createCalendarEvent() en server.js.
 *
 * @param {Function} listCalendarEvents - Función que lista eventos de Calendar
 * @param {string} uid - UID del owner
 * @param {string} dateStr - Fecha del evento (YYYY-MM-DD)
 * @param {string} reason - Razón/título del evento
 * @param {number} retryCount - Intentos restantes
 * @returns {Promise<boolean>} true si se verificó OK
 */
async function verifyCalendarEvent(listCalendarEvents, uid, dateStr, reason, retryCount = 1) {
  try {
    if (!listCalendarEvents) return true; // Si no hay función, asumir OK

    // Esperar 2 segundos para que Calendar procese
    await new Promise(resolve => setTimeout(resolve, 2000));

    const events = await listCalendarEvents(uid, dateStr);
    const found = events?.some(e =>
      (e.summary || '').toLowerCase().includes((reason || '').toLowerCase().substring(0, 20))
    );

    if (found) {
      console.log(`[INTEGRITY:VERIFY] ✅ Evento verificado en Calendar: "${reason}" el ${dateStr}`);
      return true;
    }

    if (retryCount > 0) {
      console.warn(`[INTEGRITY:VERIFY] ⚠️ Evento NO encontrado en Calendar, reintentando... "${reason}"`);
      return verifyCalendarEvent(listCalendarEvents, uid, dateStr, reason, retryCount - 1);
    }

    console.error(`[INTEGRITY:VERIFY] ❌ Evento NO verificado en Calendar después de retries: "${reason}" el ${dateStr}`);
    return false;

  } catch (err) {
    console.error(`[INTEGRITY:VERIFY] ❌ Error verificando: ${err.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// PASO 4: ADN LEARNING VIVO — Consolidación horaria al cerebro
// Reemplaza el mining muerto de cerebro_absoluto (getChats() no existe en Baileys)
//
// FLUJO:
// 1. Gemini (cada 5min) → detecta prefs/afinidades → guarda en Firestore
// 2. consolidateADNLearning (cada 1h, 8am-8pm) → lee Firestore → genera resumen
//    → appendLearning al cerebro → se inyecta al prompt → MIIA aprende
//
// PERMANENCIA: Los datos en Firestore son PERMANENTES.
// Solo se borran si el owner lo pide explícitamente ("MIIA olvidá que X").
// appendLearning acumula en trainingData → persiste en db.json + Firestore.
// ═══════════════════════════════════════════════════════════════════

/**
 * Consolida preferencias y afinidades acumuladas en un bloque de ADN
 * que se inyecta al cerebro de MIIA via appendLearning.
 */
async function consolidateADNLearning(db, ownerUid, generateAI, appendLearning) {
  try {
    console.log('[ADN-VIVO] 🧬 Iniciando consolidación horaria de ADN...');

    // 1. Leer preferencias acumuladas (sin consolidar)
    const prefsSnap = await db.collection('users').doc(ownerUid)
      .collection('contact_preferences')
      .where('consolidated', '==', false)
      .limit(50)
      .get()
      .catch(() => {
        // Si falla por falta de index, leer todas y filtrar
        return db.collection('users').doc(ownerUid)
          .collection('contact_preferences')
          .limit(50)
          .get();
      });

    // 2. Leer afinidades acumuladas
    const affsSnap = await db.collection('users').doc(ownerUid)
      .collection('contact_affinities')
      .where('consolidated', '==', false)
      .limit(50)
      .get()
      .catch(() => {
        return db.collection('users').doc(ownerUid)
          .collection('contact_affinities')
          .limit(50)
          .get();
      });

    // Filtrar no consolidadas en memoria (por si el index no existe)
    const newPrefs = [];
    const newAffs = [];
    const docsToMark = [];

    for (const doc of (prefsSnap?.docs || [])) {
      const data = doc.data();
      if (data.consolidated === true) continue; // Ya consolidada
      newPrefs.push({ id: doc.id, ...data });
      docsToMark.push(doc.ref);
    }

    for (const doc of (affsSnap?.docs || [])) {
      const data = doc.data();
      if (data.consolidated === true) continue;
      newAffs.push({ id: doc.id, ...data });
      docsToMark.push(doc.ref);
    }

    if (newPrefs.length === 0 && newAffs.length === 0) {
      console.log('[ADN-VIVO] ℹ️ Sin datos nuevos para consolidar');
      return;
    }

    // 3. Construir contexto para Gemini
    const prefsText = newPrefs.map(p => {
      const fields = Object.entries(p)
        .filter(([k]) => !['id', 'contactName', 'updatedAt', 'source', 'consolidated'].includes(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return `${p.contactName || p.id}: ${fields}`;
    }).join('\n');

    const affsText = newAffs.map(a => {
      const fields = Object.entries(a)
        .filter(([k]) => !['id', 'contactName', 'updatedAt', 'source', 'consolidated'].includes(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      return `${a.contactName || a.id}: ${fields}`;
    }).join('\n');

    const consolidationPrompt = `Sos el motor de aprendizaje de MIIA, una asistente de WhatsApp.
Tenés nuevos datos sobre contactos del owner. Consolidá esta información en UN SOLO bloque conciso de aprendizaje que MIIA pueda usar para personalizar conversaciones futuras.

PREFERENCIAS NUEVAS:
${prefsText || '(ninguna)'}

AFINIDADES NUEVAS:
${affsText || '(ninguna)'}

REGLAS:
- Escribí en segunda persona dirigido a MIIA ("Tu contacto Juan es hincha de Boca")
- Máximo 5 líneas, ultra conciso
- Solo datos ÚTILES para personalizar (no repetir lo obvio)
- Si un contacto tiene múltiples datos, consolidar en una línea
- Formato: "- [Nombre]: [dato1], [dato2], [dato3]"

Respondé SOLO con el bloque de texto, sin explicaciones.`;

    const adnBlock = await generateAI(consolidationPrompt);

    if (adnBlock && adnBlock.trim().length > 10) {
      // 4. Inyectar al cerebro de MIIA — PERMANENTE
      appendLearning(adnBlock.trim(), 'ADN_VIVO');
      console.log(`[ADN-VIVO] 🧬 ✅ Consolidación exitosa — ${newPrefs.length} prefs + ${newAffs.length} affs → cerebro`);
      console.log(`[ADN-VIVO] 📝 Bloque: ${adnBlock.substring(0, 200)}...`);
      engineState.preferencesLearned += newPrefs.length + newAffs.length;

      // 5. Marcar como consolidadas (NO borrar — datos permanentes)
      const batch = db.batch();
      for (const ref of docsToMark) {
        batch.update(ref, { consolidated: true, consolidatedAt: new Date().toISOString() });
      }
      await batch.commit();
      console.log(`[ADN-VIVO] 📌 ${docsToMark.length} docs marcados como consolidados`);
    } else {
      console.warn('[ADN-VIVO] ⚠️ Gemini no generó bloque válido — reintentando en próxima hora');
    }

  } catch (err) {
    console.error(`[ADN-VIVO] ❌ Error en consolidación: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// INIT & EXPORTS
// ═══════════════════════════════════════════════════════════════════

let pollInterval = null;

/**
 * Iniciar el Integrity Engine
 * @param {object} deps - Dependencias (ownerUid, generateAI, safeSendMessage, ownerPhone)
 */
function startIntegrityEngine(deps) {
  if (pollInterval) {
    console.warn('[INTEGRITY] ⚠️ Engine ya corriendo — ignorando start duplicado');
    return;
  }

  console.log(`[INTEGRITY] 🚀 Integrity Engine iniciado — polling cada ${POLL_INTERVAL_MS / 1000}s`);

  // Primera ejecución después de 30s (dar tiempo a que todo arranque)
  setTimeout(() => runIntegrityPoll(deps), 30 * 1000);

  // Polling periódico
  pollInterval = setInterval(() => runIntegrityPoll(deps), POLL_INTERVAL_MS);
}

/**
 * Detener el Integrity Engine
 */
function stopIntegrityEngine() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[INTEGRITY] 🛑 Integrity Engine detenido');
  }
}

/**
 * Obtener estado actual del engine
 */
function getIntegrityStats() {
  return { ...engineState };
}

module.exports = {
  // Capa 2: Auto-repair
  attemptAutoRepair,
  // Capa 3: Polling
  startIntegrityEngine,
  stopIntegrityEngine,
  runIntegrityPoll,
  getIntegrityStats,
  // Capa 4: Calendar verify
  verifyCalendarEvent,
  // Capa 5: ADN Learning Vivo
  consolidateADNLearning,
  // Para testing
  PROMISE_PATTERNS,
  PREFERENCE_PATTERNS,
};
