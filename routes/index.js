'use strict';

/**
 * ROUTE LOADER — Monta rutas modulares en el app de Express
 *
 * STANDARD: Google + Amazon + NASA (fail loudly, zero silent failures)
 *
 * ARQUITECTURA:
 *   - Cada archivo en routes/ exporta una función que recibe dependencias y retorna un Router
 *   - Este loader los monta en /api/* de forma segura (si un módulo falla, los demás siguen)
 *   - Las rutas EXISTENTES en server.js NO se tocan — este sistema es ADITIVO
 *
 * USO en server.js:
 *   const mountRoutes = require('./routes');
 *   mountRoutes(app, { getHealthStatus, requireRole, ... });
 */

const { getHealthStatus } = require('../core/health_check');

/**
 * Montar todas las rutas modulares en la app de Express
 * @param {import('express').Express} app - Express app
 * @param {Object} deps - Dependencias compartidas
 * @param {Function} deps.requireRole - Middleware de autenticación por rol
 */
function mountRoutes(app, deps = {}) {
  const mounted = [];
  const failed = [];

  // ═══ HEALTH ═══
  try {
    const createHealthRoutes = require('./health');
    app.use('/api', createHealthRoutes({
      getHealthStatus,
      requireRole: deps.requireRole || ((/* ...roles */) => (req, res, next) => next()),
    }));
    mounted.push('health');
  } catch (e) {
    console.error(`[ROUTES] ❌ Error montando health routes: ${e.message}`);
    failed.push('health');
  }

  // ═══ COTIZACIONES ═══
  try {
    const createCotizacionRoutes = require('./cotizaciones');
    app.use('/api/cotizacion', createCotizacionRoutes({
      db:          deps.db,
      verifyToken: deps.verifyToken,
    }));
    mounted.push('cotizaciones');
  } catch (e) {
    console.error(`[ROUTES] ❌ Error montando cotizaciones routes: ${e.message}`);
    failed.push('cotizaciones');
  }


  // ═══ F1 DASHBOARD ═══
  try {
    const createF1Routes = require('./f1');
    app.use('/api/f1', createF1Routes({
      verifyToken: deps.verifyToken,
    }));
    mounted.push('f1');
  } catch (e) {
    console.error(`[ROUTES] ❌ Error montando f1 routes: ${e.message}`);
    failed.push('f1');
  }

  // ═══ TEC-MIIAF1-BILLING-1: checkout + webhook ═══
  try {
    const { createF1BillingRouter } = require('./f1_billing');
    app.use('/api/f1/billing', createF1BillingRouter());
    mounted.push('f1_billing');
  } catch (e) {
    console.error(`[ROUTES] ❌ Error montando f1_billing: ${e.message}`);
    failed.push('f1_billing');
  }


  // === PROMETHEUS METRICS ===
  try {
    const createMetricsRoutes = require('./metrics');
    app.use('/api', createMetricsRoutes());
    mounted.push('metrics');
  } catch (e) {
    console.error('[ROUTES] Error montando metrics routes:', e.message);
    failed.push('metrics');
  }

  // === PRODUCTS PERMISSIONS (VI-DASH-2) ===
  try {
    const createProductsRoutes = require('./products');
    app.use('/api/products', createProductsRoutes({
      verifyToken: deps.verifyToken,
    }));
    mounted.push('products');
  } catch (e) {
    console.error('[ROUTES] Error montando products routes:', e.message);
    failed.push('products');
  }

  // Resumen
  console.log(`[ROUTES] ✅ Rutas montadas: [${mounted.join(', ')}]${failed.length ? ` ❌ Fallaron: [${failed.join(', ')}]` : ''}`);
  return { mounted, failed };
}

module.exports = mountRoutes;
