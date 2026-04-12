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

  // ═══ FUTURAS RUTAS (agregar aquí) ═══
  // try {
  //   const createCalendarRoutes = require('./calendar');
  //   app.use('/api', createCalendarRoutes({ ... }));
  //   mounted.push('calendar');
  // } catch (e) { ... }

  // Resumen
  console.log(`[ROUTES] ✅ Rutas montadas: [${mounted.join(', ')}]${failed.length ? ` ❌ Fallaron: [${failed.join(', ')}]` : ''}`);
  return { mounted, failed };
}

module.exports = mountRoutes;
