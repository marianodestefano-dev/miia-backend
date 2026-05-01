"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function getReferralDashboard(uid) {
  if (!uid) throw new Error("uid required");

  const referralsSnap = await getDb().collection("referrals").where("uid", "==", uid).get();
  const referrals = [];
  referralsSnap.forEach(doc => referrals.push(doc.data()));
  const totalClicks = referrals.reduce((s, r) => s + (r.clicks || 0), 0);
  const totalConversions = referrals.reduce((s, r) => s + (r.conversions || 0), 0);

  const commissionsSnap = await getDb().collection("commissions").where("referrerId", "==", uid).get();
  const commissions = [];
  commissionsSnap.forEach(doc => commissions.push(doc.data()));
  const pendingTotal = commissions.filter(c => c.status === "pending").reduce((s, c) => s + c.commission, 0);
  const paidTotal = commissions.filter(c => c.status === "paid").reduce((s, c) => s + c.commission, 0);

  return {
    uid,
    network: { totalReferrals: referrals.length, totalClicks, totalConversions },
    commissions: { pending: parseFloat(pendingTotal.toFixed(2)), paid: parseFloat(paidTotal.toFixed(2)), count: commissions.length },
    nextPayoutEstimate: pendingTotal > 0 ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0] : null,
  };
}

module.exports = { getReferralDashboard, __setFirestoreForTests };
