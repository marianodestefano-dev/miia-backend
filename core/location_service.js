"use strict";
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

async function setBusinessLocation(uid, opts) {
  const { address, city, country, lat, lng, googleMapsUrl } = opts || {};
  if (!uid || !address) throw new Error("uid and address required");
  const location = {
    uid, address, city: city || null, country: country || "CO",
    lat: lat || null, lng: lng || null,
    googleMapsUrl: googleMapsUrl || null,
    updatedAt: Date.now(),
  };
  await getDb().collection("business_locations").doc(uid).set(location);
  return location;
}

async function getBusinessLocation(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("business_locations").doc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

function buildLocationMessage(location) {
  if (!location) return "No tenemos ubicacion registrada.";
  let msg = "Estamos ubicados en: " + location.address;
  if (location.city) msg += ", " + location.city;
  if (location.googleMapsUrl) msg += "\nMapa: " + location.googleMapsUrl;
  return msg;
}

function buildMapsLink(lat, lng, label) {
  if (!lat || !lng) return null;
  const encodedLabel = encodeURIComponent(label || "Ubicacion");
  return "https://maps.google.com/?q=" + lat + "," + lng + "&label=" + encodedLabel;
}

module.exports = { setBusinessLocation, getBusinessLocation, buildLocationMessage, buildMapsLink, __setFirestoreForTests };
