"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const CANCEL_POLICIES = Object.freeze(["free_cancel", "fee_24h", "no_refund"]);

async function createAdvancedBooking(uid, opts) {
  const { phone, date, service, depositAmount, depositCurrency } = opts || {};
  if (!uid || !phone || !date || !service) throw new Error("uid, phone, date, service required");
  const booking = {
    id: randomUUID(), uid, phone, date, service,
    depositAmount: depositAmount || 0,
    depositCurrency: depositCurrency || "COP",
    depositPaid: false,
    status: "pending_deposit",
    createdAt: Date.now(),
  };
  await getDb().collection("advanced_bookings").doc(booking.id).set(booking);
  return booking;
}

async function recordDepositPaid(bookingId, paymentRef) {
  if (!bookingId) throw new Error("bookingId required");
  await getDb().collection("advanced_bookings").doc(bookingId).update({
    depositPaid: true, paymentRef: paymentRef || null,
    status: "confirmed", confirmedAt: Date.now(),
  });
  return { bookingId, depositPaid: true, status: "confirmed" };
}

async function cancelWithPolicy(bookingId, policy, hoursBeforeBooking) {
  if (!bookingId || !policy) throw new Error("bookingId and policy required");
  if (!CANCEL_POLICIES.includes(policy)) throw new Error("invalid policy: " + policy);
  let refundAmount = 0;
  const snap = await getDb().collection("advanced_bookings").doc(bookingId).get();
  const booking = snap.exists ? snap.data() : { depositAmount: 0 };
  if (policy === "free_cancel") refundAmount = booking.depositAmount;
  else if (policy === "fee_24h" && hoursBeforeBooking >= 24) refundAmount = booking.depositAmount;
  await getDb().collection("advanced_bookings").doc(bookingId).update({
    status: "cancelled", cancelledAt: Date.now(), refundAmount, policy,
  });
  return { bookingId, status: "cancelled", refundAmount };
}

module.exports = { createAdvancedBooking, recordDepositPaid, cancelWithPolicy, CANCEL_POLICIES, __setFirestoreForTests };
