/**
 * MIIA Sport Adapter — Fórmula 1
 * Usa OpenF1 API (https://openf1.org) — 100% gratis, sin auth.
 * Costo: $0/mes
 *
 * Standard: Google + Amazon + Apple + NASA
 */

'use strict';

const BaseSportAdapter = require('../base_adapter');
const fetch = require('node-fetch');

const OPENF1_BASE = 'https://api.openf1.org/v1';

class F1Adapter extends BaseSportAdapter {
  constructor() {
    super('f1', {
      pollIntervalMs: 15000,       // 15s durante carrera
      displayName: 'Fórmula 1',
      emoji: '🏎️',
    });
    this._driverCache = {};  // session_key -> { driver_number: { name, team } }
  }

  async getSchedule(date) {
    try {
      const url = `${OPENF1_BASE}/sessions?date_start>=${date}&date_start<=${date}T23:59:59`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) }); // T16-FIX HIGH-3
      if (!resp.ok) return [];

      const sessions = await resp.json();
      if (!Array.isArray(sessions) || sessions.length === 0) return [];

      return sessions.map(s => ({
        matchId: String(s.session_key),
        name: `${s.meeting_name || 'GP'} — ${s.session_name || 'Sesión'}`,
        teams: [],  // Se resuelven con driver preferences
        startTime: s.date_start || date,
        status: s.session_key ? 'scheduled' : 'unknown',
        league: `F1 ${s.year || new Date().getFullYear()}`,
        metadata: {
          sessionKey: s.session_key,
          sessionType: s.session_type,  // 'Race', 'Qualifying', 'Practice', 'Sprint'
          meetingKey: s.meeting_key,
          circuitShortName: s.circuit_short_name,
        },
      }));
    } catch (err) {
      this._error(`getSchedule: ${err.message}`);
      return [];
    }
  }

  async getLiveState(matchId, metadata = {}) {
    const sessionKey = metadata.sessionKey || matchId;

    try {
      // Fetch posiciones, pit stops y race control en paralelo
      const [positionsRaw, pitsRaw, rcRaw] = await Promise.all([
        this._fetch(`/position?session_key=${sessionKey}&meeting_key=${metadata.meetingKey || ''}`),
        this._fetch(`/pit?session_key=${sessionKey}`),
        this._fetch(`/race_control?session_key=${sessionKey}`),
      ]);

      // Cargar cache de drivers si no existe
      if (!this._driverCache[sessionKey]) {
        await this._loadDrivers(sessionKey);
      }

      // Procesar posiciones — obtener la última posición de cada driver
      const latestPositions = this._getLatestPositions(positionsRaw || []);

      // Procesar flags
      const flags = (rcRaw || []).filter(rc =>
        rc.flag || rc.category === 'SafetyCar' || rc.category === 'Flag'
      );
      const lastFlag = flags.length > 0 ? flags[flags.length - 1] : null;

      // Procesar pit stops
      const pitStops = (pitsRaw || []).map(p => ({
        driverNumber: p.driver_number,
        driverName: this._driverName(sessionKey, p.driver_number),
        lap: p.lap_number,
        duration: p.pit_duration,
        timestamp: p.date,
      }));

      // Determinar status
      let status = 'live';
      if (lastFlag?.flag === 'CHEQUERED') status = 'finished';

      // Determinar vuelta actual
      const maxLap = latestPositions.reduce((max, p) => Math.max(max, p.lap || 0), 0);

      return {
        sessionKey,
        sessionType: metadata.sessionType || 'Race',
        positions: latestPositions.map(p => ({
          position: p.position,
          driverNumber: p.driver_number,
          driverName: this._driverName(sessionKey, p.driver_number),
          team: this._driverTeam(sessionKey, p.driver_number),
          lap: p.lap || 0,
        })),
        currentLap: maxLap,
        flags: flags.slice(-5),  // Últimas 5 flags
        currentFlag: lastFlag?.flag || 'GREEN',
        pitStops: pitStops.slice(-10),  // Últimos 10 pits
        status,
      };
    } catch (err) {
      this._error(`getLiveState: ${err.message}`);
      return null;
    }
  }

  detectChanges(oldState, newState) {
    if (!newState || newState.status === 'not_found') return [];
    if (!oldState) {
      return [{
        type: 'session_start',
        description: `Sesión F1 en vivo: ${newState.sessionType}`,
        emotion: 'medium',
        data: newState,
        affectsTeams: newState.positions.map(p => p.driverName),
      }];
    }

    const changes = [];
    const oldPositions = this._positionsMap(oldState);
    const newPositions = this._positionsMap(newState);

    // Cambios de posición significativos (podio, +3 posiciones)
    for (const [driver, newPos] of Object.entries(newPositions)) {
      const oldPos = oldPositions[driver];
      if (!oldPos) continue;

      const posDiff = oldPos.position - newPos.position;

      // Subió al podio
      if (newPos.position <= 3 && oldPos.position > 3) {
        changes.push({
          type: 'podium_entry',
          description: `${driver} subió a P${newPos.position}! (venía P${oldPos.position})`,
          emotion: 'explosive',
          data: { driver, oldPosition: oldPos.position, newPosition: newPos.position },
          affectsTeams: [driver],
        });
      }
      // Adelantó 3+ posiciones de golpe
      else if (posDiff >= 3) {
        changes.push({
          type: 'overtake',
          description: `${driver} pasó de P${oldPos.position} a P${newPos.position}! (+${posDiff} posiciones)`,
          emotion: 'high',
          data: { driver, oldPosition: oldPos.position, newPosition: newPos.position },
          affectsTeams: [driver],
        });
      }
      // Perdió 3+ posiciones
      else if (posDiff <= -3) {
        changes.push({
          type: 'position_loss',
          description: `${driver} cayó de P${oldPos.position} a P${newPos.position} (-${Math.abs(posDiff)} posiciones)`,
          emotion: 'high',
          data: { driver, oldPosition: oldPos.position, newPosition: newPos.position },
          affectsTeams: [driver],
        });
      }
      // Pasó a P1
      else if (newPos.position === 1 && oldPos.position !== 1) {
        changes.push({
          type: 'lead_change',
          description: `${driver} LIDERA LA CARRERA! P1!`,
          emotion: 'explosive',
          data: { driver, oldPosition: oldPos.position },
          affectsTeams: [driver],
        });
      }
    }

    // Safety Car
    if (newState.currentFlag !== oldState.currentFlag) {
      if (newState.currentFlag === 'YELLOW' || newState.currentFlag === 'SAFETY_CAR') {
        changes.push({
          type: 'safety_car',
          description: `Safety Car / Bandera amarilla en pista`,
          emotion: 'high',
          data: { flag: newState.currentFlag },
          affectsTeams: newState.positions.map(p => p.driverName),
        });
      }
      if (newState.currentFlag === 'RED') {
        changes.push({
          type: 'red_flag',
          description: `BANDERA ROJA — Sesión detenida`,
          emotion: 'explosive',
          data: { flag: 'RED' },
          affectsTeams: newState.positions.map(p => p.driverName),
        });
      }
    }

    // Carrera terminó
    if (oldState.status !== 'finished' && newState.status === 'finished') {
      const winner = newState.positions.find(p => p.position === 1);
      changes.push({
        type: 'race_end',
        description: `Terminó! Ganador: ${winner?.driverName || 'Desconocido'}`,
        emotion: 'explosive',
        data: { winner: winner?.driverName, positions: newState.positions.slice(0, 10) },
        affectsTeams: newState.positions.map(p => p.driverName),
      });
    }

    return changes;
  }

  matchesPreference(event, sportPref) {
    // Para F1, siempre hay preferencia si el tipo matchea — el filtro real
    // se hace en el engine al generar mensajes (por driver)
    return sportPref.type === 'f1';
  }

  formatEvent(event, state) {
    if (!state) return `${this.emoji} F1 — ${event?.name || 'Sesión'}`;
    const top3 = (state.positions || []).slice(0, 3).map(p => `P${p.position} ${p.driverName}`).join(', ');
    return `${this.emoji} F1 ${state.sessionType} — Vuelta ${state.currentLap} — ${top3}`;
  }

  getSentiment(change, driverOrTeam) {
    if (!change?.data?.driver || !driverOrTeam) return 'neutral';
    const norm = this._normalize(driverOrTeam);
    const changeDriver = this._normalize(change.data.driver);

    if (changeDriver.includes(norm) || norm.includes(changeDriver)) {
      if (['podium_entry', 'overtake', 'lead_change', 'race_end'].includes(change.type)) return 'positive';
      if (['position_loss'].includes(change.type)) return 'negative';
    }
    return 'neutral';
  }

  // ═══ HELPERS INTERNOS ═══

  async _fetch(path) {
    try {
      const resp = await fetch(`${OPENF1_BASE}${path}`, { signal: AbortSignal.timeout(10000) }); // T16-FIX HIGH-3
      if (!resp.ok) return [];
      return await resp.json();
    } catch (err) {
      this._error(`_fetch ${path}: ${err.message}`);
      return [];
    }
  }

  async _loadDrivers(sessionKey) {
    const drivers = await this._fetch(`/drivers?session_key=${sessionKey}`);
    const cache = {};
    for (const d of (drivers || [])) {
      cache[d.driver_number] = {
        name: d.full_name || `#${d.driver_number}`,
        team: d.team_name || '',
        acronym: d.name_acronym || '',
      };
    }
    this._driverCache[sessionKey] = cache;
  }

  _driverName(sessionKey, driverNumber) {
    return this._driverCache[sessionKey]?.[driverNumber]?.name || `#${driverNumber}`;
  }

  _driverTeam(sessionKey, driverNumber) {
    return this._driverCache[sessionKey]?.[driverNumber]?.team || '';
  }

  _getLatestPositions(positions) {
    // OpenF1 retorna múltiples registros por driver — quedarnos con el último
    const latest = {};
    for (const p of positions) {
      const key = p.driver_number;
      if (!latest[key] || new Date(p.date) > new Date(latest[key].date)) {
        latest[key] = p;
      }
    }
    return Object.values(latest).sort((a, b) => (a.position || 99) - (b.position || 99));
  }

  _positionsMap(state) {
    const map = {};
    for (const p of (state?.positions || [])) {
      map[p.driverName] = p;
    }
    return map;
  }
}

module.exports = F1Adapter;
