'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }
const { randomUUID } = require("crypto");

const BOOKING_STATUSES = Object.freeze({ PENDING: "pending", CONFIRMED: "confirmed", CANCELLED: "cancelled" });

async function createBooking(uid, opts = {}) {
  const { phone, date, service, notes } = opts;
  if (!uid) throw new Error("uid required");
  if (!phone) throw new Error("phone required");
  if (!date) throw new Error("date required");
  if (!service) throw new Error("service required");
  const bookingId = randomUUID();
  const booking = {
    id: bookingId, uid, phone, date, service,
    notes: notes || "",
    status: BOOKING_STATUSES.PENDING,
    createdAt: Date.now(),
    confirmedAt: null, cancelledAt: null,
  };
  await getDb().collection("bookings").doc(bookingId).set(booking);
  return booking;
}

async function confirmBooking(uid, bookingId) {
  if (!uid || !bookingId) throw new Error("uid and bookingId required");
  const ref = getDb().collection("bookings").doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("booking_not_found");
  const data = snap.data();
  if (data.uid !== uid) throw new Error("unauthorized");
  if (data.status === BOOKING_STATUSES.CANCELLED) throw new Error("booking_cancelled");
  const updated = Object.assign({}, data, { status: BOOKING_STATUSES.CONFIRMED, confirmedAt: Date.now() });
  await ref.set(updated);
  return updated;
}

async function cancelBooking(uid, bookingId, reason) {
  if (!uid || !bookingId) throw new Error("uid and bookingId required");
  const ref = getDb().collection("bookings").doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("booking_not_found");
  const data = snap.data();
  if (data.uid !== uid) throw new Error("unauthorized");
  const updated = Object.assign({}, data, { status: BOOKING_STATUSES.CANCELLED, cancelledAt: Date.now(), cancelReason: reason || "" });
  await ref.set(updated);
  return updated;
}

async function listBookings(uid, opts = {}) {
  if (!uid) throw new Error("uid required");
  const { status } = opts;
  const col = getDb().collection("bookings");
  let q = col.where("uid", "==", uid);
  if (status) q = q.where("status", "==", status);
  const snap = await q.get();
  const bookings = [];
  snap.forEach(doc => bookings.push(doc.data()));
  return bookings;
}

async function getAvailableSlots(uid, date) {
  if (!uid || !date) throw new Error("uid and date required");
  const snap = await getDb().collection("owners").doc(uid).get();
  const config = snap.exists ? (snap.data().booking_config || {}) : {};
  const slots = config.slots || ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];
  const booked = await listBookings(uid, { status: BOOKING_STATUSES.CONFIRMED });
  const bookedOnDate = booked.filter(b => b.date === date).map(b => b.time);
  return slots.filter(s => !bookedOnDate.includes(s));
}

module.exports = { BOOKING_STATUSES, createBooking, confirmBooking, cancelBooking, listBookings, getAvailableSlots, __setFirestoreForTests };
