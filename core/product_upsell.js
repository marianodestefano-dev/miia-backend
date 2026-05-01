'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const UPSELL_SIGNALS = Object.freeze([
  'quiero mas', 'tienen otro', 'algo adicional', 'complemento', 'combo',
  'tambien', 'ademas', 'junto con', 'paquete', 'pack',
]);

function detectUpsellOpportunity(message, catalog = []) {
  if (!message) return { triggered: false, suggestedProducts: [] };
  const msgLower = message.toLowerCase();
  const triggered = UPSELL_SIGNALS.some(signal => msgLower.includes(signal));
  if (!triggered) return { triggered: false, suggestedProducts: [] };
  const suggestedProducts = catalog.slice(0, 3);
  return { triggered: true, suggestedProducts };
}

function buildUpsellPrompt(products) {
  if (!products || products.length === 0) return "";
  const NL = String.fromCharCode(10);
  const list = products.map(p => "- " + (p.name || p) + (p.price ? " ($" + p.price + ")" : "")).join(NL);
  return "Tambien te puede interesar:" + NL + list;
}

async function logUpsellTrigger(uid, phone, productIds) {
  if (!uid || !phone) throw new Error("uid and phone required");
  const docId = uid + "_" + phone + "_" + Date.now();
  await getDb().collection("upsell_triggers").doc(docId).set({
    uid, phone, productIds: productIds || [], timestamp: Date.now(),
  });
}

module.exports = { UPSELL_SIGNALS, detectUpsellOpportunity, buildUpsellPrompt, logUpsellTrigger, __setFirestoreForTests };
