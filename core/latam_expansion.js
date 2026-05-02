'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const LATAM_COUNTRIES = Object.freeze({
  CO: { name: 'Colombia', currency: 'COP', symbol: '$', timezone: 'America/Bogota', phone_prefix: '+57', payment: 'nequi', cities: ['Bogota', 'Medellin', 'Cali', 'Barranquilla', 'Cartagena'] },
  MX: { name: 'Mexico', currency: 'MXN', symbol: '$', timezone: 'America/Mexico_City', phone_prefix: '+52', payment: 'oxxo', cities: ['CDMX', 'Guadalajara', 'Monterrey', 'Puebla'], verticals: ['tacos', 'tortas', 'lucha_libre', 'artesanias'] },
  CL: { name: 'Chile', currency: 'CLP', symbol: '$', timezone: 'America/Santiago', phone_prefix: '+56', payment: 'transbank', compliance: 'Ley19628' },
  PE: { name: 'Peru', currency: 'PEN', symbol: 'S/', timezone: 'America/Lima', phone_prefix: '+51', payment: 'yape' },
  AR: { name: 'Argentina', currency: 'ARS', symbol: '$', timezone: 'America/Argentina/Buenos_Aires', phone_prefix: '+54', payment: 'modo' },
  BR: { name: 'Brasil', currency: 'BRL', symbol: 'R$', timezone: 'America/Sao_Paulo', phone_prefix: '+55', payment: 'pix' },
  UY: { name: 'Uruguay', currency: 'UYU', symbol: '$', timezone: 'America/Montevideo', phone_prefix: '+598', payment: 'cobro_express' },
  BO: { name: 'Bolivia', currency: 'BOB', symbol: 'Bs', timezone: 'America/La_Paz', phone_prefix: '+591', payment: 'cash' },
  PY: { name: 'Paraguay', currency: 'PYG', symbol: 'Gs', timezone: 'America/Asuncion', phone_prefix: '+595', payment: 'cash' },
  EC: { name: 'Ecuador', currency: 'USD', symbol: '$', timezone: 'America/Guayaquil', phone_prefix: '+593', payment: 'transferencia' },
});

const MODISMOS = Object.freeze({
  CO: { greeting: 'Quiubo', affirmative: 'Listo pues', farewell: 'Chao', cool: 'Bacano', sure: 'Dale pues' },
  MX: { greeting: 'Que onda', affirmative: 'Orale', farewell: 'Hasta luego buey', cool: 'Chido', sure: 'Simon' },
  AR: { greeting: 'Buenas che', affirmative: 'Dale boludo', farewell: 'Chau', cool: 'Copado', sure: 'Barbaro' },
  CL: { greeting: 'Buenas po', affirmative: 'Ya po', farewell: 'Chao po', cool: 'Bacán', sure: 'Claro que sí' },
  PE: { greeting: 'Hola causa', affirmative: 'Ya pe', farewell: 'Chau pe', cool: 'Bacán', sure: 'Ya pues' },
  BR: { greeting: 'Oi', affirmative: 'Claro', farewell: 'Tchau', cool: 'Legal', sure: 'Com certeza' },
});

function getCountryConfig(countryCode) {
  const config = LATAM_COUNTRIES[countryCode];
  if (!config) throw new Error('Country not supported: ' + countryCode);
  return config;
}

async function registerCountryPresence(uid, countryCode) {
  if (!LATAM_COUNTRIES[countryCode]) throw new Error('Country not supported: ' + countryCode);
  const entry = { id: randomUUID(), uid, countryCode, config: LATAM_COUNTRIES[countryCode], status: 'active', registeredAt: new Date().toISOString() };
  await getDb().collection('country_presence').doc(uid + '_' + countryCode).set(entry, { merge: true });
  return entry;
}

async function processYapePayment(uid, phone, amount) {
  if (!phone.startsWith('+51')) throw new Error('Yape only available for Peru (+51)');
  const payment = { id: randomUUID(), uid, phone, amount, currency: 'PEN', provider: 'yape', status: 'processing', createdAt: new Date().toISOString() };
  await getDb().collection('yape_payments').doc(payment.id).set(payment);
  return payment;
}

async function processModoPayment(uid, phone, amount) {
  if (!phone.startsWith('+54')) throw new Error('Modo only available for Argentina (+54)');
  const payment = { id: randomUUID(), uid, phone, amount, currency: 'ARS', provider: 'modo', status: 'processing', createdAt: new Date().toISOString() };
  await getDb().collection('modo_payments').doc(payment.id).set(payment);
  return payment;
}

async function getMultiCountryStats(uid) {
  const snap = await getDb().collection('country_presence').where('uid', '==', uid).get();
  const countries = [];
  snap.forEach(doc => { const d = doc.data(); if (d.status === 'active') countries.push(d.countryCode); });
  return { uid, activeCountries: countries, count: countries.length };
}

function buildLocalizedMessage(countryCode, templateKey, vars) {
  const modismos = MODISMOS[countryCode] || MODISMOS['CO'];
  const templates = {
    greeting: modismos.greeting + '! Como te puedo ayudar?',
    confirmation: modismos.affirmative + '! Queda confirmado.',
    farewell: modismos.farewell + '! Fue un placer.',
  };
  let msg = templates[templateKey] || templates['greeting'];
  Object.entries(vars || {}).forEach(([k, v]) => { msg = msg.replace('{' + k + '}', v); });
  return { countryCode, templateKey, message: msg };
}

function detectModisms(text, countryCode) {
  const modismos = MODISMOS[countryCode];
  if (!modismos) return { countryCode, detected: [], confidence: 0 };
  const lower = text.toLowerCase();
  const detected = Object.values(modismos).filter(m => lower.includes(m.toLowerCase()));
  return { countryCode, detected, confidence: detected.length / Object.keys(modismos).length };
}

module.exports = { __setFirestoreForTests, LATAM_COUNTRIES, MODISMOS,
  getCountryConfig, registerCountryPresence, processYapePayment, processModoPayment,
  getMultiCountryStats, buildLocalizedMessage, detectModisms };