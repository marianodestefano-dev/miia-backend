"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function getLudoDashboard(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("game_sessions").where("uid", "==", uid).get();
  const sessions = [];
  snap.forEach(doc => sessions.push(doc.data()));
  const active = sessions.filter(s => s.status === "active");
  const completed = sessions.filter(s => s.status === "completed");
  const avgScore = completed.length > 0
    ? parseFloat((completed.reduce((s, g) => s + (g.score || 0), 0) / completed.length).toFixed(1))
    : 0;
  const byGame = {};
  sessions.forEach(s => { byGame[s.gameType] = (byGame[s.gameType] || 0) + 1; });
  return {
    uid,
    activeSessions: active.length,
    completedSessions: completed.length,
    totalSessions: sessions.length,
    avgScore,
    byGame,
  };
}

async function getRecentSessions(uid, limit) {
  if (!uid) throw new Error("uid required");
  const n = limit || 10;
  const snap = await getDb().collection("game_sessions").where("uid", "==", uid).orderBy("startedAt").limit(n).get();
  const sessions = [];
  snap.forEach(doc => sessions.push(doc.data()));
  return sessions;
}

module.exports = { getLudoDashboard, getRecentSessions, __setFirestoreForTests };
