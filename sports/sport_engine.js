/**
 * MIIA Sport Engine — Orquestador Principal
 * Maneja el ciclo de vida de eventos deportivos en vivo:
 * 1. Chequea calendarios de deportes (cada 30min)
 * 2. Hace polling de eventos activos (intervalos por deporte)
 * 3. Detecta cambios y genera mensajes emotivos
 * 4. Envía via WhatsApp a contactos interesados
 *
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const admin = require('firebase-admin');
const registry = require('./sport_registry');

// ═══ CONSTANTES ═══
const SCHEDULE_CHECK_INTERVAL_MS = 30 * 60 * 1000;   // 30 min entre checks de calendario
const EVENT_STALE_TIMEOUT_MS = 4 * 60 * 60 * 1000;   // 4h max — forzar desactivación
const MAX_MESSAGES_PER_EVENT_PER_CONTACT = 5;         // Rate limit: max msgs por evento
const MIN_INTERVAL_BETWEEN_MSGS_MS = 5 * 60 * 1000;  // 5 min entre msgs al mismo contacto
const STATE_SYNC_DEBOUNCE_MS = 60 * 1000;             // Sync a Firestore cada 60s máximo

// ═══ ESTADO EN MEMORIA ═══
const engineState = {
  /** @type {Object.<string, ActiveEvent>} */
  activeEvents: {},
  /** @type {number|null} */
  lastScheduleCheck: null,
  /** @type {boolean} */
  isRunning: false,
  /** @type {number|null} */
  lastStateSyncAt: null,
  /** @type {Object.<string, ContactSportPrefs>} */
  contactPrefs: {},
  /** @type {string|null} */
  ownerUid: null,
};

// B.9 (C-398.E): observabilidad — contador monotónico de ticks
let _sportsTickCount = 0;

/**
 * @typedef {object} ActiveEvent
 * @property {string} sport — Tipo de deporte
 * @property {string} matchId — ID del evento
 * @property {string} eventKey — Clave única
 * @property {string} name — Nombre del evento
 * @property {string[]} teams — Equipos/participantes
 * @property {object|null} lastState — Último estado conocido
 * @property {number} lastPollAt — Timestamp del último poll
 * @property {number} pollingSince — Timestamp de activación
 * @property {number} pollInterval — Intervalo de polling (ms)
 * @property {string[]} interestedContacts — Phones de contactos interesados
 * @property {Object.<string, ContactEventState>} contactStates — Estado por contacto
 * @property {object} metadata — Datos extra del evento
 */

/**
 * @typedef {object} ContactEventState
 * @property {number} messagesSent — Mensajes enviados para este evento
 * @property {number} lastMessageAt — Timestamp del último mensaje
 */

// ═══ DEPENDENCIAS INYECTADAS ═══
let _deps = {
  generateAIContent: null,  // (prompt, opts) => Promise<string>
  safeSendMessage: null,     // (target, content) => Promise<void>
  isWithinSchedule: null,    // (config) => boolean
  isSystemPaused: null,      // () => boolean
  getScheduleConfig: null,   // (uid) => Promise<object>
  buildSportsPrompt: null,   // (contactName, sportPref, event, change, emotion, profile) => string
  getOwnerProfile: null,     // (uid) => Promise<object>
};

/**
 * Inicializa el engine con dependencias inyectadas.
 * @param {string} ownerUid — UID del owner
 * @param {object} deps — Funciones del sistema principal
 */
async function initSportsEngine(ownerUid, deps = {}) {
  engineState.ownerUid = ownerUid;
  Object.assign(_deps, deps);

  // Cargar estado persistido desde Firestore
  try {
    const stateDoc = await admin.firestore()
      .collection('users').doc(ownerUid)
      .collection('miia_sports_state').doc('engine')
      .get();

    if (stateDoc.exists) {
      const saved = stateDoc.data();
      engineState.activeEvents = saved.activeEvents || {};
      engineState.lastScheduleCheck = saved.lastScheduleCheck || null;
      console.log(`[SPORT-ENGINE] Estado restaurado: ${Object.keys(engineState.activeEvents).length} eventos activos`);
    }
  } catch (err) {
    console.error(`[SPORT-ENGINE] Error restaurando estado: ${err.message}`);
  }

  // Cargar preferencias de contactos
  await refreshContactPrefs();

  console.log(`[SPORT-ENGINE] ✅ Inicializado para uid=${ownerUid}`);
  console.log(`[SPORT-ENGINE] Adapters disponibles: ${registry.types().join(', ')}`);
  console.log(`[SPORT-ENGINE] Contactos con preferencias: ${Object.keys(engineState.contactPrefs).length}`);
}

/**
 * Carga/refresca preferencias deportivas de todos los contactos.
 */
async function refreshContactPrefs() {
  if (!engineState.ownerUid) return;

  try {
    const snap = await admin.firestore()
      .collection('users').doc(engineState.ownerUid)
      .collection('miia_sports')
      .where('active', '==', true)
      .get();

    const prefs = {};
    snap.forEach(doc => {
      const data = doc.data();
      if (data.contactPhone && data.sports?.length > 0) {
        prefs[data.contactPhone] = {
          contactName: data.contactName || 'Contacto',
          sports: data.sports,
        };
      }
    });

    engineState.contactPrefs = prefs;
  } catch (err) {
    console.error(`[SPORT-ENGINE] Error cargando preferencias: ${err.message}`);
  }
}

/**
 * Ciclo principal del engine. Llamado por setInterval desde server.js.
 * NUNCA lanza excepción — todo error se logea y continúa.
 */
async function runSportsEngine() {
  if (engineState.isRunning) return; // Evitar overlap
  if (!engineState.ownerUid) return;

  // Gate: sistema pausado
  if (_deps.isSystemPaused && _deps.isSystemPaused()) return;

  // Gate: horario seguro
  if (_deps.getScheduleConfig && _deps.isWithinSchedule) {
    try {
      const scheduleConfig = await _deps.getScheduleConfig(engineState.ownerUid);
      if (!_deps.isWithinSchedule(scheduleConfig)) return;
    } catch (err) {
      // Si no se puede obtener schedule, continuar (fail open)
      console.warn(`[SPORT-ENGINE] No se pudo verificar schedule: ${err.message}`);
    }
  }

  engineState.isRunning = true;
  const now = Date.now();

  // B.9 (C-398.E): observabilidad — tick ID + tally por deporte + totales
  const tickStart = Date.now();
  _sportsTickCount++;
  const tickId = `ST${_sportsTickCount}`;
  const tally = {
    scheduleChecked: false,
    activeEvents: 0,
    pollSkippedInterval: 0,     // no-poll porque aún no venció pollInterval
    polled: 0,                   // polls ejecutados
    changesDetected: 0,          // cambios sumados entre todos los eventos
    messagesSent: 0,             // se incrementará desde notifyContacts via perTick
    stale: 0,
    errored: 0,
    finished: 0,                 // eventos terminados en este tick
    syncedState: false,
  };
  // perSport tally: { [sportType]: { active, polled, changes, errored } }
  const perSport = {};
  // Exposer state para que pollEvent/notifyContacts/sendFinalSummary lo actualicen
  engineState._currentTick = { tickId, tally, perSport, tickStart };

  console.log(`[SPORT-ENGINE][${tickId}] 🏁 tick start activeEvents=${Object.keys(engineState.activeEvents).length} contactsWithPrefs=${Object.keys(engineState.contactPrefs).length}`);

  try {
    // ═══ FASE 1: Check de calendarios (cada 30min) ═══
    if (!engineState.lastScheduleCheck ||
        now - engineState.lastScheduleCheck > SCHEDULE_CHECK_INTERVAL_MS) {
      await checkSchedules();
      engineState.lastScheduleCheck = now;
      tally.scheduleChecked = true;
    }

    // ═══ FASE 2: Poll de eventos activos ═══
    const eventKeys = Object.keys(engineState.activeEvents);
    tally.activeEvents = eventKeys.length;
    for (const eventKey of eventKeys) {
      const event = engineState.activeEvents[eventKey];
      if (!event) continue;

      // Contabilizar active por deporte
      if (!perSport[event.sport]) perSport[event.sport] = { active: 0, polled: 0, changes: 0, errored: 0 };
      perSport[event.sport].active++;

      // ¿Stale? (>4h activo)
      if (now - event.pollingSince > EVENT_STALE_TIMEOUT_MS) {
        console.log(`[SPORT-ENGINE][${tickId}] ⏲️ evento stale, removiendo: ${eventKey}`);
        delete engineState.activeEvents[eventKey];
        tally.stale++;
        continue;
      }

      // ¿Es hora de pollear?
      if (event.lastPollAt && now - event.lastPollAt < event.pollInterval) {
        tally.pollSkippedInterval++;
        continue;
      }

      await pollEvent(eventKey, event);
      tally.polled++;
      perSport[event.sport].polled++;
    }

    // ═══ FASE 3: Sync estado a Firestore (debounced) ═══
    if (!engineState.lastStateSyncAt ||
        now - engineState.lastStateSyncAt > STATE_SYNC_DEBOUNCE_MS) {
      await syncState();
      engineState.lastStateSyncAt = now;
      tally.syncedState = true;
    }
  } catch (err) {
    console.error(`[SPORT-ENGINE][${tickId}] ❌ error en ciclo principal: ${err.message}`);
    tally.errored++;
  } finally {
    engineState.isRunning = false;
    const durationMs = Date.now() - tickStart;
    // Log de cierre: solo detalle cuando hay actividad, one-liner cuando está idle
    if (tally.activeEvents === 0 && !tally.scheduleChecked) {
      console.log(`[SPORT-ENGINE][${tickId}] 💤 tick idle duration=${durationMs}ms`);
    } else {
      const perSportStr = Object.keys(perSport).length > 0
        ? Object.entries(perSport).map(([s, t]) => `${s}(a=${t.active},p=${t.polled},c=${t.changes},e=${t.errored})`).join(' ')
        : '—';
      console.log(`[SPORT-ENGINE][${tickId}] ✅ tick end duration=${durationMs}ms tally=${JSON.stringify(tally)} perSport=${perSportStr}`);
    }
    engineState._currentTick = null;
  }
}

/**
 * Fase 1: Chequea calendarios de todos los deportes con interesados.
 */
async function checkSchedules() {
  // Refrescar preferencias por si se agregaron nuevas
  await refreshContactPrefs();

  const prefs = engineState.contactPrefs;
  if (Object.keys(prefs).length === 0) return;

  // Recolectar tipos de deporte con al menos un interesado
  const sportTypesNeeded = new Set();
  for (const contactData of Object.values(prefs)) {
    for (const sport of contactData.sports) {
      sportTypesNeeded.add(sport.type);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  for (const sportType of sportTypesNeeded) {
    const adapter = registry.get(sportType);
    if (!adapter) {
      console.warn(`[SPORT-ENGINE] Adapter no encontrado: ${sportType}`);
      continue;
    }

    try {
      const events = await adapter.getSchedule(today);
      if (!events || events.length === 0) continue;

      for (const event of events) {
        // ¿Hay contactos interesados en este evento?
        const interested = [];
        for (const [phone, contactData] of Object.entries(prefs)) {
          for (const sportPref of contactData.sports) {
            if (adapter.matchesPreference(event, sportPref)) {
              interested.push(phone);
              break;
            }
          }
        }

        if (interested.length === 0) continue;

        // Solo activar si el evento está live o empieza dentro de 30min
        const startsIn = new Date(event.startTime).getTime() - Date.now();
        const isLiveOrSoon = event.status === 'live' || startsIn < SCHEDULE_CHECK_INTERVAL_MS;

        if (!isLiveOrSoon) continue;

        const eventKey = adapter._eventKey(event);

        // Si ya existe, actualizar contactos interesados
        if (engineState.activeEvents[eventKey]) {
          engineState.activeEvents[eventKey].interestedContacts = interested;
          continue;
        }

        // Activar nuevo evento
        engineState.activeEvents[eventKey] = {
          sport: sportType,
          matchId: event.matchId,
          eventKey,
          name: event.name,
          teams: event.teams || [],
          lastState: null,
          lastPollAt: 0,
          pollingSince: Date.now(),
          pollInterval: adapter.pollIntervalMs,
          interestedContacts: interested,
          contactStates: {},
          metadata: event.metadata || {},
        };

        console.log(`[SPORT-ENGINE] 🟢 Evento activado: ${event.name} (${sportType}) — ${interested.length} contacto(s)`);
      }
    } catch (err) {
      console.error(`[SPORT-ENGINE] Error en schedule check de ${sportType}: ${err.message}`);
    }
  }
}

/**
 * Fase 2: Pollea un evento activo y procesa cambios.
 */
async function pollEvent(eventKey, event) {
  const adapter = registry.get(event.sport);
  if (!adapter) return;

  const tick = engineState._currentTick;
  const tickId = tick?.tickId || '-';

  try {
    const newState = await adapter.getLiveState(event.matchId, event.metadata);
    if (!newState) {
      event.lastPollAt = Date.now();
      return;
    }

    // Detectar cambios
    const changes = adapter.detectChanges(event.lastState, newState);

    if (changes && changes.length > 0) {
      if (tick) {
        tick.tally.changesDetected += changes.length;
        if (tick.perSport[event.sport]) tick.perSport[event.sport].changes += changes.length;
      }
      console.log(`[SPORT-ENGINE][${tickId}] 🔔 ${event.sport} ${event.name} → ${changes.length} cambio(s)`);
      for (const change of changes) {
        await notifyContacts(event, change, adapter, newState);
      }
    }

    // Actualizar estado
    const wasFinished = adapter.isFinished(newState);
    event.lastState = newState;
    event.lastPollAt = Date.now();

    // Si terminó, enviar resumen final y limpiar
    if (wasFinished) {
      console.log(`[SPORT-ENGINE][${tickId}] 🏁 evento terminado: ${event.name}`);
      if (tick) tick.tally.finished++;
      await sendFinalSummary(event, adapter, newState);
      delete engineState.activeEvents[eventKey];
    }
  } catch (err) {
    console.error(`[SPORT-ENGINE][${tickId}] ❌ error polleando ${eventKey}: ${err.message}`);
    event.lastPollAt = Date.now(); // No reintentar inmediatamente
    if (tick) {
      tick.tally.errored++;
      if (tick.perSport[event.sport]) tick.perSport[event.sport].errored++;
    }
  }
}

/**
 * Notifica a todos los contactos interesados sobre un cambio.
 */
async function notifyContacts(event, change, adapter, currentState) {
  if (!_deps.safeSendMessage || !_deps.generateAIContent) return;

  const now = Date.now();
  const emotionLevel = adapter.getEmotionLevel(change);

  for (const phone of event.interestedContacts) {
    // Rate limiting por contacto por evento
    if (!event.contactStates[phone]) {
      event.contactStates[phone] = { messagesSent: 0, lastMessageAt: 0 };
    }
    const cs = event.contactStates[phone];

    if (cs.messagesSent >= MAX_MESSAGES_PER_EVENT_PER_CONTACT) continue;
    if (now - cs.lastMessageAt < MIN_INTERVAL_BETWEEN_MSGS_MS) continue;

    // Solo enviar cambios relevantes (skip 'low' si ya se mandaron muchos)
    if (emotionLevel === 'low' && cs.messagesSent >= 2) continue;

    try {
      // Obtener datos del contacto
      const contactData = engineState.contactPrefs[phone];
      if (!contactData) continue;

      // Encontrar la preferencia deportiva que matchea
      const sportPref = contactData.sports.find(sp => sp.type === event.sport);
      if (!sportPref) continue;

      // Determinar sentimiento para este contacto
      const sentiment = adapter.getSentiment(change, sportPref.team || sportPref.driver);

      // Obtener perfil del owner
      let ownerProfile = null;
      if (_deps.getOwnerProfile) {
        ownerProfile = await _deps.getOwnerProfile(engineState.ownerUid);
      }

      // Construir prompt
      const prompt = _deps.buildSportsPrompt
        ? _deps.buildSportsPrompt(contactData.contactName, sportPref, event, change, emotionLevel, ownerProfile, sentiment)
        : _buildDefaultPrompt(contactData.contactName, sportPref, change, emotionLevel, sentiment);

      // Generar mensaje via IA
      const message = await _deps.generateAIContent(prompt, {});
      if (!message || message.length < 3) continue;

      // Enviar via WhatsApp
      const target = phone === 'self'
        ? `${engineState.ownerUid}@s.whatsapp.net`
        : phone;

      await _deps.safeSendMessage(target, message);

      cs.messagesSent++;
      cs.lastMessageAt = now;

      const tick = engineState._currentTick;
      if (tick) tick.tally.messagesSent++;
      const tickId = tick?.tickId || '-';
      console.log(`[SPORT-ENGINE][${tickId}] 📩 enviado a ${contactData.contactName}: ${change.type} (${emotionLevel})`);

      // Pausa entre mensajes (human-like)
      await _sleep(2000 + Math.random() * 2000);
    } catch (err) {
      console.error(`[SPORT-ENGINE] Error notificando ${phone}: ${err.message}`);
    }
  }
}

/**
 * Envía un resumen final cuando termina un evento.
 */
async function sendFinalSummary(event, adapter, finalState) {
  if (!_deps.safeSendMessage || !_deps.generateAIContent) return;

  const formatted = adapter.formatEvent(event, finalState);

  for (const phone of event.interestedContacts) {
    const contactData = engineState.contactPrefs[phone];
    if (!contactData) continue;

    const sportPref = contactData.sports.find(sp => sp.type === event.sport);
    if (!sportPref) continue;

    const cs = event.contactStates[phone] || { messagesSent: 0 };
    // Si no se le mandó ningún mensaje durante el evento, mandar al menos el resumen
    // Si ya se le mandaron muchos, no mandar resumen extra
    if (cs.messagesSent >= MAX_MESSAGES_PER_EVENT_PER_CONTACT) continue;

    try {
      const prompt = `Sos MIIA, asistente personal. Generá un breve resumen final (2-3 líneas max) del resultado de este evento deportivo para ${contactData.contactName}, que es fan de ${sportPref.team || sportPref.driver}.

Evento: ${formatted}
Estado final: ${JSON.stringify(finalState)}

Tono: emotivo pero conciso. Emojis moderados. Si ganó su equipo, celebrá. Si perdió, consolá con cariño. Lenguaje argentino informal.`;

      const message = await _deps.generateAIContent(prompt, {});
      if (!message) continue;

      const target = phone === 'self'
        ? `${engineState.ownerUid}@s.whatsapp.net`
        : phone;

      await _deps.safeSendMessage(target, message);
      await _sleep(2000);
    } catch (err) {
      console.error(`[SPORT-ENGINE] Error en resumen final para ${phone}: ${err.message}`);
    }
  }
}

/**
 * Sincroniza estado a Firestore para persistencia.
 */
async function syncState() {
  if (!engineState.ownerUid) return;

  try {
    // Serializar solo lo necesario (no funciones ni refs circulares)
    const toSave = {
      activeEvents: {},
      lastScheduleCheck: engineState.lastScheduleCheck,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    for (const [key, event] of Object.entries(engineState.activeEvents)) {
      toSave.activeEvents[key] = {
        sport: event.sport,
        matchId: event.matchId,
        name: event.name,
        teams: event.teams,
        lastPollAt: event.lastPollAt,
        pollingSince: event.pollingSince,
        pollInterval: event.pollInterval,
        interestedContacts: event.interestedContacts,
        contactStates: event.contactStates,
      };
    }

    await admin.firestore()
      .collection('users').doc(engineState.ownerUid)
      .collection('miia_sports_state').doc('engine')
      .set(toSave, { merge: true });
  } catch (err) {
    console.error(`[SPORT-ENGINE] Error sincronizando estado: ${err.message}`);
  }
}

/**
 * Prompt por defecto si buildSportsPrompt no fue inyectado.
 */
function _buildDefaultPrompt(contactName, sportPref, change, emotionLevel, sentiment) {
  const team = sportPref.team || sportPref.driver || 'su equipo';
  const rivalry = sportPref.rivalry ? `. Su rival es ${sportPref.rivalry}` : '';

  return `Sos MIIA, asistente personal. Generá UN mensaje de WhatsApp para ${contactName} reaccionando a esta novedad deportiva.

${contactName} es fan de ${team}${rivalry}.
Novedad: ${change.description}
Emoción: ${emotionLevel} (low=info casual, medium=entusiasmo, high=gritar, explosive=LOCURA TOTAL)
Sentimiento para este contacto: ${sentiment}

Máximo 2 líneas. Emojis sí pero sin exceso. Lenguaje argentino informal. NO digas que sos IA.`;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══ API PÚBLICA ═══

/**
 * Registra una preferencia deportiva para un contacto (desde self-chat).
 * @param {string} contactPhone — Phone o "self"
 * @param {string} contactName
 * @param {object} sportPref — { type, team, driver, rivalry, league }
 */
async function addSportPreference(contactPhone, contactName, sportPref) {
  if (!engineState.ownerUid) throw new Error('Engine no inicializado');

  const db = admin.firestore();
  const collRef = db.collection('users').doc(engineState.ownerUid).collection('miia_sports');

  // Buscar doc existente para este contacto
  const existing = await collRef.where('contactPhone', '==', contactPhone).limit(1).get();

  if (!existing.empty) {
    const doc = existing.docs[0];
    const data = doc.data();
    // No duplicar preferencia
    const alreadyExists = data.sports?.some(s =>
      s.type === sportPref.type &&
      (s.team || '') === (sportPref.team || '') &&
      (s.driver || '') === (sportPref.driver || '')
    );
    if (!alreadyExists) {
      await doc.ref.update({
        sports: admin.firestore.FieldValue.arrayUnion(sportPref),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } else {
    await collRef.add({
      contactPhone,
      contactName,
      sports: [sportPref],
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Refrescar cache
  await refreshContactPrefs();
  console.log(`[SPORT-ENGINE] ✅ Preferencia agregada: ${contactName} → ${sportPref.team || sportPref.driver} (${sportPref.type})`);
}

/**
 * Elimina una preferencia deportiva para un contacto.
 */
async function removeSportPreference(contactPhone, sportType) {
  if (!engineState.ownerUid) throw new Error('Engine no inicializado');

  const db = admin.firestore();
  const snap = await db.collection('users').doc(engineState.ownerUid)
    .collection('miia_sports')
    .where('contactPhone', '==', contactPhone)
    .limit(1).get();

  if (snap.empty) return;

  const doc = snap.docs[0];
  const data = doc.data();
  const filtered = (data.sports || []).filter(s => s.type !== sportType);

  if (filtered.length === 0) {
    await doc.ref.delete();
  } else {
    await doc.ref.update({
      sports: filtered,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  await refreshContactPrefs();
  console.log(`[SPORT-ENGINE] 🗑️ Preferencia eliminada: ${contactPhone} → ${sportType}`);
}

/**
 * Retorna estadísticas del engine para debugging.
 */
function getStats() {
  return {
    ownerUid: engineState.ownerUid,
    activeEvents: Object.keys(engineState.activeEvents).length,
    contactsWithPrefs: Object.keys(engineState.contactPrefs).length,
    adaptersLoaded: registry.types().length,
    lastScheduleCheck: engineState.lastScheduleCheck,
    events: Object.entries(engineState.activeEvents).map(([key, ev]) => ({
      key,
      sport: ev.sport,
      name: ev.name,
      contacts: ev.interestedContacts.length,
      pollingSince: ev.pollingSince,
    })),
  };
}

module.exports = {
  initSportsEngine,
  runSportsEngine,
  addSportPreference,
  removeSportPreference,
  refreshContactPrefs,
  getStats,
};
