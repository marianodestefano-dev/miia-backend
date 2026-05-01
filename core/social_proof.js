"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const PROOF_TYPES = Object.freeze(["testimonial", "google_review", "star_rating"]);

async function addTestimonial(uid, opts) {
  const { authorName, authorPhone, text, rating, source } = opts || {};
  if (!uid || !text) throw new Error("uid and text required");
  const entry = {
    id: randomUUID(), uid,
    authorName: authorName || "Anonimo",
    authorPhone: authorPhone || null,
    text, rating: rating || 5,
    source: source || "direct",
    verified: false,
    active: true,
    createdAt: Date.now(),
  };
  await getDb().collection("social_proof").doc(entry.id).set(entry);
  return entry;
}

async function getTopTestimonials(uid, limit) {
  if (!uid) throw new Error("uid required");
  const n = limit || 3;
  const snap = await getDb().collection("social_proof").where("uid", "==", uid).where("active", "==", true).get();
  const entries = [];
  snap.forEach(doc => entries.push(doc.data()));
  return entries.sort((a, b) => b.rating - a.rating).slice(0, n);
}

async function syncGoogleReviews(uid, placeId) {
  if (!uid || !placeId) throw new Error("uid and placeId required");
  const stub = {
    uid, placeId,
    status: "synced_stub",
    reviewCount: 0,
    avgRating: 0,
    lastSyncAt: Date.now(),
    note: "Google Places API integration pending credentials",
  };
  await getDb().collection("google_reviews_config").doc(uid).set(stub);
  return stub;
}

function buildSocialProofSnippet(testimonials) {
  if (!testimonials || testimonials.length === 0) return "";
  return testimonials.map(t =>
    t.text + ' -- ' + t.authorName + ' (' + (t.rating || 5) + '/5)'
  ).join('\n');
}

module.exports = { addTestimonial, getTopTestimonials, syncGoogleReviews, buildSocialProofSnippet, PROOF_TYPES, __setFirestoreForTests };
