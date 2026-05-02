'use strict';

const smd = require('../core/sports_mention_detector');

describe('detectSportMention', () => {
  test('null retorna null', () => {
    expect(smd.detectSportMention(null)).toBeNull();
  });
  test('no-string retorna null', () => {
    expect(smd.detectSportMention(123)).toBeNull();
  });
  test('texto vacio retorna null', () => {
    expect(smd.detectSportMention('')).toBeNull();
  });
  test('texto sin mencion retorna null', () => {
    expect(smd.detectSportMention('hola que tal')).toBeNull();
  });
  test('Vamos Boca con trigger -> high confidence', () => {
    const r = smd.detectSportMention('Vamos Boca!! a ganar la copa');
    expect(r.type).toBe('futbol');
    expect(r.team).toBe('Boca Juniors');
    expect(r.confidence).toBe('high');
  });
  test('Boca sin trigger -> medium confidence', () => {
    const r = smd.detectSportMention('Vi el partido de Boca anoche');
    expect(r.type).toBe('futbol');
    expect(r.team).toBe('Boca Juniors');
    expect(r.confidence).toBe('medium');
  });
  test('hincha de River', () => {
    const r = smd.detectSportMention('Soy hincha de River desde chico');
    expect(r.team).toBe('River Plate');
    expect(r.rivalry).toBe('Boca Juniors');
    expect(r.confidence).toBe('high');
  });
  test('fan de Verstappen', () => {
    const r = smd.detectSportMention('soy fan de Verstappen, gana siempre');
    expect(r.type).toBe('f1');
    expect(r.driver).toBe('Max Verstappen');
    expect(r.confidence).toBe('high');
  });
  test('mencion de Hamilton sin trigger', () => {
    const r = smd.detectSportMention('Hamilton manejo bien hoy');
    expect(r.type).toBe('f1');
    expect(r.driver).toBe('Lewis Hamilton');
  });
  test('Colapinto detectado', () => {
    const r = smd.detectSportMention('Colapinto ganando puntos');
    expect(r.driver).toBe('Franco Colapinto');
  });
  test('aguante Racing', () => {
    const r = smd.detectSportMention('aguante Racing eternamente');
    expect(r.team).toBe('Racing Club');
    expect(r.confidence).toBe('high');
  });
  test('mi piloto es Norris', () => {
    const r = smd.detectSportMention('mi piloto es Norris');
    expect(r.driver).toBe('Lando Norris');
    expect(r.confidence).toBe('high');
  });
  test('san_lorenzo via espacio', () => {
    const r = smd.detectSportMention('vamos San Lorenzo');
    expect(r.team).toBe('San Lorenzo');
  });
  test('caracteres especiales no rompen', () => {
    const r = smd.detectSportMention('Aguante Racing!!! ⚽⚽');
    expect(r.team).toBe('Racing Club');
  });
  test('acentos normalizados', () => {
    const r = smd.detectSportMention('Atlético Nacional juega bien');
    expect(r.team).toBe('Atletico Nacional');
  });
});

describe('detectAllMentions', () => {
  test('null retorna []', () => {
    expect(smd.detectAllMentions(null)).toEqual([]);
  });
  test('no-string retorna []', () => {
    expect(smd.detectAllMentions(123)).toEqual([]);
  });
  test('vacio retorna []', () => {
    expect(smd.detectAllMentions('')).toEqual([]);
  });
  test('sin matches retorna []', () => {
    expect(smd.detectAllMentions('hola que tal')).toEqual([]);
  });
  test('un equipo', () => {
    const r = smd.detectAllMentions('Vamos Boca');
    expect(r.length).toBe(1);
    expect(r[0].team).toBe('Boca Juniors');
  });
  test('multiples equipos en superclasico', () => {
    const r = smd.detectAllMentions('boca vs river en el monumental');
    const names = r.map(x => x.team);
    expect(names).toContain('Boca Juniors');
    expect(names).toContain('River Plate');
  });
  test('mix futbol + f1', () => {
    const r = smd.detectAllMentions('vamos boca y verstappen');
    expect(r.length).toBeGreaterThanOrEqual(2);
  });
});

describe('constants frozen', () => {
  test('FUTBOL_TEAMS frozen', () => {
    expect(() => { smd.FUTBOL_TEAMS.nuevo = {}; }).toThrow();
  });
  test('F1_DRIVERS frozen', () => {
    expect(() => { smd.F1_DRIVERS.nuevo = {}; }).toThrow();
  });
  test('FAN_TRIGGERS frozen', () => {
    expect(() => { smd.FAN_TRIGGERS.push('x'); }).toThrow();
  });
  test('FUTBOL_TEAMS contiene boca y river', () => {
    expect(smd.FUTBOL_TEAMS.boca).toBeDefined();
    expect(smd.FUTBOL_TEAMS.river).toBeDefined();
  });
  test('F1_DRIVERS contiene verstappen y hamilton', () => {
    expect(smd.F1_DRIVERS.verstappen).toBeDefined();
    expect(smd.F1_DRIVERS.hamilton).toBeDefined();
  });
});

describe('extra branches sports_mention_detector', () => {
  test('detectSportMention con texto que normaliza vacio', () => {
    expect(smd.detectSportMention('!!! ¿¿¿')).toBeNull();
  });
  test('detectSportMention con string undefined defensivo', () => {
    expect(smd.detectSportMention(undefined)).toBeNull();
  });
  test('detectAllMentions con string vacio post normalize', () => {
    expect(smd.detectAllMentions('!!!')).toEqual([]);
  });
});
