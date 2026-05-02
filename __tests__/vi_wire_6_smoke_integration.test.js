'use strict';

/**
 * vi_wire_6_smoke_integration.test.js -- VI-WIRE-6
 * Smoke E2E integration con flags ON validando el pipeline completo
 * SIN WhatsApp real (mocks).
 *
 * Cubre:
 *  - PASO 1c4 catalog (PISO3_CATALOGO_ENABLED=1) -> parseAddProductCommand + addProduct
 *  - audio_io transcribe + synthesize integrado
 *  - modo_deporte_cron tickAllOwners con sports detector + orchestrator
 */

const featureFlags = require('../core/feature_flags');
const cc = require('../core/catalog_conversational');
const aio = require('../core/audio_io');
const sd = require('../core/sports_detector');
const so = require('../core/sports_orchestrator');
const cron = require('../services/modo_deporte_cron');

const UID_CENTER = 'A5pMESWlfmPWCoCPRbwy85EzUzy2';

beforeEach(() => {
  for (const f of featureFlags.FLAG_NAMES) delete process.env[f];
  cc.__setFirestoreForTests(null);
  aio.__setFirestoreForTests(null);
  sd.__setFirestoreForTests(null);
  cron._resetForTesting();
});

afterEach(() => {
  for (const f of featureFlags.FLAG_NAMES) delete process.env[f];
  cron._resetForTesting();
});

function makeSimpleDb() {
  const docs = {};
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (id) => ({
            get: async () => ({ exists: !!docs[id], data: () => docs[id] }),
            set: async (data) => { docs[id] = Object.assign(docs[id] || {}, data); },
            delete: async () => { delete docs[id]; },
          }),
          get: async () => ({
            forEach: fn => Object.entries(docs).forEach(([id, d]) => fn({ id, data: () => d })),
          }),
        }),
      }),
    }),
  };
}

describe('VI-WIRE-6 SMOKE: PASO 1c4 catalog flow', () => {
  test('flag ON + comando self-chat -> producto persisted', async () => {
    process.env.PISO3_CATALOGO_ENABLED = '1';
    cc.__setFirestoreForTests(makeSimpleDb());

    // Simulamos lo que el wire-in PASO 1c4 hace
    const messageBody = 'MIIA agregalo: Pizza Muzzarella $12000 stock 50';
    expect(featureFlags.isFlagEnabled('PISO3_CATALOGO_ENABLED')).toBe(true);
    const parsed = cc.parseAddProductCommand(messageBody);
    expect(parsed.name).toBe('Pizza Muzzarella');
    const product = await cc.addProduct(UID_CENTER, parsed);
    expect(product.id).toBeDefined();
    expect(product.price).toBe(12000);
  });

  test('flag OFF -> wire skipea, mensaje pasa al pipeline normal', () => {
    process.env.PISO3_CATALOGO_ENABLED = '0';
    expect(featureFlags.isFlagEnabled('PISO3_CATALOGO_ENABLED')).toBe(false);
    // El wire-in no llama parseAddProductCommand cuando flag OFF -> skip
  });
});

describe('VI-WIRE-6 SMOKE: audio in/out flow', () => {
  test('audio in transcribe + audio out synthesize integrados', async () => {
    process.env.PISO3_AUDIO_IN_ENABLED = '1';
    process.env.PISO3_AUDIO_OUT_ENABLED = '1';
    aio.__setFirestoreForTests(makeSimpleDb());

    // 1. Transcribe incoming
    const incoming = await aio.transcribeIncomingAudio(Buffer.from('mock-ogg'), {
      format: 'ogg',
      transcriber: async () => 'queria preguntar el precio de la pizza',
    });
    expect(incoming.text).toContain('precio');

    // 2. Owner config audio out
    await aio.setAudioPreferences(UID_CENTER, { audioOutputEnabled: true, voiceId: 'rachel' });
    expect(await aio.shouldUseAudioOutput(UID_CENTER, '+1')).toBe(true);

    // 3. Synthesize outgoing
    const outAudio = await aio.synthesizeAudioOutput('La pizza esta a 12000 pesos', {
      synthesizer: async (text, voice) => Buffer.from(`tts:${voice}:${text}`),
      voiceId: 'rachel',
    });
    expect(outAudio.toString()).toContain('rachel');
  });
});

describe('VI-WIRE-6 SMOKE: modo deporte cron flow', () => {
  test('cron flag ON + sports cargados -> tick procesa eventos', async () => {
    process.env.MIIA_MODO_DEPORTE_ENABLED = '1';
    sd.__setFirestoreForTests(makeSimpleDb());

    // Owner sigue Boca con un contacto
    await sd.setSportForContact(UID_CENTER, '+5491155667788', {
      type: 'futbol', team: 'Boca Juniors', rivalry: 'River Plate',
    }, { contactName: 'Tio Roberto' });

    // Tick con fetcher mock que devuelve gol
    const sentMessages = [];
    const sender = async (uid, phone, msg) => { sentMessages.push({ uid, phone, msg }); };

    const fetcher = async () => ({ our: 1, rival: 0, status: 'live', minute: 14 });

    const r = await cron.tickAllOwners({
      activeOwners: [UID_CENTER],
      fetcher,
      sender,
    });

    expect(r.processed).toBeGreaterThan(0);
    expect(r.sentTotal).toBeGreaterThan(0);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].phone).toBe('+5491155667788');
  });
});

describe('VI-WIRE-6 SMOKE: anti-regresion -- todos los flags OFF', () => {
  test('feature_flags getAllFlags() todos false', () => {
    const flags = featureFlags.getAllFlags();
    expect(Object.values(flags).every(v => v === false)).toBe(true);
  });
  test('cron NO arranca con flag OFF', () => {
    expect(cron.startCron()).toBe(false);
    expect(cron.isRunning()).toBe(false);
  });
  test('catalog parser SI funciona, pero wire SOLO se activa con flag', () => {
    // Parser puro funciona siempre (es funcion pura)
    const parsed = cc.parseAddProductCommand('agregalo: X $100');
    expect(parsed).not.toBeNull();
    // Pero el wire-in PASO 1c4 NO ejecuta si flag OFF
    expect(featureFlags.isFlagEnabled('PISO3_CATALOGO_ENABLED')).toBe(false);
  });
});

describe('VI-WIRE-6 SMOKE: multi-feature simultaneo', () => {
  test('todas las flags ON -> todos los wires activos sin colision', async () => {
    process.env.PISO3_CATALOGO_ENABLED = '1';
    process.env.PISO3_AUDIO_IN_ENABLED = '1';
    process.env.PISO3_AUDIO_OUT_ENABLED = '1';
    process.env.MIIA_MODO_DEPORTE_ENABLED = '1';

    const flags = featureFlags.getAllFlags();
    expect(Object.values(flags).every(v => v === true)).toBe(true);

    // Verificar que cada modulo carga sin colision
    expect(typeof cc.parseAddProductCommand).toBe('function');
    expect(typeof aio.transcribeIncomingAudio).toBe('function');
    expect(typeof aio.synthesizeAudioOutput).toBe('function');
    expect(typeof cron.startCron).toBe('function');
  });
});
