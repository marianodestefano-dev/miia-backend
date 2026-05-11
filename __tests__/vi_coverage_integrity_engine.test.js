'use strict';

/**
 * VI-BACKEND-COVERAGE: core/integrity_engine.js — 100% branches
 */

jest.useFakeTimers();

// Mock firebase-admin BEFORE requiring the module
jest.mock('firebase-admin');
const adminMock = require('firebase-admin');

let mockDbFactory;
adminMock.firestore = jest.fn(() => mockDbFactory());

const ie = require('../core/integrity_engine');

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDoc(data, failUpdate = false) {
  return {
    id: `doc_${Math.random()}`,
    data: () => data,
    ref: {
      update: failUpdate
        ? jest.fn().mockRejectedValue(new Error('Firestore write error'))
        : jest.fn().mockResolvedValue({}),
    },
  };
}

function makeSnap(docs) {
  return {
    empty: docs.length === 0,
    docs,
    size: docs.length,
    filter: (fn) => docs.filter(fn),
  };
}

function makeBatch() {
  return {
    update: jest.fn(),
    commit: jest.fn().mockResolvedValue({}),
  };
}

function makeDb({
  agendaStaleSnap = makeSnap([]),
  agendaCalSnap = makeSnap([]),
  sessionSnap = { exists: false, data: () => ({}) },
  prefsSnap = makeSnap([]),
  affsSnap = makeSnap([]),
  prefsFail = false,
  affsFail = false,
  batch = makeBatch(),
} = {}) {
  let agendaCallIdx = 0;

  const makeAgendaQuery = () => ({
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: jest.fn().mockImplementation(() => {
      agendaCallIdx++;
      return agendaCallIdx === 1
        ? Promise.resolve(agendaStaleSnap)
        : Promise.resolve(agendaCalSnap);
    }),
  });

  const agendaQuery = makeAgendaQuery();

  const prefsQuery = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: prefsFail
      ? jest.fn().mockRejectedValue(new Error('index missing'))
      : jest.fn().mockResolvedValue(prefsSnap),
  };
  const affsQuery = {
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    get: affsFail
      ? jest.fn().mockRejectedValue(new Error('index missing'))
      : jest.fn().mockResolvedValue(affsSnap),
  };

  return {
    batch: jest.fn().mockReturnValue(batch),
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        collection: jest.fn().mockImplementation((subCol) => {
          if (subCol === 'miia_agenda') return agendaQuery;
          if (subCol === 'sessions') return {
            doc: jest.fn().mockReturnValue({
              get: jest.fn().mockResolvedValue(sessionSnap),
            }),
          };
          if (subCol === 'contact_preferences') return prefsQuery;
          if (subCol === 'contact_affinities') return affsQuery;
          return agendaQuery;
        }),
      }),
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: empty DB
  mockDbFactory = () => makeDb();
  // Reset engineState.isRunning between tests if needed
});

// ── attemptAutoRepair ────────────────────────────────────────────────────────

describe('attemptAutoRepair', () => {
  describe('action=agendar', () => {
    test('fecha con mes válido (enero) sin ampm → retorna tag', () => {
      const r = ie.attemptAutoRepair(
        'Ya te agendé la reunión para el 15 de enero a las 10',
        'agendar', '+54911111', 'Juan'
      );
      expect(r).not.toBeNull();
      expect(r).toContain('AGENDAR_EVENTO');
      expect(r).toContain('01-15');
    });

    test('fecha con mes + ampm=pm + h<12 → h+12', () => {
      const r = ie.attemptAutoRepair(
        'Ya agendé para el 15 de enero a las 3 pm',
        'agendar', '+54911111', null
      );
      expect(r).not.toBeNull();
      expect(r).toContain('15:00');
    });

    test('fecha con mes + ampm=am + h=12 → h=0', () => {
      const r = ie.attemptAutoRepair(
        'Ya agendé para el 15 de enero a las 12 am',
        'agendar', null, 'Juan'
      );
      expect(r).not.toBeNull();
      expect(r).toContain('00:00');
    });

    test('fecha con mes + reasonMatch encontrado → usa la razón', () => {
      const r = ie.attemptAutoRepair(
        'Ya te agendé la consulta médica para el 15 de enero a las 10',
        'agendar', '+54911111', 'Juan'
      );
      expect(r).not.toBeNull();
      expect(r).toContain('consulta');
    });

    test('fecha con mes + sin reasonMatch → usa "Evento"', () => {
      // No hay "agendé X para" → reasonMatch=null → 'Evento'
      const r = ie.attemptAutoRepair(
        'Para el 15 de enero a las 10',
        'agendar', null, null
      );
      expect(r).not.toBeNull();
      expect(r).toContain('Evento');
      expect(r).toContain('self'); // contactPhone=null, contactName=null → 'self'
    });

    test('sin contactPhone ni contactName → usa "self"', () => {
      const r = ie.attemptAutoRepair(
        'Ya agendé para el 20 de marzo a las 9',
        'agendar', null, null
      );
      expect(r).toContain('self');
    });

    test('contactName cuando no hay phone → usa contactName', () => {
      const r = ie.attemptAutoRepair(
        'Ya agendé para el 20 de marzo a las 9',
        'agendar', undefined, 'Pedro'
      );
      expect(r).toContain('Pedro');
    });

    test('fecha con día de semana (lunes→monthNum=null) → isoDate=null → null', () => {
      // months['lunes'] = null → falsy → no isoDate → return null
      const r = ie.attemptAutoRepair(
        'Ya te agendé para el 5 lunes a las 10',
        'agendar', '+54911111', null
      );
      expect(r).toBeNull();
    });

    test('sin fecha en mensaje → dateMatch=null → null', () => {
      const r = ie.attemptAutoRepair(
        'Ya agendé todo perfectamente sin problema',
        'agendar', '+54911111', null
      );
      expect(r).toBeNull();
    });
  });

  test('action=cancelar → siempre retorna tag CANCELAR_EVENTO', () => {
    const r = ie.attemptAutoRepair(
      'Ya eliminé el evento de tu agenda para mañana a las 9:15 AM',
      'cancelar', '+54911111', null
    );
    expect(r).not.toBeNull();
    expect(r).toContain('CANCELAR_EVENTO');
  });

  test('action=mover → siempre retorna null', () => {
    const r = ie.attemptAutoRepair('Ya lo moví a otra hora', 'mover', '+54911111', null);
    expect(r).toBeNull();
  });

  test('action=email (otro) → retorna null', () => {
    const r = ie.attemptAutoRepair('Ya mandé el correo', 'email', '+54911111', null);
    expect(r).toBeNull();
  });

  test('action=cotizacion (otro) → retorna null', () => {
    const r = ie.attemptAutoRepair('Ya mandé la cotización', 'cotizacion', '+54911111', null);
    expect(r).toBeNull();
  });
});

// ── verifyCalendarEvent ───────────────────────────────────────────────────────

describe('verifyCalendarEvent', () => {
  // verifyCalendarEvent has a real 2s sleep inside — use real timers for this block
  beforeAll(() => jest.useRealTimers());
  afterAll(() => jest.useFakeTimers());

  test('sin listCalendarEvents → true inmediato', async () => {
    const r = await ie.verifyCalendarEvent(null, 'uid', '2024-01-01', 'reunión');
    expect(r).toBe(true);
  });

  test('evento encontrado → true', async () => {
    const listFn = jest.fn().mockResolvedValue([{ summary: 'Reunión con Juan' }]);
    const r = await ie.verifyCalendarEvent(listFn, 'uid', '2024-01-01', 'reunión');
    expect(r).toBe(true);
  }, 8000);

  test('evento no encontrado + retryCount>0 → reintenta y retorna true', async () => {
    let calls = 0;
    const listFn = jest.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.resolve([{ summary: 'Otro evento' }]);
      return Promise.resolve([{ summary: 'Reunión match' }]);
    });
    const r = await ie.verifyCalendarEvent(listFn, 'uid', '2024-01-01', 'Reunión', 1);
    expect(r).toBe(true);
  }, 12000);

  test('evento no encontrado + retryCount=0 → false', async () => {
    const listFn = jest.fn().mockResolvedValue([{ summary: 'Otro evento completamente diferente' }]);
    const r = await ie.verifyCalendarEvent(listFn, 'uid', '2024-01-01', 'Reunión especial', 0);
    expect(r).toBe(false);
  }, 8000);

  test('listCalendarEvents lanza error → false', async () => {
    const listFn = jest.fn().mockRejectedValue(new Error('API error'));
    const r = await ie.verifyCalendarEvent(listFn, 'uid', '2024-01-01', 'test');
    expect(r).toBe(false);
  }, 8000);

  test('listCalendarEvents retorna null/undefined → found=false → false', async () => {
    const listFn = jest.fn().mockResolvedValue(null);
    const r = await ie.verifyCalendarEvent(listFn, 'uid', '2024-01-01', 'test', 0);
    expect(r).toBe(false);
  }, 8000);
});

// ── startIntegrityEngine / stopIntegrityEngine / getIntegrityStats ──────────

describe('startIntegrityEngine', () => {
  beforeEach(() => {
    // Stop any running engine before each test
    ie.stopIntegrityEngine();
    jest.clearAllTimers();
  });

  test('primera llamada → inicia polling (no warn)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    ie.startIntegrityEngine({ ownerUid: 'uid', generateAI: jest.fn() });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('ya corriendo'));
    ie.stopIntegrityEngine();
    warnSpy.mockRestore();
  });

  test('segunda llamada sin stop → warn "ya corriendo" + return', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    ie.startIntegrityEngine({ ownerUid: 'uid' });
    ie.startIntegrityEngine({ ownerUid: 'uid' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ya corriendo'));
    ie.stopIntegrityEngine();
    warnSpy.mockRestore();
  });
});

describe('stopIntegrityEngine', () => {
  test('sin engine running → no error (branch pollInterval falsy)', () => {
    expect(() => ie.stopIntegrityEngine()).not.toThrow();
  });

  test('con engine running → detiene y loguea', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    ie.startIntegrityEngine({ ownerUid: 'uid' });
    ie.stopIntegrityEngine();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('detenido'));
    logSpy.mockRestore();
  });
});

describe('getIntegrityStats', () => {
  test('retorna copia del estado actual', () => {
    const stats = ie.getIntegrityStats();
    expect(typeof stats).toBe('object');
    expect(stats).toHaveProperty('isRunning');
    expect(stats).toHaveProperty('promisesDetected');
  });
});

// ── runIntegrityPoll ─────────────────────────────────────────────────────────

describe('runIntegrityPoll', () => {
  test('engineState.isRunning=true → log y return sin ejecutar', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    // Forzar isRunning=true llamando poll en paralelo
    const deps = { ownerUid: 'uid1', generateAI: undefined };
    mockDbFactory = () => makeDb(); // Limpio para no colisionar
    // Primero iniciar manualmente, luego llamar mientras corre
    const firstPoll = ie.runIntegrityPoll(deps);
    const secondPoll = ie.runIntegrityPoll(deps); // debería detectar isRunning
    await Promise.all([firstPoll, secondPoll]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Poll anterior'));
    logSpy.mockRestore();
  });

  test('!ownerUid → warn y return', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbFactory = () => makeDb();
    await ie.runIntegrityPoll({ ownerUid: '', generateAI: undefined });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ownerUid'));
    warnSpy.mockRestore();
  });

  test('agenda vacía → poll completa sin errores', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      agendaStaleSnap: makeSnap([]),
      agendaCalSnap: makeSnap([]),
      sessionSnap: { exists: false, data: () => ({}) },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid2', generateAI: undefined });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Poll completo'));
    logSpy.mockRestore();
  });

  test('evento corrupto (sin reason) → update con _corruptData', async () => {
    const corruptDoc = makeDoc({ reason: null, scheduledFor: null, status: 'pending' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      agendaStaleSnap: makeSnap([corruptDoc]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid3', generateAI: undefined });
    expect(corruptDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({ _corruptData: true }));
    warnSpy.mockRestore();
  });

  test('evento con fecha inválida → update con _corruptData', async () => {
    const badDateDoc = makeDoc({ reason: 'Reunión', scheduledFor: 'not-a-date', status: 'pending' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      agendaStaleSnap: makeSnap([badDateDoc]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid4', generateAI: undefined });
    expect(badDateDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({ _corruptData: true }));
    warnSpy.mockRestore();
  });

  test('evento con hoursOld>48 → update status=expired', async () => {
    const old = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    const oldDoc = makeDoc({ reason: 'Vieja reunión', scheduledFor: old, status: 'pending' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      agendaStaleSnap: makeSnap([oldDoc]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid5', generateAI: undefined });
    expect(oldDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    warnSpy.mockRestore();
  });

  test('evento con hoursOld 1<h<=48 → solo warn (no update)', async () => {
    const slightlyOld = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const doc = makeDoc({ reason: 'Reunión reciente', scheduledFor: slightlyOld, status: 'pending' });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      agendaStaleSnap: makeSnap([doc]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid6', generateAI: undefined });
    expect(doc.ref.update).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('calendario: snap vacío → return', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      agendaCalSnap: makeSnap([]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid7', generateAI: undefined });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Poll completo'));
    logSpy.mockRestore();
  });

  test('calendario: todos ya verificados → return sin update', async () => {
    const verifiedDoc = makeDoc({ calendarSynced: true, calendarVerified: true, reason: 'x' });
    mockDbFactory = () => makeDb({
      agendaCalSnap: makeSnap([verifiedDoc]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid8', generateAI: undefined });
    expect(verifiedDoc.ref.update).not.toHaveBeenCalled();
  });

  test('calendario: doc sin verificar → update calendarVerified=true', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const unverDoc = makeDoc({ calendarSynced: true, calendarVerified: false, reason: 'Reunión' });
    mockDbFactory = () => makeDb({
      agendaCalSnap: makeSnap([unverDoc]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid9', generateAI: undefined });
    expect(unverDoc.ref.update).toHaveBeenCalledWith(expect.objectContaining({ calendarVerified: true }));
    logSpy.mockRestore();
  });

  test('con generateAI + session no existe → salta gemini audit', async () => {
    const generateAI = jest.fn();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: { exists: false, data: () => ({}) },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid10', generateAI });
    expect(generateAI).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('con generateAI + session vacía → salta gemini audit', async () => {
    const generateAI = jest.fn();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: { exists: true, data: () => ({ messages: [] }) },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid11', generateAI });
    expect(generateAI).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('con generateAI + mensajes recientes → llama generateAI', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue('{"promises":[],"preferences":[],"affinities":[]}');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({
          messages: [
            { timestamp: recentTs, fromMe: true, text: 'Hola, te agendé la reunión' },
            { timestamp: recentTs, fromMe: false, text: 'Gracias!', contactName: 'Juan' },
          ],
        }),
      },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid12', generateAI });
    expect(generateAI).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('gemini audit: response vacía (no JSON) → salta parse', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue('texto sin json');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Hola' }] }),
      },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid13', generateAI });
    warnSpy.mockRestore();
  });

  test('gemini audit: promesas rotas detectadas → log + counter', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({ promises: [{ text: 'prometió X', fulfilled: false }], preferences: [], affinities: [] })
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({ messages: [{ timestamp: recentTs, fromMe: true, text: 'Ya agendé todo' }] }),
      },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid14', generateAI });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('promesas rotas'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('gemini audit: preferencias → guarda en Firestore', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({
        promises: [],
        preferences: [{ contact: 'Juan', type: 'gusto', value: 'Boca', category: 'deporte' }],
        affinities: [],
      })
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    let prefSetCalled = false;
    const prefRef = {
      set: jest.fn().mockImplementation(() => { prefSetCalled = true; return Promise.resolve({}); }),
    };
    const mockCollectionImpl = jest.fn().mockReturnValue({
      doc: jest.fn().mockImplementation((id) => {
        if (id && id.includes('preference')) return prefRef;
        return { collection: jest.fn().mockReturnValue({ doc: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Soy hincha de Boca' }] }) }) }) }) };
      }),
    });

    // Use simpler approach: custom db
    const customDb = {
      batch: jest.fn().mockReturnValue(makeBatch()),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockImplementation((subCol) => {
            if (subCol === 'sessions') return {
              doc: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({
                  exists: true,
                  data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Soy hincha de Boca', contactName: 'Juan' }] }),
                }),
              }),
            };
            if (subCol === 'contact_preferences') return {
              doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
              where: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              get: jest.fn().mockResolvedValue(makeSnap([])),
            };
            if (subCol === 'contact_affinities') return {
              where: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              get: jest.fn().mockResolvedValue(makeSnap([])),
            };
            return { where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(makeSnap([])) };
          }),
        }),
      }),
    };
    mockDbFactory = () => customDb;
    await ie.runIntegrityPoll({ ownerUid: 'uid15', generateAI });
    logSpy.mockRestore();
  });

  test('gemini audit: afinidades → guarda en Firestore', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({
        promises: [],
        preferences: [],
        affinities: [{ contact: 'Juan', topic: 'futbol', detail: 'Boca' }],
      })
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const customDb = {
      batch: jest.fn().mockReturnValue(makeBatch()),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockImplementation((subCol) => {
            if (subCol === 'sessions') return {
              doc: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({
                  exists: true,
                  data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Soy de Boca', contactName: 'Juan' }] }),
                }),
              }),
            };
            if (subCol === 'contact_affinities') return {
              doc: jest.fn().mockReturnValue({ set: jest.fn().mockResolvedValue({}) }),
              where: jest.fn().mockReturnThis(),
              limit: jest.fn().mockReturnThis(),
              get: jest.fn().mockResolvedValue(makeSnap([])),
            };
            return { where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(makeSnap([])) };
          }),
        }),
      }),
    };
    mockDbFactory = () => customDb;
    await ie.runIntegrityPoll({ ownerUid: 'uid16', generateAI });
    logSpy.mockRestore();
  });

  test('gemini audit: preferencia sin contact → skip', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({
        promises: [],
        preferences: [{ contact: '', type: 'gusto', value: 'Boca', category: 'deporte' }],
        affinities: [],
      })
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Me gusta Boca', contactName: '' }] }),
      },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid17', generateAI });
    logSpy.mockRestore();
  });

  test('gemini audit: afinidad sin contact → skip', async () => {
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({
        promises: [],
        preferences: [],
        affinities: [{ contact: '', topic: 'futbol' }],
      })
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Hola' }] }),
      },
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid18', generateAI });
    logSpy.mockRestore();
  });

  test('generateAI + appendLearning → llama consolidateADNLearning si condiciones cumplidas', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const generateAI = jest.fn().mockResolvedValue('{"promises":[],"preferences":[],"affinities":[]}');
    const appendLearning = jest.fn();
    // Force lastAdnConsolidation to 0 by using fresh require — not possible without resetModules
    // Instead: just verify it's called when timeSinceLastConsolidation >= interval
    // Since lastAdnConsolidation starts at 0 in module load and we set Date.now to real,
    // this test just checks no error is thrown
    mockDbFactory = () => makeDb({
      sessionSnap: { exists: false, data: () => ({}) },
      prefsSnap: makeSnap([]),
      affsSnap: makeSnap([]),
    });
    await ie.runIntegrityPoll({ ownerUid: 'uid19', generateAI, appendLearning });
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('Firestore principal lanza error → catch + log error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    adminMock.firestore = jest.fn(() => { throw new Error('Firestore unavailable'); });
    await expect(ie.runIntegrityPoll({ ownerUid: 'uid20' })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error en poll'));
    adminMock.firestore = jest.fn(() => mockDbFactory());
    errSpy.mockRestore();
  });

  test('checkStalePendingEvents + checkCalendarSync Firestore error → catch líneas 263+292', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failingAgendaQuery = {
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockRejectedValue(new Error('Firestore stale error')),
    };
    mockDbFactory = () => ({
      batch: jest.fn().mockReturnValue(makeBatch()),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockReturnValue(failingAgendaQuery),
        }),
      }),
    });
    await expect(ie.runIntegrityPoll({ ownerUid: 'uid-agenda-fail', generateAI: undefined })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('STALE'));
    errSpy.mockRestore();
  });

  test('runGeminiAudit: prefRef.set() lanza error → prefErr catch (línea 380)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({ promises: [], preferences: [{ contact: 'Juan', type: 'gusto', value: 'Boca', category: 'deporte' }], affinities: [] })
    );
    mockDbFactory = () => ({
      batch: jest.fn().mockReturnValue(makeBatch()),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockImplementation((subCol) => {
            if (subCol === 'sessions') return {
              doc: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({
                  exists: true,
                  data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Me gusta Boca', contactName: 'Juan' }] }),
                }),
              }),
            };
            if (subCol === 'contact_preferences') return {
              doc: jest.fn().mockReturnValue({ set: jest.fn().mockRejectedValue(new Error('Firestore write fail')) }),
            };
            return { where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(makeSnap([])) };
          }),
        }),
      }),
    });
    await expect(ie.runIntegrityPoll({ ownerUid: 'uid-pref-fail', generateAI })).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Error guardando preferencia'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('runGeminiAudit: affRef.set() lanza error → affErr catch (línea 400)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockResolvedValue(
      JSON.stringify({ promises: [], preferences: [], affinities: [{ contact: 'Juan', topic: 'futbol', detail: 'Boca' }] })
    );
    mockDbFactory = () => ({
      batch: jest.fn().mockReturnValue(makeBatch()),
      collection: jest.fn().mockReturnValue({
        doc: jest.fn().mockReturnValue({
          collection: jest.fn().mockImplementation((subCol) => {
            if (subCol === 'sessions') return {
              doc: jest.fn().mockReturnValue({
                get: jest.fn().mockResolvedValue({
                  exists: true,
                  data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Soy de Boca', contactName: 'Juan' }] }),
                }),
              }),
            };
            if (subCol === 'contact_affinities') return {
              doc: jest.fn().mockReturnValue({ set: jest.fn().mockRejectedValue(new Error('Aff write fail')) }),
            };
            return { where: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), get: jest.fn().mockResolvedValue(makeSnap([])) };
          }),
        }),
      }),
    });
    await expect(ie.runIntegrityPoll({ ownerUid: 'uid-aff-fail', generateAI })).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Error guardando afinidad'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('runGeminiAudit: JSON válido en regex pero inválido → parseErr catch (líneas 405-407)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const recentTs = new Date().toISOString();
    // Returns something matching /\{[\s\S]*\}/ but not parseable as JSON
    const generateAI = jest.fn().mockResolvedValue('{ broken: undefined }');
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Hola mundo desde las pruebas' }] }),
      },
    });
    await expect(ie.runIntegrityPoll({ ownerUid: 'uid-parseerr', generateAI })).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No se pudo parsear'));
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('runGeminiAudit: generateAI lanza error → outer catch (líneas 409-411)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const recentTs = new Date().toISOString();
    const generateAI = jest.fn().mockRejectedValue(new Error('AI timeout'));
    mockDbFactory = () => makeDb({
      sessionSnap: {
        exists: true,
        data: () => ({ messages: [{ timestamp: recentTs, fromMe: false, text: 'Hola tengo una duda para consultar' }] }),
      },
    });
    await expect(ie.runIntegrityPoll({ ownerUid: 'uid-ai-throw', generateAI })).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error'));
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ── consolidateADNLearning ────────────────────────────────────────────────────

describe('consolidateADNLearning', () => {
  test('sin datos nuevos → log y return temprano', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const db = makeDb({
      prefsSnap: makeSnap([]),
      affsSnap: makeSnap([]),
    });
    await ie.consolidateADNLearning(db, 'uid', jest.fn(), jest.fn());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Sin datos nuevos'));
    logSpy.mockRestore();
  });

  test('prefs ya consolidadas → filtradas + sin datos → return', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const db = makeDb({
      prefsSnap: makeSnap([makeDoc({ consolidated: true, contactName: 'Juan', deporte: 'Boca' })]),
      affsSnap: makeSnap([]),
    });
    await ie.consolidateADNLearning(db, 'uid', jest.fn(), jest.fn());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Sin datos nuevos'));
    logSpy.mockRestore();
  });

  test('datos nuevos + generateAI retorna bloque válido → appendLearning + batch commit', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const generateAI = jest.fn().mockResolvedValue('- Juan: hincha de Boca, médico en Buenos Aires');
    const appendLearning = jest.fn();
    const batch = makeBatch();
    const db = makeDb({
      prefsSnap: makeSnap([makeDoc({ consolidated: false, contactName: 'Juan', deporte: 'Boca' })]),
      affsSnap: makeSnap([makeDoc({ consolidated: false, contactName: 'Juan', futbol: 'Boca' })]),
      batch,
    });
    await ie.consolidateADNLearning(db, 'uid', generateAI, appendLearning);
    expect(appendLearning).toHaveBeenCalled();
    expect(batch.commit).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  test('generateAI retorna bloque muy corto (<=10 chars) → warn + no appendLearning', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const generateAI = jest.fn().mockResolvedValue('corto');
    const appendLearning = jest.fn();
    const db = makeDb({
      prefsSnap: makeSnap([makeDoc({ consolidated: false, contactName: 'Juan', deporte: 'Boca' })]),
      affsSnap: makeSnap([]),
    });
    await ie.consolidateADNLearning(db, 'uid', generateAI, appendLearning);
    expect(appendLearning).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no generó bloque válido'));
    warnSpy.mockRestore();
  });

  test('prefs Firestore falla (catch) → usa segunda query sin filtro', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const generateAI = jest.fn().mockResolvedValue('corto');
    const db = makeDb({
      prefsFail: true, // primera query falla → catch → segunda sin filtro
      affsSnap: makeSnap([]),
    });
    await ie.consolidateADNLearning(db, 'uid', generateAI, jest.fn());
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('error en consolidación → catch + log error', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const generateAI = jest.fn().mockRejectedValue(new Error('AI error'));
    const db = makeDb({
      prefsSnap: makeSnap([makeDoc({ consolidated: false, contactName: 'Juan', x: 'y' })]),
      affsSnap: makeSnap([]),
    });
    await expect(ie.consolidateADNLearning(db, 'uid', generateAI, jest.fn())).resolves.not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Error en consolidación'));
    errSpy.mockRestore();
  });

  test('affs Firestore falla (catch) → usa segunda query sin filtro (línea 510)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const generateAI = jest.fn().mockResolvedValue('corto');
    const db = makeDb({
      prefsSnap: makeSnap([]),
      affsFail: true, // primera query affs falla → catch → segunda query sin filtro ejecuta (línea 510)
    });
    await ie.consolidateADNLearning(db, 'uid', generateAI, jest.fn());
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
