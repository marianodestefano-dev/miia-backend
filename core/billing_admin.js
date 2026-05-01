"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function issueRefund(paymentId, amount, reason) {
  if (!paymentId || !amount || amount <= 0) throw new Error("paymentId and positive amount required");
  const refund = { id: randomUUID(), paymentId, amount: parseFloat(amount.toFixed(2)), reason: reason || "admin_request", status: "processed", issuedAt: Date.now() };
  await getDb().collection("refunds").doc(refund.id).set(refund);
  await getDb().collection("payments").doc(paymentId).update({ refunded: true, refundId: refund.id });
  return refund;
}

async function changePlan(uid, newPlan) {
  if (!uid || !newPlan) throw new Error("uid and newPlan required");
  const valid = ["free", "starter", "pro", "enterprise"];
  if (!valid.includes(newPlan)) throw new Error("invalid plan: " + newPlan);
  await getDb().collection("owners").doc(uid).update({ plan: newPlan, planChangedAt: Date.now() });
  return { uid, plan: newPlan };
}

async function getOwnerBilling(uid) {
  if (!uid) throw new Error("uid required");
  const [paymentsSnap, refundsSnap] = await Promise.all([
    getDb().collection("payments").where("uid", "==", uid).get(),
    getDb().collection("refunds").where("paymentId", "!=", null).get(),
  ]);
  const payments = [];
  paymentsSnap.forEach(doc => payments.push(doc.data()));
  const total = payments.reduce((s, p) => s + (p.amount || 0), 0);
  return { uid, payments, totalPaid: parseFloat(total.toFixed(2)) };
}

module.exports = { issueRefund, changePlan, getOwnerBilling, __setFirestoreForTests };
