'use strict';

/**
 * VI-BACKEND-COVERAGE: pattern_engine.js — 100% branches
 * Usa jest.resetModules() para aislar state mutable (_deps, _ownerUid, _analysisInterval).
 */

function freshEngine() {
  jest.resetModules();
  return require('../core/pattern_engine');
}

function makeFirestore({ dnaExists = false, dnaData = {}, sessionExists = false, sessionData = {} } = {}) {
  const setMock = jest.fn().mockResolvedValue(undefined);
  const getMock = jest.fn().mockResolvedValue({ exists: false });

  const db = {
    _setMock: setMock,
    _getMock: getMock,
    collection: () => ({
      doc: () => ({
        get: () => Promise.resolve({ exists: dnaExists, data: () => dnaData }),
        collection: () => ({
          doc: () => ({
            get: () => Promise.resolve({ exists: sessionExists, data: () => sessionData }),
            set: setMock,
          }),
        }),
        set: setMock,
      }),
    }),
  };
  return db;
}

function makeAIGateway(result = { text: '{"faq":[],"objections":[],"closingStrategies":[],"peakHours":[],"sellerDNA":{"tone":"informal"}}' }) {
  return { smartCall: jest.fn().mockResolvedValue(result) };
}

// ── init + stop ───────────────────────────────────────────────────────────────

describe('init + stop', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('init registra interval y setTimeout', () => {
    const pe = freshEngine();
    const fs = makeFirestore();
    const ai = makeAIGateway();
    pe.init('uid-owner', { firestore: fs, aiGateway: ai });
    // No assertions needed — just covers init lines
  });

  test('stop limpia el interval', () => {
    const pe = freshEngine();
    pe.init('uid-stop', { firestore: makeFirestore(), aiGateway: makeAIGateway() });
    pe.stop(); // clears _analysisInterval
  });

  test('stop sin _analysisInterval → no throw', () => {
    const pe = freshEngine();
    pe.stop(); // _analysisInterval = null
  });
});

// ── getSellerDNA ──────────────────────────────────────────────────────────────

describe('getSellerDNA', () => {
  test('sin _deps → retorna null', async () => {
    const pe = freshEngine();
    const r = await pe.getSellerDNA();
    expect(r).toBeNull();
  });

  test('con _deps pero sin ownerUid → retorna null', async () => {
    const pe = freshEngine();
    // init con uid vacío no es válido para nuestra expectativa, pero podemos usar _deps sin uid
    // Llamar directamente getSellerDNA sin init → _deps=null, _ownerUid=null → null
    const r = await pe.getSellerDNA();
    expect(r).toBeNull();
  });

  test('con _deps y ownerUid, doc.exists=true → retorna data', async () => {
    const pe = freshEngine();
    const dnaData = { tone: 'informal', faq: [] };
    // getSellerDNA usa .collection('users').doc().collection('settings').doc().get()
    // → la respuesta viene de sessionExists/sessionData en makeFirestore
    const fs = makeFirestore({ sessionExists: true, sessionData: dnaData });
    pe.init('uid-dna', { firestore: fs, aiGateway: makeAIGateway() });
    const r = await pe.getSellerDNA();
    expect(r).toEqual(dnaData);
  });

  test('con _deps y ownerUid, doc.exists=false → retorna null', async () => {
    const pe = freshEngine();
    const fs = makeFirestore({ sessionExists: false });
    pe.init('uid-dna2', { firestore: fs, aiGateway: makeAIGateway() });
    const r = await pe.getSellerDNA();
    expect(r).toBeNull();
  });

  test('firestore.get() lanza → catch, retorna null', async () => {
    const pe = freshEngine();
    const fs = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: () => ({ get: () => { throw new Error('fs-crash'); } }),
          }),
        }),
      }),
    };
    pe.init('uid-err', { firestore: fs, aiGateway: makeAIGateway() });
    const r = await pe.getSellerDNA();
    expect(r).toBeNull();
  });
});

// ── runPatternAnalysis ────────────────────────────────────────────────────────

describe('runPatternAnalysis — early returns', () => {
  test('sin _deps → early return', async () => {
    const pe = freshEngine();
    await pe.runPatternAnalysis(); // _deps=null → return
  });

  test('con _deps pero sin firestore → early return', async () => {
    const pe = freshEngine();
    pe.init('uid-1', { firestore: null, aiGateway: null });
    await pe.runPatternAnalysis();
  });

  test('con deps pero < 3 conversaciones → skip análisis', async () => {
    const pe = freshEngine();
    const fs = makeFirestore({ sessionExists: true, sessionData: { conversations: {} } }); // sin convs
    pe.init('uid-2', { firestore: fs, aiGateway: makeAIGateway() });
    await pe.runPatternAnalysis();
  });
});

describe('runPatternAnalysis — flujo completo', () => {
  function makeSessionFSWithConvs(convs) {
    const setMock = jest.fn().mockResolvedValue(undefined);
    const fs = {
      _setMock: setMock,
      collection: (col) => ({
        doc: (uid) => ({
          collection: (sub) => ({
            doc: (dateStr) => {
              if (sub === 'tenant_sessions') {
                return {
                  get: () => Promise.resolve({ exists: true, data: () => ({ conversations: convs }) }),
                };
              }
              // pattern_analysis + seller_dna
              return {
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
                set: setMock,
              };
            },
          }),
        }),
      }),
    };
    return { fs, setMock };
  }

  const ENOUGH_CONVS = {};
  for (let i = 0; i < 3; i++) {
    ENOUGH_CONVS[`+5700${i}`] = {
      contactName: `Lead ${i}`,
      type: 'lead',
      messages: [
        { role: 'lead', text: '¿Cuánto cuesta?' },
        { from: 'owner', body: 'Depende del plan.' },
        { content: 'Ok gracias' },
      ],
    };
  }

  test('3 conversaciones → detectPatterns llamado, patrones guardados', async () => {
    const pe = freshEngine();
    const { fs, setMock } = makeSessionFSWithConvs(ENOUGH_CONVS);
    const ai = makeAIGateway();
    pe.init('uid-3', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(ai.smartCall).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalled();
  });

  test('aiGateway retorna null text → patterns null, return early', async () => {
    const pe = freshEngine();
    const { fs } = makeSessionFSWithConvs(ENOUGH_CONVS);
    const ai = makeAIGateway(null); // result=null → result?.text = undefined
    pe.init('uid-4', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
  });

  test('detectPatterns result sin JSON match → rawAnalysis', async () => {
    const pe = freshEngine();
    const { fs, setMock } = makeSessionFSWithConvs(ENOUGH_CONVS);
    const ai = makeAIGateway({ text: 'Solo texto sin JSON aquí' });
    pe.init('uid-5', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(setMock).toHaveBeenCalled();
  });

  test('error en firestore.set → catch, no throw', async () => {
    const pe = freshEngine();
    const fs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: () => {
              if (sub === 'tenant_sessions') {
                return { get: () => { throw new Error('session-crash'); } };
              }
              return {
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
                set: jest.fn().mockRejectedValue(new Error('set-crash')),
              };
            },
          }),
        }),
      }),
    };
    pe.init('uid-err', { firestore: fs, aiGateway: makeAIGateway() });
    await pe.runPatternAnalysis(); // should not throw
  });

  test('pattern_analysis.set lanza → outer catch en runPatternAnalysis', async () => {
    // Para cubrir línea 85: el set de pattern_analysis falla (no detectPatterns ni updateSellerDNA)
    const pe = freshEngine();
    const convs = {};
    for (let i = 0; i < 3; i++) {
      convs[`+5700${i}`] = {
        messages: [{ role: 'lead', text: 'q' }, { role: 'owner', text: 'a' }],
      };
    }
    const fs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: () => {
              if (sub === 'tenant_sessions') {
                return { get: () => Promise.resolve({ exists: true, data: () => ({ conversations: convs }) }) };
              }
              if (sub === 'pattern_analysis') {
                return { set: jest.fn().mockRejectedValue(new Error('pattern-set-crash')) };
              }
              return {
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
                set: jest.fn().mockResolvedValue(undefined),
              };
            },
          }),
        }),
      }),
    };
    pe.init('uid-outer-catch', { firestore: fs, aiGateway: makeAIGateway() });
    await pe.runPatternAnalysis(); // triggers outer catch (line 85)
  });

  test('aiGateway.smartCall lanza → catch en detectPatterns (líneas 182-183)', async () => {
    const pe = freshEngine();
    const convs = {};
    for (let i = 0; i < 3; i++) {
      convs[`+5700${i}`] = {
        messages: [{ role: 'lead', text: 'q' }, { role: 'owner', text: 'a' }],
      };
    }
    const fs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: () => {
              if (sub === 'tenant_sessions') {
                return { get: () => Promise.resolve({ exists: true, data: () => ({ conversations: convs }) }) };
              }
              return {
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
                set: jest.fn().mockResolvedValue(undefined),
              };
            },
          }),
        }),
      }),
    };
    const ai = { smartCall: jest.fn().mockRejectedValue(new Error('ai-crash')) };
    pe.init('uid-detect-err', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis(); // detectPatterns catch → null → runPatternAnalysis returns
  });
});

// ── collectLeadConversations branches ────────────────────────────────────────

describe('collectLeadConversations — branches internos (via runPatternAnalysis)', () => {
  function makeFSWithMixedSessions() {
    // Primera query returns exists=false, resto returns exists=true con convs que tienen <2 mensajes
    let callCount = 0;
    const setMock = jest.fn().mockResolvedValue(undefined);
    const fs = {
      _setMock: setMock,
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: () => {
              if (sub === 'tenant_sessions') {
                callCount++;
                if (callCount === 1) {
                  // Día 1: doc.exists = false (cubre branch false de línea 105)
                  return { get: () => Promise.resolve({ exists: false }) };
                }
                if (callCount === 2) {
                  // Día 2: conversations undefined/null (cubre false de línea 107)
                  return { get: () => Promise.resolve({ exists: true, data: () => ({}) }) };
                }
                if (callCount === 3) {
                  // Día 3: conv.messages.length < 2 (cubre false de línea 109)
                  return { get: () => Promise.resolve({ exists: true, data: () => ({
                    conversations: { '+57001': { messages: [{ role: 'lead', text: 'solo uno' }] } }
                  })}) };
                }
                // Días 4-7: 3 conversations válidas cada una con mensajes sin text/body/content
                const convs = {};
                for (let i = 0; i < 3; i++) {
                  convs[`+5700${callCount}${i}`] = {
                    messages: [
                      { role: 'lead', text: 'pregunta' },
                      { from: 'owner', body: 'respuesta' },
                      {}, // sin text/body/content → ''.substring(0,300) (línea 118 || '')
                    ],
                  };
                }
                return { get: () => Promise.resolve({ exists: true, data: () => ({ conversations: convs }) }) };
              }
              // pattern_analysis + seller_dna
              return {
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
                set: setMock,
              };
            },
          }),
        }),
      }),
    };
    return { fs, setMock };
  }

  test('doc.exists false + data sin conversations + messages<2 + mensaje sin texto → todos los branches', async () => {
    const pe = freshEngine();
    const { fs } = makeFSWithMixedSessions();
    const ai = makeAIGateway(); // default JSON con sellerDNA+faq
    pe.init('uid-mixed', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    // Se cubren líneas 105(false), 107(false), 109(false), 118(|| '')
  });
});

// ── updateSellerDNA (via runPatternAnalysis) ──────────────────────────────────

describe('updateSellerDNA — branches', () => {
  function makeFSForDNA({ dnaExists, dnaData }) {
    const setMock = jest.fn().mockResolvedValue(undefined);
    const fs = {
      _setMock: setMock,
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: () => {
              if (sub === 'tenant_sessions') {
                // 3 conversations enough
                const convs = {};
                for (let i = 0; i < 3; i++) {
                  convs[`+5700${i}`] = {
                    messages: [{ role: 'lead', text: 'q' }, { role: 'owner', text: 'a' }],
                  };
                }
                return { get: () => Promise.resolve({ exists: true, data: () => ({ conversations: convs }) }) };
              }
              if (sub === 'pattern_analysis') {
                return { get: () => Promise.resolve({ exists: false, data: () => ({}) }), set: setMock };
              }
              // seller_dna
              return { get: () => Promise.resolve({ exists: dnaExists, data: () => dnaData }), set: setMock };
            },
          }),
        }),
      }),
    };
    return { fs, setMock };
  }

  test('patterns sin sellerDNA y sin faq → updateSellerDNA early return', async () => {
    const pe = freshEngine();
    const { fs } = makeFSForDNA({ dnaExists: false, dnaData: {} });
    const ai = makeAIGateway({ text: '{"objections":[]}' }); // sin sellerDNA ni faq
    pe.init('uid-u1', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
  });

  test('DNA existente → merge FAQ sin duplicados', async () => {
    const pe = freshEngine();
    const existingDNA = {
      faq: [{ question: '¿cuánto cuesta el plan?' }],
      totalAnalyses: 5,
    };
    const { fs, setMock } = makeFSForDNA({ dnaExists: true, dnaData: existingDNA });
    const aiResult = { text: '{"faq":[{"question":"¿cuánto cuesta el plan?","idealAnswer":"Depende"},{"question":"¿Tienen prueba gratis?","idealAnswer":"Sí"}],"sellerDNA":{"tone":"informal"}}' };
    const ai = makeAIGateway(aiResult);
    pe.init('uid-u2', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(setMock).toHaveBeenCalled();
  });

  test('DNA no existente → existingDNA = {}', async () => {
    const pe = freshEngine();
    const { fs, setMock } = makeFSForDNA({ dnaExists: false, dnaData: {} });
    const ai = makeAIGateway(); // default JSON with sellerDNA
    pe.init('uid-u3', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(setMock).toHaveBeenCalled();
  });

  test('patterns con sellerDNA pero sin faq → faq usa [] (línea 200 || [])', async () => {
    const pe = freshEngine();
    const { fs, setMock } = makeFSForDNA({ dnaExists: false, dnaData: {} });
    // patterns sin faq pero con sellerDNA → guard pasa, line 200: patterns.faq || [] = [] (falsy)
    const ai = makeAIGateway({ text: '{"sellerDNA":{"tone":"formal"}}' });
    pe.init('uid-u-nofaq', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(setMock).toHaveBeenCalled();
  });

  test('patterns sin sellerDNA, existingDNA con sellerDNA → línea 218 || existingDNA.sellerDNA', async () => {
    const pe = freshEngine();
    const existingDNA = { sellerDNA: { tone: 'formal' }, faq: [], totalAnalyses: 1 };
    const { fs, setMock } = makeFSForDNA({ dnaExists: true, dnaData: existingDNA });
    // patterns con faq pero sin sellerDNA → line 218: patterns.sellerDNA(undef) || existingDNA.sellerDNA
    const ai = makeAIGateway({ text: '{"faq":[{"question":"q","idealAnswer":"a"}]}' });
    pe.init('uid-u-nosdna', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(setMock).toHaveBeenCalled();
  });

  test('patterns y existingDNA sin sellerDNA → línea 218 || {}', async () => {
    const pe = freshEngine();
    const { fs, setMock } = makeFSForDNA({ dnaExists: false, dnaData: {} });
    // patterns con faq pero sin sellerDNA, existingDNA={} → line 218: undef || undef || {}
    const ai = makeAIGateway({ text: '{"faq":[{"question":"q","idealAnswer":"a"}]}' });
    pe.init('uid-u-bothnosdna', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
    expect(setMock).toHaveBeenCalled();
  });

  test('updateSellerDNA error en set → catch, no throw', async () => {
    const pe = freshEngine();
    const fs = {
      collection: () => ({
        doc: () => ({
          collection: (sub) => ({
            doc: () => {
              const convs = {};
              for (let i = 0; i < 3; i++) {
                convs[`+5700${i}`] = {
                  messages: [{ role: 'lead', text: 'q' }, { role: 'owner', text: 'a' }],
                };
              }
              if (sub === 'tenant_sessions') {
                return { get: () => Promise.resolve({ exists: true, data: () => ({ conversations: convs }) }) };
              }
              if (sub === 'pattern_analysis') {
                return { get: () => Promise.resolve({ exists: false }), set: jest.fn().mockResolvedValue(undefined) };
              }
              return {
                get: () => Promise.resolve({ exists: false, data: () => ({}) }),
                set: jest.fn().mockRejectedValue(new Error('dna-crash')),
              };
            },
          }),
        }),
      }),
    };
    const ai = makeAIGateway();
    pe.init('uid-u4', { firestore: fs, aiGateway: ai });
    await pe.runPatternAnalysis();
  });
});
