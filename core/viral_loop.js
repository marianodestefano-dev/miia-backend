"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SHARE_CHANNELS = Object.freeze(["whatsapp", "email", "copy"]);

function buildShareLink(uid, referralCode, channel) {
  if (!uid || !referralCode) throw new Error("uid and referralCode required");
  const base = "https://miia-app.com/join?ref=" + referralCode;
  const messages = {
    whatsapp: "https://wa.me/?text=" + encodeURIComponent("Proba MIIA: " + base),
    email: "mailto:?subject=Te+invito+a+MIIA&body=" + encodeURIComponent(base),
    copy: base,
  };
  return messages[channel] || base;
}

async function trackShare(uid, referralCode, channel) {
  if (!uid || !referralCode) throw new Error("uid and referralCode required");
  const record = { id: randomUUID(), uid, referralCode, channel: channel || "copy", sharedAt: Date.now() };
  await getDb().collection("viral_shares").doc(record.id).set(record);
  return record;
}

async function getShareStats(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("viral_shares").where("uid", "==", uid).get();
  const byChannel = { whatsapp: 0, email: 0, copy: 0 };
  snap.forEach(doc => { const ch = doc.data().channel; byChannel[ch] = (byChannel[ch] || 0) + 1; });
  return { uid, total: snap.docs ? snap.docs.length : 0, byChannel };
}

module.exports = { buildShareLink, trackShare, getShareStats, SHARE_CHANNELS, __setFirestoreForTests };
