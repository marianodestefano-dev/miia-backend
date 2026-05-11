'use strict';

/**
 * VI-BACKEND-COVERAGE: core/miia_invocation.js — 100% branches
 * Pure logic + in-memory state, no external deps.
 */

const {
  isInvocation, isFarewell, detectRelationship, detectScope,
  checkScope, detectAutoventaOpportunity, extractContactLearnings,
  activateInvocation, deactivateInvocation, touchInteraction,
  setScope, setContactInfo, getInvocationState, isInvoked,
  AUTO_RETIRE_MS,
} = require('../core/miia_invocation');

// ── isInvocation ──────────────────────────────────────────────
describe('isInvocation', () => {
  test('null → false (branch !message)', () => {
    expect(isInvocation(null)).toBe(false);
    expect(isInvocation('')).toBe(false);
  });

  test('"miia estas" → true', () => {
    expect(isInvocation('miia estas?')).toBe(true);
  });

  test('"miia ven" → true', () => {
    expect(isInvocation('miia ven')).toBe(true);
  });

  test('"ven miia" → true', () => {
    expect(isInvocation('ven miia')).toBe(true);
  });

  test('"estas miia" → true', () => {
    expect(isInvocation('estas miia?')).toBe(true);
  });

  test('texto random → false (ningun pattern matchea)', () => {
    expect(isInvocation('hola como estas')).toBe(false);
  });
});

// ── isFarewell ────────────────────────────────────────────────
describe('isFarewell', () => {
  test('null → false (branch !message)', () => {
    expect(isFarewell(null)).toBe(false);
    expect(isFarewell('')).toBe(false);
  });

  test('"chau miia" → true', () => {
    expect(isFarewell('chau miia')).toBe(true);
  });

  test('"bye miia" → true', () => {
    expect(isFarewell('bye miia')).toBe(true);
  });

  test('"adios miia" → true', () => {
    expect(isFarewell('adios miia')).toBe(true);
  });

  test('"miia chau" → true', () => {
    expect(isFarewell('miia chau')).toBe(true);
  });

  test('texto random → false', () => {
    expect(isFarewell('hola como estas')).toBe(false);
  });
});

// ── detectRelationship ────────────────────────────────────────
describe('detectRelationship', () => {
  test('null → {relation:null, name:null} (branch !message)', () => {
    const r = detectRelationship(null);
    expect(r.relation).toBeNull();
    expect(r.name).toBeNull();
  });

  test('"mi mama" → familia', () => {
    const r = detectRelationship('ella es mi mama');
    expect(r.relation).toBe('familia');
  });

  test('"mi amigo" → amigos', () => {
    const r = detectRelationship('es mi amigo de la facu');
    expect(r.relation).toBe('amigos');
  });

  test('"del equipo" → equipo', () => {
    const r = detectRelationship('es del equipo de trabajo');
    expect(r.relation).toBe('equipo');
  });

  test('"un cliente" → lead', () => {
    const r = detectRelationship('es un cliente');
    expect(r.relation).toBe('lead');
  });

  test('nombre extraido via "se llama"', () => {
    const r = detectRelationship('ella es mi amiga se llama Sofia');
    expect(r.relation).toBe('amigos');
    expect(r.name).toBe('Sofia');
  });

  test('sin patron → {relation:null, name:null}', () => {
    const r = detectRelationship('no hay nada aqui');
    expect(r.relation).toBeNull();
    expect(r.name).toBeNull();
  });
});

// ── detectScope ───────────────────────────────────────────────
describe('detectScope', () => {
  test('null → null (branch !message)', () => {
    expect(detectScope(null)).toBeNull();
    expect(detectScope('')).toBeNull();
  });

  test('"estabamos hablando de un viaje" → detecta scope', () => {
    const s = detectScope('estabamos hablando de un viaje a colombia');
    expect(s).toBeTruthy();
    expect(s.length).toBeGreaterThan(2);
  });

  test('"ayudanos con el presupuesto" → detecta scope', () => {
    const s = detectScope('ayudanos con el presupuesto del proyecto');
    expect(s).toBeTruthy();
  });

  test('texto sin scope → null', () => {
    expect(detectScope('hola que tal')).toBeNull();
  });

  test('scope demasiado corto (<=2) → null (branch scope.length > 2 false)', () => {
    const s = detectScope('ayudanos con a');
    expect(s).toBeNull();
  });
});

// ── checkScope ────────────────────────────────────────────────
describe('checkScope', () => {
  test('sin scope → outOfScope=true, reason=no_scope_set (branch !scope)', () => {
    const r = checkScope('hola', null);
    expect(r.outOfScope).toBe(true);
    expect(r.reason).toBe('no_scope_set');
  });

  test('pedido personal → outOfScope=true, reason=personal_assistance_request', () => {
    const r = checkScope('miia buscame el hotel', 'viaje');
    expect(r.outOfScope).toBe(true);
    expect(r.reason).toBe('personal_assistance_request');
  });

  test('mensaje dentro de scope → outOfScope=false, reason=within_scope', () => {
    const r = checkScope('que opinion tenes?', 'viaje');
    expect(r.outOfScope).toBe(false);
    expect(r.reason).toBe('within_scope');
  });
});

// ── detectAutoventaOpportunity ────────────────────────────────
describe('detectAutoventaOpportunity', () => {
  test('null → interested=false (branch !message)', () => {
    const r = detectAutoventaOpportunity(null);
    expect(r.interested).toBe(false);
    expect(r.trigger).toBeNull();
  });

  test('"como haces" → curiosidad_funcional', () => {
    const r = detectAutoventaOpportunity('como haces esto?');
    expect(r.interested).toBe(true);
    expect(r.trigger).toBe('curiosidad_funcional');
  });

  test('"increible" → admiracion', () => {
    const r = detectAutoventaOpportunity('increible!');
    expect(r.interested).toBe(true);
    expect(r.trigger).toBe('admiracion');
  });

  test('"quiero algo como" → deseo_directo', () => {
    const r = detectAutoventaOpportunity('quiero algo como esto');
    expect(r.interested).toBe(true);
    expect(r.trigger).toBe('deseo_directo');
  });

  test('"existe algo asi" → consulta_producto', () => {
    const r = detectAutoventaOpportunity('existe algo como esto para mi');
    expect(r.interested).toBe(true);
    expect(r.trigger).toBe('consulta_producto');
  });

  test('"sos una ia" → pregunta_identidad', () => {
    const r = detectAutoventaOpportunity('sos una ia?');
    expect(r.interested).toBe(true);
    expect(r.trigger).toBe('pregunta_identidad');
  });

  test('"yo tambien quiero asistente" → necesidad_expresada', () => {
    const r = detectAutoventaOpportunity('yo tambien quiero un asistente');
    expect(r.interested).toBe(true);
    expect(r.trigger).toBe('necesidad_expresada');
  });

  test('mensaje neutro → interested=false', () => {
    const r = detectAutoventaOpportunity('el partido estuvo bueno');
    expect(r.interested).toBe(false);
    expect(r.trigger).toBeNull();
  });
});

// ── extractContactLearnings ───────────────────────────────────
describe('extractContactLearnings', () => {
  test('null → [] (branch !message)', () => {
    expect(extractContactLearnings(null)).toEqual([]);
  });

  test('muy corto (< 10 chars) → [] (branch length < 10)', () => {
    expect(extractContactLearnings('hola')).toEqual([]);
  });

  test('"soy medico" → profesion detectada', () => {
    const r = extractContactLearnings('soy medico en un hospital grande aca');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toContain('profesion');
  });

  test('"tengo una clinica" → negocio detectado', () => {
    const r = extractContactLearnings('tengo una clinica en el centro de la ciudad');
    expect(r.some(l => l.includes('negocio'))).toBe(true);
  });

  test('"siempre me olvido" → pain_point', () => {
    const r = extractContactLearnings('siempre me olvido de las reuniones importantes del dia');
    expect(r.some(l => l.includes('pain_point'))).toBe(true);
  });

  test('"necesito organizar" → pain_point', () => {
    const r = extractContactLearnings('necesito organizar mejor mis turnos medicos importantes');
    expect(r.some(l => l.includes('pain_point'))).toBe(true);
  });

  test('"me gusta la fotografia" → interes', () => {
    const r = extractContactLearnings('me gusta la fotografia y los viajes por el mundo');
    expect(r.some(l => l.includes('interes'))).toBe(true);
  });

  test('texto sin patrones → []', () => {
    const r = extractContactLearnings('el tiempo esta muy frio hoy aca en la ciudad');
    expect(r).toEqual([]);
  });
});

// ── activateInvocation ────────────────────────────────────────
describe('activateInvocation', () => {
  test('nuevo phone → crea estado invocado con knownContact=true', () => {
    const s = activateInvocation('+54111', 'owner', { contactName: 'Juan', knownContact: true });
    expect(s.invoked).toBe(true);
    expect(s.invokedBy).toBe('owner');
    expect(s.contactName).toBe('Juan');
    expect(s.knownContact).toBe(true);
    expect(s.pendingIntroduction).toBe(false);
  });

  test('phone con estado existente sin timer → recrea sin clearTimeout', () => {
    activateInvocation('+54222', 'owner', { knownContact: false });
    const s = activateInvocation('+54222', 'contact', { contactName: 'Lala' });
    expect(s.invokedBy).toBe('contact');
    expect(s.contactName).toBe('Lala');
  });

  test('phone con estado existente CON timer → clearTimeout (branch line 204)', () => {
    jest.useFakeTimers();
    activateInvocation('+54225', 'owner');
    touchInteraction('+54225', jest.fn()); // sets autoRetireTimer
    // re-activate → should clearTimeout the existing timer
    const s = activateInvocation('+54225', 'contact', { contactName: 'Ana' });
    expect(s.invokedBy).toBe('contact');
    jest.useRealTimers();
  });

  test('knownContact=false → pendingIntroduction=true', () => {
    const s = activateInvocation('+54333', 'owner', { knownContact: false });
    expect(s.pendingIntroduction).toBe(true);
  });

  test('contactName heredado del estado existente', () => {
    activateInvocation('+54444', 'owner', { contactName: 'Pedro' });
    const s = activateInvocation('+54444', 'contact', {});
    expect(s.contactName).toBe('Pedro');
  });
});

// ── deactivateInvocation ──────────────────────────────────────
describe('deactivateInvocation', () => {
  test('phone sin estado → no error (branch !state.autoRetireTimer)', () => {
    expect(() => deactivateInvocation('+99999')).not.toThrow();
  });

  test('phone con estado activo → desactiva (branch state truthy)', () => {
    activateInvocation('+54555', 'owner');
    deactivateInvocation('+54555', 'farewell');
    expect(isInvoked('+54555')).toBe(false);
  });
});

// ── touchInteraction ──────────────────────────────────────────
describe('touchInteraction', () => {
  test('phone sin estado → no error (branch !state)', () => {
    expect(() => touchInteraction('+00000', jest.fn())).not.toThrow();
  });

  test('estado desactivado → no error (branch !state.invoked)', () => {
    activateInvocation('+54666', 'owner');
    deactivateInvocation('+54666');
    expect(() => touchInteraction('+54666', jest.fn())).not.toThrow();
  });

  test('estado invocado sin timer → crea timer (branch state.autoRetireTimer falsy)', () => {
    jest.useFakeTimers();
    activateInvocation('+54777', 'owner');
    touchInteraction('+54777', jest.fn());
    const state = getInvocationState('+54777');
    expect(state.autoRetireTimer).toBeTruthy();
    jest.useRealTimers();
  });

  test('estado invocado con timer → resetea timer (branch state.autoRetireTimer truthy)', () => {
    jest.useFakeTimers();
    activateInvocation('+54888', 'owner');
    touchInteraction('+54888', jest.fn());
    touchInteraction('+54888', jest.fn());
    const state = getInvocationState('+54888');
    expect(state.autoRetireTimer).toBeTruthy();
    jest.useRealTimers();
  });

  test('timer dispara onAutoRetire → typeof function true', () => {
    jest.useFakeTimers();
    activateInvocation('+54999', 'owner', { contactName: 'Test' });
    const cb = jest.fn();
    touchInteraction('+54999', cb);
    jest.advanceTimersByTime(AUTO_RETIRE_MS + 100);
    expect(cb).toHaveBeenCalledWith('+54999', 'Test');
    jest.useRealTimers();
  });

  test('onAutoRetire no-function → no error (typeof false branch)', () => {
    jest.useFakeTimers();
    activateInvocation('+55000', 'owner');
    touchInteraction('+55000', null);
    expect(() => jest.advanceTimersByTime(AUTO_RETIRE_MS + 100)).not.toThrow();
    jest.useRealTimers();
  });
});

// ── setScope ──────────────────────────────────────────────────
describe('setScope', () => {
  test('phone sin estado → no error (branch !state)', () => {
    expect(() => setScope('+11111', 'algo')).not.toThrow();
  });

  test('phone con estado → establece scope', () => {
    activateInvocation('+54110', 'owner');
    setScope('+54110', 'presupuesto');
    expect(getInvocationState('+54110').scope).toBe('presupuesto');
  });
});

// ── setContactInfo ────────────────────────────────────────────
describe('setContactInfo', () => {
  test('phone sin estado → no error (branch !state)', () => {
    expect(() => setContactInfo('+22222', 'Juan', 'amigos')).not.toThrow();
  });

  test('phone con estado → actualiza contacto', () => {
    activateInvocation('+54120', 'owner');
    setContactInfo('+54120', 'Maria', 'familia');
    const s = getInvocationState('+54120');
    expect(s.contactName).toBe('Maria');
    expect(s.contactRelation).toBe('familia');
    expect(s.knownContact).toBe(true);
    expect(s.pendingIntroduction).toBe(false);
  });
});

// ── getInvocationState / isInvoked ────────────────────────────
describe('getInvocationState', () => {
  test('phone inexistente → null', () => {
    expect(getInvocationState('+00001')).toBeNull();
  });

  test('phone con estado → objeto estado', () => {
    activateInvocation('+54130', 'owner');
    expect(getInvocationState('+54130')).not.toBeNull();
    expect(getInvocationState('+54130').invoked).toBe(true);
  });
});

describe('isInvoked', () => {
  test('phone inexistente → false', () => {
    expect(isInvoked('+00002')).toBe(false);
  });

  test('phone activo → true', () => {
    activateInvocation('+54140', 'owner');
    expect(isInvoked('+54140')).toBe(true);
  });

  test('phone desactivado → false', () => {
    activateInvocation('+54150', 'owner');
    deactivateInvocation('+54150');
    expect(isInvoked('+54150')).toBe(false);
  });
});
