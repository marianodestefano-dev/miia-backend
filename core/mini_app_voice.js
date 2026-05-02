"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const VOICE_TRIGGERS = Object.freeze(["hola miia", "ey miia", "miia", "oye miia"]);
const APP_MODES = Object.freeze(["voice", "chat", "hybrid"]);
const SESSION_STATUS = Object.freeze(["active", "idle", "ended"]);

function detectVoiceTrigger(transcript) {
  const lower = (transcript || "").toLowerCase().trim();
  const matched = VOICE_TRIGGERS.find(t => lower.startsWith(t) || lower.includes(t));
  return { triggered: !!matched, trigger: matched || null, command: matched ? lower.replace(matched, "").trim() : lower };
}

async function createMobileSession(uid, opts) {
  opts = opts || {};
  const mode = opts.mode || "hybrid";
  if (!APP_MODES.includes(mode)) throw new Error("Invalid app mode: " + mode);
  const session = { id: randomUUID(), uid, mode, deviceId: opts.deviceId || null, status: "active", voiceEnabled: mode !== "chat", language: opts.language || "es", startedAt: new Date().toISOString() };
  await getDb().collection("mobile_sessions").doc(session.id).set(session);
  return session;
}

async function recordVoiceCommand(sessionId, transcript, response) {
  const cmd = { id: randomUUID(), sessionId, transcript, response: response || null, trigger: detectVoiceTrigger(transcript), recordedAt: new Date().toISOString() };
  await getDb().collection("voice_commands").doc(cmd.id).set(cmd);
  return cmd;
}

async function endSession(sessionId) {
  await getDb().collection("mobile_sessions").doc(sessionId).set({ status: "ended", endedAt: new Date().toISOString() }, { merge: true });
  return { sessionId, status: "ended" };
}

async function getSessionHistory(uid) {
  const snap = await getDb().collection("mobile_sessions").where("uid", "==", uid).get();
  const sessions = [];
  snap.forEach(doc => sessions.push(doc.data()));
  return sessions;
}

module.exports = { __setFirestoreForTests, VOICE_TRIGGERS, APP_MODES, SESSION_STATUS,
  detectVoiceTrigger, createMobileSession, recordVoiceCommand, endSession, getSessionHistory };
