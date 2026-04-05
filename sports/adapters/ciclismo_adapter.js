/**
 * MIIA Sport Adapter — Ciclismo
 * Usa Gemini google_search. Costo: $0/mes
 * Poll: 300s. Temporada: Tour (Jun-Jul), Giro (May-Jun), Vuelta (Ago-Sep) + monumentos.
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
let _geminiSearch = null;

class CiclismoAdapter extends BaseSportAdapter {
  constructor() {
    super('ciclismo', {
      pollIntervalMs: 300000,      // 5 min (ciclismo es largo)
      displayName: 'Ciclismo',
      emoji: '🚴',
    });
  }

  static setDeps({ geminiSearch }) { _geminiSearch = geminiSearch; }

  async getSchedule(date) {
    if (!_geminiSearch) return [];
    try {
      const prompt = `¿Hay etapa de ciclismo profesional hoy ${date}? (Tour de France, Giro d'Italia, Vuelta a España, clásicas monumentales, Mundial). JSON:
[{"matchId":"tour_stage_15","name":"Tour de France — Etapa 15","teams":["Pogacar","Vingegaard","Evenepoel"],"startTime":"${date}T11:00:00Z","status":"live","league":"Tour de France"}]
teams = favoritos/líderes de la general. Si no hay etapa: []`;
      const raw = await _geminiSearch(prompt);
      return this._parseJSON(raw, date);
    } catch (err) { this._error(`getSchedule: ${err.message}`); return []; }
  }

  async getLiveState(matchId) {
    if (!_geminiSearch) return null;
    const raceName = matchId.replace(/_/g, ' ');
    try {
      const prompt = `Estado en vivo de la etapa de ciclismo "${raceName}" hoy. SOLO JSON:
{"race":"Tour de France","stage":"Etapa 15","kmRemaining":45,"leaders":[{"rider":"Pogacar","team":"UAE","gap":"0:00"}],"gc":[{"rider":"Pogacar","time":"52:30:00","gap":"0:00"},{"rider":"Vingegaard","time":"52:32:15","gap":"+2:15"}],"status":"live"}
leaders = ciclistas al frente. gc = clasificación general. Si terminó: status="finished". Si no hay datos: {"status":"not_found"}`;
      const raw = await _geminiSearch(prompt);
      return this._parseLiveState(raw);
    } catch (err) { this._error(`getLiveState: ${err.message}`); return null; }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) return [];

    const changes = [];

    // Cambio de líder en etapa
    const oldLeader = oldState.leaders?.[0]?.rider;
    const newLeader = newState.leaders?.[0]?.rider;
    if (oldLeader && newLeader && oldLeader !== newLeader) {
      changes.push({ type: 'breakaway', description: `${newLeader} ahora lidera la etapa! (faltan ${newState.kmRemaining}km)`, emotion: 'medium', data: { rider: newLeader, kmRemaining: newState.kmRemaining }, affectsTeams: [newLeader] });
    }

    // Cambio en clasificación general
    const oldGCLeader = oldState.gc?.[0]?.rider;
    const newGCLeader = newState.gc?.[0]?.rider;
    if (oldGCLeader && newGCLeader && oldGCLeader !== newGCLeader) {
      changes.push({ type: 'gc_change', description: `CAMBIO DE LÍDER! ${newGCLeader} es el nuevo líder de la general!`, emotion: 'explosive', data: { rider: newGCLeader, gc: newState.gc?.slice(0, 5) }, affectsTeams: [newGCLeader, oldGCLeader] });
    }

    // Etapa terminó
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const stageWinner = newState.leaders?.[0]?.rider || '?';
      const gcLeader = newState.gc?.[0]?.rider || '?';
      changes.push({ type: 'stage_finish', description: `Etapa terminada! Ganador: ${stageWinner}. Líder general: ${gcLeader}`, emotion: 'high', data: { stageWinner, gcLeader, gc: newState.gc?.slice(0, 5) }, affectsTeams: [stageWinner, gcLeader] });
    }

    // Últimos km (< 10km y antes no era < 10)
    if (newState.kmRemaining <= 10 && (oldState.kmRemaining || 999) > 10) {
      changes.push({ type: 'final_km', description: `Últimos ${newState.kmRemaining}km! Líderes: ${(newState.leaders || []).slice(0, 3).map(l => l.rider).join(', ')}`, emotion: 'high', data: { kmRemaining: newState.kmRemaining, leaders: newState.leaders?.slice(0, 5) }, affectsTeams: (newState.leaders || []).map(l => l.rider) });
    }

    return changes;
  }

  matchesPreference(event, sportPref) {
    if (sportPref.type !== 'ciclismo') return false;
    const target = this._normalize(sportPref.team || sportPref.driver || '');
    return (event.teams || []).some(t => this._normalize(t).includes(target) || target.includes(this._normalize(t)));
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} ${event?.name || 'Etapa'}`;
    const leader = state.leaders?.[0]?.rider || '?';
    return `${this.emoji} ${state.race} ${state.stage} — ${state.kmRemaining}km restantes — Líder: ${leader}`;
  }

  getSentiment(change, rider) {
    if (!change?.data?.rider && !change?.data?.stageWinner) return 'neutral';
    const r = change.data.stageWinner || change.data.rider || '';
    return this._normalize(r).includes(this._normalize(rider)) ? 'positive' : 'neutral';
  }

  _parseJSON(raw, date) { try { const m = raw.match(/\[[\s\S]*\]/); if (!m) return []; return JSON.parse(m[0]).map(e => ({ matchId: e.matchId, name: e.name, teams: e.teams||[], startTime: e.startTime||`${date}T00:00:00Z`, status: e.status||'scheduled', league: e.league||'', metadata: {} })); } catch { return []; } }
  _parseLiveState(raw) { try { const m = raw.match(/\{[\s\S]*\}/); if (!m) return null; const p = JSON.parse(m[0]); return { race: p.race, stage: p.stage, kmRemaining: parseInt(p.kmRemaining)||0, leaders: Array.isArray(p.leaders)?p.leaders:[], gc: Array.isArray(p.gc)?p.gc:[], status: p.status||'unknown' }; } catch { return null; } }
}

module.exports = CiclismoAdapter;
