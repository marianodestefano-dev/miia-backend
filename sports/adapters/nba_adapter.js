/**
 * MIIA Sport Adapter — NBA (Básquet)
 * Usa Gemini google_search. Costo: $0/mes
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
let _geminiSearch = null;

class NBAAdapter extends BaseSportAdapter {
  constructor() {
    super('nba', {
      pollIntervalMs: 60000,
      displayName: 'NBA',
      emoji: '🏀',
    });
  }

  static setDeps({ geminiSearch }) { _geminiSearch = geminiSearch; }

  async getSchedule(date) {
    if (!_geminiSearch) return [];
    try {
      const prompt = `Listá los partidos de NBA de hoy ${date}. Formato JSON array:
[{"matchId":"team1_vs_team2","name":"Lakers vs Celtics","teams":["Lakers","Celtics"],"startTime":"${date}T19:30:00Z","status":"scheduled","league":"NBA"}]
Solo JSON.`;
      const raw = await _geminiSearch(prompt);
      return this._parseJSON(raw, date);
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    if (!_geminiSearch) return null;
    const teams = matchId.split('_vs_').map(t => t.replace(/_/g, ' '));
    try {
      const prompt = `Score en vivo ${teams[0]} vs ${teams[1]} NBA hoy. SOLO JSON:
{"homeTeam":"${teams[0]}","awayTeam":"${teams[1]}","homeScore":0,"awayScore":0,"quarter":1,"timeRemaining":"12:00","status":"live"}
Quarters: 1-4 + OT. Status: scheduled/live/halftime/finished. Si no hay datos: {"status":"not_found"}`;
      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      if (newState.status === 'live') return [{ type: 'game_start', description: `Arrancó: ${newState.homeTeam} vs ${newState.awayTeam}`, emotion: 'medium', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] }];
      return [];
    }

    const changes = [];

    // Cambio de quarter
    if (newState.quarter > (oldState.quarter || 0)) {
      changes.push({ type: 'quarter_end', description: `Fin del Q${oldState.quarter}: ${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}`, emotion: 'medium', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    // Ventaja de 20+ puntos
    const lead = Math.abs(newState.homeScore - newState.awayScore);
    const oldLead = Math.abs((oldState.homeScore || 0) - (oldState.awayScore || 0));
    if (lead >= 20 && oldLead < 20) {
      const leader = newState.homeScore > newState.awayScore ? newState.homeTeam : newState.awayTeam;
      changes.push({ type: 'big_lead', description: `${leader} destruyendo! +${lead} puntos de ventaja`, emotion: 'high', data: { leader, lead }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    // Comeback (estaba -10+ y ahora gana)
    const oldLeader = oldState.homeScore > oldState.awayScore ? 'home' : 'away';
    const newLeader = newState.homeScore > newState.awayScore ? 'home' : 'away';
    if (oldLeader !== newLeader && oldLead >= 10) {
      const comeback = newLeader === 'home' ? newState.homeTeam : newState.awayTeam;
      changes.push({ type: 'comeback', description: `REMONTADA de ${comeback}! Estaba -${oldLead} y ahora gana`, emotion: 'explosive', data: { team: comeback }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    // Overtime
    if (newState.quarter > 4 && (oldState.quarter || 0) <= 4) {
      changes.push({ type: 'overtime', description: `OVERTIME! ${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}`, emotion: 'explosive', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    // Fin del partido
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const winner = newState.homeScore > newState.awayScore ? newState.homeTeam : newState.awayTeam;
      changes.push({ type: 'game_end', description: `Terminó! ${winner} gana ${newState.homeScore}-${newState.awayScore}`, emotion: 'high', data: { winner, ...newState }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    return changes;
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Partido'}`;
    return `${this.emoji} ${state.homeTeam} ${state.homeScore}-${state.awayScore} ${state.awayTeam} (Q${state.quarter} ${state.timeRemaining})`;
  }

  getSentiment(change, team) {
    if (!change || !team) return 'neutral';
    const norm = this._normalize(team);
    if (change.data?.winner) return this._normalize(change.data.winner).includes(norm) ? 'positive' : 'negative';
    if (change.data?.leader) return this._normalize(change.data.leader).includes(norm) ? 'positive' : 'negative';
    if (change.data?.team) return this._normalize(change.data.team).includes(norm) ? 'positive' : 'negative';
    return 'neutral';
  }

  _parseJSON(raw, date) {
    try { const m = raw.match(/\[[\s\S]*\]/); if (!m) return []; return JSON.parse(m[0]).map(e => ({ matchId: e.matchId || `${this._normalize(e.teams?.[0])}_vs_${this._normalize(e.teams?.[1])}`, name: e.name, teams: e.teams || [], startTime: e.startTime || `${date}T00:00:00Z`, status: e.status || 'scheduled', league: e.league || 'NBA', metadata: {} })); } catch { return []; }
  }

  _parseLiveState(raw) {
    try { const m = raw.match(/\{[\s\S]*\}/); if (!m) return null; const p = JSON.parse(m[0]); return { homeTeam: p.homeTeam, awayTeam: p.awayTeam, homeScore: parseInt(p.homeScore)||0, awayScore: parseInt(p.awayScore)||0, quarter: parseInt(p.quarter)||1, timeRemaining: p.timeRemaining||'', status: p.status||'unknown' }; } catch { return null; }
  }
}

module.exports = NBAAdapter;
