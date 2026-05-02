"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ADDON_IDS = Object.freeze(["ludo_miia", "miia_dt"]);
const ADDON_CATALOG = Object.freeze({
  ludo_miia: { id: "ludo_miia", name: "LudoMIIA", description: "Juegos y gamificacion para tu negocio", priceUSD: 5, type: "web_app", url: "https://ludo.miia-app.com" },
  miia_dt: { id: "miia_dt", name: "MIIA DT", description: "Avisos automaticos WhatsApp por eventos", priceUSD: 5, type: "whatsapp_addon", url: "https://dt.miia-app.com" },
});

function getAddonCatalog() {
  return Object.values(ADDON_CATALOG);
}

async function getOwnerAddons(uid) {
  const snap = await getDb().collection("owner_addons").where("uid", "==", uid).get();
  const addons = {};
  ADDON_IDS.forEach(id => { addons[id] = { id, active: false, activatedAt: null }; });
  snap.forEach(doc => { const d = doc.data(); if (addons[d.addonId]) addons[d.addonId] = d; });
  return addons;
}

async function buildDashboardExtrasSection(uid) {
  const ownerAddons = await getOwnerAddons(uid);
  const cards = ADDON_IDS.map(id => {
    const catalog = ADDON_CATALOG[id];
    const status = ownerAddons[id];
    return { id, name: catalog.name, description: catalog.description, priceUSD: catalog.priceUSD, active: status.active || false, activatedAt: status.activatedAt || null, url: status.active ? catalog.url : null };
  });
  return { uid, section: "extras", cards };
}

module.exports = { __setFirestoreForTests, ADDON_IDS, ADDON_CATALOG,
  getAddonCatalog, getOwnerAddons, buildDashboardExtrasSection };
