"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ADDON_IDS = Object.freeze(["ludo_miia", "miia_dt"]);
const ADDON_PRICE_USD = 5;
const PAYMENT_PROVIDERS = Object.freeze(["paddle", "mercadopago"]);
const PAYMENT_STATUS = Object.freeze(["pending", "completed", "failed", "refunded"]);

async function createAddonCheckout(uid, addonId, provider) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  if (!PAYMENT_PROVIDERS.includes(provider)) throw new Error("Invalid provider: " + provider);
  const checkout = { id: randomUUID(), uid, addonId, provider, amountUSD: ADDON_PRICE_USD, status: "pending", checkoutUrl: "https://checkout.miia-app.com/" + addonId + "/" + randomUUID(), createdAt: new Date().toISOString() };
  await getDb().collection("addon_checkouts").doc(checkout.id).set(checkout);
  return checkout;
}

async function confirmAddonPayment(uid, addonId, transactionId) {
  if (!ADDON_IDS.includes(addonId)) throw new Error("Invalid addon: " + addonId);
  const payment = { id: randomUUID(), uid, addonId, transactionId, amountUSD: ADDON_PRICE_USD, status: "completed", confirmedAt: new Date().toISOString() };
  await getDb().collection("addon_payments").doc(payment.id).set(payment);
  await getDb().collection("owner_addons").doc(uid + "_" + addonId).set({ uid, addonId, active: true, activatedAt: new Date().toISOString(), transactionId }, { merge: true });
  return { ...payment, addonActivated: true };
}

async function getAddonPaymentHistory(uid) {
  const snap = await getDb().collection("addon_payments").where("uid", "==", uid).get();
  const payments = [];
  snap.forEach(doc => payments.push(doc.data()));
  return payments;
}

module.exports = { __setFirestoreForTests, ADDON_IDS, ADDON_PRICE_USD, PAYMENT_PROVIDERS, PAYMENT_STATUS,
  createAddonCheckout, confirmAddonPayment, getAddonPaymentHistory };
