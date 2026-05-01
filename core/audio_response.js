'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }
const crypto = require("crypto");

const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = "2VUqK4PEdMj16L6xTN4J";
const TTS_TIMEOUT_MS = 8000;

function buildTTSRequest(text, voiceId, opts = {}) {
  if (!text) throw new Error("text required");
  const voice = voiceId || DEFAULT_VOICE_ID;
  return {
    url: ELEVENLABS_API_URL + "/" + voice,
    body: JSON.stringify({
      text,
      model_id: opts.model || "eleven_multilingual_v2",
      voice_settings: { stability: opts.stability || 0.5, similarity_boost: opts.similarity || 0.75 },
    }),
    headers: { "Content-Type": "application/json", "Accept": "audio/mpeg", "xi-api-key": process.env.ELEVENLABS_API_KEY || "" },
  };
}

async function getVoiceForOwner(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("owners").doc(uid).get();
  if (!snap.exists) return DEFAULT_VOICE_ID;
  return snap.data().elevenlabs_voice_id || DEFAULT_VOICE_ID;
}

function cacheKey(text, voiceId) {
  if (!text || !voiceId) throw new Error("text and voiceId required");
  return crypto.createHash("sha256").update(text + "|" + voiceId).digest("hex");
}

async function generateAudio(text, uid) {
  if (!text || !uid) throw new Error("text and uid required");
  try {
    const voiceId = await getVoiceForOwner(uid);
    const req = buildTTSRequest(text, voiceId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer;
  } catch (e) {
    return null;
  }
}

module.exports = { buildTTSRequest, generateAudio, getVoiceForOwner, cacheKey, __setFirestoreForTests, TTS_TIMEOUT_MS, DEFAULT_VOICE_ID };
