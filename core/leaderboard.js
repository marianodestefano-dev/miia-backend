"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function updateLeaderboard(uid, alias, gameId, score) {
  if (!uid || !gameId || score === undefined) throw new Error("uid, gameId, score required");
  const key = uid + "_" + gameId;
  const entry = { uid, alias: alias || "Anonimo", gameId, score, updatedAt: Date.now() };
  await getDb().collection("leaderboard").doc(key).set(entry);
  return entry;
}

async function getTopPlayers(gameId, limit) {
  if (!gameId) throw new Error("gameId required");
  const n = limit || 10;
  let q = getDb().collection("leaderboard").where("gameId", "==", gameId).orderBy("score").limit(n);
  const snap = await q.get();
  const players = [];
  snap.forEach(doc => players.push(doc.data()));
  return players.sort((a, b) => b.score - a.score);
}

async function getGlobalStats() {
  const snap = await getDb().collection("leaderboard").get();
  const byGame = {};
  snap.forEach(doc => { const d = doc.data(); byGame[d.gameId] = (byGame[d.gameId] || 0) + 1; });
  const mostActive = Object.entries(byGame).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([gameId, players]) => ({ gameId, players }));
  return { totalPlayers: snap.docs ? snap.docs.length : 0, mostActive };
}

module.exports = { updateLeaderboard, getTopPlayers, getGlobalStats, __setFirestoreForTests };
