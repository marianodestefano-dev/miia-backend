/**
 * MIIA Sport Adapter — Golf
 * Usa Gemini google_search. Costo: $0/mes
 * Poll: 300s (golf es lento).
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
let _geminiSearch = null;

class GolfAdapter extends BaseSportAdapter {
  constructor() {
    super('golf', {
      pollIntervalMs: 300000,      // 5 min
      displayName: 'Golf',
      emoji: '⛳',
    });
  }

  static setDeps({ geminiSearch }) { _geminiSearch = geminiSearch; }

  async getSchedule(date) {
    if (!_geminiSearch) return [];
    try {
      const prompt = `¿Hay torneo de golf PGA/LPGA/Masters/Open en juego hoy ${date}? JSON:
[{"matchId":"tournament_name","name":"The Masters 2026 — Round 3","teams":["Scottie Scheffler","Rory McIlroy","Jon Rahm"],"startTime":"${date}T12:00:00Z","status":"live","league":"PGA Tour"}]
teams = top jugadores del torneo. Si no hay torneo: []`;
      const raw = await _geminiSearch(prompt);
      return this._parseJSON(raw, date);
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    if (!_geminiSearch) return null;
    const tournamentName = matchId.replace(/_/g, ' ');
    try {
      const prompt = `Leaderboard en vivo del torneo de golf "${tournamentName}" hoy. SOLO JSON:
{"tournament":"${tournamentName}","round":3,"leaderboard":[{"player":"Scheffler","score":-12,"position":1,"thru":14},{"player":"McIlroy","score":-10,"position":2,"thru":16}],"status":"live"}
score = total vs par (negativo = bajo par). thru = hoyos jugados hoy (1-18). Si terminó: status="finished". Si no hay datos: {"status":"not_found"}`;
      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) return [];

    const changes = [];
    const oldBoard = this._leaderboardMap(oldState);
    const newBoard = this._leaderboardMap(newState);

    for (const [player, newEntry] of Object.entries(newBoard)) {
      const oldEntry = oldBoard[player];
      if (!oldEntry) continue;

      // Subió al top-5
      if (newEntry.position <= 5 && oldEntry.position > 5) {
        changes.push({ type: 'position_change', description: `${player} subió a posición ${newEntry.position}! (${newEntry.score > 0 ? '+' : ''}${newEntry.score})`, emotion: 'high', data: { player, oldPos: oldEntry.position, newPos: newEntry.position, score: newEntry.score }, affectsTeams: [player] });
      }

      // Eagle o mejor (score bajó 2+ en un poll)
      if (newEntry.score < oldEntry.score - 1) {
        const diff = oldEntry.score - newEntry.score;
        changes.push({ type: 'eagle_or_better', description: `${diff >= 3 ? 'ALBATROSS' : 'EAGLE'} de ${player}! Ahora ${newEntry.score > 0 ? '+' : ''}${newEntry.score}`, emotion: 'explosive', data: { player, improvement: diff, score: newEntry.score }, affectsTeams: [player] });
      }
    }

    // Cambio de round
    if (newState.round > (oldState.round || 0)) {
      changes.push({ type: 'round_end', description: `Fin del round ${oldState.round}. Líder: ${newState.leaderboard?.[0]?.player || '?'} (${newState.leaderboard?.[0]?.score || 0})`, emotion: 'medium', data: newState, affectsTeams: (newState.leaderboard || []).map(l => l.player) });
    }

    // Torneo terminó
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const winner = newState.leaderboard?.[0];
      changes.push({ type: 'tournament_end', description: `Terminó! ${winner?.player || '?'} campeón con ${winner?.score || 0}`, emotion: 'high', data: { winner: winner?.player, score: winner?.score, leaderboard: newState.leaderboard?.slice(0, 5) }, affectsTeams: (newState.leaderboard || []).map(l => l.player) });
    }

    return changes;
  }

  matchesPreference(event, sportPref) {
    if (sportPref.type !== 'golf') return false;
    const target = this._normalize(sportPref.team || sportPref.driver || '');
    return (event.teams || []).some(t => this._normalize(t).includes(target) || target.includes(this._normalize(t)));
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Torneo'}`;
    const leader = state.leaderboard?.[0];
    return `${this.emoji} ${state.tournament} R${state.round} — Líder: ${leader?.player || '?'} (${leader?.score || 0})`;
  }

  getSentiment(change, player) {
    if (!change?.data?.player && !change?.data?.winner) return 'neutral';
    const p = change.data.winner || change.data.player || '';
    return this._normalize(p).includes(this._normalize(player)) ? 'positive' : 'neutral';
  }

  _leaderboardMap(state) { const m = {}; for (const e of (state?.leaderboard || [])) { m[e.player] = e; } return m; }
  _parseJSON(raw, date) { try { const m = raw.match(/\[[\s\S]*\]/); if (!m) return []; return JSON.parse(m[0]).map(e => ({ matchId: e.matchId, name: e.name, teams: e.teams||[], startTime: e.startTime||`${date}T00:00:00Z`, status: e.status||'scheduled', league: e.league||'PGA', metadata: {} })); } catch { return []; } }
  _parseLiveState(raw) { try { const m = raw.match(/\{[\s\S]*\}/); if (!m) return null; const p = JSON.parse(m[0]); return { tournament: p.tournament, round: parseInt(p.round)||1, leaderboard: Array.isArray(p.leaderboard) ? p.leaderboard : [], status: p.status||'unknown' }; } catch { return null; } }
}

module.exports = GolfAdapter;
