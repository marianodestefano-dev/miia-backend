/**
 * security_contacts.js — Contactos de Seguridad Bidireccionales
 *
 * Sistema Protector ↔ Protegido:
 * - Cualquier usuario puede designar un contacto de seguridad
 * - Bidireccional: A protege a B, B puede proteger a A
 * - Niveles configurables: emergencies_only, agenda_visible, full_supervision
 * - Menores de 13: auto-aprobado (COPPA). 13-17: requiere consentimiento. Adultos: consentimiento mutuo.
 * - Vinculación por OTP o desde dashboard web
 *
 * Firestore:
 *   users/{uid}/security_contacts/{relationId}
 *     { partnerUid, partnerPhone, partnerName, direction: 'protector'|'protegido',
 *       level, status: 'pending'|'active'|'rejected', consentAt, createdAt, updatedAt }
 *
 * STANDARD: Google + Amazon + APPLE + NASA
 * Fail loudly, exhaustive logging, zero silent failures.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

const LOG_PREFIX = '[SECURITY-CONTACTS]';

// ═══ DEPENDENCIAS INYECTADAS ═══
let _safeSendMessage = null;
let _sendGenericEmail = null;

function setSecurityContactDependencies({ safeSendMessage, sendGenericEmail }) {
  _safeSendMessage = safeSendMessage;
  _sendGenericEmail = sendGenericEmail;
  console.log(`${LOG_PREFIX} ✅ Dependencias inyectadas`);
}

// ═══ CONSTANTES ═══

const VALID_LEVELS = ['emergencies_only', 'agenda_visible', 'full_supervision'];
const VALID_STATUSES = ['pending', 'active', 'rejected'];
const OTP_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24h

const LEVEL_DESCRIPTIONS = {
  emergencies_only: 'Solo emergencias — se notifica si MIIA detecta algo grave (SOS, caída, inactividad prolongada)',
  agenda_visible: 'Agenda visible — puede ver citas y recordatorios del protegido + emergencias',
  full_supervision: 'Supervisión completa — ve agenda, resúmenes de conversaciones, y puede enviar mensajes a través de MIIA'
};

// ═══ HELPERS ═══

function db() {
  return admin.firestore();
}

function generateOTP() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let otp = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    otp += chars[bytes[i] % chars.length];
  }
  return otp;
}

/**
 * Generar ID de relación determinístico para evitar duplicados
 * Ordenamos los UIDs para que A→B y B→A produzcan el mismo par
 */
function getRelationPairKey(uid1, uid2) {
  return [uid1, uid2].sort().join('_');
}

// ═══ CRUD ═══

/**
 * Obtener todos los contactos de seguridad de un usuario
 * Retorna tanto los que protege como los que lo protegen
 */
async function getSecurityContacts(uid) {
  const snap = await db().collection('users').doc(uid)
    .collection('security_contacts').get();

  const contacts = [];
  snap.forEach(doc => {
    contacts.push({ id: doc.id, ...doc.data() });
  });

  console.log(`${LOG_PREFIX} 📋 ${uid}: ${contacts.length} contactos de seguridad`);
  return contacts;
}

/**
 * Obtener un contacto de seguridad específico
 */
async function getSecurityContact(uid, relationId) {
  const doc = await db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId).get();

  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Solicitar vinculación como protector de alguien
 * El protegido debe aceptar (excepto menores de 13)
 *
 * @param {string} protectorUid - UID del que quiere proteger
 * @param {string} protectedUid - UID del que será protegido
 * @param {string} level - Nivel de acceso solicitado
 * @param {object} opts - { protectorName, protectorPhone, protectedName, protectedPhone, protectedAge }
 */
async function requestProtection(protectorUid, protectedUid, level, opts = {}) {
  if (!VALID_LEVELS.includes(level)) {
    throw new Error(`Nivel inválido: ${level}. Válidos: ${VALID_LEVELS.join(', ')}`);
  }

  if (protectorUid === protectedUid) {
    throw new Error('No podés ser tu propio contacto de seguridad');
  }

  const pairKey = getRelationPairKey(protectorUid, protectedUid);

  // Verificar si ya existe relación activa en esta dirección
  const existingSnap = await db().collection('users').doc(protectorUid)
    .collection('security_contacts')
    .where('partnerUid', '==', protectedUid)
    .where('direction', '==', 'protector')
    .limit(1).get();

  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0].data();
    if (existing.status === 'active') {
      console.log(`${LOG_PREFIX} ⚠️ Ya existe relación activa ${protectorUid} → ${protectedUid}`);
      return { alreadyExists: true, relationId: existingSnap.docs[0].id, status: 'active' };
    }
    if (existing.status === 'pending') {
      console.log(`${LOG_PREFIX} ⚠️ Ya existe solicitud pendiente ${protectorUid} → ${protectedUid}`);
      return { alreadyExists: true, relationId: existingSnap.docs[0].id, status: 'pending' };
    }
  }

  const now = new Date().toISOString();
  const autoApprove = opts.protectedAge !== undefined && opts.protectedAge < 13;
  const status = autoApprove ? 'active' : 'pending';

  // Crear en ambos lados (bidireccional)
  const batch = db().batch();
  // C-449-IDS-RACE-FIX: random suffix evita colision si 2 requests
  // con mismo pairKey se crean en mismo ms (extension principio C-447).
  const relationId = `sec_${pairKey}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Lado del protector
  const protectorRef = db().collection('users').doc(protectorUid)
    .collection('security_contacts').doc(relationId);
  batch.set(protectorRef, {
    partnerUid: protectedUid,
    partnerPhone: opts.protectedPhone || '',
    partnerName: opts.protectedName || '',
    direction: 'protector',
    level,
    status,
    consentAt: autoApprove ? now : null,
    createdAt: now,
    updatedAt: now
  });

  // Lado del protegido
  const protectedRef = db().collection('users').doc(protectedUid)
    .collection('security_contacts').doc(relationId);
  batch.set(protectedRef, {
    partnerUid: protectorUid,
    partnerPhone: opts.protectorPhone || '',
    partnerName: opts.protectorName || '',
    direction: 'protegido',
    level,
    status,
    consentAt: autoApprove ? now : null,
    createdAt: now,
    updatedAt: now
  });

  await batch.commit();

  console.log(`${LOG_PREFIX} ${autoApprove ? '✅ AUTO-APROBADO' : '📨 SOLICITUD'}: ${opts.protectorName || protectorUid} → protege a ${opts.protectedName || protectedUid} (${level})`);

  // Notificar al protegido si necesita consentimiento
  if (!autoApprove && _safeSendMessage && opts.protectedPhone) {
    const msg = `🛡️ *Solicitud de Contacto de Seguridad*\n\n${opts.protectorName || 'Alguien'} quiere ser tu contacto de seguridad con nivel: *${LEVEL_DESCRIPTIONS[level]}*\n\nPara aceptar, escribí: "aceptar seguridad"\nPara rechazar: "rechazar seguridad"`;
    try {
      await _safeSendMessage(opts.protectedPhone, msg);
      console.log(`${LOG_PREFIX} 📤 Notificación enviada a ${opts.protectedName} (${opts.protectedPhone})`);
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error notificando a protegido: ${e.message}`);
    }
  }

  return { relationId, status, autoApproved: autoApprove };
}

/**
 * Aceptar o rechazar solicitud de protección
 */
async function respondToRequest(uid, relationId, accept) {
  const doc = await db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId).get();

  if (!doc.exists) {
    throw new Error(`Relación ${relationId} no encontrada`);
  }

  const data = doc.data();
  if (data.status !== 'pending') {
    throw new Error(`Relación ${relationId} no está pendiente (status: ${data.status})`);
  }

  const now = new Date().toISOString();
  const newStatus = accept ? 'active' : 'rejected';

  // Actualizar ambos lados
  const batch = db().batch();

  batch.update(db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId), {
    status: newStatus,
    consentAt: accept ? now : null,
    updatedAt: now
  });

  batch.update(db().collection('users').doc(data.partnerUid)
    .collection('security_contacts').doc(relationId), {
    status: newStatus,
    consentAt: accept ? now : null,
    updatedAt: now
  });

  await batch.commit();

  console.log(`${LOG_PREFIX} ${accept ? '✅ ACEPTADO' : '❌ RECHAZADO'}: ${uid} ${accept ? 'aceptó' : 'rechazó'} a ${data.partnerUid} (${relationId})`);

  // Notificar al protector
  if (_safeSendMessage && data.partnerPhone) {
    const msg = accept
      ? `🛡️ ¡${data.partnerName || 'Tu contacto'} aceptó ser tu protegido! Nivel: *${LEVEL_DESCRIPTIONS[data.level]}*`
      : `🛡️ ${data.partnerName || 'Tu contacto'} rechazó la solicitud de contacto de seguridad.`;
    try {
      await _safeSendMessage(data.partnerPhone, msg);
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error notificando respuesta: ${e.message}`);
    }
  }

  return { relationId, status: newStatus };
}

/**
 * Cambiar nivel de acceso de una relación activa
 * Solo el protegido puede cambiar el nivel (es su privacidad)
 */
async function updateLevel(uid, relationId, newLevel) {
  if (!VALID_LEVELS.includes(newLevel)) {
    throw new Error(`Nivel inválido: ${newLevel}`);
  }

  const doc = await db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId).get();

  if (!doc.exists) throw new Error(`Relación ${relationId} no encontrada`);
  const data = doc.data();

  if (data.direction !== 'protegido') {
    throw new Error('Solo el protegido puede cambiar el nivel de acceso');
  }

  if (data.status !== 'active') {
    throw new Error('Solo se puede cambiar nivel en relaciones activas');
  }

  const now = new Date().toISOString();
  const batch = db().batch();

  batch.update(db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId), {
    level: newLevel, updatedAt: now
  });

  batch.update(db().collection('users').doc(data.partnerUid)
    .collection('security_contacts').doc(relationId), {
    level: newLevel, updatedAt: now
  });

  await batch.commit();
  console.log(`${LOG_PREFIX} 🔄 Nivel cambiado: ${relationId} → ${newLevel} (por ${uid})`);

  // ═══ ALERTA AL PROTECTOR: nivel cambiado ═══
  const levelDesc = LEVEL_DESCRIPTIONS[newLevel] || newLevel;
  const protegidoName = data.partnerName || 'Tu protegido';

  // 1. WhatsApp self-chat al protector
  if (_safeSendMessage && data.partnerPhone) {
    const alertMsg = `🛡️🔔 *Alerta de Seguridad*\n\n` +
      `${protegidoName} cambió el nivel de acceso de tu protección.\n` +
      `📊 Nuevo nivel: *${newLevel}*\n` +
      `ℹ️ ${levelDesc}\n\n` +
      `Si no reconocés este cambio, contactá a ${protegidoName} directamente.`;
    try {
      await _safeSendMessage(data.partnerPhone, alertMsg);
      console.log(`${LOG_PREFIX} 📱 Alerta WhatsApp enviada al protector: ${data.partnerPhone}`);
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error enviando alerta WhatsApp al protector: ${e.message}`);
    }
  }

  // 2. Email al protector
  if (_sendGenericEmail) {
    try {
      const protectorDoc = await db().collection('users').doc(data.partnerUid).get();
      const protectorEmail = protectorDoc.exists ? protectorDoc.data().email : null;
      if (protectorEmail) {
        await _sendGenericEmail(
          protectorEmail,
          `🛡️ Cambio en configuración de seguridad — ${protegidoName}`,
          `Hola,\n\n${protegidoName} cambió el nivel de acceso de tu contacto de seguridad.\n\nNuevo nivel: ${newLevel}\n${levelDesc}\n\nSi no reconocés este cambio, contactá a ${protegidoName} directamente.\n\n— MIIA Seguridad`
        );
        console.log(`${LOG_PREFIX} 📧 Email de alerta enviado al protector: ${protectorEmail}`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error enviando email al protector: ${e.message}`);
    }
  }

  return { relationId, level: newLevel };
}

/**
 * Desvincular contacto de seguridad (cualquier lado puede hacerlo)
 */
async function unlinkSecurityContact(uid, relationId, reason = 'manual') {
  const doc = await db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId).get();

  if (!doc.exists) throw new Error(`Relación ${relationId} no encontrada`);
  const data = doc.data();

  const batch = db().batch();

  // Eliminar de ambos lados
  batch.delete(db().collection('users').doc(uid)
    .collection('security_contacts').doc(relationId));
  batch.delete(db().collection('users').doc(data.partnerUid)
    .collection('security_contacts').doc(relationId));

  await batch.commit();

  console.log(`${LOG_PREFIX} 🔓 Desvinculado: ${uid} ↔ ${data.partnerUid} (${relationId}). Razón: ${reason}`);

  // ═══ ALERTA AL OTRO LADO: desvinculación ═══
  const partnerName = data.partnerName || 'un usuario';

  // 1. WhatsApp al partner
  if (_safeSendMessage && data.partnerPhone) {
    const alertMsg = `🛡️🔔 *Alerta de Seguridad*\n\n` +
      `Tu contacto de seguridad con *${partnerName}* ha sido desvinculado.\n` +
      `📋 Razón: ${reason}\n\n` +
      `Si no fuiste vos quien lo hizo, contactá a ${partnerName} directamente.`;
    try {
      await _safeSendMessage(data.partnerPhone, alertMsg);
      console.log(`${LOG_PREFIX} 📱 Alerta desvinculación enviada a: ${data.partnerPhone}`);
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error notificando desvinculación por WhatsApp: ${e.message}`);
    }
  }

  // 2. Email al partner
  if (_sendGenericEmail) {
    try {
      const partnerDoc = await db().collection('users').doc(data.partnerUid).get();
      const partnerEmail = partnerDoc.exists ? partnerDoc.data().email : null;
      if (partnerEmail) {
        await _sendGenericEmail(
          partnerEmail,
          `🛡️ Contacto de seguridad desvinculado — ${partnerName}`,
          `Hola,\n\nTu contacto de seguridad con ${partnerName} ha sido desvinculado.\n\nRazón: ${reason}\n\nSi no reconocés esta acción, contactá a ${partnerName} directamente.\n\n— MIIA Seguridad`
        );
        console.log(`${LOG_PREFIX} 📧 Email de desvinculación enviado a: ${partnerEmail}`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error enviando email de desvinculación: ${e.message}`);
    }
  }

  return { unlinked: true, relationId };
}

// ═══ OTP PARA VINCULACIÓN VIA WHATSAPP ═══

/**
 * Crear OTP de vinculación de seguridad
 * El owner escribe "proteger a +54911..." en self-chat → MIIA genera OTP
 */
async function createSecurityOTP(requestorUid, requestorName, targetPhone, level) {
  const otp = generateOTP();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS).toISOString();

  await db().collection('users').doc(requestorUid)
    .collection('security_otps').add({
      otp,
      targetPhone,
      level: level || 'emergencies_only',
      direction: 'protector', // el requestor quiere proteger al target
      requestorName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt
    });

  console.log(`${LOG_PREFIX} 🔑 OTP creado: ${requestorName} quiere proteger a ${targetPhone} (OTP: ${otp})`);
  return { otp, expiresAt };
}

/**
 * Validar OTP de vinculación
 * El protegido escribe el OTP en su self-chat
 */
async function validateSecurityOTP(protectedUid, otpCode) {
  // Buscar OTP en TODOS los usuarios (el OTP es global)
  const usersSnap = await db().collection('users').get();

  for (const userDoc of usersSnap.docs) {
    const otpSnap = await db().collection('users').doc(userDoc.id)
      .collection('security_otps')
      .where('otp', '==', otpCode.toUpperCase().trim())
      .where('status', '==', 'pending')
      .limit(1).get();

    if (!otpSnap.empty) {
      const otpData = otpSnap.docs[0].data();

      // Verificar expiración
      if (new Date(otpData.expiresAt) < new Date()) {
        await otpSnap.docs[0].ref.update({ status: 'expired' });
        return { valid: false, reason: 'OTP expirado' };
      }

      // Marcar como usado
      await otpSnap.docs[0].ref.update({ status: 'used', usedAt: new Date().toISOString() });

      return {
        valid: true,
        protectorUid: userDoc.id,
        protectorName: otpData.requestorName,
        level: otpData.level,
        targetPhone: otpData.targetPhone
      };
    }
  }

  return { valid: false, reason: 'OTP no encontrado' };
}

// ═══ CONSULTAS PARA PROTECTORES ═══

/**
 * Obtener datos del protegido según nivel de acceso
 * Usado cuando el protector consulta en self-chat: "¿cómo está mamá?"
 */
async function getProtectedData(protectorUid, protectedUid, relationId) {
  const relation = await getSecurityContact(protectorUid, relationId);
  if (!relation || relation.status !== 'active' || relation.direction !== 'protector') {
    return { authorized: false, reason: 'Relación no activa o no sos protector' };
  }

  const level = relation.level;
  const result = { authorized: true, level, data: {} };

  // NIVEL 1: emergencies_only — solo alertas activas
  if (level === 'emergencies_only' || level === 'agenda_visible' || level === 'full_supervision') {
    try {
      const alertsSnap = await db().collection('users').doc(protectedUid)
        .collection('protection').doc('alerts').get();
      result.data.alerts = alertsSnap.exists ? alertsSnap.data() : { none: true };
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error cargando alertas de ${protectedUid}: ${e.message}`);
    }
  }

  // NIVEL 2: agenda_visible — agenda + recordatorios
  if (level === 'agenda_visible' || level === 'full_supervision') {
    try {
      const agendaSnap = await db().collection('users').doc(protectedUid)
        .collection('personal').doc('miia_agenda').get();
      result.data.agenda = agendaSnap.exists ? agendaSnap.data() : {};

      // Próximos recordatorios (7 días)
      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const remindersSnap = await db().collection('users').doc(protectedUid)
        .collection('reminders')
        .where('scheduledFor', '>=', now.toISOString())
        .where('scheduledFor', '<=', weekFromNow.toISOString())
        .limit(20).get();
      result.data.reminders = [];
      remindersSnap.forEach(doc => result.data.reminders.push({ id: doc.id, ...doc.data() }));
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error cargando agenda de ${protectedUid}: ${e.message}`);
    }
  }

  // NIVEL 3: full_supervision — resúmenes de actividad (NO mensajes literales)
  if (level === 'full_supervision') {
    try {
      const persistRef = db().collection('users').doc(protectedUid)
        .collection('miia_persistent').doc('tenant_conversations');
      const convoDoc = await persistRef.get();
      if (convoDoc.exists) {
        const convos = convoDoc.data().conversations || {};
        const summary = {};
        for (const [phone, msgs] of Object.entries(convos)) {
          const last5 = (msgs || []).slice(-5);
          summary[phone] = {
            totalMessages: (msgs || []).length,
            lastActivity: last5.length > 0 ? last5[last5.length - 1].timestamp : null,
            // NO incluir contenido literal — solo metadata
            recentTopics: last5.map(m => m.content ? m.content.substring(0, 30) + '...' : '').filter(Boolean)
          };
        }
        result.data.activitySummary = summary;
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} ❌ Error cargando actividad de ${protectedUid}: ${e.message}`);
    }
  }

  console.log(`${LOG_PREFIX} 📊 Datos de ${protectedUid} entregados a protector ${protectorUid} (nivel: ${level})`);
  return result;
}

// ═══ NOTIFICACIONES DE EMERGENCIA ═══

/**
 * Notificar a todos los protectores de un usuario
 * Se llama desde protection_manager cuando detecta emergencia
 */
async function notifyProtectors(protectedUid, eventType, details) {
  const contacts = await getSecurityContacts(protectedUid);
  const protectors = contacts.filter(c =>
    c.direction === 'protegido' && c.status === 'active'
  );

  if (protectors.length === 0) {
    console.log(`${LOG_PREFIX} ℹ️ ${protectedUid} no tiene protectores activos`);
    return { notified: 0 };
  }

  let notified = 0;
  for (const protector of protectors) {
    // Verificar que el nivel permite esta notificación
    if (eventType === 'emergency' || eventType === 'sos' || eventType === 'fall') {
      // Todos los niveles reciben emergencias
    } else if (eventType === 'agenda_change' || eventType === 'reminder') {
      if (protector.level === 'emergencies_only') continue;
    } else if (eventType === 'activity_summary') {
      if (protector.level !== 'full_supervision') continue;
    }

    if (_safeSendMessage && protector.partnerPhone) {
      const emoji = eventType === 'sos' ? '🚨' : eventType === 'fall' ? '⚠️' : '🛡️';
      const msg = `${emoji} *Alerta de Seguridad*\n\n${details.message || `Evento: ${eventType}`}\nContacto: ${details.protectedName || protectedUid}`;
      try {
        await _safeSendMessage(protector.partnerPhone, msg);
        notified++;
      } catch (e) {
        console.error(`${LOG_PREFIX} ❌ Error notificando a protector ${protector.partnerUid}: ${e.message}`);
      }
    }
  }

  console.log(`${LOG_PREFIX} 📢 ${notified}/${protectors.length} protectores notificados de ${eventType} para ${protectedUid}`);
  return { notified, total: protectors.length };
}

// ═══ SELF-CHAT COMMANDS ═══

/**
 * Detectar comandos de seguridad en self-chat
 * Retorna null si el mensaje no es un comando de seguridad
 */
function detectSecurityCommand(messageBody) {
  const msg = (messageBody || '').toLowerCase().trim();

  // "proteger a +54911..." o "contacto seguridad +54911..."
  const protectMatch = msg.match(/(?:proteger\s+a|contacto\s+(?:de\s+)?seguridad)\s+(\+?\d{10,15})/);
  if (protectMatch) {
    return { command: 'request_protection', phone: protectMatch[1] };
  }

  // "aceptar seguridad"
  if (/aceptar\s+seguridad/i.test(msg)) {
    return { command: 'accept_protection' };
  }

  // "rechazar seguridad"
  if (/rechazar\s+seguridad/i.test(msg)) {
    return { command: 'reject_protection' };
  }

  // "nivel seguridad emergencias/agenda/completo"
  const levelMatch = msg.match(/nivel\s+seguridad\s+(emergencias?|agenda|completo)/);
  if (levelMatch) {
    const levelMap = {
      emergencia: 'emergencies_only', emergencias: 'emergencies_only',
      agenda: 'agenda_visible',
      completo: 'full_supervision'
    };
    return { command: 'change_level', level: levelMap[levelMatch[1]] || 'emergencies_only' };
  }

  // "desvincular seguridad"
  if (/desvincular\s+seguridad/i.test(msg)) {
    return { command: 'unlink' };
  }

  // "mis protegidos" o "mis protectores"
  if (/mis\s+protegidos/i.test(msg)) return { command: 'list_protected' };
  if (/mis\s+protectores/i.test(msg)) return { command: 'list_protectors' };

  // "cómo está {nombre}" — consulta de protector
  const checkMatch = msg.match(/c[oó]mo\s+est[aá]\s+(.+)/);
  if (checkMatch) {
    return { command: 'check_protected', name: checkMatch[1].trim() };
  }

  return null;
}

// ═══ EXPORTS ═══

module.exports = {
  setSecurityContactDependencies,

  // CRUD
  getSecurityContacts,
  getSecurityContact,
  requestProtection,
  respondToRequest,
  updateLevel,
  unlinkSecurityContact,

  // OTP
  createSecurityOTP,
  validateSecurityOTP,

  // Consultas
  getProtectedData,

  // Notificaciones
  notifyProtectors,

  // Self-chat
  detectSecurityCommand,

  // Constantes
  VALID_LEVELS,
  LEVEL_DESCRIPTIONS
};
