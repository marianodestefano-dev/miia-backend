'use strict';
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }
const { randomUUID } = require("crypto");

async function createTemplate(uid, opts = {}) {
  const { name, content, variables = [], category = "general" } = opts;
  if (!uid) throw new Error("uid required");
  if (!name) throw new Error("name required");
  if (!content) throw new Error("content required");
  const id = randomUUID();
  const template = { id, uid, name, content, variables, category, use_count: 0, last_used: null, createdAt: Date.now() };
  await getDb().collection("templates").doc(id).set(template);
  return template;
}

function renderTemplate(template, vars = {}) {
  if (!template || !template.content) throw new Error("invalid template");
  let rendered = template.content;
  Object.entries(vars).forEach(([k, v]) => {
    rendered = rendered.replace(new RegExp("\{" + k + "\}", "g"), v);
  });
  return rendered;
}

function validateTemplate(content) {
  if (!content) return { valid: false, errors: ["content required"] };
  const opens = (content.match(/\{/g) || []).length;
  const closes = (content.match(/\}/g) || []).length;
  if (opens !== closes) return { valid: false, errors: ["unbalanced_braces"] };
  const variables = (content.match(/\{(\w+)\}/g) || []).map(v => v.slice(1, -1));
  return { valid: true, variables };
}

async function listTemplates(uid, category) {
  if (!uid) throw new Error("uid required");
  const col = getDb().collection("templates");
  let q = col.where("uid", "==", uid);
  if (category) q = q.where("category", "==", category);
  const snap = await q.get();
  const templates = [];
  snap.forEach(doc => templates.push(doc.data()));
  return templates;
}

async function useTemplate(uid, templateId) {
  if (!uid || !templateId) throw new Error("uid and templateId required");
  const ref = getDb().collection("templates").doc(templateId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("template_not_found");
  const data = snap.data();
  if (data.uid !== uid) throw new Error("unauthorized");
  const updated = Object.assign({}, data, { use_count: (data.use_count || 0) + 1, last_used: Date.now() });
  await ref.set(updated);
  return updated;
}

module.exports = { createTemplate, renderTemplate, validateTemplate, listTemplates, useTemplate, __setFirestoreForTests };
