"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const COMMISSION_RATES = Object.freeze({ month1: 0.20, months2to6: 0.10, month7plus: 0.00 });

function getCommissionRate(monthsSinceReferral) {
  if (monthsSinceReferral < 1) return COMMISSION_RATES.month1;
  if (monthsSinceReferral < 6) return COMMISSION_RATES.months2to6;
  return COMMISSION_RATES.month7plus;
}

async function recordCommission(referrerId, referredUid, amount, monthsSince) {
  if (!referrerId || !referredUid || !amount || amount <= 0) throw new Error("invalid params");
  const rate = getCommissionRate(monthsSince || 0);
  const commission = parseFloat((amount * rate).toFixed(2));
  const id = referrerId + "_" + Date.now();
  const record = { id, referrerId, referredUid, amount, rate, commission, status: "pending", createdAt: Date.now() };
  await getDb().collection("commissions").doc(id).set(record);
  return record;
}

async function getPendingCommissions(referrerId) {
  if (!referrerId) throw new Error("referrerId required");
  const snap = await getDb().collection("commissions").where("referrerId", "==", referrerId).where("status", "==", "pending").get();
  const items = [];
  snap.forEach(doc => items.push(doc.data()));
  const total = items.reduce((s, c) => s + c.commission, 0);
  return { items, total: parseFloat(total.toFixed(2)) };
}

async function markCommissionPaid(commissionId) {
  if (!commissionId) throw new Error("commissionId required");
  await getDb().collection("commissions").doc(commissionId).update({ status: "paid", paidAt: Date.now() });
  return { commissionId, status: "paid" };
}

module.exports = { recordCommission, getPendingCommissions, markCommissionPaid, getCommissionRate, COMMISSION_RATES, __setFirestoreForTests };
