'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const DISPLAY_MODES = Object.freeze(['tv_status', 'kiosk_pos', 'dashboard_live', 'screensaver']);
const VISION_MILESTONES = Object.freeze([
  { id: 'M1', target: 1000, label: '1K negocios MIIA' },
  { id: 'M2', target: 10000, label: '10K negocios MIIA' },
  { id: 'M3', target: 100000, label: '100K negocios MIIA - Lider regional' },
  { id: 'M4', target: 500000, label: '500K negocios MIIA - Expansion continental' },
  { id: 'M5', target: 1000000, label: '1 MILLON negocios MIIA en LATAM - VISION CUMPLIDA' },
]);

async function createTVDisplay(uid, opts) {
  const mode = opts.mode || 'tv_status';
  if (!DISPLAY_MODES.includes(mode)) throw new Error('Invalid display mode: ' + mode);
  const display = { id: randomUUID(), uid, mode, title: opts.title || 'MIIA Business Status', refreshIntervalSeconds: opts.refreshIntervalSeconds || 30, widgets: opts.widgets || ['messages_today', 'leads_active', 'bookings_today'], createdAt: new Date().toISOString() };
  await getDb().collection('displays').doc(display.id).set(display);
  return display;
}

async function createKioskConfig(uid, opts) {
  const kiosk = { id: randomUUID(), uid, mode: 'kiosk_pos', touchEnabled: true, catalogEnabled: opts.catalogEnabled !== false, bookingEnabled: opts.bookingEnabled !== false, paymentEnabled: opts.paymentEnabled !== false, language: opts.language || 'es', theme: opts.theme || 'miia_default', createdAt: new Date().toISOString() };
  await getDb().collection('kiosk_configs').doc(uid).set(kiosk, { merge: true });
  return kiosk;
}

async function getLiveBusinessStatus(uid) {
  const doc = await getDb().collection('owners').doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  return { uid, businessName: data.business_name || 'Mi Negocio', isOpen: data.is_open !== false, activeLeads: data.active_leads || 0, messagesToday: data.messages_today || 0, bookingsToday: data.bookings_today || 0, updatedAt: new Date().toISOString() };
}

function getVisionProgress(currentBusinesses) {
  const completed = VISION_MILESTONES.filter(m => currentBusinesses >= m.target);
  const next = VISION_MILESTONES.find(m => currentBusinesses < m.target);
  const pct = next ? Math.round((currentBusinesses / next.target) * 100) : 100;
  return { currentBusinesses, completedMilestones: completed.length, nextMilestone: next || null, progressPercent: pct, visionComplete: currentBusinesses >= 1000000 };
}

function getMIIAOSSummary() {
  return {
    productName: 'MIIA OS',
    vision: 'El sistema operativo del negocio pequeno latinoamericano',
    targetYear: 2028,
    targetMarket: 'LATAM',
    targetBusinesses: 1000000,
    pillars: ['whatsapp_first', 'ia_propia', 'latam_native', 'zero_code', 'affordable'],
    currentVersion: '2.0',
  };
}

async function recordBusinessCount(count) {
  const entry = { id: randomUUID(), count, recordedAt: new Date().toISOString() };
  await getDb().collection('business_count_history').doc(entry.id).set(entry);
  return { ...entry, progress: getVisionProgress(count) };
}

module.exports = { __setFirestoreForTests, DISPLAY_MODES, VISION_MILESTONES,
  createTVDisplay, createKioskConfig, getLiveBusinessStatus, getVisionProgress, getMIIAOSSummary, recordBusinessCount };