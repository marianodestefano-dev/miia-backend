'use strict';

/**
 * MIIA â€” Catalog Setup Guide (T156)
 * Guia al owner en la configuracion inicial del catalogo via chat.
 * Genera preguntas contextuales y procesa respuestas.
 */

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() {
  if (_db) return _db;
  return require('firebase-admin').firestore();
}

const SETUP_STAGES = Object.freeze(['start','naming','categories','pricing','availability','complete']);

const STAGE_PROMPTS = Object.freeze({
  start: 'Vamos a configurar tu catalogo! Primero, cuantos productos o servicios ofreces aproximadamente?',
  naming: 'Perfecto! Dame el nombre de tu primer producto o servicio.',
  categories: 'En que categoria entra ese producto? (ej: ropa, electronica, servicio, etc)',
  pricing: 'Cual es el precio? Puedes poner el precio base.',
  availability: 'Ese producto esta disponible actualmente? (si/no)',
  complete: 'Tu catalogo inicial esta configurado! Puedes agregar mas productos desde el panel.',
});

/**
 * Obtiene el estado de setup del catalogo.
 */
async function getSetupState(uid) {
  if (!uid) throw new Error('uid requerido');
  try {
    const snap = await db().collection('catalog_setup').doc(uid).get();
    if (!snap.exists) return _defaultSetupState(uid);
    return { ..._defaultSetupState(uid), ...snap.data() };
  } catch (e) {
    console.error('[CATALOG_SETUP] Error leyendo estado uid=' + uid.substring(0,8) + ': ' + e.message);
    return _defaultSetupState(uid);
  }
}

function _defaultSetupState(uid) {
  return {
    uid,
    stage: 'start',
    products: [],
    currentProduct: {},
    completed: false,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Procesa una respuesta del owner y avanza el setup.
 * @param {string} uid
 * @param {string} message - respuesta del owner
 * @param {object} [opts] - { state } para inyectar estado en tests
 * @returns {Promise<{response, stage, state, products}>}
 */
async function processSetupMessage(uid, message, opts) {
  if (!uid) throw new Error('uid requerido');
  if (!message || typeof message !== 'string') throw new Error('message requerido');

  const state = (opts && opts.state) ? opts.state : await getSetupState(uid);
  const trimmed = message.trim();

  let newState = { ...state };
  let response = '';

  switch (state.stage) {
    case 'start': {
      const count = parseInt(trimmed, 10);
      if (!isNaN(count) && count > 0) {
        newState.estimatedProducts = count;
        newState.stage = 'naming';
        response = STAGE_PROMPTS.naming;
      } else {
        response = 'Por favor ingresa un numero. Cuantos productos tienes aproximadamente?';
      }
      break;
    }
    case 'naming': {
      if (trimmed.length >= 2) {
        newState.currentProduct = { name: trimmed };
        newState.stage = 'categories';
        response = STAGE_PROMPTS.categories;
      } else {
        response = 'El nombre debe tener al menos 2 caracteres. Cual es el nombre del producto?';
      }
      break;
    }
    case 'categories': {
      if (trimmed.length >= 2) {
        newState.currentProduct = { ...newState.currentProduct, category: trimmed.toLowerCase() };
        newState.stage = 'pricing';
        response = STAGE_PROMPTS.pricing;
      } else {
        response = 'Ingresa una categoria valida (ej: ropa, comida, servicio)';
      }
      break;
    }
    case 'pricing': {
      const price = parseFloat(trimmed.replace(/[$,]/g, ''));
      if (!isNaN(price) && price >= 0) {
        newState.currentProduct = { ...newState.currentProduct, price };
        newState.stage = 'availability';
        response = STAGE_PROMPTS.availability;
      } else {
        response = 'Ingresa un precio valido (ej: 25000, 49.99)';
      }
      break;
    }
    case 'availability': {
      const lower = trimmed.toLowerCase();
      const available = lower.includes('si') || lower === 'yes' || lower === 's';
      const product = {
        ...newState.currentProduct,
        available,
        stock: available ? 1 : 0,
        createdAt: new Date().toISOString(),
        active: true,
      };
      newState.products = [...(newState.products || []), product];
      newState.currentProduct = {};
      newState.stage = 'complete';
      newState.completed = true;
      response = STAGE_PROMPTS.complete + ' Producto "' + product.name + '" guardado!';
      break;
    }
    case 'complete': {
      response = 'Tu catalogo ya esta configurado. Usa el panel para agregar mas productos.';
      break;
    }
    default: {
      response = STAGE_PROMPTS.start;
      newState.stage = 'start';
    }
  }

  if (!opts || !opts.state) {
    try {
      await db().collection('catalog_setup').doc(uid).set(newState);
    } catch (e) {
      console.error('[CATALOG_SETUP] Error guardando estado: ' + e.message);
    }
  }

  return { response, stage: newState.stage, state: newState, products: newState.products || [] };
}

/**
 * Genera el prompt de inicio del wizard.
 */
function getWelcomePrompt(sector) {
  const sectorHint = sector ? ' para tu negocio de ' + sector : '';
  return 'Hola! Voy a ayudarte a configurar tu catalogo' + sectorHint + '. ' + STAGE_PROMPTS.start;
}

module.exports = {
  getSetupState, processSetupMessage, getWelcomePrompt,
  SETUP_STAGES, STAGE_PROMPTS,
  __setFirestoreForTests,
};
