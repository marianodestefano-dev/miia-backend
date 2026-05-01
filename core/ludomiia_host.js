"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function activateLudoMIIA(uid, opts) {
  if (!uid) throw new Error("uid required");
  const config = {
    enabled: true,
    gamesAllowed: (opts && opts.gamesAllowed) || ["trivia", "wordgame", "quiz"],
    maxSessionsPerDay: (opts && opts.maxSessionsPerDay) || 10,
    activatedAt: Date.now(),
  };
  await getDb().collection("owners").doc(uid).update({ ludomiia: config });
  return { uid, ludomiia: config };
}

async function getLudoStatus(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("owners").doc(uid).get();
  if (!snap.exists) return { uid, enabled: false };
  const d = snap.data();
  return { uid, enabled: !!(d.ludomiia && d.ludomiia.enabled), config: d.ludomiia || null };
}

async function createGameSession(uid, phone, gameType) {
  if (!uid || !phone || !gameType) throw new Error("uid, phone, gameType required");
  const session = {
    id: randomUUID(), uid, phone, gameType,
    status: "active", score: 0, turn: 0,
    startedAt: Date.now(),
  };
  await getDb().collection("game_sessions").doc(session.id).set(session);
  return session;
}

async function endGameSession(sessionId, finalScore) {
  if (!sessionId) throw new Error("sessionId required");
  await getDb().collection("game_sessions").doc(sessionId).update({
    status: "completed", score: finalScore || 0, endedAt: Date.now()
  });
  return { sessionId, status: "completed", score: finalScore || 0 };
}

module.exports = { activateLudoMIIA, getLudoStatus, createGameSession, endGameSession, __setFirestoreForTests };
