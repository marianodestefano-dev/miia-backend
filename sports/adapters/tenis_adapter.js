/**
 * MIIA Sport Adapter — Tenis
 * Usa Gemini google_search. Costo: $0/mes
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
let _geminiSearch = null;

class TenisAdapter extends BaseSportAdapter {
  constructor() {
    super('tenis', {
      pollIntervalMs: 90000,       // 90s (tenis cambia rápido pero Gemini tiene latencia)
      displayName: 'Tenis',
      emoji: '🎾',
    });
  }

  static setDeps({ geminiSearch }) { _geminiSearch = geminiSearch; }

  async getSchedule(date) {
    if (!_geminiSearch) return [];
    try {
      const prompt = `Listá los partidos de tenis importantes de hoy ${date} (Grand Slams, ATP Masters, WTA 1000, Davis Cup). Formato JSON array:
[{"matchId":"player1_vs_player2","name":"Player1 vs Player2","teams":["Player1","Player2"],"startTime":"${date}T14:00:00Z","status":"scheduled","league":"Roland Garros"}]
Solo devolvé el JSON.`;
      const raw = await _geminiSearch(prompt);
      return this._parseJSON(raw, date);
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    if (!_geminiSearch) return null;
    const players = matchId.split('_vs_').map(p => p.replace(/_/g, ' '));
    try {
      const prompt = `Score en vivo de ${players[0] || matchId} vs ${players[1] || ''} tenis hoy. SOLO JSON:
{"player1":"${players[0]}","player2":"${players[1]}","sets":[[6,4],[3,6],[2,1]],"serving":"player1","currentSet":3,"currentGame":"2-1","status":"live"}
Si terminó: status="finished". Si no hay datos: {"status":"not_found"}`;
      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      if (newState.status === 'live') {
        return [{ type: 'match_start', description: `Arrancó: ${newState.player1} vs ${newState.player2}`, emotion: 'medium', data: newState, affectsTeams: [newState.player1, newState.player2] }];
      }
      return [];
    }

    const changes = [];
    const oldSets = oldState.sets || [];
    const newSets = newState.sets || [];

    // Set ganado
    if (newSets.length > oldSets.length) {
      const lastSet = newSets[newSets.length - 1];
      const winner = lastSet[0] > lastSet[1] ? newState.player1 : newState.player2;
      changes.push({
        type: 'set_won',
        description: `${winner} ganó el set ${newSets.length - 1}! (${lastSet[0]}-${lastSet[1]})`,
        emotion: 'high',
        data: { winner, setNumber: newSets.length - 1, score: lastSet },
        affectsTeams: [newState.player1, newState.player2],
      });
    }

    // Tiebreak (6-6 en set actual)
    if (newSets.length > 0) {
      const current = newSets[newSets.length - 1];
      if (current[0] === 6 && current[1] === 6 && !(oldSets[oldSets.length - 1]?.[0] === 6 && oldSets[oldSets.length - 1]?.[1] === 6)) {
        changes.push({
          type: 'tiebreak',
          description: `Tiebreak en el set ${newSets.length}!`,
          emotion: 'high',
          data: { set: newSets.length },
          affectsTeams: [newState.player1, newState.player2],
        });
      }
    }

    // Partido terminado
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const p1Sets = newSets.filter(s => s[0] > s[1]).length;
      const p2Sets = newSets.filter(s => s[1] > s[0]).length;
      const winner = p1Sets > p2Sets ? newState.player1 : newState.player2;
      changes.push({
        type: 'match_end',
        description: `Terminó! ${winner} ganó ${p1Sets}-${p2Sets} en sets`,
        emotion: 'explosive',
        data: { winner, sets: newSets, p1Sets, p2Sets },
        affectsTeams: [newState.player1, newState.player2],
      });
    }

    return changes;
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Partido'}`;
    const setsStr = (state.sets || []).map(s => `${s[0]}-${s[1]}`).join(', ');
    return `${this.emoji} ${state.player1} vs ${state.player2} — Sets: ${setsStr}`;
  }

  getSentiment(change, player) {
    if (!change?.data?.winner || !player) return 'neutral';
    return this._normalize(change.data.winner).includes(this._normalize(player)) ? 'positive' : 'negative';
  }

  _parseJSON(raw, date) {
    try {
      const m = raw.match(/\[[\s\S]*\]/);
      if (!m) return [];
      return JSON.parse(m[0]).map(e => ({
        matchId: e.matchId || `${this._normalize(e.teams?.[0])}_vs_${this._normalize(e.teams?.[1])}`,
        name: e.name, teams: e.teams || [], startTime: e.startTime || `${date}T00:00:00Z`,
        status: e.status || 'scheduled', league: e.league || '', metadata: {},
      }));
    } catch { return []; }
  }

  _parseLiveState(raw) {
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const p = JSON.parse(m[0]);
      return { player1: p.player1, player2: p.player2, sets: p.sets || [], serving: p.serving, currentSet: p.currentSet || 1, currentGame: p.currentGame || '0-0', status: p.status || 'unknown' };
    } catch { return null; }
  }
}

module.exports = TenisAdapter;
