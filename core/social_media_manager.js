'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const SOCIAL_PLATFORMS = Object.freeze(['instagram', 'facebook', 'twitter', 'tiktok', 'linkedin']);
const POST_STATUS = Object.freeze(['draft', 'scheduled', 'published', 'failed']);
const DM_STATUS = Object.freeze(['received', 'processing', 'replied', 'escalated']);

async function registerSocialAccount(uid, platform, opts) {
  if (!SOCIAL_PLATFORMS.includes(platform)) throw new Error('Unsupported platform: ' + platform);
  const account = { id: randomUUID(), uid, platform, pageId: opts.pageId || null, accessToken: opts.accessToken ? '[REDACTED]' : null, status: 'active', registeredAt: new Date().toISOString() };
  await getDb().collection('social_accounts').doc(uid + '_' + platform).set(account, { merge: true });
  return account;
}

async function receiveDM(uid, platform, opts) {
  if (!SOCIAL_PLATFORMS.includes(platform)) throw new Error('Unsupported platform: ' + platform);
  const dm = { id: randomUUID(), uid, platform, senderId: opts.senderId, message: opts.message, status: 'received', receivedAt: new Date().toISOString() };
  await getDb().collection('social_dms').doc(dm.id).set(dm);
  return dm;
}

async function replyToDM(uid, dmId, replyText) {
  const ref = getDb().collection('social_dms').doc(dmId);
  await ref.set({ status: 'replied', reply: replyText, repliedAt: new Date().toISOString() }, { merge: true });
  return { dmId, status: 'replied', reply: replyText };
}

async function schedulePost(uid, platform, opts) {
  if (!SOCIAL_PLATFORMS.includes(platform)) throw new Error('Unsupported platform: ' + platform);
  const post = { id: randomUUID(), uid, platform, content: opts.content, mediaUrl: opts.mediaUrl || null, scheduledAt: opts.scheduledAt, status: 'scheduled', createdAt: new Date().toISOString() };
  await getDb().collection('scheduled_posts').doc(post.id).set(post);
  return post;
}

async function getScheduledPosts(uid, platform) {
  const snap = await getDb().collection('scheduled_posts').where('uid', '==', uid).get();
  const posts = [];
  snap.forEach(doc => { const d = doc.data(); if (!platform || d.platform === platform) posts.push(d); });
  return posts;
}

async function getInboxDMs(uid, platform) {
  const snap = await getDb().collection('social_dms').where('uid', '==', uid).get();
  const dms = [];
  snap.forEach(doc => { const d = doc.data(); if (!platform || d.platform === platform) dms.push(d); });
  return dms;
}

module.exports = { __setFirestoreForTests, SOCIAL_PLATFORMS, POST_STATUS, DM_STATUS,
  registerSocialAccount, receiveDM, replyToDM, schedulePost, getScheduledPosts, getInboxDMs };