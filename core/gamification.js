"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const BADGES = Object.freeze({
  PRIMER_LEAD: { id: "primer_lead", name: "Primer Lead", description: "Primer cliente potencial captado" },
  CIEN_CONVERSAS: { id: "cien_conversas", name: "100 Conversaciones", description: "Cien conversaciones con leads" },
  TRES_MESES: { id: "tres_meses", name: "3 Meses Activo", description: "MIIA activa por 3 meses" },
  CINCO_VENTAS: { id: "cinco_ventas", name: "5 Ventas", description: "Cinco conversaciones convertidas" },
});

async function checkAndAwardBadges(uid) {
  if (!uid) throw new Error("uid required");
  const ownerDoc = await getDb().collection("owners").doc(uid).get();
  const owner = ownerDoc.exists ? ownerDoc.data() : {};
  const existing = owner.badges || [];
  const awarded = [];

  const leadsSnap = await getDb().collection("leads").where("uid", "==", uid).get();
  const leadCount = leadsSnap.docs ? leadsSnap.docs.length : 0;
  if (leadCount >= 1 && !existing.includes("primer_lead")) awarded.push(BADGES.PRIMER_LEAD);

  const convSnap = await getDb().collection("conversations").where("uid", "==", uid).get();
  const convCount = convSnap.docs ? convSnap.docs.length : 0;
  if (convCount >= 100 && !existing.includes("cien_conversas")) awarded.push(BADGES.CIEN_CONVERSAS);

  const createdAt = owner.createdAt || Date.now();
  const monthsActive = (Date.now() - createdAt) / (30 * 24 * 60 * 60 * 1000);
  if (monthsActive >= 3 && !existing.includes("tres_meses")) awarded.push(BADGES.TRES_MESES);

  if (awarded.length > 0) {
    await getDb().collection("owners").doc(uid).update({ badges: [...existing, ...awarded.map(b => b.id)] });
  }
  return { uid, awarded, total: existing.length + awarded.length };
}

async function getOwnerBadges(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("owners").doc(uid).get();
  const badgeIds = snap.exists ? (snap.data().badges || []) : [];
  const badges = badgeIds.map(id => Object.values(BADGES).find(b => b.id === id) || { id, name: id });
  return { uid, badges, count: badges.length };
}

module.exports = { checkAndAwardBadges, getOwnerBadges, BADGES, __setFirestoreForTests };
