'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const MIIA_ID_STATUS = Object.freeze(['active', 'suspended', 'deleted']);

async function createMiiaId(phone, opts) {
  const existing = await getDb().collection('miia_ids').where('phone', '==', phone).get();
  let existingDoc = null;
  existing.forEach(d => { if (!existingDoc) existingDoc = d; });
  if (existingDoc) return { id: existingDoc.id, ...existingDoc.data(), alreadyExists: true };
  const miiaId = { id: randomUUID(), phone, name: opts.name || null, email: opts.email || null, status: 'active', authorizedOwners: [], createdAt: new Date().toISOString() };
  await getDb().collection('miia_ids').doc(miiaId.id).set(miiaId);
  return miiaId;
}

async function getMiiaProfile(miiaId) {
  const doc = await getDb().collection('miia_ids').doc(miiaId).get();
  if (!doc.exists) throw new Error('MIIA ID not found: ' + miiaId);
  return doc.data();
}

async function authorizeProfileShare(miiaId, targetUid) {
  const ref = getDb().collection('miia_ids').doc(miiaId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('MIIA ID not found: ' + miiaId);
  const data = doc.data();
  const authorized = data.authorizedOwners || [];
  if (!authorized.includes(targetUid)) authorized.push(targetUid);
  await ref.set({ authorizedOwners: authorized }, { merge: true });
  return { miiaId, targetUid, authorized: true };
}

async function linkOwnerToMiiaId(uid, miiaId) {
  const link = { uid, miiaId, linkedAt: new Date().toISOString() };
  await getDb().collection('owner_miia_id_links').doc(uid).set(link, { merge: true });
  return link;
}

function getSSOToken(uid) {
  const payload = { uid, issuedAt: Date.now(), expiresIn: 3600 };
  const token = Buffer.from(JSON.stringify(payload)).toString('base64');
  return { uid, token, expiresIn: 3600 };
}

module.exports = { __setFirestoreForTests, MIIA_ID_STATUS,
  createMiiaId, getMiiaProfile, authorizeProfileShare, linkOwnerToMiiaId, getSSOToken };