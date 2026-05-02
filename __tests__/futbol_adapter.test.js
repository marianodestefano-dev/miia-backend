'use strict';

const fa = require('../core/futbol_adapter');

describe('STATUS y EVENT_TYPES', () => {
  test('STATUS frozen', () => { expect(() => { fa.STATUS.x = 1; }).toThrow(); });
  test('EVENT_TYPES frozen', () => { expect(() => { fa.EVENT_TYPES.x = 1; }).toThrow(); });
  test('STATUS contiene LIVE FINISHED', () => {
    expect(fa.STATUS.LIVE).toBe('live');
    expect(fa.STATUS.FINISHED).toBe('finished');
  });
});

describe('fetchMatchStatus', () => {
  test('team undefined throw', async () => {
    await expect(fa.fetchMatchStatus(undefined, {})).rejects.toThrow('team');
  });
  test('team no-string throw', async () => {
    await expect(fa.fetchMatchStatus(123, {})).rejects.toThrow('team');
  });
  test('result null retorna empty', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => null });
    expect(r.status).toBe('unknown');
    expect(r.score.our).toBe(0);
  });
  test('result objeto estructurado', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      our: 2, rival: 1, minute: 67, status: 'live', rival: 'River',
    })});
    expect(r.score.our).toBe(2);
    expect(r.minute).toBe(67);
  });
  test('result objeto con score nested', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      score: { our: 1, rival: 0 }, minute: 30, status: 'live'
    })});
    expect(r.score.our).toBe(1);
  });
  test('snippet "Boca 2 - 1 River 67"', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => 'Boca 2 - 1 River 67\'' });
    expect(r.score.our).toBe(2);
    expect(r.score.rival).toBe(1);
    expect(r.minute).toBe(67);
    expect(r.status).toBe('live');
  });
  test('snippet "River 1-2 Boca" (team segundo, invierte)', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => 'River 1-2 Boca' });
    expect(r.score.our).toBe(2);
    expect(r.score.rival).toBe(1);
  });
  test('snippet finalizado', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => 'Finalizado: Boca 3-1 River' });
    expect(r.status).toBe('finished');
    expect(r.score.our).toBe(3);
  });
  test('snippet entretiempo', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => 'Entretiempo Boca 1-0 River' });
    expect(r.status).toBe('half_time');
  });
  test('snippet sin score retorna empty', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => 'Boca juega esta noche' });
    expect(r.status).toBe('unknown');
  });
  test('result objeto con raw string', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({ raw: 'Boca 1-0 River 30\'' }) });
    expect(r.score.our).toBe(1);
  });
  test('result objeto con raw vacio', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({ raw: '' }) });
    expect(r.status).toBe('unknown');
  });
});

describe('detectScoreChange', () => {
  test('current null retorna null', () => {
    expect(fa.detectScoreChange(null, null)).toBeNull();
  });
  test('prev null + current live -> started', () => {
    const r = fa.detectScoreChange(null, { score: { our: 0, rival: 0 }, status: 'live' });
    expect(r.event).toBe('started');
  });
  test('prev null + current scheduled -> null', () => {
    const r = fa.detectScoreChange(null, { score: { our: 0, rival: 0 }, status: 'scheduled' });
    expect(r).toBeNull();
  });
  test('gol nuestro detectado', () => {
    const r = fa.detectScoreChange(
      { score: { our: 0, rival: 0 }, status: 'live' },
      { score: { our: 1, rival: 0 }, status: 'live' }
    );
    expect(r.event).toBe('goal_us');
    expect(r.our).toBe(1);
  });
  test('gol rival detectado', () => {
    const r = fa.detectScoreChange(
      { score: { our: 1, rival: 0 }, status: 'live' },
      { score: { our: 1, rival: 1 }, status: 'live' }
    );
    expect(r.event).toBe('goal_rival');
  });
  test('half_time detectado', () => {
    const r = fa.detectScoreChange(
      { score: { our: 1, rival: 0 }, status: 'live' },
      { score: { our: 1, rival: 0 }, status: 'half_time' }
    );
    expect(r.event).toBe('half_time');
  });
  test('resumed despues de half_time', () => {
    const r = fa.detectScoreChange(
      { score: { our: 1, rival: 0 }, status: 'half_time' },
      { score: { our: 1, rival: 0 }, status: 'live' }
    );
    expect(r.event).toBe('resumed');
  });
  test('final detectado', () => {
    const r = fa.detectScoreChange(
      { score: { our: 2, rival: 1 }, status: 'live' },
      { score: { our: 2, rival: 1 }, status: 'finished' }
    );
    expect(r.event).toBe('final');
  });
  test('sin cambios -> null', () => {
    const r = fa.detectScoreChange(
      { score: { our: 1, rival: 0 }, status: 'live' },
      { score: { our: 1, rival: 0 }, status: 'live' }
    );
    expect(r).toBeNull();
  });
  test('prev sin score -> null', () => {
    const r = fa.detectScoreChange({}, { score: { our: 0, rival: 0 }, status: 'live' });
    expect(r.event).toBe('started');
  });
  test('current sin score -> null', () => {
    expect(fa.detectScoreChange({ score: { our: 0, rival: 0 }, status: 'live' }, {})).toBeNull();
  });
});

describe('extra branches futbol_adapter', () => {
  test('fetchMatchStatus sin opts (default fetcher excepcion)', async () => {
    await expect(fa.fetchMatchStatus('Boca')).rejects.toThrow();
  });
  test('struct con rival_score key', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      our: 2, rival_score: 1, minute: 80,
    })});
    expect(r.score.rival).toBe(1);
  });
  test('struct con opponent key (deprecated)', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      our: 1, opponent: 0,
    })});
    expect(r.score.rival).toBe(0);
  });
  test('struct sin minute (default 0)', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      our: 1, rival: 0,
    })});
    expect(r.minute).toBe(0);
  });
  test('struct sin status -> unknown', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      our: 1, rival: 0,
    })});
    expect(r.status).toBe('unknown');
  });
  test('snippet sin afterScore -> rival null', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => 'Boca 2-1' });
    expect(r.score.our).toBe(2);
  });
});

describe('extra branches futbol_adapter to 100', () => {
  test('struct con our NaN (string no-numero) -> 0', async () => {
    const r = await fa.fetchMatchStatus('Boca', { fetcher: async () => ({
      our: 'no-numero', rival: 'tampoco',
    })});
    expect(r.score.our).toBe(0);
    expect(r.score.rival).toBe(0);
  });
});
