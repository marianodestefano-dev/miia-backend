/**
 * C-442 §A — Privacy Report Schema (Zod 7 categorías).
 *
 * Origen: CARTA_C-442 Wi → Vi (2026-04-27) bajo anchor
 *   [FIRMADO_VIVO_PISO_1_MMC_2026-04-27] (cubre 6 MMC + 4 privacy).
 *
 * Define las 7 categorías de data per owner expuestas al privacy
 * report. Counts y summaries solamente — NO raw content sensible.
 *
 * Continuidad C-435 doctrina Zod (5 endpoints públicos).
 */

'use strict';

const { z } = require('zod');

// ════════════════════════════════════════════════════════════════════
// 7 categorías de data
// ════════════════════════════════════════════════════════════════════

const profileSchema = z.object({
  uid: z.string().min(20).max(128),
  email: z.string().email().max(200).optional().nullable(),
  ownerName: z.string().max(200).optional().nullable(),
}).strict();

const conversationsSummarySchema = z.object({
  totalContacts: z.number().int().min(0),
  totalMessages: z.number().int().min(0),
  conversationsWithMessages: z.number().int().min(0),
}).strict();

const contactsClassificationsSchema = z.object({
  totalClassified: z.number().int().min(0),
  byType: z.record(z.string(), z.number().int().min(0)),
}).strict();

const calendarEventsSchema = z.object({
  totalCreated: z.number().int().min(0),
  upcoming: z.number().int().min(0),
  past: z.number().int().min(0),
}).strict();

const quotesSchema = z.object({
  totalGenerated: z.number().int().min(0),
  lastQuoteAt: z.string().optional().nullable(),
}).strict();

const configFlagsSchema = z.object({
  aiDisclosureEnabled: z.boolean().optional().nullable(),
  fortalezaSealed: z.boolean().optional().nullable(),
  weekendModeEnabled: z.boolean().optional().nullable(),
}).strict();

const auditLogSchema = z.object({
  consentRecords: z.number().int().min(0),
  totalEntries: z.number().int().min(0),
}).strict();

// ════════════════════════════════════════════════════════════════════
// C-462-PRIVACY-REPORT-LOUD-FAIL — Diagnostic field opcional para
// reportar partial errors cuando algun helper falla (UNAUTHENTICATED,
// permission denied, etc.). UI puede mostrar mensaje "algunas
// secciones no se pudieron cargar" en vez de exito engañoso.
// ════════════════════════════════════════════════════════════════════

const reportDiagnosticSchema = z.object({
  partial_errors: z.array(z.object({
    section: z.string(),
    error: z.string(),
  })).default([]),
}).strict();

// ════════════════════════════════════════════════════════════════════
// Privacy report root schema
// ════════════════════════════════════════════════════════════════════

const privacyReportSchema = z.object({
  ownerUid: z.string().min(20).max(128),
  generatedAt: z.string(),
  profile: profileSchema,
  conversationsSummary: conversationsSummarySchema,
  contactsClassifications: contactsClassificationsSchema,
  calendarEvents: calendarEventsSchema,
  quotes: quotesSchema,
  configFlags: configFlagsSchema,
  auditLog: auditLogSchema,
  // C-462: optional - solo presente si hubo partial errors.
  _diagnostic: reportDiagnosticSchema.optional(),
}).strict();

// Request schema (validate query string of GET /api/privacy/report)
const privacyReportRequestSchema = z.object({
  userId: z.string().min(20).max(128),
}).strict();

// C-444 — forget-me request body (POST /api/privacy/forget-me)
const forgetMeRequestSchema = z.object({
  userId: z.string().min(20).max(128),
}).strict();

// C-444 — forget-me confirm body (POST /api/privacy/forget-me/confirm)
const forgetMeConfirmSchema = z.object({
  userId: z.string().min(20).max(128),
  token: z.string().length(6).regex(/^\d{6}$/),
}).strict();

module.exports = {
  profileSchema,
  conversationsSummarySchema,
  contactsClassificationsSchema,
  calendarEventsSchema,
  quotesSchema,
  configFlagsSchema,
  auditLogSchema,
  privacyReportSchema,
  privacyReportRequestSchema,
  forgetMeRequestSchema,
  forgetMeConfirmSchema,
  reportDiagnosticSchema,
};
