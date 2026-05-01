'use strict';

const express = require('express');
const admin = require('firebase-admin');
const { paths, validateF1Prefs } = require('../sports/f1_dashboard/f1_schema');

module.exports = function createF1Routes({ verifyToken }) {
  const router = express.Router();
  const db = () => admin.firestore();

  // Auth middleware
  const auth = verifyToken
    ? verifyToken
    : (req, res, next) => next(); // fallback dev

  // ── GET /api/f1/calendar/:season ──────────────────────────
  router.get('/calendar/:season', auth, async (req, res) => {
    try {
      const { season } = req.params;
      const snap = await db().collection(`f1_data/${season}/schedule`).orderBy('round').get();
      const gps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      res.json({ season, gps, total: gps.length });
    } catch (err) {
      console.error(`[F1-ROUTES] GET calendar: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/f1/results/:season/:gp_id ───────────────────
  router.get('/results/:season/:gp_id', auth, async (req, res) => {
    try {
      const { season, gp_id } = req.params;
      const doc = await db().doc(paths.result(season, gp_id)).get();
      if (!doc.exists) return res.status(404).json({ error: 'Resultado no encontrado' });
      res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
      console.error(`[F1-ROUTES] GET results: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/f1/standings/drivers/:season ────────────────
  router.get('/standings/drivers/:season', auth, async (req, res) => {
    try {
      const { season } = req.params;
      const snap = await db().collection(`f1_data/${season}/drivers`).orderBy('number').get();
      res.json({ season, drivers: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    } catch (err) {
      console.error(`[F1-ROUTES] GET standings/drivers: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/f1/standings/constructors/:season ───────────
  router.get('/standings/constructors/:season', auth, async (req, res) => {
    try {
      const { season } = req.params;
      // Agrupar puntos por equipo de los drivers
      const snap = await db().collection(`f1_data/${season}/drivers`).get();
      const teams = {};
      snap.docs.forEach(d => {
        const { team, team_color } = d.data();
        if (!teams[team]) teams[team] = { team, team_color: team_color || '#888', points: 0, drivers: [] };
        teams[team].drivers.push(d.id);
      });
      res.json({ season, constructors: Object.values(teams) });
    } catch (err) {
      console.error(`[F1-ROUTES] GET standings/constructors: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/f1/driver/:season/:driver_id ────────────────
  router.get('/driver/:season/:driver_id', auth, async (req, res) => {
    try {
      const { season, driver_id } = req.params;
      const doc = await db().doc(paths.driver(season, driver_id)).get();
      if (!doc.exists) return res.status(404).json({ error: 'Piloto no encontrado' });
      res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
      console.error(`[F1-ROUTES] GET driver: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/f1/adopt ───────────────────────────────────
  router.post('/adopt', auth, async (req, res) => {
    try {
      const uid = req.user?.uid || req.body.uid;
      if (!uid) return res.status(401).json({ error: 'No autenticado' });
      const { driver_id, season = '2025' } = req.body;
      if (!driver_id) return res.status(400).json({ error: 'driver_id requerido' });

      // Verificar que el piloto existe
      const driverDoc = await db().doc(paths.driver(season, driver_id)).get();
      if (!driverDoc.exists) return res.status(404).json({ error: 'Piloto no encontrado' });

      const prefs = { uid, adopted_driver: driver_id, updated_at: new Date().toISOString() };
      const validation = validateF1Prefs(prefs);
      if (!validation.valid) return res.status(400).json({ error: validation.error });

      await db().doc(paths.f1Prefs(uid)).set(prefs, { merge: true });
      const driver = driverDoc.data();
      console.log(`[F1-ROUTES] Owner ${uid} adopto piloto: ${driver_id}`);
      res.json({ ok: true, adopted: driver_id, driver_name: driver.name, team: driver.team });
    } catch (err) {
      console.error(`[F1-ROUTES] POST adopt: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/f1/prefs ────────────────────────────────────
  router.get('/prefs', auth, async (req, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return res.status(401).json({ error: 'No autenticado' });
      const doc = await db().doc(paths.f1Prefs(uid)).get();
      res.json(doc.exists ? { uid, ...doc.data() } : { uid, adopted_driver: null, notifications: false });
    } catch (err) {
      console.error(`[F1-ROUTES] GET prefs: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ── PATCH /api/f1/prefs ──────────────────────────────────
  router.patch('/prefs', auth, async (req, res) => {
    try {
      const uid = req.user?.uid;
      if (!uid) return res.status(401).json({ error: 'No autenticado' });
      const allowed = ['notifications', 'adopted_driver'];
      const update = {};
      for (const k of allowed) {
        if (req.body[k] !== undefined) update[k] = req.body[k];
      }
      update.updated_at = new Date().toISOString();
      await db().doc(paths.f1Prefs(uid)).set(update, { merge: true });
      res.json({ ok: true, updated: update });
    } catch (err) {
      console.error(`[F1-ROUTES] PATCH prefs: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
