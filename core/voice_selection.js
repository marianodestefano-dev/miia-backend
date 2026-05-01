"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const AVAILABLE_VOICES = Object.freeze([
  { id: "2VUqK4PEdMj16L6xTN4J", name: "Sofia", lang: "es", gender: "female", preview: "Hola, soy Sofia" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", lang: "es", gender: "female", preview: "Hola, soy Bella" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Adam", lang: "es", gender: "male", preview: "Hola, soy Adam" },
  { id: "CYw3kZ78EXXxRdSchFcz", name: "Dave", lang: "en", gender: "male", preview: "Hello, I am Dave" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam EN", lang: "en", gender: "male", preview: "Hello, I am Adam" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam", lang: "en", gender: "male", preview: "Hello, I am Sam" },
  { id: "jsCqWAovK2LkecY7zXl4", name: "Freya", lang: "pt", gender: "female", preview: "Ola, eu sou Freya" },
  { id: "jBpfuIE2acCO8z3wKNLl", name: "Gigi", lang: "pt", gender: "female", preview: "Ola, eu sou Gigi" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", lang: "pt", gender: "male", preview: "Ola, eu sou Daniel" },
]);

async function setVoice(uid, voiceId) {
  if (!uid || !voiceId) throw new Error("uid and voiceId required");
  const voice = AVAILABLE_VOICES.find(v => v.id === voiceId);
  if (!voice) throw new Error("invalid voiceId: " + voiceId);
  await getDb().collection("owners").doc(uid).update({ voice_id: voiceId, voice_lang: voice.lang });
  return { uid, voice };
}

async function getVoice(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("owners").doc(uid).get();
  const voiceId = snap.exists ? snap.data().voice_id : null;
  return voiceId ? AVAILABLE_VOICES.find(v => v.id === voiceId) || null : AVAILABLE_VOICES[0];
}

function listVoices(lang) {
  if (!lang) return AVAILABLE_VOICES.slice();
  return AVAILABLE_VOICES.filter(v => v.lang === lang);
}

module.exports = { setVoice, getVoice, listVoices, AVAILABLE_VOICES, __setFirestoreForTests };
