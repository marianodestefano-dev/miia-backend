'use strict';

/**
 * MIIA - Tenant Isolation Validator (T235)
 * C.5 ROADMAP: test aislamiento cross-tenant UNICORNIO_FUCSIA_42.
 * Marker en corpus owner A, verificar ausencia en prompt owner B.
 * Auditor pre-envio severidad maxima.
 */

const CANARY_MARKER = 'UNICORNIO_FUCSIA_42';
const CANARY_SECONDARY = 'CANARY_ISOLATION_TEST_MIIA';
const ISOLATION_SEVERITY = 'CRITICAL';
const MAX_PROMPT_SCAN_LENGTH = 50000;

const VIOLATION_TYPES = Object.freeze([
  'canary_leak', 'uid_mismatch', 'cross_tenant_data', 'prompt_injection',
]);

function containsCanaryMarker(text) {
  if (!text || typeof text !== 'string') return false;
  return text.includes(CANARY_MARKER) || text.includes(CANARY_SECONDARY);
}

function detectUIDLeak(text, ownerUID) {
  if (!text || !ownerUID) return false;
  var otherUIDPattern = /[a-zA-Z0-9]{20,}/g;
  var matches = text.match(otherUIDPattern) || [];
  return matches.some(function(m) { return m !== ownerUID && m.length >= 20 && m !== CANARY_MARKER && m !== CANARY_SECONDARY; });
}

function buildCanaryPayload(ownerUID) {
  if (!ownerUID) throw new Error('ownerUID requerido');
  return {
    marker: CANARY_MARKER,
    ownerUID,
    insertedAt: new Date().toISOString(),
    type: 'isolation_test',
  };
}

function auditPromptForLeaks(prompt, ownerUID, opts) {
  if (!prompt) throw new Error('prompt requerido');
  if (!ownerUID) throw new Error('ownerUID requerido');
  var violations = [];
  var scanTarget = String(prompt).slice(0, MAX_PROMPT_SCAN_LENGTH);
  if (containsCanaryMarker(scanTarget)) {
    violations.push({
      type: 'canary_leak',
      severity: ISOLATION_SEVERITY,
      detail: 'Marker UNICORNIO_FUCSIA_42 detectado en prompt',
      ownerUID,
    });
  }
  var foreignUIDs = [];
  if (opts && opts.knownForeignUIDs) {
    opts.knownForeignUIDs.forEach(function(fUID) {
      if (scanTarget.includes(fUID)) {
        foreignUIDs.push(fUID);
        violations.push({
          type: 'cross_tenant_data',
          severity: ISOLATION_SEVERITY,
          detail: 'UID foraneo detectado en prompt: ' + fUID.slice(0, 8) + '...',
          ownerUID,
        });
      }
    });
  }
  var isClean = violations.length === 0;
  return {
    ownerUID,
    isClean,
    violations,
    scannedLength: scanTarget.length,
    severity: violations.length > 0 ? ISOLATION_SEVERITY : 'OK',
    auditedAt: new Date().toISOString(),
  };
}

function auditConversationsForLeaks(conversations, ownerUID) {
  if (!Array.isArray(conversations)) throw new Error('conversations debe ser array');
  if (!ownerUID) throw new Error('ownerUID requerido');
  var violations = [];
  conversations.forEach(function(conv, i) {
    if (!conv || !conv.uid) return;
    if (conv.uid !== ownerUID) {
      violations.push({
        type: 'uid_mismatch',
        severity: ISOLATION_SEVERITY,
        detail: 'Conversacion ' + i + ' tiene uid ' + conv.uid.slice(0, 8) + '... (esperado ' + ownerUID.slice(0, 8) + '...)',
        index: i,
      });
    }
    var textToCheck = JSON.stringify(conv);
    if (containsCanaryMarker(textToCheck)) {
      violations.push({
        type: 'canary_leak',
        severity: ISOLATION_SEVERITY,
        detail: 'Canary en conversacion ' + i,
        index: i,
      });
    }
  });
  return {
    ownerUID,
    totalConversations: conversations.length,
    isClean: violations.length === 0,
    violations,
    severity: violations.length > 0 ? ISOLATION_SEVERITY : 'OK',
  };
}

function runCanaryTest(ownerA_UID, ownerB_prompt) {
  if (!ownerA_UID) throw new Error('ownerA_UID requerido');
  if (!ownerB_prompt && ownerB_prompt !== '') throw new Error('ownerB_prompt requerido');
  var canaryPresent = containsCanaryMarker(ownerB_prompt);
  return {
    ownerA_UID,
    canaryMarker: CANARY_MARKER,
    canaryFoundInOwnerB: canaryPresent,
    passed: !canaryPresent,
    severity: canaryPresent ? ISOLATION_SEVERITY : 'OK',
    testedAt: new Date().toISOString(),
  };
}

function generateIsolationReport(uid, auditResults) {
  if (!uid) throw new Error('uid requerido');
  if (!Array.isArray(auditResults)) throw new Error('auditResults debe ser array');
  var totalViolations = auditResults.reduce(function(sum, r) { return sum + (r.violations ? r.violations.length : 0); }, 0);
  var hasCanaryLeak = auditResults.some(function(r) {
    return r.violations && r.violations.some(function(v) { return v.type === 'canary_leak'; });
  });
  return {
    uid,
    generatedAt: new Date().toISOString(),
    totalAudits: auditResults.length,
    totalViolations,
    hasCanaryLeak,
    overallStatus: totalViolations === 0 ? 'ISOLATED' : 'BREACH_DETECTED',
    auditResults,
  };
}

module.exports = {
  containsCanaryMarker,
  detectUIDLeak,
  buildCanaryPayload,
  auditPromptForLeaks,
  auditConversationsForLeaks,
  runCanaryTest,
  generateIsolationReport,
  CANARY_MARKER,
  CANARY_SECONDARY,
  ISOLATION_SEVERITY,
  VIOLATION_TYPES,
  MAX_PROMPT_SCAN_LENGTH,
};
