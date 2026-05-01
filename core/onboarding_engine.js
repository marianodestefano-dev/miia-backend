'use strict';

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || require('firebase-admin').firestore(); }

const ONBOARDING_STEPS = Object.freeze([
  'welcome',
  'business_info',
  'whatsapp_setup',
  'catalog_setup',
  'personality_config',
  'test_conversation',
  'go_live',
]);

const ONBOARDING_STATUSES = Object.freeze([
  'not_started', 'in_progress', 'paused', 'completed', 'failed',
]);

const BUSINESS_TYPES = Object.freeze([
  'ecommerce', 'servicios_profesionales', 'salud_belleza', 'gastronomia',
  'educacion', 'inmobiliaria', 'retail', 'tecnologia', 'otro',
]);

const MAX_BUSINESS_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const ONBOARDING_VERSION = '1.0';

function isValidStep(step) { return ONBOARDING_STEPS.includes(step); }
function isValidStatus(s) { return ONBOARDING_STATUSES.includes(s); }
function isValidBusinessType(t) { return BUSINESS_TYPES.includes(t); }

function getNextStep(currentStep) {
  if (!currentStep) return ONBOARDING_STEPS[0];
  const idx = ONBOARDING_STEPS.indexOf(currentStep);
  if (idx === -1 || idx === ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[idx + 1];
}

function computeProgress(completedSteps) {
  if (!Array.isArray(completedSteps) || completedSteps.length === 0) return 0;
  const valid = completedSteps.filter(s => isValidStep(s));
  return Math.round((valid.length / ONBOARDING_STEPS.length) * 100);
}

function buildOnboardingRecord(uid, data) {
  data = data || {};
  const now = Date.now();
  return {
    onboardingId: uid.slice(0, 8) + '_onboarding',
    uid,
    version: ONBOARDING_VERSION,
    status: isValidStatus(data.status) ? data.status : 'not_started',
    currentStep: isValidStep(data.currentStep) ? data.currentStep : ONBOARDING_STEPS[0],
    completedSteps: Array.isArray(data.completedSteps)
      ? data.completedSteps.filter(s => isValidStep(s))
      : [],
    businessInfo: data.businessInfo && typeof data.businessInfo === 'object'
      ? {
          name: typeof data.businessInfo.name === 'string'
            ? data.businessInfo.name.trim().slice(0, MAX_BUSINESS_NAME_LENGTH) : '',
          type: isValidBusinessType(data.businessInfo.type) ? data.businessInfo.type : 'otro',
          description: typeof data.businessInfo.description === 'string'
            ? data.businessInfo.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : '',
          phone: typeof data.businessInfo.phone === 'string' ? data.businessInfo.phone.trim() : '',
          timezone: typeof data.businessInfo.timezone === 'string' ? data.businessInfo.timezone : 'America/Argentina/Buenos_Aires',
        }
      : { name: '', type: 'otro', description: '', phone: '', timezone: 'America/Argentina/Buenos_Aires' },
    personalityConfig: data.personalityConfig && typeof data.personalityConfig === 'object'
      ? data.personalityConfig : {},
    catalogSetup: typeof data.catalogSetup === 'boolean' ? data.catalogSetup : false,
    whatsappConnected: typeof data.whatsappConnected === 'boolean' ? data.whatsappConnected : false,
    testConversationDone: typeof data.testConversationDone === 'boolean' ? data.testConversationDone : false,
    startedAt: data.startedAt || now,
    completedAt: data.completedAt || null,
    updatedAt: now,
  };
}

function buildStepPayload(step, data) {
  data = data || {};
  if (!isValidStep(step)) throw new Error('step invalido: ' + step);
  switch (step) {
    case 'welcome':
      return { acknowledged: true, timestamp: Date.now() };
    case 'business_info':
      return {
        name: typeof data.name === 'string' ? data.name.trim().slice(0, MAX_BUSINESS_NAME_LENGTH) : '',
        type: isValidBusinessType(data.type) ? data.type : 'otro',
        description: typeof data.description === 'string' ? data.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : '',
        phone: typeof data.phone === 'string' ? data.phone.trim() : '',
        timezone: typeof data.timezone === 'string' ? data.timezone : 'America/Argentina/Buenos_Aires',
      };
    case 'whatsapp_setup':
      return { connected: typeof data.connected === 'boolean' ? data.connected : false, qrScanned: data.qrScanned || false };
    case 'catalog_setup':
      return { productCount: typeof data.productCount === 'number' ? data.productCount : 0, skipped: data.skipped || false };
    case 'personality_config':
      return {
        tone: data.tone || 'amigable',
        language: data.language || 'es',
        customInstructions: typeof data.customInstructions === 'string' ? data.customInstructions.slice(0, 500) : '',
      };
    case 'test_conversation':
      return { passed: typeof data.passed === 'boolean' ? data.passed : false, notes: data.notes || '' };
    case 'go_live':
      return { activatedAt: Date.now(), channel: data.channel || 'whatsapp' };
    default:
      return {};
  }
}

function validateStepCompletion(step, payload) {
  payload = payload || {};
  switch (step) {
    case 'welcome':
      return { valid: true };
    case 'business_info':
      if (!payload.name || payload.name.trim().length === 0) {
        return { valid: false, reason: 'business name es requerido' };
      }
      return { valid: true };
    case 'whatsapp_setup':
      if (!payload.connected) return { valid: false, reason: 'whatsapp no conectado' };
      return { valid: true };
    case 'catalog_setup':
      return { valid: true };
    case 'personality_config':
      return { valid: true };
    case 'test_conversation':
      if (!payload.passed) return { valid: false, reason: 'test conversation no aprobado' };
      return { valid: true };
    case 'go_live':
      return { valid: true };
    default:
      return { valid: false, reason: 'step desconocido' };
  }
}

async function saveOnboarding(uid, record) {
  console.log('[ONBOARDING] Guardando uid=' + uid + ' step=' + record.currentStep + ' status=' + record.status);
  try {
    await db().collection('owners').doc(uid)
      .collection('onboarding').doc(record.onboardingId)
      .set(record, { merge: false });
    return record.onboardingId;
  } catch (err) {
    console.error('[ONBOARDING] Error guardando:', err.message);
    throw err;
  }
}

async function getOnboarding(uid) {
  try {
    const onboardingId = uid.slice(0, 8) + '_onboarding';
    const snap = await db().collection('owners').doc(uid)
      .collection('onboarding').doc(onboardingId).get();
    if (!snap.exists) return null;
    return snap.data();
  } catch (err) {
    console.error('[ONBOARDING] Error obteniendo:', err.message);
    return null;
  }
}

async function advanceStep(uid, step, payload) {
  if (!isValidStep(step)) throw new Error('step invalido: ' + step);
  const validation = validateStepCompletion(step, payload || {});
  if (!validation.valid) throw new Error('step no completado: ' + validation.reason);
  const now = Date.now();
  const existing = await getOnboarding(uid);
  const completedSteps = existing ? [...(existing.completedSteps || [])] : [];
  if (!completedSteps.includes(step)) completedSteps.push(step);
  const nextStep = getNextStep(step);
  const newStatus = nextStep === null ? 'completed' : 'in_progress';
  const update = {
    currentStep: nextStep || step,
    completedSteps,
    status: newStatus,
    updatedAt: now,
    completedAt: newStatus === 'completed' ? now : null,
  };
  if (step === 'business_info' && payload) update.businessInfo = payload;
  if (step === 'personality_config' && payload) update.personalityConfig = payload;
  if (step === 'whatsapp_setup') update.whatsappConnected = !!(payload && payload.connected);
  if (step === 'catalog_setup') update.catalogSetup = true;
  if (step === 'test_conversation') update.testConversationDone = !!(payload && payload.passed);
  console.log('[ONBOARDING] Avanzando step=' + step + ' nextStep=' + nextStep + ' uid=' + uid);
  try {
    const onboardingId = uid.slice(0, 8) + '_onboarding';
    await db().collection('owners').doc(uid)
      .collection('onboarding').doc(onboardingId)
      .set(update, { merge: true });
    return { step, nextStep, status: newStatus, completedSteps };
  } catch (err) {
    console.error('[ONBOARDING] Error avanzando step:', err.message);
    throw err;
  }
}

function buildOnboardingText(record) {
  if (!record) return 'Onboarding no iniciado.';
  const progress = computeProgress(record.completedSteps);
  const parts = [];
  parts.push('\u{1F680} *Estado del Onboarding*');
  parts.push('Progreso: ' + progress + '% (' + (record.completedSteps || []).length + '/' + ONBOARDING_STEPS.length + ' pasos)');
  parts.push('Estado: ' + record.status);
  parts.push('Paso actual: ' + record.currentStep);
  if (record.businessInfo && record.businessInfo.name) {
    parts.push('Negocio: ' + record.businessInfo.name + ' (' + record.businessInfo.type + ')');
  }
  if (record.whatsappConnected) parts.push('\u{2705} WhatsApp conectado');
  if (record.catalogSetup) parts.push('\u{2705} Catálogo configurado');
  if (record.testConversationDone) parts.push('\u{2705} Conversación de prueba completada');
  return parts.join('\n');
}

function buildWelcomeMessage(businessName) {
  const name = typeof businessName === 'string' && businessName.trim() ? businessName.trim() : 'tu negocio';
  return [
    '\u{1F44B} Bienvenido a MIIA!',
    '',
    'Vamos a configurar MIIA para ' + name + ' en unos pocos pasos.',
    '',
    'Con MIIA vas a poder:',
    '\u{2705} Responder mensajes de WhatsApp automáticamente',
    '\u{2705} Gestionar tu catálogo de productos y servicios',
    '\u{2705} Agendar citas y enviar recordatorios',
    '\u{2705} Hacer seguimiento de tus leads',
    '',
    'Empecemos! Cuéntame: \u{1F4E7} ¿Cuál es el nombre de tu negocio?',
  ].join('\n');
}

module.exports = {
  buildOnboardingRecord,
  buildStepPayload,
  validateStepCompletion,
  saveOnboarding,
  getOnboarding,
  advanceStep,
  getNextStep,
  computeProgress,
  buildOnboardingText,
  buildWelcomeMessage,
  ONBOARDING_STEPS,
  ONBOARDING_STATUSES,
  BUSINESS_TYPES,
  ONBOARDING_VERSION,
  __setFirestoreForTests,
};
