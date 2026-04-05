/**
 * MIIA Sport Adapter — Fútbol
 * Usa Gemini google_search para obtener resultados en vivo.
 * Costo: $0/mes
 *
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');

// Gemini se inyecta en runtime via setDeps
let _geminiSearch = null;

class FutbolAdapter extends BaseSportAdapter {
  constructor() {
    super('futbol', {
      pollIntervalMs: 60000,       // 60s durante partido
      displayName: 'Fútbol',
      emoji: '⚽',
    });
  }

  /**
   * Inyectar dependencia de Gemini google_search.
   * @param {Function} geminiSearchFn — (prompt) => Promise<string>
   */
  static setDeps({ geminiSearch }) {
    _geminiSearch = geminiSearch;
  }

  async getSchedule(date) {
    if (!_geminiSearch) {
      this._error('geminiSearch no inyectado');
      return [];
    }

    try {
      const prompt = `Listá los partidos de fútbol importantes de hoy ${date} (ligas argentinas, europeas, Champions, Libertadores, Copa América, Mundial). Para cada partido indicá: equipos, liga, horario (UTC), y si ya empezó o terminó. Formato JSON array:
[{"matchId":"team1_vs_team2","name":"Team1 vs Team2","teams":["Team1","Team2"],"startTime":"${date}T21:00:00Z","status":"scheduled","league":"Liga Argentina"}]
Solo devolvé el JSON, nada más.`;

      const raw = await _geminiSearch(prompt);
      return this._parseScheduleResponse(raw, date);
    } catch (err) {
      this._error(`getSchedule: ${err.message}`);
      return [];
    }
  }

  async getLiveState(matchId, metadata = {}) {
    if (!_geminiSearch) return null;

    const teams = matchId.split('_vs_');
    const teamA = teams[0]?.replace(/_/g, ' ') || matchId;
    const teamB = teams[1]?.replace(/_/g, ' ') || '';

    try {
      const prompt = `Resultado en vivo de ${teamA} vs ${teamB} hoy. Respondé SOLO en JSON:
{"homeTeam":"${teamA}","awayTeam":"${teamB}","homeScore":0,"awayScore":0,"minute":0,"period":"first_half","status":"live","events":[]}
Periodos: pre_match, first_half, halftime, second_half, extra_time, penalties, finished.
Events: [{"type":"goal","team":"...","minute":14,"player":"..."}]
Si no encontrás datos, respondé: {"status":"not_found"}`;

      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) {
      this._error(`getLiveState: ${err.message}`);
      return null;
    }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      // Primer poll — si ya hay goles, reportar estado inicial
      if (newState.status === 'live') {
        return [{
          type: 'match_start',
          description: `Arrancó: ${newState.homeTeam} vs ${newState.awayTeam}`,
          emotion: 'medium',
          data: newState,
          affectsTeams: [newState.homeTeam, newState.awayTeam],
        }];
      }
      return [];
    }

    const changes = [];

    // Gol del local
    if (newState.homeScore > (oldState.homeScore || 0)) {
      const diff = newState.homeScore - (oldState.homeScore || 0);
      changes.push({
        type: 'goal',
        description: `GOL de ${newState.homeTeam}! Ahora ${newState.homeScore}-${newState.awayScore} (min ${newState.minute})`,
        emotion: 'explosive',
        data: { team: newState.homeTeam, score: `${newState.homeScore}-${newState.awayScore}`, minute: newState.minute },
        affectsTeams: [newState.homeTeam, newState.awayTeam],
      });
    }

    // Gol del visitante
    if (newState.awayScore > (oldState.awayScore || 0)) {
      changes.push({
        type: 'goal',
        description: `GOL de ${newState.awayTeam}! Ahora ${newState.homeScore}-${newState.awayScore} (min ${newState.minute})`,
        emotion: 'explosive',
        data: { team: newState.awayTeam, score: `${newState.homeScore}-${newState.awayScore}`, minute: newState.minute },
        affectsTeams: [newState.homeTeam, newState.awayTeam],
      });
    }

    // Entretiempo
    if (oldState.period !== 'halftime' && newState.period === 'halftime') {
      changes.push({
        type: 'halftime',
        description: `Entretiempo: ${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}`,
        emotion: 'low',
        data: newState,
        affectsTeams: [newState.homeTeam, newState.awayTeam],
      });
    }

    // Fin del partido
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      changes.push({
        type: 'match_end',
        description: `Terminó! ${newState.homeTeam} ${newState.homeScore}-${newState.awayScore} ${newState.awayTeam}`,
        emotion: 'high',
        data: newState,
        affectsTeams: [newState.homeTeam, newState.awayTeam],
      });
    }

    // Roja (detectar en events)
    if (newState.events?.length > (oldState.events?.length || 0)) {
      const newEvents = newState.events.slice(oldState.events?.length || 0);
      for (const ev of newEvents) {
        if (ev.type === 'red_card') {
          changes.push({
            type: 'red_card',
            description: `Roja para ${ev.team}${ev.player ? ` (${ev.player})` : ''} min ${ev.minute}`,
            emotion: 'high',
            data: ev,
            affectsTeams: [ev.team],
          });
        }
        if (ev.type === 'penalty') {
          changes.push({
            type: 'penalty',
            description: `Penal para ${ev.team} min ${ev.minute}`,
            emotion: 'explosive',
            data: ev,
            affectsTeams: [ev.team],
          });
        }
      }
    }

    return changes;
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Partido'}`;
    return `${this.emoji} ${state.homeTeam} ${state.homeScore}-${state.awayScore} ${state.awayTeam} (min ${state.minute}, ${state.period})`;
  }

  getSentiment(change, team) {
    if (!change || !team) return 'neutral';
    const norm = this._normalize(team);

    if (change.type === 'goal') {
      const goalTeam = this._normalize(change.data?.team || '');
      if (goalTeam.includes(norm) || norm.includes(goalTeam)) return 'positive';
      return 'negative';
    }
    if (change.type === 'match_end' && change.data) {
      const { homeTeam, awayTeam, homeScore, awayScore } = change.data;
      const isHome = this._normalize(homeTeam).includes(norm) || norm.includes(this._normalize(homeTeam));
      if (isHome) return homeScore > awayScore ? 'positive' : homeScore < awayScore ? 'negative' : 'neutral';
      return awayScore > homeScore ? 'positive' : awayScore < homeScore ? 'negative' : 'neutral';
    }
    return 'neutral';
  }

  // ═══ PARSERS INTERNOS ═══

  _parseScheduleResponse(raw, date) {
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map(e => ({
        matchId: e.matchId || `${this._normalize(e.teams?.[0] || '')}_vs_${this._normalize(e.teams?.[1] || '')}`,
        name: e.name || `${e.teams?.[0]} vs ${e.teams?.[1]}`,
        teams: e.teams || [],
        startTime: e.startTime || `${date}T00:00:00Z`,
        status: e.status || 'scheduled',
        league: e.league || '',
        metadata: {},
      }));
    } catch (err) {
      this._error(`_parseScheduleResponse: ${err.message}`);
      return [];
    }
  }

  _parseLiveState(raw) {
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        homeTeam: parsed.homeTeam || '',
        awayTeam: parsed.awayTeam || '',
        homeScore: parseInt(parsed.homeScore, 10) || 0,
        awayScore: parseInt(parsed.awayScore, 10) || 0,
        minute: parseInt(parsed.minute, 10) || 0,
        period: parsed.period || 'unknown',
        status: parsed.status || 'unknown',
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (err) {
      this._error(`_parseLiveState: ${err.message}`);
      return null;
    }
  }
}

module.exports = FutbolAdapter;
