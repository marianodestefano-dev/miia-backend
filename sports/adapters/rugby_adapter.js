/**
 * MIIA Sport Adapter — Rugby
 * Usa Gemini google_search. Costo: $0/mes
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
let _geminiSearch = null;

class RugbyAdapter extends BaseSportAdapter {
  constructor() {
    super('rugby', {
      pollIntervalMs: 60000,
      displayName: 'Rugby',
      emoji: '🏉',
    });
  }

  static setDeps({ geminiSearch }) { _geminiSearch = geminiSearch; }

  async getSchedule(date) {
    if (!_geminiSearch) return [];
    try {
      const prompt = `Partidos de rugby importantes hoy ${date} (Six Nations, Rugby Championship, Pumas, All Blacks, Super Rugby, World Cup). JSON:
[{"matchId":"team1_vs_team2","name":"Argentina vs New Zealand","teams":["Argentina","New Zealand"],"startTime":"${date}T18:00:00Z","status":"scheduled","league":"Rugby Championship"}]
Si no hay: []`;
      const raw = await _geminiSearch(prompt);
      return this._parseJSON(raw, date);
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    if (!_geminiSearch) return null;
    const teams = matchId.split('_vs_').map(t => t.replace(/_/g, ' '));
    try {
      const prompt = `Score en vivo ${teams[0]} vs ${teams[1]} rugby hoy. SOLO JSON:
{"homeTeam":"${teams[0]}","awayTeam":"${teams[1]}","homeScore":0,"awayScore":0,"minute":0,"period":"first_half","status":"live"}
Periods: first_half, halftime, second_half, finished. Si no hay datos: {"status":"not_found"}`;
      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      if (newState.status === 'live') return [{ type: 'match_start', description: `Arrancó: ${newState.homeTeam} vs ${newState.awayTeam}`, emotion: 'medium', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] }];
      return [];
    }

    const changes = [];

    // Detectar tipo de anotación por diferencia de score
    for (const side of ['home', 'away']) {
      const team = side === 'home' ? newState.homeTeam : newState.awayTeam;
      const newScore = side === 'home' ? newState.homeScore : newState.awayScore;
      const oldScore = side === 'home' ? (oldState.homeScore || 0) : (oldState.awayScore || 0);
      const diff = newScore - oldScore;

      if (diff >= 7) {
        changes.push({ type: 'try_scored', description: `TRY + conversión de ${team}! (${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}, min ${newState.minute})`, emotion: 'explosive', data: { team, points: diff, score: `${newState.homeScore}-${newState.awayScore}` }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
      } else if (diff === 5) {
        changes.push({ type: 'try_scored', description: `TRY de ${team}! (${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}, min ${newState.minute})`, emotion: 'explosive', data: { team, points: diff }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
      } else if (diff === 3) {
        changes.push({ type: 'penalty_kick', description: `Penal de ${team} (${newState.homeScore}-${newState.awayScore}, min ${newState.minute})`, emotion: 'medium', data: { team, points: diff }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
      } else if (diff === 2) {
        changes.push({ type: 'conversion', description: `Conversión de ${team} (${newState.homeScore}-${newState.awayScore})`, emotion: 'medium', data: { team, points: diff }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
      }
    }

    if (oldState.period !== 'halftime' && newState.period === 'halftime') {
      changes.push({ type: 'halftime', description: `Entretiempo: ${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}`, emotion: 'low', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const winner = newState.homeScore > newState.awayScore ? newState.homeTeam : newState.awayTeam;
      changes.push({ type: 'match_end', description: `Final! ${winner} gana ${newState.homeScore}-${newState.awayScore}`, emotion: 'high', data: { winner, ...newState }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    return changes;
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Partido'}`;
    return `${this.emoji} ${state.homeTeam} ${state.homeScore}-${state.awayScore} ${state.awayTeam} (min ${state.minute})`;
  }

  getSentiment(change, team) {
    if (!change?.data?.team && !change?.data?.winner) return 'neutral';
    const t = change.data.winner || change.data.team || '';
    return this._normalize(t).includes(this._normalize(team)) ? 'positive' : 'negative';
  }

  _parseJSON(raw, date) { try { const m = raw.match(/\[[\s\S]*\]/); if (!m) return []; return JSON.parse(m[0]).map(e => ({ matchId: e.matchId, name: e.name, teams: e.teams||[], startTime: e.startTime||`${date}T00:00:00Z`, status: e.status||'scheduled', league: e.league||'', metadata: {} })); } catch { return []; } }

  _parseLiveState(raw) { try { const m = raw.match(/\{[\s\S]*\}/); if (!m) return null; const p = JSON.parse(m[0]); return { homeTeam: p.homeTeam, awayTeam: p.awayTeam, homeScore: parseInt(p.homeScore)||0, awayScore: parseInt(p.awayScore)||0, minute: parseInt(p.minute)||0, period: p.period||'unknown', status: p.status||'unknown' }; } catch { return null; } }
}

module.exports = RugbyAdapter;
