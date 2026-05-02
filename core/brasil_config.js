'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const BRASIL_CONFIG = Object.freeze({ currency: 'BRL', currencySymbol: 'R$', timezone: 'America/Sao_Paulo', locale: 'pt-BR', phone_prefix: '+55', pix_enabled: true });
const LGPD_RIGHTS = Object.freeze(['access', 'correction', 'deletion', 'portability', 'objection', 'information']);
const BRASIL_PERSONALITY = Object.freeze({ greetings: ['Oi', 'Ola', 'Tudo bem?'], acknowledgements: ['Claro!', 'Com certeza!', 'Otimo!'], farewells: ['Ate logo!', 'Tchau!', 'Um abraco!'] });

function getBrasilConfig() { return { ...BRASIL_CONFIG }; }

function isBrasilPhone(phone) { return phone.startsWith('+55') || phone.startsWith('55'); }

function buildBrasilPersonality() {
  return { language: 'pt-BR', greeting: BRASIL_PERSONALITY.greetings[0], acknowledgement: BRASIL_PERSONALITY.acknowledgements[0], tone: 'warm_informal', pixEnabled: BRASIL_CONFIG.pix_enabled };
}

function formatPixAmount(amount) { return 'R$ ' + amount.toFixed(2).replace('.', ','); }

async function recordLGPDConsent(uid, phone, rights) {
  const invalid = rights.filter(r => !LGPD_RIGHTS.includes(r));
  if (invalid.length > 0) throw new Error('Invalid LGPD rights: ' + invalid.join(', '));
  const consent = { id: randomUUID(), uid, phone, rights, recordedAt: new Date().toISOString(), lawBasis: 'LGPD Art. 7' };
  await getDb().collection('lgpd_consents').doc(consent.id).set(consent);
  return consent;
}

async function handleLGPDRequest(uid, phone, right) {
  if (!LGPD_RIGHTS.includes(right)) throw new Error('Invalid LGPD right: ' + right);
  const request = { id: randomUUID(), uid, phone, right, status: 'pending', createdAt: new Date().toISOString() };
  await getDb().collection('lgpd_requests').doc(request.id).set(request);
  return request;
}

module.exports = { __setFirestoreForTests, BRASIL_CONFIG, LGPD_RIGHTS, BRASIL_PERSONALITY,
  getBrasilConfig, isBrasilPhone, buildBrasilPersonality, formatPixAmount, recordLGPDConsent, handleLGPDRequest };