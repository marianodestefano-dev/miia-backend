"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const DEFAULT_BRAND = Object.freeze({
  name: "MIIA",
  primaryColor: "#25D366",
  secondaryColor: "#128C7E",
  logoUrl: null,
  font: "Inter",
});

async function setBrandConfig(uid, config) {
  if (!uid) throw new Error("uid required");
  const brand = {
    name: config.name || DEFAULT_BRAND.name,
    primaryColor: config.primaryColor || DEFAULT_BRAND.primaryColor,
    secondaryColor: config.secondaryColor || DEFAULT_BRAND.secondaryColor,
    logoUrl: config.logoUrl || null,
    font: config.font || DEFAULT_BRAND.font,
    updatedAt: Date.now(),
  };
  await getDb().collection("owners").doc(uid).update({ brand });
  return brand;
}

async function getBrandConfig(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("owners").doc(uid).get();
  if (!snap.exists) return { ...DEFAULT_BRAND };
  return snap.data().brand || { ...DEFAULT_BRAND };
}

function getAssistantName(brand) {
  return (brand && brand.name) || DEFAULT_BRAND.name;
}

module.exports = { setBrandConfig, getBrandConfig, getAssistantName, DEFAULT_BRAND, __setFirestoreForTests };
