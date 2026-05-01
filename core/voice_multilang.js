"use strict";

const LANGUAGE_PATTERNS = Object.freeze({
  pt: [/\bobrigado\b/i, /\bolá\b/i, /\bpor favor\b/i, /\btudo bem\b/i, /\bvocê\b/i, /\bprazer\b/i],
  en: [/\bthank you\b/i, /\bhello\b/i, /\bplease\b/i, /\bhow are you\b/i, /\bwhat\b/i, /\bwhere\b/i],
});

const VOICE_BY_LANG = Object.freeze({
  es: "2VUqK4PEdMj16L6xTN4J",
  en: "CYw3kZ78EXXxRdSchFcz",
  pt: "jsCqWAovK2LkecY7zXl4",
});

function detectLanguage(text) {
  if (!text) return "es";
  for (const [lang, patterns] of Object.entries(LANGUAGE_PATTERNS)) {
    if (patterns.some(p => p.test(text))) return lang;
  }
  return "es";
}

function getVoiceForLanguage(lang) {
  return VOICE_BY_LANG[lang] || VOICE_BY_LANG.es;
}

function selectVoice(text, ownerVoiceId) {
  const lang = detectLanguage(text);
  const voiceId = ownerVoiceId || getVoiceForLanguage(lang);
  return { lang, voiceId };
}

module.exports = { detectLanguage, getVoiceForLanguage, selectVoice, LANGUAGE_PATTERNS, VOICE_BY_LANG };
