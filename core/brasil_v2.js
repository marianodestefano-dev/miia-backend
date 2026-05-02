'use strict';
const { randomUUID } = require('crypto');

let _db = null;
function __setFirestoreForTests(db) { _db = db; }
function getDb() { return _db || require('../config/firebase').db; }

const BRASIL_V2_FEATURES = Object.freeze(['ludomiia_integration', 'miiadt_integration', 'standalone_product', 'pix_native', 'lgpd_full', 'pt_br_nlp']);
const BRASIL_DEPLOY_STATUS = Object.freeze(['not_deployed', 'deploying', 'active', 'paused', 'error']);

async function deployBrasilStandalone(uid, opts) {
  const features = opts.features || ['standalone_product', 'pix_native', 'lgpd_full'];
  const invalid = features.filter(f => !BRASIL_V2_FEATURES.includes(f));
  if (invalid.length > 0) throw new Error('Invalid Brasil V2 features: ' + invalid.join(', '));
  const deployment = { id: randomUUID(), uid, features, status: 'active', marketCode: 'BR', deployedAt: new Date().toISOString() };
  await getDb().collection('brasil_deployments').doc(deployment.id).set(deployment);
  return deployment;
}

async function integrateWithLudoMIIA(uid, config) {
  const integration = { id: randomUUID(), uid, type: 'ludomiia', config: config || {}, status: 'active', region: 'BR', integratedAt: new Date().toISOString() };
  await getDb().collection('ludomiia_integrations').doc(integration.id).set(integration);
  return integration;
}

async function integrateWithMIIADT(uid, config) {
  const integration = { id: randomUUID(), uid, type: 'miiadt', config: config || {}, alertChannels: config.alertChannels || ['whatsapp'], status: 'active', region: 'BR', integratedAt: new Date().toISOString() };
  await getDb().collection('miiadt_integrations').doc(integration.id).set(integration);
  return integration;
}

async function getBrasilDeployStatus(uid) {
  const snap = await getDb().collection('brasil_deployments').where('uid', '==', uid).get();
  const deployments = [];
  snap.forEach(doc => deployments.push(doc.data()));
  if (deployments.length === 0) return { uid, status: 'not_deployed', features: [] };
  const latest = deployments[deployments.length - 1];
  return { uid, status: latest.status, features: latest.features, deployedAt: latest.deployedAt };
}

function getBrasilMarketSummary() {
  return { country: 'Brasil', code: 'BR', population: 215e6, smallBusinesses: 20e6, currency: 'BRL', paymentMethods: ['Pix', 'Boleto', 'Cartao'], language: 'pt-BR', compliance: 'LGPD' };
}

module.exports = { __setFirestoreForTests, BRASIL_V2_FEATURES, BRASIL_DEPLOY_STATUS,
  deployBrasilStandalone, integrateWithLudoMIIA, integrateWithMIIADT, getBrasilDeployStatus, getBrasilMarketSummary };