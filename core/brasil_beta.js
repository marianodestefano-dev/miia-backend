"use strict";
const { randomUUID } = require("crypto");

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const BRASIL_REGIONS = Object.freeze(["SP", "RJ", "MG", "RS", "BA", "PR", "PE", "CE", "GO", "DF"]);
const BETA_STATUS = Object.freeze(["applicant", "approved", "active", "graduated", "rejected"]);
const BETA_MAX_TESTERS = 100;

function buildBrasilWelcome(name, region) {
  const regionLabel = BRASIL_REGIONS.includes(region) ? region : "BR";
  return "Ola " + (name || "parceiro") + "! Bem-vindo ao MIIA Brasil " + regionLabel + ". Vamos transformar seu negocio!";
}

async function registerBetaTester(opts) {
  opts = opts || {};
  if (!opts.phone) throw new Error("Phone required");
  if (!opts.businessName) throw new Error("Business name required");
  const region = opts.region && BRASIL_REGIONS.includes(opts.region) ? opts.region : "SP";
  const tester = { id: randomUUID(), phone: opts.phone, businessName: opts.businessName, region, language: "pt-BR", status: "applicant", registeredAt: new Date().toISOString(), notes: opts.notes || null };
  await getDb().collection("brasil_beta").doc(tester.id).set(tester);
  return tester;
}

async function approveBetaTester(testerId) {
  const doc = await getDb().collection("brasil_beta").doc(testerId).get();
  if (!doc.exists) throw new Error("Tester not found: " + testerId);
  const snap = await getDb().collection("brasil_beta").where("status", "==", "active").get();
  if (snap.size >= BETA_MAX_TESTERS) throw new Error("Beta program full (" + BETA_MAX_TESTERS + " testers max)");
  await getDb().collection("brasil_beta").doc(testerId).set({ status: "approved", approvedAt: new Date().toISOString() }, { merge: true });
  return { testerId, status: "approved" };
}

async function activateBetaTester(testerId) {
  await getDb().collection("brasil_beta").doc(testerId).set({ status: "active", activatedAt: new Date().toISOString() }, { merge: true });
  return { testerId, status: "active" };
}

async function getBetaStats() {
  const snap = await getDb().collection("brasil_beta").get();
  const stats = {};
  BETA_STATUS.forEach(s => { stats[s] = 0; });
  snap.forEach(doc => { const d = doc.data(); if (stats[d.status] !== undefined) stats[d.status]++; });
  return { total: snap.size, byStatus: stats, maxTesters: BETA_MAX_TESTERS, isFull: (stats.active || 0) >= BETA_MAX_TESTERS };
}

async function graduateTester(testerId) {
  await getDb().collection("brasil_beta").doc(testerId).set({ status: "graduated", graduatedAt: new Date().toISOString() }, { merge: true });
  return { testerId, status: "graduated" };
}

module.exports = { __setFirestoreForTests, BRASIL_REGIONS, BETA_STATUS, BETA_MAX_TESTERS,
  buildBrasilWelcome, registerBetaTester, approveBetaTester, activateBetaTester, getBetaStats, graduateTester };
