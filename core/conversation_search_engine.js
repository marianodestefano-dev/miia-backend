'use strict';

/**
 * MIIA - Conversation Search Engine (T236)
 * P2.3 ROADMAP: buscador semantico de contactos y conversaciones.
 * Busca por nombre, keyword, frase de conversacion previa.
 */

const SEARCH_MODES = Object.freeze(['contacts', 'conversations', 'all']);
const MAX_RESULTS = 50;
const MIN_QUERY_LENGTH = 2;
const RELEVANCE_THRESHOLD = 0.3;

function isValidMode(mode) {
  return SEARCH_MODES.includes(mode);
}

function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeRelevance(query, target) {
  var q = normalizeText(query);
  var t = normalizeText(target);
  if (!q || !t) return 0;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.9;
  if (t.includes(q)) return 0.7;
  var words = q.split(' ').filter(function(w) { return w.length > 1; });
  if (words.length === 0) return 0;
  var matchCount = words.filter(function(w) { return t.includes(w); }).length;
  return matchCount / words.length * 0.6;
}

function searchContacts(contacts, query, opts) {
  if (!Array.isArray(contacts)) throw new Error('contacts debe ser array');
  if (!query || query.trim().length < MIN_QUERY_LENGTH) {
    throw new Error('query debe tener al menos ' + MIN_QUERY_LENGTH + ' caracteres');
  }
  var limit = (opts && opts.limit) ? Math.min(opts.limit, MAX_RESULTS) : MAX_RESULTS;
  var results = [];
  contacts.forEach(function(contact) {
    var scoreFields = [
      computeRelevance(query, contact.name || ''),
      computeRelevance(query, contact.phone || ''),
      computeRelevance(query, contact.email || ''),
      computeRelevance(query, (contact.tags || []).join(' ')),
      computeRelevance(query, contact.notes || ''),
    ];
    var relevance = Math.max.apply(null, scoreFields);
    if (relevance >= RELEVANCE_THRESHOLD) {
      results.push({ contact, relevance, matchedIn: getMatchedFields(query, contact) });
    }
  });
  results.sort(function(a, b) { return b.relevance - a.relevance; });
  return {
    query,
    mode: 'contacts',
    results: results.slice(0, limit),
    total: results.length,
    limit,
  };
}

function getMatchedFields(query, contact) {
  var q = normalizeText(query);
  var fields = [];
  if (computeRelevance(query, contact.name || '') >= RELEVANCE_THRESHOLD) fields.push('name');
  if (computeRelevance(query, contact.phone || '') >= RELEVANCE_THRESHOLD) fields.push('phone');
  if (computeRelevance(query, contact.email || '') >= RELEVANCE_THRESHOLD) fields.push('email');
  if (computeRelevance(query, (contact.tags || []).join(' ')) >= RELEVANCE_THRESHOLD) fields.push('tags');
  if (computeRelevance(query, contact.notes || '') >= RELEVANCE_THRESHOLD) fields.push('notes');
  return fields;
}

function searchMessages(messages, query, opts) {
  if (!Array.isArray(messages)) throw new Error('messages debe ser array');
  if (!query || query.trim().length < MIN_QUERY_LENGTH) {
    throw new Error('query debe tener al menos ' + MIN_QUERY_LENGTH + ' caracteres');
  }
  var limit = (opts && opts.limit) ? Math.min(opts.limit, MAX_RESULTS) : MAX_RESULTS;
  var results = [];
  messages.forEach(function(msg) {
    var text = msg.text || msg.body || msg.content || '';
    var relevance = computeRelevance(query, text);
    if (relevance >= RELEVANCE_THRESHOLD) {
      results.push({ message: msg, relevance, snippet: buildSnippet(text, query) });
    }
  });
  results.sort(function(a, b) { return b.relevance - a.relevance; });
  return {
    query,
    mode: 'conversations',
    results: results.slice(0, limit),
    total: results.length,
    limit,
  };
}

function buildSnippet(text, query, maxLen) {
  if (!text) return '';
  var max = maxLen || 150;
  var idx = normalizeText(text).indexOf(normalizeText(query));
  if (idx === -1) return text.slice(0, max) + (text.length > max ? '...' : '');
  var start = Math.max(0, idx - 30);
  var end = Math.min(text.length, idx + query.length + 60);
  var snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

function searchAll(contacts, messages, query, opts) {
  if (!query || query.trim().length < MIN_QUERY_LENGTH) {
    throw new Error('query debe tener al menos ' + MIN_QUERY_LENGTH + ' caracteres');
  }
  var contactResults = searchContacts(contacts || [], query, opts);
  var messageResults = searchMessages(messages || [], query, opts);
  return {
    query,
    mode: 'all',
    contacts: contactResults,
    conversations: messageResults,
    totalResults: contactResults.total + messageResults.total,
  };
}

module.exports = {
  searchContacts,
  searchMessages,
  searchAll,
  computeRelevance,
  normalizeText,
  buildSnippet,
  getMatchedFields,
  isValidMode,
  SEARCH_MODES,
  MAX_RESULTS,
  MIN_QUERY_LENGTH,
  RELEVANCE_THRESHOLD,
};
