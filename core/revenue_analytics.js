"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function getMRR(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("subscriptions").where("uid", "==", uid).where("status", "==", "active").get();
  let mrr = 0;
  snap.forEach(doc => { const d = doc.data(); mrr += d.monthlyAmount || 0; });
  return { uid, mrr: parseFloat(mrr.toFixed(2)), currency: "USD" };
}

async function getRevenueSummary(uid) {
  if (!uid) throw new Error("uid required");
  const mrrData = await getMRR(uid);
  const mrr = mrrData.mrr;
  const arr = parseFloat((mrr * 12).toFixed(2));

  const allSubs = await getDb().collection("subscriptions").where("uid", "==", uid).get();
  const totalSubs = allSubs.docs ? allSubs.docs.length : 0;
  const activeSubs = (allSubs.docs || []).filter(d => d.data().status === "active").length;
  const churnRate = totalSubs > 0 ? parseFloat(((totalSubs - activeSubs) / totalSubs * 100).toFixed(1)) : 0;

  const paymentsSnap = await getDb().collection("payments").where("uid", "==", uid).get();
  let totalRevenue = 0;
  paymentsSnap.forEach(doc => { totalRevenue += doc.data().amount || 0; });
  const ltv = activeSubs > 0 ? parseFloat((totalRevenue / activeSubs).toFixed(2)) : 0;

  return { uid, mrr, arr, churnRate, ltv, activeSubscriptions: activeSubs, currency: "USD" };
}

module.exports = { getMRR, getRevenueSummary, __setFirestoreForTests };
