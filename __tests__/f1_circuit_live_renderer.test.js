'use strict';

/**
 * Tests circuit_live_renderer.js — render SVG live multi-driver dots.
 * 100% branches.
 */

const lr = require('../sports/f1_dashboard/circuit_live_renderer');

describe('circuit_live_renderer — renderLiveCircuit', () => {
  test('genera SVG válido con trazado de Monaco', () => {
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers: [] });
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('data-circuit-id="mc-1929"');
    expect(svg).toContain('Circuit de Monaco');
  });

  test('genera dots para drivers con lat/lon', () => {
    const drivers = [
      {
        driver_number: 4,
        lat: 43.7395,
        lon: 7.4272,
        team_color: '#FF8000',
        driver_name: 'L Norris',
        team_name: 'McLaren',
      },
      {
        driver_number: 1,
        lat: 43.7400,
        lon: 7.4280,
        team_color: '#3671C6',
        driver_name: 'M Verstappen',
        team_name: 'Red Bull',
      },
    ];
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers });
    expect(svg).toContain('data-driver-number="4"');
    expect(svg).toContain('data-driver-number="1"');
    expect(svg).toContain('data-driver-name="L Norris"');
    expect(svg).toContain('data-team-name="McLaren"');
    expect(svg).toContain('fill="#FF8000"');
    expect(svg).toContain('fill="#3671C6"');
  });

  test('null si circuitId no resoluble', () => {
    expect(lr.renderLiveCircuit({ circuitId: 'inexistente' })).toBeNull();
  });

  test('null si args undefined → fileId null', () => {
    expect(lr.renderLiveCircuit()).toBeNull();
  });

  test('null si circuitId falta', () => {
    expect(lr.renderLiveCircuit({})).toBeNull();
  });

  test('drivers vacío genera SVG sin dots', () => {
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers: [] });
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('class="miiaf1-driver-dot"');
  });

  test('drivers undefined → array vacío', () => {
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco' });
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('miiaf1-driver-dot');
  });

  test('drivers no-array tratado como vacío', () => {
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers: 'invalid' });
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('miiaf1-driver-dot');
  });

  test('viewport custom respeta dimensions', () => {
    const svg = lr.renderLiveCircuit({
      circuitId: 'monaco',
      drivers: [],
      viewport: { width: 1200, height: 700, padding: 40 },
    });
    expect(svg).toContain('viewBox="0 0 1200 700"');
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="700"');
  });

  test('viewport sin width usa defaults', () => {
    const svg = lr.renderLiveCircuit({
      circuitId: 'monaco',
      drivers: [],
      viewport: {},
    });
    expect(svg).toContain('viewBox="0 0 800 500"');
  });

  test('circuit country sin COUNTRY_COLOR usa DEFAULT_TRACK_COLOR (Argentina historical)', () => {
    // ar-1952 = Argentina, no está en COUNTRY_COLOR map → fallback DEFAULT_TRACK_COLOR
    const svg = lr.renderLiveCircuit({ circuitId: 'ar-1952', drivers: [] });
    expect(svg).toContain('<svg');
    expect(svg).toContain('#00E5FF'); // DEFAULT_TRACK_COLOR
  });

  test('showLabels=true incluye text con driver number', () => {
    const drivers = [
      { driver_number: 4, lat: 43.7395, lon: 7.4272, team_color: '#FF8000', driver_name: 'Norris' },
    ];
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers, showLabels: true });
    expect(svg).toContain('<text');
    expect(svg).toMatch(/<text[^>]*>4<\/text>/);
  });

  test('showLabels false (default) no incluye text del driver', () => {
    const drivers = [
      { driver_number: 4, lat: 43.7395, lon: 7.4272, driver_name: 'Norris' },
    ];
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers });
    // <text> del label del circuito sí está, pero no del driver
    expect(svg).not.toMatch(/<text[^>]*pointer-events="none"[^>]*>4<\/text>/);
  });

  test('highlightAdopted=true agrega halo en piloto adoptado', () => {
    const drivers = [
      {
        driver_number: 4,
        lat: 43.7395,
        lon: 7.4272,
        team_color: '#FF8000',
        is_adopted: true,
      },
    ];
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers });
    // El halo es el primer círculo (r mayor)
    const circles = svg.match(/<circle[^>]+>/g) || [];
    expect(circles.length).toBeGreaterThanOrEqual(2); // halo + dot
  });

  test('highlightAdopted=false omite halo', () => {
    const drivers = [
      {
        driver_number: 4,
        lat: 43.7395,
        lon: 7.4272,
        team_color: '#FF8000',
        is_adopted: true,
      },
    ];
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers, highlightAdopted: false });
    const circles = svg.match(/<circle[^>]+>/g) || [];
    expect(circles.length).toBe(1); // solo dot
  });

  test('driver sin is_adopted no agrega halo', () => {
    const drivers = [
      { driver_number: 4, lat: 43.7395, lon: 7.4272, team_color: '#FF8000' },
    ];
    const svg = lr.renderLiveCircuit({ circuitId: 'monaco', drivers });
    const circles = svg.match(/<circle[^>]+>/g) || [];
    expect(circles.length).toBe(1);
  });
});

describe('circuit_live_renderer — _renderDriverDot defensive', () => {
  const bbox = [7.421, 43.732, 7.430, 43.741];
  const vp = { width: 800, height: 500, padding: 30 };

  test('driver null → vacío', () => {
    expect(lr._renderDriverDot(null, bbox, vp, false, true)).toBe('');
  });

  test('driver undefined → vacío', () => {
    expect(lr._renderDriverDot(undefined, bbox, vp, false, true)).toBe('');
  });

  test('driver no-object → vacío', () => {
    expect(lr._renderDriverDot('string', bbox, vp, false, true)).toBe('');
    expect(lr._renderDriverDot(42, bbox, vp, false, true)).toBe('');
  });

  test('driver sin lat → vacío', () => {
    expect(lr._renderDriverDot({ lon: 7.42 }, bbox, vp, false, true)).toBe('');
  });

  test('driver sin lon → vacío', () => {
    expect(lr._renderDriverDot({ lat: 43.73 }, bbox, vp, false, true)).toBe('');
  });

  test('driver lat no-number → vacío', () => {
    expect(lr._renderDriverDot({ lat: 'x', lon: 7.42 }, bbox, vp, false, true)).toBe('');
  });

  test('driver minimal con lat/lon → dot OK con team_color default', () => {
    const out = lr._renderDriverDot({ lat: 43.737, lon: 7.426 }, bbox, vp, false, true);
    expect(out).toContain('<circle');
    expect(out).toContain('fill="#FFFFFF"'); // default
  });

  test('driver con driver_number 0 (falsy pero válido)', () => {
    const out = lr._renderDriverDot({ lat: 43.737, lon: 7.426, driver_number: 0 }, bbox, vp, false, true);
    expect(out).toContain('data-driver-number="0"');
  });

  test('driver con driver_number null → string vacío', () => {
    const out = lr._renderDriverDot({ lat: 43.737, lon: 7.426, driver_number: null }, bbox, vp, false, true);
    expect(out).toContain('data-driver-number=""');
  });

  test('showLabels con driver_number presente', () => {
    const out = lr._renderDriverDot({ lat: 43.737, lon: 7.426, driver_number: 16 }, bbox, vp, true, true);
    expect(out).toMatch(/<text[^>]*>16<\/text>/);
  });

  test('showLabels con solo driver_name', () => {
    const out = lr._renderDriverDot({ lat: 43.737, lon: 7.426, driver_name: 'Sainz' }, bbox, vp, true, true);
    expect(out).toMatch(/<text[^>]*>Sainz<\/text>/);
  });

  test('showLabels=true sin driver_number ni driver_name no agrega text', () => {
    const out = lr._renderDriverDot({ lat: 43.737, lon: 7.426 }, bbox, vp, true, true);
    // Sólo el <title> del circle pero no el text label externo
    expect(out).not.toMatch(/<text[^>]+>/);
  });
});

describe('circuit_live_renderer — escape helpers', () => {
  test('_escapeAttr escapa caracteres peligrosos', () => {
    expect(lr._escapeAttr('A&B')).toBe('A&amp;B');
    expect(lr._escapeAttr('A"B')).toBe('A&quot;B');
    expect(lr._escapeAttr('A<B')).toBe('A&lt;B');
  });

  test('_escapeAttr null/undefined → string vacío', () => {
    expect(lr._escapeAttr(null)).toBe('');
    expect(lr._escapeAttr(undefined)).toBe('');
  });

  test('_escapeText escapa <, >, &', () => {
    expect(lr._escapeText('a<b>c&d')).toBe('a&lt;b&gt;c&amp;d');
  });

  test('_escapeText null/undefined → string vacío', () => {
    expect(lr._escapeText(null)).toBe('');
    expect(lr._escapeText(undefined)).toBe('');
  });
});

describe('circuit_live_renderer — exports', () => {
  test('DEFAULT_DOT_RADIUS + DEFAULT_LABEL_OFFSET expuestos', () => {
    expect(typeof lr.DEFAULT_DOT_RADIUS).toBe('number');
    expect(typeof lr.DEFAULT_LABEL_OFFSET).toBe('number');
  });
});
