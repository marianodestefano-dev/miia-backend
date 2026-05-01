"use strict";
const { randomUUID } = require("crypto");
let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require("../config/firebase").db; }

const TICKET_STATUSES = Object.freeze({ OPEN: "open", IN_PROGRESS: "in_progress", RESOLVED: "resolved", CLOSED: "closed" });
const TICKET_PRIORITIES = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high", URGENT: "urgent" });

async function createTicket(uid, opts) {
  const { subject, description, priority } = opts || {};
  if (!uid || !subject || !description) throw new Error("uid, subject, description required");
  const ticket = {
    id: randomUUID(), uid, subject, description,
    priority: priority || TICKET_PRIORITIES.MEDIUM,
    status: TICKET_STATUSES.OPEN,
    messages: [],
    createdAt: Date.now(),
  };
  await getDb().collection("support_tickets").doc(ticket.id).set(ticket);
  return ticket;
}

async function replyToTicket(ticketId, fromUid, message) {
  if (!ticketId || !fromUid || !message) throw new Error("ticketId, fromUid, message required");
  const snap = await getDb().collection("support_tickets").doc(ticketId).get();
  if (!snap.exists) throw new Error("ticket not found: " + ticketId);
  const ticket = snap.data();
  const reply = { from: fromUid, message, sentAt: Date.now() };
  const messages = [...(ticket.messages || []), reply];
  await getDb().collection("support_tickets").doc(ticketId).update({ messages, status: TICKET_STATUSES.IN_PROGRESS });
  return { ticketId, reply };
}

async function closeTicket(ticketId, resolution) {
  if (!ticketId) throw new Error("ticketId required");
  await getDb().collection("support_tickets").doc(ticketId).update({
    status: TICKET_STATUSES.RESOLVED,
    resolution: resolution || "Resolved by support",
    closedAt: Date.now(),
  });
  return { ticketId, status: TICKET_STATUSES.RESOLVED };
}

async function listTickets(opts) {
  let q = getDb().collection("support_tickets");
  if (opts && opts.status) q = q.where("status", "==", opts.status);
  if (opts && opts.uid) q = q.where("uid", "==", opts.uid);
  const snap = await q.get();
  const tickets = [];
  snap.forEach(doc => tickets.push(doc.data()));
  return tickets;
}

module.exports = { createTicket, replyToTicket, closeTicket, listTickets, TICKET_STATUSES, TICKET_PRIORITIES, __setFirestoreForTests };
