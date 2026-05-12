'use strict';

/**
 * CAT.3 — Onboarding wizard routes
 * POST /api/owner/onboarding/start
 * GET  /api/owner/onboarding/status
 * POST /api/owner/onboarding/complete-step/:n  (n = 1-5)
 */

const TOTAL_STEPS = 5;

let _db = null;
function __setFirestoreForTests(fs) { _db = fs; }
function db() { return _db || /* istanbul ignore next */ require('firebase-admin').firestore(); }

function _onboardDoc(uid) {
  return db().collection('owners').doc(uid).collection('onboarding').doc('wizard');
}

module.exports = function createOnboardingRoutes(opts) {
  const express = require('express');
  const router = express.Router();
  const requireAuth = (opts && opts.requireAuth) || function(req, res, next) { next(); };

  // POST /api/owner/onboarding/start
  router.post('/start', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      const doc = await _onboardDoc(uid).get();
      if (doc.exists && doc.data().completed) {
        return res.json({ ok: true, already_completed: true, step: TOTAL_STEPS });
      }
      const state = {
        step: doc.exists ? doc.data().step : 1,
        completed: false,
        steps_done: doc.exists ? (doc.data().steps_done || []) : [],
        started_at: doc.exists ? doc.data().started_at : new Date().toISOString(),
      };
      await _onboardDoc(uid).set(state, { merge: true });
      return res.json({ ok: true, step: state.step, total_steps: TOTAL_STEPS });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET /api/owner/onboarding/status
  router.get('/status', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    try {
      const doc = await _onboardDoc(uid).get();
      if (!doc.exists) return res.json({ step: 1, completed: false, steps_done: [] });
      const d = doc.data();
      return res.json({
        step: d.step || 1,
        completed: !!d.completed,
        steps_done: d.steps_done || [],
        total_steps: TOTAL_STEPS,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  // POST /api/owner/onboarding/complete-step/:n
  router.post('/complete-step/:n', requireAuth, async function(req, res) {
    const uid = req.user && req.user.uid;
    if (!uid) return res.status(401).json({ error: 'No autenticado' });

    const n = parseInt(req.params.n);
    if (isNaN(n) || n < 1 || n > TOTAL_STEPS) {
      return res.status(400).json({ error: 'Step invalido. Rango: 1-' + TOTAL_STEPS });
    }

    try {
      const doc = await _onboardDoc(uid).get();
      const current = doc.exists ? doc.data() : { step: 1, steps_done: [] };
      const stepsDone = Array.from(new Set((current.steps_done || []).concat([n])));
      const nextStep = Math.min(n + 1, TOTAL_STEPS);
      const allDone = stepsDone.length >= TOTAL_STEPS;

      await _onboardDoc(uid).set({
        step: allDone ? TOTAL_STEPS : nextStep,
        steps_done: stepsDone,
        completed: allDone,
        completed_at: allDone ? new Date().toISOString() : null,
      }, { merge: true });

      return res.json({ ok: true, step_completed: n, next_step: nextStep, completed: allDone });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
};

module.exports.__setFirestoreForTests = __setFirestoreForTests;
