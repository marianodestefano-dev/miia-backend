"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const SOCIAL_PLATFORMS = Object.freeze(["twitter", "instagram", "facebook", "tiktok"]);

async function registerMentionWebhook(uid, opts) {
  const { platform, keywords, webhookUrl } = opts || {};
  if (!uid || !platform || !webhookUrl) throw new Error("uid, platform, webhookUrl required");
  if (!SOCIAL_PLATFORMS.includes(platform)) throw new Error("invalid platform: " + platform);
  const config = {
    id: randomUUID(), uid, platform,
    keywords: keywords || [],
    webhookUrl, active: true,
    registeredAt: Date.now(),
  };
  await getDb().collection("social_webhooks").doc(uid + "_" + platform).set(config);
  return config;
}

async function processMention(uid, mention) {
  if (!uid || !mention) throw new Error("uid and mention required");
  const record = {
    id: randomUUID(), uid,
    platform: mention.platform || "unknown",
    author: mention.author || "anonymous",
    text: mention.text || "",
    sentiment: mention.sentiment || "neutral",
    processedAt: Date.now(),
  };
  await getDb().collection("social_mentions").doc(record.id).set(record);
  return record;
}

async function getMentionStats(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("social_mentions").where("uid", "==", uid).get();
  const mentions = [];
  snap.forEach(doc => mentions.push(doc.data()));
  const byPlatform = {};
  const bySentiment = { positive: 0, neutral: 0, negative: 0 };
  mentions.forEach(m => {
    byPlatform[m.platform] = (byPlatform[m.platform] || 0) + 1;
    if (bySentiment[m.sentiment] !== undefined) bySentiment[m.sentiment]++;
  });
  return { uid, total: mentions.length, byPlatform, bySentiment };
}

module.exports = { registerMentionWebhook, processMention, getMentionStats, SOCIAL_PLATFORMS, __setFirestoreForTests };
