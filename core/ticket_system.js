'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const TICKET_TYPES = Object.freeze({ BUG: '📖', CRITICAL: '🚨', IDEA: '💡', QUESTION: '❓', FEATURE: '🎁', ANNOUNCEMENT: '📣' });
const TICKET_STATUS = Object.freeze(['open', 'in_progress', 'resolved', 'closed', 'escalated']);

function parseTicketFromMessage(message) {
  const text = (message || '').trim();
  for (const [type, emoji] of Object.entries(TICKET_TYPES)) {
    if (text.startsWith(emoji)) {
      const body = text.slice(emoji.length).trim();
      const lines = body.split('\n');
      return { type, emoji, subject: lines[0] || 'Sin asunto', body: lines.slice(1).join('\n').trim() || body, detected: true };
    }
  }
  return { detected: false };
}

async function createTicket(uid, phone, opts) {
  const { type, subject, body } = opts;
  const emoji = TICKET_TYPES[type];
  if (!emoji) throw new Error('Invalid ticket type: ' + type);
  const ticket = { id: randomUUID(), uid, phone, type, emoji, subject, body: body || '', status: type === 'CRITICAL' ? 'escalated' : 'open', priority: type === 'CRITICAL' ? 'high' : type === 'BUG' ? 'medium' : 'normal', createdAt: new Date().toISOString(), resolvedAt: null };
  await getDb().collection('tickets').doc(ticket.id).set(ticket);
  return ticket;
}

async function getTicketsByStatus(uid, status) {
  if (status && !TICKET_STATUS.includes(status)) throw new Error('Invalid status: ' + status);
  const snap = await getDb().collection('tickets').where('uid', '==', uid).get();
  const tickets = [];
  snap.forEach(doc => { const d = doc.data(); if (!status || d.status === status) tickets.push(d); });
  return tickets;
}

async function updateTicketStatus(uid, ticketId, newStatus) {
  if (!TICKET_STATUS.includes(newStatus)) throw new Error('Invalid status: ' + newStatus);
  const update = { status: newStatus, updatedAt: new Date().toISOString() };
  if (newStatus === 'resolved') update.resolvedAt = new Date().toISOString();
  await getDb().collection('tickets').doc(ticketId).set(update, { merge: true });
  return { ticketId, status: newStatus };
}

async function assignTicket(uid, ticketId, agentId) {
  await getDb().collection('tickets').doc(ticketId).set({ assignedTo: agentId, status: 'in_progress', updatedAt: new Date().toISOString() }, { merge: true });
  return { ticketId, assignedTo: agentId };
}

async function getDashboardStats(uid) {
  const snap = await getDb().collection('tickets').where('uid', '==', uid).get();
  const stats = { total: 0, open: 0, in_progress: 0, resolved: 0, closed: 0, escalated: 0, byType: {} };
  snap.forEach(doc => { const d = doc.data(); stats.total++; if (stats[d.status] !== undefined) stats[d.status]++; stats.byType[d.type] = (stats.byType[d.type] || 0) + 1; });
  return stats;
}

module.exports = { __setFirestoreForTests, TICKET_TYPES, TICKET_STATUS,
  parseTicketFromMessage, createTicket, getTicketsByStatus, updateTicketStatus, assignTicket, getDashboardStats };