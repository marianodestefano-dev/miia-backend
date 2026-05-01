'use strict';

/**
 * MiiaF1 -- SVG circuit maps (F1.17)
 * 24 circuitos de F1 2025 en formato SVG esquematico.
 * viewBox normalizado: 0 0 400 300
 * Estilo: trazo 4px grad #00E5FF->lColor, fondo #0A0A12
 */

// Datos esquematicos de los 24 circuitos 2025
// trackPath: polyline simplificado del trazado
const CIRCUITS = {
  australia: {
    name: 'Albert Park',
    country: 'Australia',
    laps: 58,
    length_km: 5.278,
    color: '#00E5FF',
    // Trazado esquematico Albert Park (cuadrado redondeado con chicane)
    path: 'M 80,80 L 320,80 Q 340,80 340,100 L 340,200 Q 340,220 320,220 L 180,220 Q 160,220 150,230 L 120,250 Q 100,260 80,250 Q 60,240 60,220 L 60,100 Q 60,80 80,80 Z',
  },
  china: {
    name: 'Shanghai International',
    country: 'China',
    laps: 56,
    length_km: 5.451,
    color: '#FF1744',
    path: 'M 60,150 Q 60,80 120,80 L 200,80 Q 250,80 270,120 L 280,160 Q 290,190 260,210 L 200,220 L 150,250 Q 120,260 100,240 Q 60,220 60,190 Z',
  },
  japan: {
    name: 'Suzuka',
    country: 'Japan',
    laps: 53,
    length_km: 5.807,
    color: '#FF6D00',
    path: 'M 80,60 L 200,60 Q 300,60 310,130 Q 320,200 250,220 L 180,230 Q 120,235 100,200 L 80,160 Q 60,130 80,100 Z M 180,60 Q 220,100 200,140 Q 180,180 160,160 Q 140,140 160,100 Z',
  },
  bahrain: {
    name: 'Bahrain International',
    country: 'Bahrain',
    laps: 57,
    length_km: 5.412,
    color: '#7C3AED',
    path: 'M 100,80 L 300,80 Q 330,80 330,110 L 330,140 Q 330,160 300,165 L 200,170 L 200,200 L 280,200 Q 310,200 310,225 Q 310,250 280,250 L 120,250 Q 90,250 90,225 Q 90,200 120,200 L 160,200 L 160,165 L 70,165 Q 70,140 100,140 L 280,140 Q 300,140 300,120 L 300,100 L 100,100 Z',
  },
  saudi_arabia: {
    name: 'Jeddah Corniche',
    country: 'Saudi Arabia',
    laps: 50,
    length_km: 6.174,
    color: '#4CAF50',
    path: 'M 60,250 L 60,60 Q 60,40 80,40 L 340,40 Q 360,40 360,60 L 360,80 Q 360,100 340,100 L 200,100 Q 180,100 180,120 L 180,180 Q 180,200 200,200 L 340,200 Q 360,200 360,220 L 360,250 L 60,250 Z',
  },
  miami: {
    name: 'Miami International',
    country: 'USA (Miami)',
    laps: 57,
    length_km: 5.412,
    color: '#E91E63',
    path: 'M 80,60 L 300,60 Q 340,60 340,100 L 340,160 Q 340,190 310,200 L 200,200 L 180,220 L 180,250 L 100,250 Q 70,250 70,220 L 70,190 L 200,190 L 200,80 L 80,80 Z',
  },
  imola: {
    name: 'Imola',
    country: 'Italy',
    laps: 63,
    length_km: 4.909,
    color: '#FF1744',
    path: 'M 200,40 Q 300,40 320,100 Q 340,160 280,200 Q 240,220 180,220 Q 100,220 80,160 Q 60,100 120,60 Q 160,40 200,40 Z',
  },
  monaco: {
    name: 'Circuit de Monaco',
    country: 'Monaco',
    laps: 78,
    length_km: 3.337,
    color: '#FFC107',
    path: 'M 80,200 L 80,80 Q 80,60 100,60 L 200,60 Q 240,60 260,90 L 320,90 Q 340,90 340,110 L 340,150 L 260,150 L 240,180 L 240,220 L 180,250 L 100,250 Q 80,240 80,220 Z',
  },
  canada: {
    name: 'Circuit Gilles Villeneuve',
    country: 'Canada',
    laps: 70,
    length_km: 4.361,
    color: '#FF1744',
    path: 'M 100,60 L 300,60 Q 330,60 330,90 L 330,140 Q 330,160 300,160 L 200,160 Q 180,160 180,180 L 180,220 Q 180,250 150,250 L 100,250 Q 70,250 70,220 L 70,90 Q 70,60 100,60 Z',
  },
  spain: {
    name: 'Circuit de Barcelona',
    country: 'Spain',
    laps: 66,
    length_km: 4.657,
    color: '#FFC107',
    path: 'M 80,80 L 300,80 Q 330,80 330,110 L 330,150 Q 310,170 280,165 L 220,160 Q 200,160 195,180 L 200,200 L 280,200 Q 310,200 320,220 Q 330,240 310,250 L 100,250 Q 70,250 70,220 L 70,110 Q 70,80 80,80 Z',
  },
  austria: {
    name: 'Red Bull Ring',
    country: 'Austria',
    laps: 71,
    length_km: 4.318,
    color: '#2196F3',
    path: 'M 150,60 Q 200,40 250,60 L 320,120 Q 350,150 330,200 L 280,240 Q 240,260 200,240 L 120,200 Q 80,170 80,130 Q 80,80 150,60 Z',
  },
  britain: {
    name: 'Silverstone',
    country: 'Great Britain',
    laps: 52,
    length_km: 5.891,
    color: '#2196F3',
    path: 'M 100,80 L 280,80 Q 340,80 340,140 L 320,200 Q 300,230 260,230 L 200,220 L 140,250 Q 100,255 80,230 Q 60,200 80,170 L 100,140 L 80,120 Z',
  },
  hungary: {
    name: 'Hungaroring',
    country: 'Hungary',
    laps: 70,
    length_km: 4.381,
    color: '#4CAF50',
    path: 'M 80,150 Q 80,80 150,80 L 250,80 Q 300,80 320,120 Q 340,160 310,200 L 240,230 Q 200,240 160,220 L 100,200 Q 60,190 60,160 Z',
  },
  belgium: {
    name: 'Spa-Francorchamps',
    country: 'Belgium',
    laps: 44,
    length_km: 7.004,
    color: '#FF6D00',
    path: 'M 60,180 L 60,100 Q 60,60 100,60 L 220,80 Q 260,90 270,130 L 260,160 L 320,180 Q 350,200 340,230 Q 330,260 300,250 L 100,200 Z',
  },
  netherlands: {
    name: 'Zandvoort',
    country: 'Netherlands',
    laps: 72,
    length_km: 4.259,
    color: '#FF6D00',
    path: 'M 100,60 L 300,60 Q 340,60 340,100 L 340,200 Q 340,240 300,240 L 200,240 Q 160,240 150,210 L 100,200 Q 60,190 60,160 L 60,100 Q 60,60 100,60 Z',
  },
  italy: {
    name: 'Monza',
    country: 'Italy',
    laps: 51,
    length_km: 5.793,
    color: '#FF1744',
    path: 'M 80,80 L 320,80 Q 340,80 340,110 L 320,160 L 280,160 L 280,200 L 320,200 Q 340,200 340,230 Q 340,260 320,260 L 80,260 Q 60,260 60,230 Q 60,200 80,200 L 120,200 L 120,160 L 80,160 Q 60,160 60,130 Q 60,80 80,80 Z',
  },
  azerbaijan: {
    name: 'Baku City Circuit',
    country: 'Azerbaijan',
    laps: 51,
    length_km: 6.003,
    color: '#2196F3',
    path: 'M 60,260 L 60,80 Q 60,60 80,60 L 180,60 Q 200,60 200,80 L 200,150 Q 200,170 220,170 L 340,170 Q 360,170 360,190 L 360,260 L 60,260 Z',
  },
  singapore: {
    name: 'Marina Bay Street',
    country: 'Singapore',
    laps: 62,
    length_km: 4.94,
    color: '#FF1744',
    path: 'M 80,60 L 200,60 L 200,120 L 320,120 Q 340,120 340,140 L 340,200 Q 340,220 320,220 L 200,220 L 200,250 Q 200,270 180,270 L 100,270 Q 80,270 80,250 L 80,60 Z',
  },
  usa_austin: {
    name: 'Circuit of the Americas',
    country: 'USA (Austin)',
    laps: 56,
    length_km: 5.513,
    color: '#E91E63',
    path: 'M 60,250 L 60,100 Q 60,60 120,60 L 300,80 Q 330,90 330,120 L 300,150 Q 270,170 240,155 L 180,140 L 180,200 L 280,200 Q 310,200 320,220 Q 330,250 300,250 Z',
  },
  mexico: {
    name: 'Hermanos Rodriguez',
    country: 'Mexico',
    laps: 71,
    length_km: 4.304,
    color: '#4CAF50',
    path: 'M 80,80 L 300,80 Q 330,80 330,110 L 330,160 Q 320,190 290,190 L 200,190 L 200,220 L 290,220 Q 320,220 330,250 L 300,260 L 80,260 Q 60,260 60,230 L 60,110 Q 60,80 80,80 Z',
  },
  brazil: {
    name: 'Autodromo Interlagos',
    country: 'Brazil',
    laps: 71,
    length_km: 4.309,
    color: '#4CAF50',
    path: 'M 200,40 Q 300,40 330,100 Q 360,160 320,220 Q 280,260 200,260 Q 120,260 80,220 Q 40,170 80,100 Q 120,40 200,40 Z M 200,80 Q 250,80 270,120 Q 280,150 250,170 Q 220,190 190,170 Q 160,150 170,120 Q 185,80 200,80 Z',
  },
  las_vegas: {
    name: 'Las Vegas Street',
    country: 'USA (Las Vegas)',
    laps: 50,
    length_km: 6.201,
    color: '#E91E63',
    path: 'M 80,60 L 320,60 Q 350,60 350,90 L 350,240 Q 350,260 320,260 L 80,260 Q 50,260 50,240 L 50,90 Q 50,60 80,60 Z M 200,60 L 200,260 M 50,160 L 350,160',
  },
  qatar: {
    name: 'Lusail International',
    country: 'Qatar',
    laps: 57,
    length_km: 5.419,
    color: '#9C27B0',
    path: 'M 200,40 Q 320,40 340,130 Q 360,200 300,240 L 240,260 Q 160,270 100,230 L 60,180 Q 40,120 80,80 Q 120,40 200,40 Z',
  },
  abu_dhabi: {
    name: 'Yas Marina',
    country: 'Abu Dhabi',
    laps: 58,
    length_km: 5.281,
    color: '#9C27B0',
    path: 'M 80,80 L 280,80 Q 330,80 330,130 L 330,160 Q 310,180 280,175 L 200,170 Q 200,200 240,200 L 300,200 Q 340,200 340,230 Q 340,260 300,260 L 80,260 Q 60,260 60,240 L 60,100 Q 60,80 80,80 Z',
  },
};

/**
 * Genera SVG del circuito con posicion opcional del piloto.
 * @param {string} circuitId - ID del circuito (ej: 'monaco')
 * @param {object} opts - { driverPos: {x, y}, driverName, teamColor, showLabel: true }
 * @returns {string} SVG string
 */
function generateCircuitSVG(circuitId, opts) {
  opts = opts || {};
  const c = CIRCUITS[circuitId];
  if (!c) return null;

  const teamColor = opts.teamColor || '#00E5FF';
  const driverPos = opts.driverPos;
  const driverLabel = opts.showLabel !== false && opts.driverName ? opts.driverName : null;

  let driverOverlay = '';
  if (driverPos) {
    driverOverlay = '<circle cx="' + driverPos.x + '" cy="' + driverPos.y + '" r="8" fill="' + teamColor + '" opacity="0.9"/>';
    if (driverLabel) {
      driverOverlay += '<text x="' + (driverPos.x + 12) + '" y="' + (driverPos.y + 4) + '" fill="white" font-size="11" font-family="Inter,sans-serif" font-weight="600">' + driverLabel + '</text>';
    }
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">' +
    '<rect width="400" height="300" fill="#0A0A12"/>' +
    '<defs>' +
    '<linearGradient id="tg_' + circuitId + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#00E5FF"/>' +
    '<stop offset="100%" stop-color="' + c.color + '"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<path d="' + c.path + '" fill="none" stroke="url(#tg_' + circuitId + ')" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    driverOverlay +
    '<text x="8" y="292" fill="#ffffff44" font-size="10" font-family="Inter,sans-serif">' + c.name + '</text>' +
    '</svg>';
}

/**
 * Lista de todos los IDs de circuito disponibles.
 * @returns {string[]}
 */
function getCircuitIds() { return Object.keys(CIRCUITS); }

/**
 * Obtiene datos de un circuito.
 * @param {string} id
 * @returns {object|null}
 */
function getCircuit(id) { return CIRCUITS[id] || null; }

module.exports = { CIRCUITS, generateCircuitSVG, getCircuitIds, getCircuit };
