/**
 * protection_manager.js — Modo Protección KIDS + ABUELOS
 *
 * Dos modos independientes:
 * - KIDS: Cuentos, juegos, filtros, control de sesión, detección automática
 * - ABUELOS: Acompañamiento, recordatorios médicos, ubicación, tono paciente
 *
 * Sistema OTP para vincular adulto responsable.
 * Emails informativos a padres/responsables en cada evento OTP.
 * Desvinculación automática por edad legal según país.
 *
 * STANDARD: Google + Amazon + APPLE + NASA
 * Fail loudly, exhaustive logging, zero silent failures.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');

// ═══ DEPENDENCIAS INYECTADAS ═══
let _sendGenericEmail = null;
let _safeSendMessage = null;
let _generateAIContent = null;

function setProtectionDependencies({ sendGenericEmail, safeSendMessage, generateAIContent }) {
  _sendGenericEmail = sendGenericEmail;
  _safeSendMessage = safeSendMessage;
  _generateAIContent = generateAIContent;
  console.log('[PROTECTION] ✅ Dependencias inyectadas');
}

// ═══ EDAD LEGAL POR PAÍS (código telefónico → edad de mayoría de edad) ═══
// Edad a la que el menor puede solicitar desvinculación del adulto responsable
const LEGAL_AGE_BY_COUNTRY = {
  '54': { country: 'Argentina', age: 18, dataAutonomyAge: 13 },
  '57': { country: 'Colombia', age: 18, dataAutonomyAge: 14 },
  '52': { country: 'México', age: 18, dataAutonomyAge: 16 },
  '34': { country: 'España', age: 18, dataAutonomyAge: 14 },   // RGPD
  '55': { country: 'Brasil', age: 18, dataAutonomyAge: 14 },    // LGPD
  '56': { country: 'Chile', age: 18, dataAutonomyAge: 14 },
  '51': { country: 'Perú', age: 18, dataAutonomyAge: 14 },
  '58': { country: 'Venezuela', age: 18, dataAutonomyAge: 14 },
  '593': { country: 'Ecuador', age: 18, dataAutonomyAge: 14 },
  '598': { country: 'Uruguay', age: 18, dataAutonomyAge: 13 },
  '595': { country: 'Paraguay', age: 18, dataAutonomyAge: 14 },
  '591': { country: 'Bolivia', age: 18, dataAutonomyAge: 14 },
  '1': { country: 'USA/Canadá', age: 18, dataAutonomyAge: 13 }, // COPPA
  '44': { country: 'Reino Unido', age: 18, dataAutonomyAge: 13 },
  '33': { country: 'Francia', age: 18, dataAutonomyAge: 15 },
  '49': { country: 'Alemania', age: 18, dataAutonomyAge: 16 },
  '39': { country: 'Italia', age: 18, dataAutonomyAge: 14 },
  '81': { country: 'Japón', age: 18, dataAutonomyAge: 15 },
};

// Default para países no listados
const DEFAULT_LEGAL = { country: 'Desconocido', age: 18, dataAutonomyAge: 14 };

/**
 * Detectar país y edad legal desde número de teléfono
 */
function getLegalInfoFromPhone(phone) {
  const clean = (phone || '').replace(/\D/g, '');
  // Probar código de 3 dígitos, luego 2, luego 1
  for (const len of [3, 2, 1]) {
    const code = clean.substring(0, len);
    if (LEGAL_AGE_BY_COUNTRY[code]) {
      return LEGAL_AGE_BY_COUNTRY[code];
    }
  }
  return DEFAULT_LEGAL;
}

/**
 * Calcular edad a partir de fecha de nacimiento
 */
function calculateAge(birthDateStr) {
  const birth = new Date(birthDateStr);
  if (isNaN(birth)) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// ═══ DETECCIÓN AUTOMÁTICA SILENCIOSA ═══

/**
 * Patrones de detección KIDS (sin preguntar al usuario)
 */
const KIDS_PATTERNS = {
  vocabulary: /\b(mami|papi|mamá|papá|mami|abu|abue|profe|seño|tarea|cole|escuela|jardín|dibuj[oa]r|juguete|muñec[oa]|dinosaurio|unicornio|dragón|princesa|superhéroe)\b/i,
  questions: /\b(por\s*qu[eé]|qu[eé]\s+es\s+un|c[oó]mo\s+se\s+llama|cu[aá]ntos\s+a[ñn]os)\b/i,
  emojiExcess: /(?:[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}].*){5,}/u,
  simpleSentences: /^[^.!?]{3,25}[.!?]?$/,
  childTopics: /\b(cuento|historia|juego|adivinanza|chiste|animales|planetas|estrellas|colores|n[uú]meros)\b/i,
};

/**
 * Patrones de detección ABUELOS (sin preguntar al usuario)
 */
const ELDERLY_PATTERNS = {
  healthTopics: /\b(m[eé]dico|doctor|doctora|pastilla|remedio|medicamento|turno|presi[oó]n|az[uú]car|diabetes|colesterol|dolor|hospital|cl[ií]nica|receta)\b/i,
  familyReferences: /\b(mi\s+hijo|mi\s+hija|mi\s+nieto|mi\s+nieta|los\s+chicos|los\s+nenes|mi\s+yerno|mi\s+nuera)\b/i,
  techConfusion: /\b(c[oó]mo\s+hago|no\s+entiendo|no\s+s[eé]\s+c[oó]mo|qu[eé]\s+toco|d[oó]nde\s+aprieto|se\s+me\s+borr[oó]|no\s+me\s+anda)\b/i,
  formalGreeting: /\b(buen\s*d[ií]a|buenas\s*tardes|buenas\s*noches|muy\s+amable|le\s+agradezco|por\s+favor\s+querida)\b/i,
  repetition: null, // Se evalúa comparando mensajes anteriores
};

/**
 * Evaluar si un mensaje tiene patrones KIDS
 * @returns {number} Score 0-100
 */
function scoreKidsPatterns(message, messageHistory = []) {
  if (!message || typeof message !== 'string') return 0;
  let score = 0;

  if (KIDS_PATTERNS.vocabulary.test(message)) score += 25;
  if (KIDS_PATTERNS.questions.test(message)) score += 15;
  if (KIDS_PATTERNS.emojiExcess.test(message)) score += 15;
  if (KIDS_PATTERNS.childTopics.test(message)) score += 25;
  if (message.length < 30) score += 10; // Mensajes muy cortos
  if (/^[A-ZÁÉÍÓÚÑ\s!?]+$/.test(message) && message.length < 20) score += 10; // TODO MAYUSCULAS corto

  // Errores ortográficos frecuentes en niños
  const childTypos = /\b(kiero|xq|xque|porfis|plis|siii+|nooo+|jajaj+|xd+)\b/i;
  if (childTypos.test(message)) score += 15;

  return Math.min(score, 100);
}

/**
 * Evaluar si un mensaje tiene patrones ABUELOS
 * @returns {number} Score 0-100
 */
function scoreElderlyPatterns(message, messageHistory = []) {
  if (!message || typeof message !== 'string') return 0;
  let score = 0;

  if (ELDERLY_PATTERNS.healthTopics.test(message)) score += 25;
  if (ELDERLY_PATTERNS.familyReferences.test(message)) score += 20;
  if (ELDERLY_PATTERNS.techConfusion.test(message)) score += 25;
  if (ELDERLY_PATTERNS.formalGreeting.test(message)) score += 15;

  // Mensajes largos sin puntuación (stream of consciousness)
  if (message.length > 100 && !/[.,;:!?]/.test(message)) score += 15;

  // Repetición de mensajes anteriores (señal de confusión)
  if (messageHistory.length >= 3) {
    const lastMsgs = messageHistory.slice(-3).map(m => (m.content || '').toLowerCase().trim());
    if (lastMsgs.filter(m => m === message.toLowerCase().trim()).length >= 1) {
      score += 20;
    }
  }

  // Horario muy temprano (5-6 AM) — se evalúa externamente
  return Math.min(score, 100);
}

/**
 * Detectar modo automáticamente — NO pregunta, actúa en silencio
 * @returns {'kids' | 'elderly' | null}
 */
function detectProtectionMode(message, messageHistory = [], existingMode = null) {
  // Si ya tiene modo configurado manualmente, no cambiar
  if (existingMode === 'kids_manual' || existingMode === 'elderly_manual') return null;

  const kidsScore = scoreKidsPatterns(message, messageHistory);
  const elderlyScore = scoreElderlyPatterns(message, messageHistory);

  // Umbral alto para evitar falsos positivos — necesita consistencia
  const THRESHOLD = 60;

  if (kidsScore >= THRESHOLD && kidsScore > elderlyScore) return 'kids';
  if (elderlyScore >= THRESHOLD && elderlyScore > kidsScore) return 'elderly';
  return null;
}

// ═══ GESTIÓN OTP ═══

/**
 * Generar OTP de 6 dígitos para vinculación de adulto responsable
 */
function generateProtectionOTP() {
  // Excluir caracteres confusos: 0/O, 1/I/L
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let otp = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    otp += chars[bytes[i] % chars.length];
  }
  return otp;
}

/**
 * Crear OTP de vinculación en Firestore
 * Se genera en el selfchat del NIÑO/ABUELO y se copia al selfchat del ADULTO
 */
async function createLinkOTP(protectedUid, protectedPhone, protectedName) {
  const otp = generateProtectionOTP();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas

  await admin.firestore().collection('users').doc(protectedUid)
    .collection('protection_otps').add({
      otp,
      type: 'link_adult',
      protectedPhone,
      protectedName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    });

  console.log(`[PROTECTION] 🔑 OTP de vinculación creado para ${protectedName} (${protectedUid}): ${otp}`);
  return otp;
}

/**
 * Crear OTP de desvinculación (cuando el menor alcanza edad legal)
 */
async function createUnlinkOTP(adultUid, adultPhone, protectedName) {
  const otp = generateProtectionOTP();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 horas (más tiempo por ser importante)

  await admin.firestore().collection('users').doc(adultUid)
    .collection('protection_otps').add({
      otp,
      type: 'unlink_minor',
      protectedName,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString()
    });

  console.log(`[PROTECTION] 🔑 OTP de desvinculación creado para adulto ${adultUid}`);
  return otp;
}

/**
 * Validar OTP de vinculación
 */
async function validateLinkOTP(protectedUid, otpCode) {
  const otpSnap = await admin.firestore().collection('users').doc(protectedUid)
    .collection('protection_otps')
    .where('otp', '==', otpCode.toUpperCase())
    .where('status', '==', 'pending')
    .where('type', '==', 'link_adult')
    .limit(1)
    .get();

  if (otpSnap.empty) return { valid: false, reason: 'not_found' };

  const doc = otpSnap.docs[0];
  const data = doc.data();

  if (new Date(data.expiresAt) < new Date()) {
    await doc.ref.update({ status: 'expired' });
    return { valid: false, reason: 'expired' };
  }

  await doc.ref.update({ status: 'used', usedAt: new Date().toISOString() });
  return { valid: true, protectedPhone: data.protectedPhone, protectedName: data.protectedName };
}

/**
 * Validar OTP de desvinculación
 */
async function validateUnlinkOTP(adultUid, otpCode) {
  const otpSnap = await admin.firestore().collection('users').doc(adultUid)
    .collection('protection_otps')
    .where('otp', '==', otpCode.toUpperCase())
    .where('status', '==', 'pending')
    .where('type', '==', 'unlink_minor')
    .limit(1)
    .get();

  if (otpSnap.empty) return { valid: false, reason: 'not_found' };

  const doc = otpSnap.docs[0];
  const data = doc.data();

  if (new Date(data.expiresAt) < new Date()) {
    await doc.ref.update({ status: 'expired' });
    return { valid: false, reason: 'expired' };
  }

  await doc.ref.update({ status: 'used', usedAt: new Date().toISOString() });
  return { valid: true, protectedName: data.protectedName };
}

// ═══ VINCULACIÓN DE ADULTO RESPONSABLE ═══

/**
 * Vincular adulto responsable al niño/abuelo
 */
async function linkResponsibleAdult(protectedUid, adultUid, adultPhone, adultName, adultEmail, role = 'parent') {
  const protectionRef = admin.firestore().collection('users').doc(protectedUid).collection('protection');

  // Obtener datos existentes o crear
  const configDoc = await protectionRef.doc('config').get();
  const existing = configDoc.exists ? configDoc.data() : {};
  const adults = existing.responsibleAdults || [];

  // Verificar que no esté ya vinculado
  if (adults.some(a => a.uid === adultUid)) {
    console.log(`[PROTECTION] ⚠️ Adulto ${adultName} ya está vinculado a ${protectedUid}`);
    return { success: false, reason: 'already_linked' };
  }

  adults.push({
    uid: adultUid,
    phone: adultPhone,
    name: adultName,
    email: adultEmail || '',
    role, // 'parent' | 'guardian' | 'caretaker'
    linkedAt: new Date().toISOString(),
    otpValidated: true
  });

  await protectionRef.doc('config').set({
    ...existing,
    responsibleAdults: adults,
    updatedAt: new Date().toISOString()
  }, { merge: true });

  // Log de acceso inmutable
  await logProtectionEvent(protectedUid, 'adult_linked', {
    adultUid, adultName, adultPhone, role
  });

  console.log(`[PROTECTION] ✅ Adulto ${adultName} vinculado a ${protectedUid} como ${role}`);
  return { success: true };
}

/**
 * Desvincular adulto responsable
 */
async function unlinkResponsibleAdult(protectedUid, adultUid, reason = 'age_reached') {
  const configRef = admin.firestore().collection('users').doc(protectedUid).collection('protection').doc('config');
  const configDoc = await configRef.get();
  if (!configDoc.exists) return { success: false, reason: 'no_config' };

  const data = configDoc.data();
  const adults = (data.responsibleAdults || []).filter(a => a.uid !== adultUid);

  await configRef.update({
    responsibleAdults: adults,
    updatedAt: new Date().toISOString()
  });

  await logProtectionEvent(protectedUid, 'adult_unlinked', { adultUid, reason });

  console.log(`[PROTECTION] 🔓 Adulto ${adultUid} desvinculado de ${protectedUid}. Razón: ${reason}`);
  return { success: true };
}

// ═══ CONFIGURACIÓN DE MODO ═══

/**
 * Activar modo protección (automático o manual)
 */
async function activateProtectionMode(uid, mode, options = {}) {
  const { detectedAutomatically = false, birthDate, name, phone } = options;
  const legalInfo = getLegalInfoFromPhone(phone);

  const configRef = admin.firestore().collection('users').doc(uid).collection('protection').doc('config');

  await configRef.set({
    mode, // 'kids' | 'elderly'
    modeSource: detectedAutomatically ? 'auto_detected' : 'manual',
    birthDate: birthDate || null,
    protectedName: name || '',
    protectedPhone: phone || '',
    country: legalInfo.country,
    legalAge: legalInfo.age,
    dataAutonomyAge: legalInfo.dataAutonomyAge,
    active: true,
    activatedAt: new Date().toISOString(),
    responsibleAdults: [],
    emergencyAccess: {
      level1_enabled: true,
      level2_requires: 'otp_adult',
      level3_requires: 'admin_judicial_code'
    },
    // KIDS specific
    ...(mode === 'kids' && {
      sessionMaxMinutes: 30,
      sessionCooldownMinutes: 10,
      contentFilters: true,
      ageGroup: birthDate ? _getAgeGroup(calculateAge(birthDate)) : '5-7'
    }),
    // ABUELOS specific
    ...(mode === 'elderly' && {
      medicationReminders: true,
      locationSharing: true,
      patienceTone: true,
      largeTextPreference: true
    })
  }, { merge: true });

  await logProtectionEvent(uid, 'mode_activated', { mode, detectedAutomatically });
  console.log(`[PROTECTION] 🛡️ Modo ${mode} activado para ${uid} (${detectedAutomatically ? 'auto' : 'manual'})`);
  return { success: true };
}

function _getAgeGroup(age) {
  if (age === null) return '5-7';
  if (age <= 4) return '2-4';
  if (age <= 7) return '5-7';
  if (age <= 10) return '8-10';
  if (age <= 12) return '11-12';
  return '13+';
}

// ═══ VERIFICACIÓN DE EDAD LEGAL ═══

/**
 * Verificar si un menor ha alcanzado la edad de autonomía de datos
 * Se ejecuta cuando el menor informa su edad actual
 */
async function checkAgeAutonomy(uid, currentAge, phone) {
  const configRef = admin.firestore().collection('users').doc(uid).collection('protection').doc('config');
  const configDoc = await configRef.get();
  if (!configDoc.exists) return { eligible: false };

  const config = configDoc.data();
  if (config.mode !== 'kids') return { eligible: false };

  const legalInfo = getLegalInfoFromPhone(phone);
  const autonomyAge = legalInfo.dataAutonomyAge;

  if (currentAge >= autonomyAge) {
    return {
      eligible: true,
      currentAge,
      autonomyAge,
      country: legalInfo.country,
      responsibleAdults: config.responsibleAdults || []
    };
  }

  return { eligible: false, currentAge, autonomyAge, yearsRemaining: autonomyAge - currentAge };
}

/**
 * Iniciar proceso de desvinculación por edad legal
 * 1. MIIA del menor informa al menor que puede solicitar desvinculación
 * 2. MIIA del adulto genera OTP en su selfchat
 * 3. Adulto copia OTP al selfchat del menor
 * 4. Se envía email a TODOS los adultos responsables
 */
async function initiateAgeUnlink(protectedUid, protectedPhone, protectedName) {
  const configRef = admin.firestore().collection('users').doc(protectedUid).collection('protection').doc('config');
  const configDoc = await configRef.get();
  if (!configDoc.exists) return { success: false, reason: 'no_config' };

  const config = configDoc.data();
  const adults = config.responsibleAdults || [];

  if (adults.length === 0) return { success: false, reason: 'no_adults' };

  // Para CADA adulto responsable: generar OTP en su MIIA
  const results = [];
  for (const adult of adults) {
    try {
      const otp = await createUnlinkOTP(adult.uid, adult.phone, protectedName);

      // Enviar OTP al selfchat del adulto
      if (_safeSendMessage) {
        await _safeSendMessage(`${adult.phone}@s.whatsapp.net`,
          `🔓 *Solicitud de desvinculación*\n\n${protectedName} ha alcanzado la edad legal de autonomía de datos en su país y solicita la desvinculación del Modo Protección.\n\nSi autorizas, copia este código y envíalo en el selfchat de ${protectedName}:\n\n🔑 *${otp}*\n\nEste código expira en 72 horas.`,
          { isSelfChat: true, skipEmoji: true }
        );
      }

      // Enviar email informativo
      if (_sendGenericEmail && adult.email) {
        await _sendGenericEmail(
          adult.email,
          `🔓 MIIA — Solicitud de desvinculación de ${protectedName}`,
          `Hola ${adult.name},\n\n${protectedName} ha alcanzado la edad legal de autonomía de datos personales en su país y ha solicitado la desvinculación del Modo Protección KIDS.\n\nEsto significa que ${protectedName} podrá gestionar su cuenta MIIA de forma independiente.\n\nSe ha generado un código de autorización en tu selfchat de WhatsApp. Si autorizas el cambio, copia el código y envíalo en el selfchat de ${protectedName}.\n\nSi NO autorizas, simplemente ignora el código. Expirará en 72 horas.\n\n⚠️ Este evento será incluido en tu próximo informe quincenal como alerta.\n\nMIIA — Protección Inteligente`
        );
        console.log(`[PROTECTION] 📧 Email de desvinculación enviado a ${adult.email}`);
      }

      results.push({ adult: adult.name, otpSent: true });
    } catch (err) {
      console.error(`[PROTECTION] ❌ Error enviando OTP a ${adult.name}:`, err.message);
      results.push({ adult: adult.name, otpSent: false, error: err.message });
    }
  }

  await logProtectionEvent(protectedUid, 'unlink_requested', {
    protectedName,
    adultsNotified: results
  });

  return { success: true, adultsNotified: results };
}

/**
 * Completar desvinculación (el menor pegó el OTP del adulto en su selfchat)
 */
async function completeAgeUnlink(protectedUid, adultUid, protectedName) {
  const configRef = admin.firestore().collection('users').doc(protectedUid).collection('protection').doc('config');
  const configDoc = await configRef.get();
  if (!configDoc.exists) return { success: false };

  const config = configDoc.data();
  const adults = config.responsibleAdults || [];
  const adult = adults.find(a => a.uid === adultUid);

  // Desvincular
  await unlinkResponsibleAdult(protectedUid, adultUid, 'age_autonomy');

  // Notificar en selfchat del menor: SOLO "cambio autorizado"
  if (_safeSendMessage) {
    await _safeSendMessage(`${config.protectedPhone}@s.whatsapp.net`,
      `✅ Cambio autorizado.`,
      { isSelfChat: true, skipEmoji: true }
    );
  }

  // Notificar en selfchat del adulto
  if (_safeSendMessage && adult) {
    await _safeSendMessage(`${adult.phone}@s.whatsapp.net`,
      `✅ Desvinculación de ${protectedName} completada.`,
      { isSelfChat: true, skipEmoji: true }
    );
  }

  // Email a TODOS los adultos responsables (padre Y madre)
  for (const a of adults) {
    if (_sendGenericEmail && a.email) {
      await _sendGenericEmail(
        a.email,
        `✅ MIIA — Desvinculación completada: ${protectedName}`,
        `Hola ${a.name},\n\nSe ha completado la desvinculación de ${protectedName} del Modo Protección KIDS.\n\nA partir de ahora, ${protectedName} gestiona su cuenta MIIA de forma independiente.\n\nFecha: ${new Date().toLocaleString('es-ES')}\nAutorizado por: ${adult ? adult.name : 'Adulto responsable'}\n\n⚠️ Este evento será incluido como alerta en tu próximo informe quincenal.\n\nMIIA — Protección Inteligente`
      );
    }
  }

  // Si no quedan adultos, desactivar modo protección
  const remainingAdults = adults.filter(a => a.uid !== adultUid);
  if (remainingAdults.length === 0) {
    await configRef.update({
      mode: null,
      active: false,
      deactivatedAt: new Date().toISOString(),
      deactivationReason: 'age_autonomy_all_adults_unlinked'
    });
    console.log(`[PROTECTION] 🔓 Modo protección desactivado para ${protectedUid} — sin adultos vinculados`);
  }

  await logProtectionEvent(protectedUid, 'unlink_completed', {
    adultUid, adultName: adult?.name, reason: 'age_autonomy'
  });

  return { success: true };
}

// ═══ ACCESO DE EMERGENCIA ═══

/**
 * Nivel 1: Info básica (adulto vinculado con OTP válido)
 */
async function getEmergencyLevel1(protectedUid, conversations = {}, agenda = []) {
  const info = {};

  // Última actividad
  const allPhones = Object.keys(conversations);
  let lastActivity = null;
  for (const ph of allPhones) {
    const msgs = conversations[ph] || [];
    const last = msgs[msgs.length - 1];
    if (last?.timestamp && (!lastActivity || last.timestamp > lastActivity)) {
      lastActivity = last.timestamp;
    }
  }
  info.lastActivity = lastActivity ? new Date(lastActivity).toISOString() : 'Sin actividad registrada';
  info.minutesSinceLastActivity = lastActivity ? Math.round((Date.now() - lastActivity) / 60000) : null;

  // Agenda del día
  const today = new Date().toISOString().split('T')[0];
  info.todayEvents = agenda
    .filter(e => e.scheduledForLocal?.startsWith(today) && e.status === 'pending')
    .map(e => ({
      reason: e.reason,
      time: e.scheduledForLocal?.split('T')[1]?.substring(0, 5) || '?',
      location: e.eventLocation || 'No especificada',
      mode: e.eventMode || 'presencial'
    }));

  // Última ubicación compartida (si existe en Firestore)
  try {
    const locSnap = await admin.firestore().collection('users').doc(protectedUid)
      .collection('shared_locations')
      .orderBy('sharedAt', 'desc')
      .limit(1)
      .get();
    if (!locSnap.empty) {
      const loc = locSnap.docs[0].data();
      info.lastSharedLocation = {
        latitude: loc.latitude,
        longitude: loc.longitude,
        sharedAt: loc.sharedAt,
        minutesAgo: Math.round((Date.now() - new Date(loc.sharedAt).getTime()) / 60000)
      };
    }
  } catch (e) {
    console.warn(`[PROTECTION] ⚠️ Error leyendo ubicación: ${e.message}`);
  }

  return info;
}

/**
 * Nivel 2: Info extendida (OTP + segundo factor)
 */
async function getEmergencyLevel2(protectedUid, conversations = {}) {
  const level1 = await getEmergencyLevel1(protectedUid, conversations);

  // Contactos con los que habló hoy
  const today = new Date().toISOString().split('T')[0];
  const todayContacts = [];
  for (const [ph, msgs] of Object.entries(conversations)) {
    const todayMsgs = msgs.filter(m => m.timestamp && new Date(m.timestamp).toISOString().startsWith(today));
    if (todayMsgs.length > 0) {
      todayContacts.push({
        phone: ph.split('@')[0],
        messageCount: todayMsgs.length,
        lastMessageAt: new Date(todayMsgs[todayMsgs.length - 1].timestamp).toISOString()
      });
    }
  }
  level1.todayContacts = todayContacts;

  // Resumen general (sin contenido textual exacto)
  level1.summary = `Habló con ${todayContacts.length} contactos hoy. ${level1.todayEvents.length} eventos en agenda.`;

  return level1;
}

/**
 * Nivel 3: Acceso completo (orden judicial — requiere código admin)
 */
async function getEmergencyLevel3(protectedUid, conversations = {}, adminCode) {
  // Verificar código admin (hardcodeado por Mariano)
  const ADMIN_JUDICIAL_CODE = process.env.MIIA_JUDICIAL_CODE;
  if (!ADMIN_JUDICIAL_CODE || adminCode !== ADMIN_JUDICIAL_CODE) {
    return { error: 'Código judicial inválido', authorized: false };
  }

  const level2 = await getEmergencyLevel2(protectedUid, conversations);

  // Contenido completo de chats del día
  const today = new Date().toISOString().split('T')[0];
  const fullChats = {};
  for (const [ph, msgs] of Object.entries(conversations)) {
    const todayMsgs = msgs.filter(m => m.timestamp && new Date(m.timestamp).toISOString().startsWith(today));
    if (todayMsgs.length > 0) {
      fullChats[ph] = todayMsgs.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: new Date(m.timestamp).toISOString()
      }));
    }
  }
  level2.fullChats = fullChats;
  level2.authorized = true;

  // Log inmutable — SIEMPRE registrar acceso nivel 3
  await logProtectionEvent(protectedUid, 'level3_access', {
    accessedAt: new Date().toISOString(),
    note: 'ACCESO JUDICIAL — registrado de forma inmutable'
  });

  return level2;
}

// ═══ LOG INMUTABLE ═══

/**
 * Registrar evento de protección — inmutable, no se puede borrar
 */
async function logProtectionEvent(uid, eventType, details = {}) {
  try {
    await admin.firestore().collection('users').doc(uid)
      .collection('protection_log').add({
        eventType,
        details,
        timestamp: new Date().toISOString(),
        immutable: true
      });
    console.log(`[PROTECTION-LOG] 📝 ${eventType} para ${uid}`);
  } catch (e) {
    console.error(`[PROTECTION-LOG] ❌ Error registrando evento:`, e.message);
  }
}

// ═══ SESIÓN KIDS — Control de tiempo ═══

// En memoria: { [phone]: { startedAt, warned5min } }
const kidsSessions = {};

/**
 * Verificar/gestionar sesión KIDS
 * @returns {{ allowed: boolean, message?: string, minutesLeft?: number }}
 */
function checkKidsSession(phone, maxMinutes = 30, cooldownMinutes = 10) {
  const now = Date.now();
  const session = kidsSessions[phone];

  if (!session) {
    // Nueva sesión
    kidsSessions[phone] = { startedAt: now, warned5min: false };
    return { allowed: true, minutesLeft: maxMinutes };
  }

  const elapsedMin = (now - session.startedAt) / 60000;

  // Cooldown activo
  if (session.cooldownUntil && now < session.cooldownUntil) {
    const cooldownLeft = Math.ceil((session.cooldownUntil - now) / 60000);
    return {
      allowed: false,
      message: `Ahora es momento de descansar un poquito. Volvemos a jugar en ${cooldownLeft} minutos. 🌟`,
      cooldownMinutes: cooldownLeft
    };
  }

  // Sesión expirada → activar cooldown
  if (elapsedMin >= maxMinutes) {
    kidsSessions[phone] = {
      ...session,
      cooldownUntil: now + cooldownMinutes * 60000
    };
    return {
      allowed: false,
      message: '¡Fue muy divertido! Pero es hora de descansar un ratito. Vuelve en un rato y seguimos jugando. 🌈',
      sessionExpired: true
    };
  }

  // Aviso 5 minutos antes
  const minutesLeft = Math.ceil(maxMinutes - elapsedMin);
  if (minutesLeft <= 5 && !session.warned5min) {
    kidsSessions[phone].warned5min = true;
    return {
      allowed: true,
      minutesLeft,
      warn5min: true,
      warnMessage: `¡Uy, nos quedan ${minutesLeft} minutitos! Aprovechemos. ⏰`
    };
  }

  return { allowed: true, minutesLeft };
}

/**
 * Resetear sesión KIDS (nuevo día o cooldown terminado)
 */
function resetKidsSession(phone) {
  delete kidsSessions[phone];
}

// ═══ CONTENIDO FILTRADO KIDS ═══

const BLOCKED_TOPICS_KIDS = [
  /\b(sex[ou]|porn|desnud|violencia|droga|matar|suicid|arma|pistola|cuchillo)\b/i,
  /\b(alcohol|cerveza|vino|marihuana|coca[ií]na|pastilla)\b/i,
  /\b(odi[oa]r|maldici[oó]n|diablo|demonio|infierno)\b/i,
  /\b(novio|novia|beso|enamorad)\b/i, // Para menores de 10
];

/**
 * Verificar si el contenido es seguro para KIDS
 */
function isContentSafeForKids(text, ageGroup = '5-7') {
  if (!text) return { safe: true };

  for (const pattern of BLOCKED_TOPICS_KIDS) {
    if (pattern.test(text)) {
      return {
        safe: false,
        reason: 'blocked_topic',
        redirect: '¡Eso no es para nosotros! ¿Mejor te cuento un cuento o jugamos a algo? 🌟'
      };
    }
  }

  return { safe: true };
}

// ═══ GUARDAR UBICACIÓN COMPARTIDA ═══

/**
 * Guardar ubicación compartida manualmente por el owner via WhatsApp
 */
async function saveSharedLocation(uid, latitude, longitude, address = '') {
  try {
    await admin.firestore().collection('users').doc(uid)
      .collection('shared_locations').add({
        latitude,
        longitude,
        address,
        sharedAt: new Date().toISOString(),
        source: 'whatsapp_manual'
      });
    console.log(`[PROTECTION] 📍 Ubicación guardada para ${uid}: ${latitude}, ${longitude}`);
    return { success: true };
  } catch (e) {
    console.error(`[PROTECTION] ❌ Error guardando ubicación:`, e.message);
    return { success: false, error: e.message };
  }
}

// ═══ DATOS PARA INFORME QUINCENAL ═══

/**
 * Obtener alertas de protección para incluir en informe quincenal
 */
async function getProtectionAlertsForReport(uid, daysBack = 15) {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  try {
    const logSnap = await admin.firestore().collection('users').doc(uid)
      .collection('protection_log')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    return logSnap.docs.map(d => d.data());
  } catch (e) {
    console.error(`[PROTECTION] ❌ Error leyendo alertas:`, e.message);
    return [];
  }
}

// ═══ EMAIL PARA CADA EVENTO OTP ═══

/**
 * Enviar email informativo a todos los adultos responsables
 * Se envía en cada evento OTP importante
 */
async function notifyAdultsByEmail(protectedUid, subject, body) {
  const configDoc = await admin.firestore().collection('users').doc(protectedUid)
    .collection('protection').doc('config').get();
  if (!configDoc.exists) return;

  const adults = configDoc.data().responsibleAdults || [];
  for (const adult of adults) {
    if (_sendGenericEmail && adult.email) {
      try {
        await _sendGenericEmail(adult.email, subject, body);
        console.log(`[PROTECTION] 📧 Email enviado a ${adult.name} (${adult.email})`);
      } catch (e) {
        console.error(`[PROTECTION] ❌ Error enviando email a ${adult.email}:`, e.message);
      }
    }
  }
}

// ═══ EXPORTS ═══

module.exports = {
  // Dependencias
  setProtectionDependencies,

  // Detección
  detectProtectionMode,
  scoreKidsPatterns,
  scoreElderlyPatterns,

  // Configuración
  activateProtectionMode,
  getLegalInfoFromPhone,
  calculateAge,

  // OTP
  createLinkOTP,
  createUnlinkOTP,
  validateLinkOTP,
  validateUnlinkOTP,
  generateProtectionOTP,

  // Vinculación
  linkResponsibleAdult,
  unlinkResponsibleAdult,

  // Edad legal
  checkAgeAutonomy,
  initiateAgeUnlink,
  completeAgeUnlink,

  // Emergencia
  getEmergencyLevel1,
  getEmergencyLevel2,
  getEmergencyLevel3,

  // Log
  logProtectionEvent,
  getProtectionAlertsForReport,

  // Sesión KIDS
  checkKidsSession,
  resetKidsSession,
  isContentSafeForKids,

  // Ubicación
  saveSharedLocation,

  // Notificaciones
  notifyAdultsByEmail,
};
