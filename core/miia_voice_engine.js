'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const MIIA_VOICE_ACCENTS = Object.freeze({
  CO: { name: 'Colombiano', voiceId: 'miia-co-v1', pitch: 1.0, rate: 0.95, warmth: 'high' },
  AR: { name: 'Rioplatense', voiceId: 'miia-ar-v1', pitch: 0.98, rate: 1.0, warmth: 'medium' },
  MX: { name: 'Mexicano', voiceId: 'miia-mx-v1', pitch: 1.02, rate: 0.98, warmth: 'high' },
  CL: { name: 'Chileno', voiceId: 'miia-cl-v1', pitch: 1.0, rate: 1.05, warmth: 'medium' },
  PE: { name: 'Peruano', voiceId: 'miia-pe-v1', pitch: 1.01, rate: 0.97, warmth: 'high' },
  BR: { name: 'Brasileiro', voiceId: 'miia-br-v1', pitch: 1.03, rate: 0.96, warmth: 'high' },
});
const VOICE_ENGINE_STATUS = Object.freeze(['not_configured', 'training', 'ready', 'deprecated']);

function getVoiceForCountry(countryCode) {
  const accent = MIIA_VOICE_ACCENTS[countryCode];
  if (!accent) return { countryCode, voiceId: 'miia-latam-default', pitch: 1.0, rate: 1.0, warmth: 'medium' };
  return { countryCode, ...accent };
}

async function registerCustomVoice(uid, opts) {
  const { countryCode, voiceId, sampleUrl } = opts;
  const voice = { id: randomUUID(), uid, countryCode: countryCode || 'CO', voiceId, sampleUrl: sampleUrl || null, status: 'training', createdAt: new Date().toISOString() };
  await getDb().collection('custom_voices').doc(voice.id).set(voice);
  return voice;
}

async function setVoiceForOwner(uid, countryCode) {
  const voice = getVoiceForCountry(countryCode);
  await getDb().collection('owners').doc(uid).set({ voice_config: voice, voice_country: countryCode }, { merge: true });
  return { uid, voice };
}

async function buildVoiceSynthRequest(uid, text, countryCode) {
  const voice = getVoiceForCountry(countryCode);
  return { uid, text, voiceId: voice.voiceId, pitch: voice.pitch, rate: voice.rate, format: 'mp3', provider: 'miia_voice_engine' };
}

function listAvailableAccents() {
  return Object.entries(MIIA_VOICE_ACCENTS).map(([code, v]) => ({ countryCode: code, name: v.name, voiceId: v.voiceId }));
}

module.exports = { __setFirestoreForTests, MIIA_VOICE_ACCENTS, VOICE_ENGINE_STATUS,
  getVoiceForCountry, registerCustomVoice, setVoiceForOwner, buildVoiceSynthRequest, listAvailableAccents };