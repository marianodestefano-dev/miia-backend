'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const REVIEW_STARS = Object.freeze([1, 2, 3, 4, 5]);
const LISTING_TYPES = Object.freeze(['standard', 'featured', 'premium']);

async function searchBusinesses(query, opts) {
  opts = opts || {};
  const limit = opts.limit || 10;
  const category = opts.category;
  let ref = getDb().collection('network_directory');
  if (category) ref = ref.where('category', '==', category);
  const snap = await ref.get();
  const results = [];
  snap.forEach(doc => {
    const d = doc.data();
    const text = (d.name + ' ' + (d.description || '')).toLowerCase();
    if (!query || text.includes(query.toLowerCase())) results.push({ id: doc.id, ...d });
  });
  return results.slice(0, limit);
}

async function addReview(businessId, opts) {
  const { uid, stars, text } = opts;
  if (!REVIEW_STARS.includes(stars)) throw new Error('Stars must be 1-5');
  const review = { id: randomUUID(), uid, stars, text, createdAt: new Date().toISOString() };
  await getDb().collection('network_directory').doc(businessId).collection('reviews').doc(review.id).set(review);
  return review;
}

async function setFeaturedListing(uid, businessId, opts) {
  opts = opts || {};
  const listingType = opts.listingType || 'featured';
  if (!LISTING_TYPES.includes(listingType)) throw new Error('Invalid listing type');
  const data = { uid, businessId, listingType, expiresAt: opts.expiresAt || null, createdAt: new Date().toISOString() };
  await getDb().collection('featured_listings').doc(businessId).set(data, { merge: true });
  return data;
}

async function suggestComplementaryBusinesses(uid, leadMessage) {
  const snap = await getDb().collection('network_directory').get();
  const businesses = [];
  snap.forEach(doc => businesses.push({ id: doc.id, ...doc.data() }));
  const keywords = (leadMessage || '').toLowerCase().split(/\s+/);
  const scored = businesses
    .map(b => { const desc = (b.name + ' ' + (b.description || '') + ' ' + (b.category || '')).toLowerCase(); const score = keywords.filter(k => k.length > 3 && desc.includes(k)).length; return { ...b, score }; })
    .filter(b => b.score > 0 && b.uid !== uid);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3);
}

async function getBusinessReviews(businessId) {
  const snap = await getDb().collection('network_directory').doc(businessId).collection('reviews').get();
  const reviews = [];
  snap.forEach(doc => reviews.push(doc.data()));
  return reviews;
}

module.exports = { __setFirestoreForTests, REVIEW_STARS, LISTING_TYPES,
  searchBusinesses, addReview, setFeaturedListing, suggestComplementaryBusinesses, getBusinessReviews };