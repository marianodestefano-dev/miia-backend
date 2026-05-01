"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const UTM_BASE = "https://miia-app.com/join";

function generateReferralCode(uid) {
  return uid.slice(0, 6) + "-" + randomUUID().slice(0, 6);
}

async function createInvite(uid, opts = {}) {
  if (!uid) throw new Error("uid required");
  const code = generateReferralCode(uid);
  const link = UTM_BASE + "?ref=" + code + (opts.utm_campaign ? "&utm_campaign=" + opts.utm_campaign : "");
  const invite = { id: randomUUID(), uid, code, link, clicks: 0, conversions: 0, createdAt: Date.now() };
  await getDb().collection("referrals").doc(invite.id).set(invite);
  await getDb().collection("owners").doc(uid).update({ referralCode: code });
  return invite;
}

async function trackClick(code) {
  const snap = await getDb().collection("referrals").where("code", "==", code).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  await doc.ref.update({ clicks: (doc.data().clicks || 0) + 1 });
  return { code, clicked: true };
}

async function getReferralNetwork(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("referrals").where("uid", "==", uid).get();
  const nodes = [];
  snap.forEach(doc => { const d = doc.data(); nodes.push({ id: d.code, uid: d.uid, clicks: d.clicks, conversions: d.conversions }); });
  return { nodes, edges: [], total: nodes.length };
}

module.exports = { createInvite, trackClick, getReferralNetwork, generateReferralCode, __setFirestoreForTests };
