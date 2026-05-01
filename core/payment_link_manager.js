'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }
const { randomUUID } = require("crypto");

async function generatePaymentLink(uid, opts = {}) {
  const { amount, currency, description, phone } = opts;
  if (!uid) throw new Error("uid required");
  if (!amount || amount <= 0) throw new Error("amount must be positive");
  if (!currency) throw new Error("currency required");
  const linkId = randomUUID();
  const link = { id: linkId, uid, amount, currency, description: description || "", phone: phone || null, status: "pending", click_count: 0, createdAt: Date.now(), paidAt: null, url: "https://pay.miia-app.com/p/" + linkId };
  await getDb().collection("payment_links").doc(linkId).set(link);
  return link;
}

async function trackPaymentClick(linkId) {
  if (!linkId) throw new Error("linkId required");
  const ref = getDb().collection("payment_links").doc(linkId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("link_not_found");
  const data = snap.data();
  const updated = Object.assign({}, data, { click_count: (data.click_count || 0) + 1 });
  await ref.set(updated);
  return updated;
}

async function markPaymentPaid(linkId, paymentData) {
  if (!linkId) throw new Error("linkId required");
  const ref = getDb().collection("payment_links").doc(linkId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("link_not_found");
  const data = snap.data();
  if (data.status === "paid") throw new Error("already_paid");
  const updated = Object.assign({}, data, { status: "paid", paidAt: Date.now(), paymentData: paymentData || {} });
  await ref.set(updated);
  return updated;
}

async function listPaymentLinks(uid, opts = {}) {
  if (!uid) throw new Error("uid required");
  const { status } = opts;
  const col = getDb().collection("payment_links");
  let q = col.where("uid", "==", uid);
  if (status) q = q.where("status", "==", status);
  const snap = await q.get();
  const links = [];
  snap.forEach(doc => links.push(doc.data()));
  return links;
}

function buildWhatsAppMessage(link) {
  if (!link || !link.url) throw new Error("invalid link");
  const sym = link.currency === "ARS" ? "$" : link.currency === "USD" ? "US$" : link.currency;
  return "Link de pago - Monto: " + sym + " " + link.amount + " - Paga aqui: " + link.url;
}

module.exports = { generatePaymentLink, trackPaymentClick, markPaymentPaid, listPaymentLinks, buildWhatsAppMessage, __setFirestoreForTests };
