'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const ASSISTANT_TASK_TYPES = Object.freeze(['booking', 'stock_inquiry', 'appointment', 'quote_request', 'complaint', 'delivery_tracking']);
const TASK_STATUS = Object.freeze(['initiated', 'awaiting_response', 'pending_confirm', 'completed', 'failed']);

function buildAssistantIntro(ownerName, taskType) {
  const intros = {
    booking: 'Hola, soy asistente de ' + ownerName + ' y queria consultar disponibilidad para una reserva.',
    stock_inquiry: 'Hola, soy asistente de ' + ownerName + ' y queria consultar disponibilidad de productos.',
    appointment: 'Hola, soy asistente de ' + ownerName + ' y queria agendar un turno.',
    quote_request: 'Hola, soy asistente de ' + ownerName + ' y queria solicitar una cotizacion.',
    complaint: 'Hola, soy asistente de ' + ownerName + ' y queria reportar una situacion.',
    delivery_tracking: 'Hola, soy asistente de ' + ownerName + ' y queria consultar un envio.',
  };
  return intros[taskType] || 'Hola, soy asistente de ' + ownerName + '.';
}

async function initiateExternalTask(uid, opts) {
  const { externalBusiness, taskType, details, ownerName } = opts;
  if (!ASSISTANT_TASK_TYPES.includes(taskType)) throw new Error('Invalid task type: ' + taskType);
  const task = { id: randomUUID(), uid, externalBusiness, taskType, details: details || {}, ownerName: ownerName || 'el propietario', introMessage: buildAssistantIntro(ownerName || 'el propietario', taskType), status: 'initiated', requiresConfirmation: true, createdAt: new Date().toISOString(), completedAt: null };
  await getDb().collection('assistant_tasks').doc(task.id).set(task);
  return task;
}

async function confirmBeforeComplete(uid, taskId, summary) {
  const doc = await getDb().collection('assistant_tasks').doc(taskId).get();
  if (!doc.exists) throw new Error('Task not found: ' + taskId);
  if (doc.data().uid !== uid) throw new Error('Unauthorized');
  await getDb().collection('assistant_tasks').doc(taskId).set({ status: 'pending_confirm', summary, awaitingConfirmAt: new Date().toISOString() }, { merge: true });
  return { taskId, confirmationMessage: 'Antes de cerrar: ' + summary + '. Confirmas que todo quedo en orden?' };
}

async function markTaskCompleted(uid, taskId) {
  const doc = await getDb().collection('assistant_tasks').doc(taskId).get();
  if (!doc.exists) throw new Error('Task not found: ' + taskId);
  await getDb().collection('assistant_tasks').doc(taskId).set({ status: 'completed', completedAt: new Date().toISOString() }, { merge: true });
  return { taskId, status: 'completed' };
}

async function getExternalTasks(uid, status) {
  const snap = await getDb().collection('assistant_tasks').where('uid', '==', uid).get();
  const tasks = [];
  snap.forEach(doc => { const d = doc.data(); if (!status || d.status === status) tasks.push(d); });
  return tasks;
}

module.exports = { __setFirestoreForTests, ASSISTANT_TASK_TYPES, TASK_STATUS,
  buildAssistantIntro, initiateExternalTask, confirmBeforeComplete, markTaskCompleted, getExternalTasks };