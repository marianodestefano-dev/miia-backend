'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function buildDailySummary(uid) {
  if (!uid) throw new Error("uid required");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const snap = await getDb().collection("conversations").doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const msgs = data.messages || [];
  const todayTs = today.getTime();
  const todayMsgs = msgs.filter(m => m.timestamp >= todayTs);
  const sent = todayMsgs.filter(m => m.role === "miia").length;
  const received = todayMsgs.filter(m => m.role === "lead").length;
  const leadsSnap = await getDb().collection("leads").where("uid", "==", uid).where("createdAt", ">=", todayTs).get();
  const newLeads = leadsSnap.docs ? leadsSnap.docs.length : 0;
  return { period: "daily", date: today.toISOString().split("T")[0], sent, received, newLeads };
}

async function buildWeeklySummary(uid) {
  if (!uid) throw new Error("uid required");
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7); weekAgo.setHours(0, 0, 0, 0);
  const snap = await getDb().collection("conversations").doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  const msgs = data.messages || [];
  const weekTs = weekAgo.getTime();
  const weekMsgs = msgs.filter(m => m.timestamp >= weekTs);
  const sent = weekMsgs.filter(m => m.role === "miia").length;
  const received = weekMsgs.filter(m => m.role === "lead").length;
  const leadsSnap = await getDb().collection("leads").where("uid", "==", uid).where("createdAt", ">=", weekTs).get();
  const newLeads = leadsSnap.docs ? leadsSnap.docs.length : 0;
  return { period: "weekly", weekStart: weekAgo.toISOString().split("T")[0], sent, received, newLeads };
}

function formatSummaryMessage(summary) {
  if (!summary || !summary.period) throw new Error("invalid summary");
  if (summary.period === "daily") {
    return "Resumen del dia - Enviados: " + summary.sent + " Recibidos: " + summary.received + " Nuevos leads: " + summary.newLeads;
  }
  return "Resumen semanal - Enviados: " + summary.sent + " Recibidos: " + summary.received + " Nuevos leads: " + summary.newLeads;
}

async function scheduleNotification(uid, type, cronExpr) {
  if (!uid || !type || !cronExpr) throw new Error("uid, type, cronExpr required");
  await getDb().collection("notification_config").doc(uid).set({ [type]: cronExpr }, { merge: true });
}

async function shouldNotify(uid, type) {
  if (!uid || !type) return false;
  const snap = await getDb().collection("notification_config").doc(uid).get();
  if (!snap.exists) return false;
  return !!snap.data()[type];
}

module.exports = { buildDailySummary, buildWeeklySummary, formatSummaryMessage, scheduleNotification, shouldNotify, __setFirestoreForTests };
