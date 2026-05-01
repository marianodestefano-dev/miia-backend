'use strict';

/**
 * MIIA - Broadcast Preview (T204)
 * Preview y validacion de broadcast antes de enviar.
 */

const MAX_MESSAGE_LENGTH = 4096;
const MAX_PREVIEW_RECIPIENTS = 5;
const PREVIEW_PLACEHOLDER = '[NOMBRE]';

function validateBroadcastMessage(message) {
  if (typeof message !== 'string') return { valid: false, reason: 'message debe ser string' };
  var trimmed = message.trim();
  if (trimmed.length === 0) return { valid: false, reason: 'message no puede estar vacio' };
  if (trimmed.length > MAX_MESSAGE_LENGTH) return { valid: false, reason: 'message supera ' + MAX_MESSAGE_LENGTH + ' caracteres' };
  return { valid: true, length: trimmed.length };
}

function personalizeMessage(template, contact) {
  if (!template || typeof template !== 'string') return template || '';
  var name = (contact && contact.name) ? contact.name : 'Cliente';
  return template
    .replace(/\[NOMBRE\]/g, name)
    .replace(/\[PHONE\]/g, (contact && contact.phone) ? contact.phone : '')
    .replace(/\[NEGOCIO\]/g, (contact && contact.businessName) ? contact.businessName : '');
}

function generatePreview(message, recipients, opts) {
  if (!message || typeof message !== 'string') throw new Error('message requerido');
  if (!Array.isArray(recipients)) throw new Error('recipients debe ser array');
  var validation = validateBroadcastMessage(message);
  var previewContacts = recipients.slice(0, MAX_PREVIEW_RECIPIENTS);
  var previews = previewContacts.map(function(contact) {
    return {
      phone: contact.phone || contact,
      name: contact.name || null,
      personalizedMessage: personalizeMessage(message, contact),
    };
  });
  var hasPersonalization = message.includes(PREVIEW_PLACEHOLDER) ||
    message.includes('[PHONE]') || message.includes('[NEGOCIO]');
  return {
    originalMessage: message,
    messageLength: validation.length,
    totalRecipients: recipients.length,
    previewCount: previewContacts.length,
    hasPersonalization,
    previews,
    estimatedSendTimeMs: recipients.length * 1500,
  };
}

function estimateSendCost(recipientCount, hasmedia) {
  if (typeof recipientCount !== 'number' || recipientCount < 0) throw new Error('recipientCount debe ser numero >= 0');
  var baseCost = recipientCount * 0.01;
  if (hasmedia) baseCost *= 1.5;
  return {
    recipientCount,
    estimatedCost: Math.round(baseCost * 100) / 100,
    currency: 'USD',
    hasMedia: !!hasmedia,
  };
}

function validateRecipients(recipients) {
  if (!Array.isArray(recipients)) throw new Error('recipients debe ser array');
  var valid = [];
  var invalid = [];
  recipients.forEach(function(r) {
    var phone = typeof r === 'string' ? r : (r && r.phone);
    if (phone && /^\+\d{8,15}$/.test(phone)) {
      valid.push(r);
    } else {
      invalid.push(r);
    }
  });
  return { valid, invalid, validCount: valid.length, invalidCount: invalid.length };
}

module.exports = {
  validateBroadcastMessage,
  personalizeMessage,
  generatePreview,
  estimateSendCost,
  validateRecipients,
  MAX_MESSAGE_LENGTH,
  MAX_PREVIEW_RECIPIENTS,
  PREVIEW_PLACEHOLDER,
};