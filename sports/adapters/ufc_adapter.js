/**
 * MIIA Sport Adapter — UFC/MMA
 * Usa Gemini google_search. Costo: $0/mes
 * Eventos infrecuentes (~2/mes). Poll: 120s.
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
let _geminiSearch = null;

class UFCAdapter extends BaseSportAdapter {
  constructor() {
    super('ufc', {
      pollIntervalMs: 120000,      // 120s (peleas son largas entre rounds)
      displayName: 'UFC / MMA',
      emoji: '🥊',
    });
  }

  static setDeps({ geminiSearch }) { _geminiSearch = geminiSearch; }

  async getSchedule(date) {
    if (!_geminiSearch) return [];
    try {
      const prompt = `¿Hay evento UFC o pelea de MMA importante hoy ${date}? Formato JSON:
[{"matchId":"fighter1_vs_fighter2","name":"UFC 300 — Fighter1 vs Fighter2","teams":["Fighter1","Fighter2"],"startTime":"${date}T22:00:00Z","status":"scheduled","league":"UFC"}]
Si no hay evento hoy, respondé: []`;
      const raw = await _geminiSearch(prompt);
      return this._parseJSON(raw, date);
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    if (!_geminiSearch) return null;
    const fighters = matchId.split('_vs_').map(f => f.replace(/_/g, ' '));
    try {
      const prompt = `Resultado/estado de la pelea ${fighters[0]} vs ${fighters[1]} UFC/MMA hoy. SOLO JSON:
{"eventName":"UFC 300","fighter1":"${fighters[0]}","fighter2":"${fighters[1]}","currentRound":2,"totalRounds":5,"result":null,"method":null,"winner":null,"status":"live"}
Methods: KO, TKO, Submission, Decision, Split_Decision. Si terminó: status="finished", result="winner_name", method="KO". Si no hay datos: {"status":"not_found"}`;
      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      if (newState.status === 'live') return [{ type: 'fight_start', description: `Pelea en curso: ${newState.fighter1} vs ${newState.fighter2}`, emotion: 'high', data: newState, affectsTeams: [newState.fighter1, newState.fighter2] }];
      return [];
    }

    const changes = [];

    // Cambio de round
    if (newState.currentRound > (oldState.currentRound || 0)) {
      changes.push({ type: 'round_end', description: `Fin del round ${oldState.currentRound}. ${newState.fighter1} vs ${newState.fighter2}`, emotion: 'medium', data: newState, affectsTeams: [newState.fighter1, newState.fighter2] });
    }

    // Pelea terminó
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const method = (newState.method || '').toUpperCase();
      const isKO = method.includes('KO') || method.includes('TKO');
      const isSub = method.includes('SUB');

      changes.push({
        type: isKO ? 'knockout' : isSub ? 'submission' : 'fight_result',
        description: `${newState.winner || '?'} gana por ${newState.method || 'decisión'}! Round ${newState.currentRound}`,
        emotion: 'explosive',
        data: { winner: newState.winner, method: newState.method, round: newState.currentRound },
        affectsTeams: [newState.fighter1, newState.fighter2],
      });
    }

    return changes;
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Pelea'}`;
    return `${this.emoji} ${state.fighter1} vs ${state.fighter2} — Round ${state.currentRound}/${state.totalRounds}`;
  }

  getSentiment(change, fighter) {
    if (!change?.data?.winner || !fighter) return 'neutral';
    return this._normalize(change.data.winner).includes(this._normalize(fighter)) ? 'positive' : 'negative';
  }

  _parseJSON(raw, date) {
    try { const m = raw.match(/\[[\s\S]*\]/); if (!m) return []; return JSON.parse(m[0]).map(e => ({ matchId: e.matchId, name: e.name, teams: e.teams || [], startTime: e.startTime || `${date}T00:00:00Z`, status: e.status || 'scheduled', league: e.league || 'UFC', metadata: {} })); } catch { return []; }
  }

  _parseLiveState(raw) {
    try { const m = raw.match(/\{[\s\S]*\}/); if (!m) return null; const p = JSON.parse(m[0]); return { eventName: p.eventName, fighter1: p.fighter1, fighter2: p.fighter2, currentRound: parseInt(p.currentRound)||1, totalRounds: parseInt(p.totalRounds)||5, result: p.result, method: p.method, winner: p.winner, status: p.status||'unknown' }; } catch { return null; }
  }
}

module.exports = UFCAdapter;
