"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const OFFER_STATUS = Object.freeze(["active", "paused", "expired", "sold_out"]);

async function createOffer(uid, opts) {
  const { title, description, price, currency, expiresAt } = opts || {};
  if (!uid || !title || price === undefined) throw new Error("uid, title, price required");
  const offer = {
    id: randomUUID(), uid, title,
    description: description || "",
    price, currency: currency || "COP",
    status: "active",
    expiresAt: expiresAt || null,
    views: 0, inquiries: 0,
    createdAt: Date.now(),
  };
  await getDb().collection("marketplace_offers").doc(offer.id).set(offer);
  return offer;
}

async function listActiveOffers(category) {
  const snap = await getDb().collection("marketplace_offers").where("status", "==", "active").get();
  const offers = [];
  snap.forEach(doc => offers.push(doc.data()));
  return offers;
}

async function trackInquiry(offerId, leadPhone) {
  if (!offerId || !leadPhone) throw new Error("offerId and leadPhone required");
  const ref = getDb().collection("marketplace_offers").doc(offerId);
  await ref.update({ inquiries: 1, lastInquiryAt: Date.now() });
  return { offerId, leadPhone, recordedAt: Date.now() };
}

async function updateOfferStatus(uid, offerId, status) {
  if (!uid || !offerId || !status) throw new Error("uid, offerId, status required");
  if (!OFFER_STATUS.includes(status)) throw new Error("invalid status: " + status);
  await getDb().collection("marketplace_offers").doc(offerId).update({ status, updatedAt: Date.now() });
  return { offerId, status };
}

module.exports = { createOffer, listActiveOffers, trackInquiry, updateOfferStatus, OFFER_STATUS, __setFirestoreForTests };
