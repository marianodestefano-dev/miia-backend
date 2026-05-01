"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SLA_CONTACT_TYPES = Object.freeze(["lead", "client", "enterprise_lead", "vip"]);

const DEFAULT_SLA = Object.freeze({
  first_response_minutes: 30,
  resolution_hours: 24,
  escalation_minutes: 60,
});

async function setSLA(uid, contactType, slaOpts) {
  if (!uid || !contactType) throw new Error("uid and contactType required");
  if (!SLA_CONTACT_TYPES.includes(contactType)) throw new Error("invalid contactType: " + contactType);
  const sla = {
    uid, contactType,
    first_response_minutes: (slaOpts && slaOpts.first_response_minutes) || DEFAULT_SLA.first_response_minutes,
    resolution_hours: (slaOpts && slaOpts.resolution_hours) || DEFAULT_SLA.resolution_hours,
    escalation_minutes: (slaOpts && slaOpts.escalation_minutes) || DEFAULT_SLA.escalation_minutes,
    updatedAt: Date.now(),
  };
  await getDb().collection("sla_configs").doc(uid + "_" + contactType).set(sla);
  return sla;
}

async function getSLA(uid, contactType) {
  if (!uid || !contactType) throw new Error("uid and contactType required");
  const snap = await getDb().collection("sla_configs").doc(uid + "_" + contactType).get();
  if (!snap.exists) return { ...DEFAULT_SLA, uid, contactType, isDefault: true };
  return snap.data();
}

function checkSLABreach(sla, messageTimestamp) {
  if (!sla || !messageTimestamp) throw new Error("sla and messageTimestamp required");
  const elapsedMinutes = (Date.now() - messageTimestamp) / 60000;
  const breached = elapsedMinutes > sla.first_response_minutes;
  const escalate = elapsedMinutes > sla.escalation_minutes;
  return { breached, escalate, elapsedMinutes: parseFloat(elapsedMinutes.toFixed(1)) };
}

module.exports = { setSLA, getSLA, checkSLABreach, SLA_CONTACT_TYPES, DEFAULT_SLA, __setFirestoreForTests };
