"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const ROLES = Object.freeze({ ADMIN: "admin", AGENT: "agent", READONLY: "readonly" });
const MAX_USERS_FREE = 1;

async function addUser(ownerUid, newUserEmail, role) {
  if (!ownerUid || !newUserEmail || !role) throw new Error("ownerUid, email, role required");
  if (!Object.values(ROLES).includes(role)) throw new Error("invalid role: " + role);
  const user = { id: randomUUID(), ownerUid, email: newUserEmail, role, active: true, addedAt: Date.now() };
  await getDb().collection("team_users").doc(user.id).set(user);
  return user;
}

async function listUsers(ownerUid) {
  if (!ownerUid) throw new Error("ownerUid required");
  const snap = await getDb().collection("team_users").where("ownerUid", "==", ownerUid).where("active", "==", true).get();
  const users = [];
  snap.forEach(doc => users.push(doc.data()));
  return users;
}

async function updateUserRole(userId, newRole) {
  if (!userId || !newRole) throw new Error("userId and newRole required");
  if (!Object.values(ROLES).includes(newRole)) throw new Error("invalid role: " + newRole);
  await getDb().collection("team_users").doc(userId).update({ role: newRole });
  return { userId, role: newRole };
}

async function removeUser(userId) {
  if (!userId) throw new Error("userId required");
  await getDb().collection("team_users").doc(userId).update({ active: false, removedAt: Date.now() });
  return { userId, active: false };
}

module.exports = { addUser, listUsers, updateUserRole, removeUser, ROLES, __setFirestoreForTests };
