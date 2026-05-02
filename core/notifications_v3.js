'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const NOTIFICATION_CHANNELS = Object.freeze(['whatsapp', 'email', 'push_web']);
const AB_TEST_STATUS = Object.freeze(['active', 'paused', 'completed']);

async function sendMultiChannel(uid, phone, message, channels) {
  const invalid = channels.filter(c => !NOTIFICATION_CHANNELS.includes(c));
  if (invalid.length > 0) throw new Error('Invalid channels: ' + invalid.join(', '));
  const results = channels.map(channel => ({ channel, status: 'queued', messageId: randomUUID() }));
  const batch = { id: randomUUID(), uid, phone, message, channels: results, sentAt: new Date().toISOString() };
  await getDb().collection('notification_batches').doc(batch.id).set(batch);
  return batch;
}

async function createABTest(uid, opts) {
  const { variants, targetSegment } = opts;
  if (!variants || variants.length < 2) throw new Error('Need at least 2 variants');
  const test = { id: randomUUID(), uid, variants: variants.map((v, i) => ({ ...v, index: i, sends: 0, opens: 0 })), targetSegment: targetSegment || 'all', status: 'active', createdAt: new Date().toISOString() };
  await getDb().collection('ab_tests').doc(test.id).set(test);
  return test;
}

async function recordABResult(testId, variant, opened) {
  const ref = getDb().collection('ab_tests').doc(testId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('AB test not found: ' + testId);
  const data = doc.data();
  const updatedVariants = data.variants.map(v => {
    if (v.index === variant) return { ...v, sends: (v.sends || 0) + 1, opens: opened ? (v.opens || 0) + 1 : (v.opens || 0) };
    return v;
  });
  await ref.set({ variants: updatedVariants }, { merge: true });
  return { testId, variant, opened };
}

async function getPredictiveSendTime(uid, phone) {
  const snap = await getDb().collection('notification_batches').where('uid', '==', uid).get();
  const hours = [];
  snap.forEach(doc => { const d = doc.data(); if (d.phone === phone && d.sentAt) hours.push(new Date(d.sentAt).getUTCHours()); });
  if (hours.length === 0) return { hour: 10, timezone: 'America/Bogota', source: 'default' };
  const avg = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
  return { hour: avg, timezone: 'America/Bogota', source: 'historical' };
}

async function scheduleNotification(uid, phone, message, sendAtISO, channels) {
  const n = { id: randomUUID(), uid, phone, message, channels: channels || ['whatsapp'], scheduledAt: sendAtISO, status: 'scheduled', createdAt: new Date().toISOString() };
  await getDb().collection('scheduled_notifications').doc(n.id).set(n);
  return n;
}

module.exports = { __setFirestoreForTests, NOTIFICATION_CHANNELS, AB_TEST_STATUS,
  sendMultiChannel, createABTest, recordABResult, getPredictiveSendTime, scheduleNotification };