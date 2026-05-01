"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function createCampaign(uid, opts) {
  const { name, steps } = opts || {};
  if (!uid || !name || !Array.isArray(steps) || steps.length === 0) throw new Error("uid, name, steps required");
  steps.forEach((s, i) => { if (!s.message || typeof s.delayDays !== "number") throw new Error("step " + i + " needs message and delayDays"); });
  const campaign = { id: randomUUID(), uid, name, steps, active: true, enrolledCount: 0, createdAt: Date.now() };
  await getDb().collection("drip_campaigns").doc(campaign.id).set(campaign);
  return campaign;
}

async function enrollContact(campaignId, phone) {
  if (!campaignId || !phone) throw new Error("campaignId and phone required");
  const snap = await getDb().collection("drip_campaigns").doc(campaignId).get();
  if (!snap.exists) throw new Error("campaign not found");
  const enrollment = { id: campaignId + "_" + phone, campaignId, phone, currentStep: 0, optedOut: false, enrolledAt: Date.now() };
  await getDb().collection("drip_enrollments").doc(enrollment.id).set(enrollment);
  await snap.ref.update({ enrolledCount: (snap.data().enrolledCount || 0) + 1 });
  return enrollment;
}

async function optOut(campaignId, phone) {
  if (!campaignId || !phone) throw new Error("campaignId and phone required");
  const id = campaignId + "_" + phone;
  await getDb().collection("drip_enrollments").doc(id).update({ optedOut: true, optedOutAt: Date.now() });
  return { campaignId, phone, optedOut: true };
}

module.exports = { createCampaign, enrollContact, optOut, __setFirestoreForTests };
