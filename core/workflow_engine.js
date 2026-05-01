"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const TRIGGER_TYPES = Object.freeze(["lead_no_response_48h", "lead_new", "booking_confirmed", "payment_received"]);
const ACTION_TYPES = Object.freeze(["send_message", "send_template", "add_tag", "notify_owner"]);

async function createWorkflow(uid, opts) {
  const { name, trigger, action, delayHours } = opts || {};
  if (!uid || !name || !trigger || !action) throw new Error("uid, name, trigger, action required");
  if (!TRIGGER_TYPES.includes(trigger)) throw new Error("invalid trigger: " + trigger);
  if (!ACTION_TYPES.includes(action.type)) throw new Error("invalid action type: " + action.type);
  const workflow = {
    id: randomUUID(), uid, name, trigger, action,
    delayHours: delayHours || 48,
    active: true, createdAt: Date.now(),
  };
  await getDb().collection("workflows").doc(workflow.id).set(workflow);
  return workflow;
}

async function checkTriggers(uid) {
  if (!uid) throw new Error("uid required");
  const snap = await getDb().collection("workflows").where("uid", "==", uid).where("active", "==", true).get();
  const active = [];
  snap.forEach(doc => active.push(doc.data()));
  return { uid, activeWorkflows: active.length, workflows: active };
}

async function executeWorkflow(workflowId, context) {
  if (!workflowId) throw new Error("workflowId required");
  const snap = await getDb().collection("workflows").doc(workflowId).get();
  if (!snap.exists) throw new Error("workflow not found: " + workflowId);
  const wf = snap.data();
  const execution = { id: randomUUID(), workflowId, context: context || {}, executedAt: Date.now(), status: "executed" };
  await getDb().collection("workflow_executions").doc(execution.id).set(execution);
  return execution;
}

module.exports = { createWorkflow, checkTriggers, executeWorkflow, TRIGGER_TYPES, ACTION_TYPES, __setFirestoreForTests };
