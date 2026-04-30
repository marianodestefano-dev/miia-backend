/**
 * MIIA Sport Adapter — MLB (Béisbol)
 * Usa MLB Stats API (statsapi.mlb.com) — gratis, sin auth.
 * Costo: $0/mes
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
const fetch = require('node-fetch');

const MLB_BASE = 'https://statsapi.mlb.com';

class MLBAdapter extends BaseSportAdapter {
  constructor() {
    super('mlb', {
      pollIntervalMs: 90000,       // 90s
      displayName: 'MLB',
      emoji: '⚾',
    });
  }

  async getSchedule(date) {
    try {
      const url = `${MLB_BASE}/api/v1/schedule?sportId=1&date=${date}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) }); // T16-FIX HIGH-3
      if (!resp.ok) return [];
      const data = await resp.json();

      const games = [];
      for (const d of (data.dates || [])) {
        for (const g of (d.games || [])) {
          games.push({
            matchId: String(g.gamePk),
            name: `${g.teams?.away?.team?.name || '?'} @ ${g.teams?.home?.team?.name || '?'}`,
            teams: [g.teams?.away?.team?.name, g.teams?.home?.team?.name].filter(Boolean),
            startTime: g.gameDate || `${date}T00:00:00Z`,
            status: this._mapStatus(g.status?.detailedState),
            league: 'MLB',
            metadata: { gamePk: g.gamePk },
          });
        }
      }
      return games;
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    try {
      const url = `${MLB_BASE}/api/v1.1/game/${matchId}/feed/live`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) }); // T16-FIX HIGH-3
      if (!resp.ok) return null;
      const data = await resp.json();

      const linescore = data.liveData?.linescore;
      const status = data.gameData?.status;

      return {
        homeTeam: data.gameData?.teams?.home?.name || '',
        awayTeam: data.gameData?.teams?.away?.name || '',
        homeScore: linescore?.teams?.home?.runs || 0,
        awayScore: linescore?.teams?.away?.runs || 0,
        inning: linescore?.currentInning || 0,
        halfInning: linescore?.inningHalf === 'Top' ? 'top' : 'bottom',
        outs: linescore?.outs || 0,
        status: this._mapStatus(status?.detailedState),
        hits: { home: linescore?.teams?.home?.hits || 0, away: linescore?.teams?.away?.hits || 0 },
        errors: { home: linescore?.teams?.home?.errors || 0, away: linescore?.teams?.away?.errors || 0 },
      };
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      if (newState.status === 'live') return [{ type: 'game_start', description: `Play ball! ${newState.awayTeam} @ ${newState.homeTeam}`, emotion: 'medium', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] }];
      return [];
    }

    const changes = [];

    // Carreras del local
    if (newState.homeScore > (oldState.homeScore || 0)) {
      const diff = newState.homeScore - oldState.homeScore;
      const isHomeRun = diff >= 1;  // Simplificado — MLB API real detectaría HR
      changes.push({
        type: diff >= 3 ? 'home_run' : 'run_scored',
        description: `${diff >= 3 ? 'GRAND SLAM' : diff >= 2 ? 'JONRÓN' : 'Carrera'} de ${newState.homeTeam}! ${newState.awayScore}-${newState.homeScore} (${newState.inning}° inning)`,
        emotion: diff >= 3 ? 'explosive' : 'high',
        data: { team: newState.homeTeam, runs: diff, score: `${newState.awayScore}-${newState.homeScore}` },
        affectsTeams: [newState.homeTeam, newState.awayTeam],
      });
    }

    // Carreras del visitante
    if (newState.awayScore > (oldState.awayScore || 0)) {
      const diff = newState.awayScore - oldState.awayScore;
      changes.push({
        type: diff >= 3 ? 'home_run' : 'run_scored',
        description: `${diff >= 3 ? 'GRAND SLAM' : diff >= 2 ? 'JONRÓN' : 'Carrera'} de ${newState.awayTeam}! ${newState.awayScore}-${newState.homeScore} (${newState.inning}° inning)`,
        emotion: diff >= 3 ? 'explosive' : 'high',
        data: { team: newState.awayTeam, runs: diff, score: `${newState.awayScore}-${newState.homeScore}` },
        affectsTeams: [newState.homeTeam, newState.awayTeam],
      });
    }

    // Cambio de inning
    if (newState.inning > (oldState.inning || 0)) {
      changes.push({ type: 'inning_end', description: `Fin del ${oldState.inning}° inning: ${newState.awayTeam} ${newState.awayScore}-${newState.homeScore} ${newState.homeTeam}`, emotion: 'low', data: newState, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    // Fin del partido
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const winner = newState.homeScore > newState.awayScore ? newState.homeTeam : newState.awayTeam;
      changes.push({ type: 'game_end', description: `Final! ${winner} gana ${newState.awayScore}-${newState.homeScore}`, emotion: 'high', data: { winner, ...newState }, affectsTeams: [newState.homeTeam, newState.awayTeam] });
    }

    return changes;
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Partido'}`;
    return `${this.emoji} ${state.awayTeam} ${state.awayScore}-${state.homeScore} ${state.homeTeam} (${state.inning}° ${state.halfInning})`;
  }

  getSentiment(change, team) {
    if (!change?.data?.team && !change?.data?.winner) return 'neutral';
    const target = change.data.winner || change.data.team || '';
    return this._normalize(target).includes(this._normalize(team)) ? 'positive' : 'negative';
  }

  _mapStatus(detailedState) {
    if (!detailedState) return 'unknown';
    const s = detailedState.toLowerCase();
    if (s.includes('final') || s.includes('game over')) return 'finished';
    if (s.includes('in progress') || s.includes('live')) return 'live';
    if (s.includes('scheduled') || s.includes('pre-game')) return 'scheduled';
    if (s.includes('postponed')) return 'postponed';
    return 'unknown';
  }
}

module.exports = MLBAdapter;
