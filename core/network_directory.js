"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const BUSINESS_CATEGORIES = Object.freeze([
  "salud", "educacion", "comercio", "gastronomia", "servicios", "belleza",
  "tecnologia", "construccion", "entretenimiento", "otro",
]);

async function registerBusiness(uid, opts) {
  const { name, category, description, location, phone } = opts || {};
  if (!uid || !name || !category) throw new Error("uid, name, category required");
  if (!BUSINESS_CATEGORIES.includes(category)) throw new Error("invalid category: " + category);
  const entry = {
    uid, name, category,
    description: description || "",
    location: location || null,
    phone: phone || null,
    visible: true,
    registeredAt: Date.now(),
  };
  await getDb().collection("business_directory").doc(uid).set(entry);
  return entry;
}

async function searchDirectory(query, category) {
  const snap = await getDb().collection("business_directory").where("visible", "==", true).get();
  let results = [];
  snap.forEach(doc => results.push(doc.data()));
  if (category) results = results.filter(b => b.category === category);
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(b =>
      b.name.toLowerCase().includes(q) ||
      (b.description || "").toLowerCase().includes(q)
    );
  }
  return results;
}

async function recommendBusiness(uid, leadMessage) {
  if (!uid || !leadMessage) throw new Error("uid and leadMessage required");
  const snap = await getDb().collection("business_directory").where("visible", "==", true).get();
  const businesses = [];
  snap.forEach(doc => { const d = doc.data(); if (d.uid !== uid) businesses.push(d); });
  const lower = leadMessage.toLowerCase();
  const match = businesses.find(b =>
    lower.includes(b.category) || lower.includes(b.name.toLowerCase())
  );
  return match || null;
}

module.exports = { registerBusiness, searchDirectory, recommendBusiness, BUSINESS_CATEGORIES, __setFirestoreForTests };
