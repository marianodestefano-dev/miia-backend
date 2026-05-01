"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

function getMonthKey(timestamp) {
  const d = new Date(timestamp);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

async function buildCohorts(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("leads").where("uid", "==", uid).get();
  const cohorts = {};
  snap.forEach(doc => {
    const d = doc.data();
    const month = getMonthKey(d.createdAt || Date.now());
    if (!cohorts[month]) cohorts[month] = { month, size: 0, retained: 0 };
    cohorts[month].size++;
    if (d.lastMessageAt && d.lastMessageAt > Date.now() - 30 * 24 * 60 * 60 * 1000) {
      cohorts[month].retained++;
    }
  });
  Object.values(cohorts).forEach(c => {
    c.retentionRate = c.size > 0 ? parseFloat((c.retained / c.size * 100).toFixed(1)) : 0;
  });
  return { uid, cohorts: Object.values(cohorts).sort((a, b) => a.month.localeCompare(b.month)) };
}

module.exports = { buildCohorts, getMonthKey, __setFirestoreForTests };
