'use strict';

/**
 * MiiaF1 — Schema y validadores Firestore
 * Colecciones:
 *   f1_data/{season}/drivers/{driver_id}
 *   f1_data/{season}/schedule/{gp_id}
 *   f1_data/{season}/results/{gp_id}
 *   owners/{uid}/f1_prefs
 */

const DRIVER_SCHEMA = {
  required: ['id', 'name', 'team', 'number', 'nationality', 'season'],
  optional: ['acronym', 'team_color', 'active'],
};

const GP_SCHEMA = {
  required: ['id', 'name', 'circuit', 'date', 'country', 'season'],
  optional: ['city', 'round', 'status', 'sprint'],
  statuses: ['scheduled', 'live', 'completed', 'cancelled'],
};

const RESULT_SCHEMA = {
  required: ['gp_id', 'season', 'positions'],
  optional: ['fastest_lap', 'pole', 'dnfs', 'safety_cars', 'recorded_at'],
};

const F1_PREFS_SCHEMA = {
  required: ['uid'],
  optional: ['adopted_driver', 'notifications', 'updated_at'],
};

function validateDriver(d) {
  for (const f of DRIVER_SCHEMA.required) {
    if (d[f] === undefined || d[f] === null || d[f] === '') {
      return { valid: false, error: `Campo requerido faltante: ${f}` };
    }
  }
  if (typeof d.number !== 'number' || d.number < 0 || d.number > 99) {
    return { valid: false, error: `number debe ser entero 0-99, recibido: ${d.number}` };
  }
  return { valid: true };
}

function validateGP(gp) {
  for (const f of GP_SCHEMA.required) {
    if (gp[f] === undefined || gp[f] === null || gp[f] === '') {
      return { valid: false, error: `Campo requerido faltante: ${f}` };
    }
  }
  if (gp.status && !GP_SCHEMA.statuses.includes(gp.status)) {
    return { valid: false, error: `status invalido: ${gp.status}. Validos: ${GP_SCHEMA.statuses.join(', ')}` };
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(gp.date)) {
    return { valid: false, error: `date debe ser ISO 8601, recibido: ${gp.date}` };
  }
  return { valid: true };
}

function validateResult(r) {
  for (const f of RESULT_SCHEMA.required) {
    if (r[f] === undefined || r[f] === null) {
      return { valid: false, error: `Campo requerido faltante: ${f}` };
    }
  }
  if (!Array.isArray(r.positions) || r.positions.length === 0) {
    return { valid: false, error: 'positions debe ser array no vacio' };
  }
  for (const p of r.positions) {
    if (!p.position || !p.driver_id || !p.driver_name) {
      return { valid: false, error: `Posicion incompleta: ${JSON.stringify(p)}` };
    }
  }
  return { valid: true };
}

function validateF1Prefs(prefs) {
  if (!prefs.uid) return { valid: false, error: 'uid requerido' };
  return { valid: true };
}

/**
 * Firestore paths helpers
 */
const paths = {
  driver: (season, driverId) => `f1_data/${season}/drivers/${driverId}`,
  gp: (season, gpId) => `f1_data/${season}/schedule/${gpId}`,
  result: (season, gpId) => `f1_data/${season}/results/${gpId}`,
  f1Prefs: (uid) => `owners/${uid}/f1_prefs`,
  fantasyStandings: (season) => `f1_fantasy/${season}/standings`,
  fantasyEntry: (season, uid) => `f1_fantasy/${season}/standings/${uid}`,
};

module.exports = {
  DRIVER_SCHEMA,
  GP_SCHEMA,
  RESULT_SCHEMA,
  F1_PREFS_SCHEMA,
  validateDriver,
  validateGP,
  validateResult,
  validateF1Prefs,
  paths,
};
