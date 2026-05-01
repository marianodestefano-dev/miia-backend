"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const DARK_HOURS = Object.freeze({ start: 22, end: 7 });

function isDarkHour(timestamp, timezone) {
  const date = new Date(timestamp || Date.now());
  const hour = date.getHours();
  return hour >= DARK_HOURS.start || hour < DARK_HOURS.end;
}

async function recordOpenTime(uid, phone, timestamp) {
  if (!uid || !phone) throw new Error("uid and phone required");
  const hour = new Date(timestamp || Date.now()).getHours();
  const key = uid + "_" + phone;
  const snap = await getDb().collection("open_time_history").doc(key).get();
  const existing = snap.exists ? snap.data().hours || [] : [];
  existing.push(hour);
  if (existing.length > 100) existing.shift();
  await getDb().collection("open_time_history").doc(key).set({ uid, phone, hours: existing, updatedAt: Date.now() });
  return { uid, phone, hour };
}

async function getOptimalHour(uid, phone) {
  if (!uid || !phone) throw new Error("uid and phone required");
  const snap = await getDb().collection("open_time_history").doc(uid + "_" + phone).get();
  if (!snap.exists || !snap.data().hours || snap.data().hours.length === 0) return 10;
  const hours = snap.data().hours;
  const counts = {};
  hours.forEach(h => { counts[h] = (counts[h] || 0) + 1; });
  const optimal = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  return parseInt(optimal, 10);
}

function shouldSendNow(timestamp, timezone) {
  return !isDarkHour(timestamp, timezone);
}

module.exports = { isDarkHour, recordOpenTime, getOptimalHour, shouldSendNow, DARK_HOURS, __setFirestoreForTests };
