'use strict';

/**
 * sports_e2e_smoke.test.js -- T-MD-9 smoke E2E Modo Deporte
 * + T-P3-5 smoke E2E Piso 3
 * Conecta los modulos para validar flujos completos.
 */

const sd = require('../core/sports_detector');
const smd = require('../core/sports_mention_detector');
const so = require('../core/sports_orchestrator');
const cc = require('../core/catalog_conversational');
const ow = require('../core/onboarding_wizard');
const aio = require('../core/audio_io');

const UID = 'test_uid_e2e';

function makeBasicMockDb() {
  const docs = {};
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (key) => ({
            get: async () => ({ exists: !!docs[key], data: () => docs[key] || null }),
            set: async (data) => { docs[key] = Object.assign(docs[key] || {}, data); },
            delete: async () => { delete docs[key]; },
          }),
          get: async () => ({
            forEach: fn => Object.entries(docs).forEach(([id, d]) => fn({ id, data: () => d })),
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => {
  sd.__setFirestoreForTests(null);
  cc.__setFirestoreForTests(null);
  ow.__setFirestoreForTests(null);
  aio.__setFirestoreForTests(null);
});

describe('E2E Modo Deporte: Tio Roberto + Boca + gol', () => {
  test('flujo completo: detect mention -> save sport -> tick gol -> notify', async () => {
    sd.__setFirestoreForTests(makeBasicMockDb());

    // 1. Mention detection
    const mention = smd.detectSportMention('Vamos Boca!! a ganar la copa');
    expect(mention.team).toBe('Boca Juniors');
    expect(mention.confidence).toBe('high');

    // 2. Save sport para Tio Roberto
    await sd.setSportForContact(UID, '5491155667788', {
      type: mention.type,
      team: mention.team,
      rivalry: mention.rivalry,
    }, { contactName: 'Tio Roberto' });

    // 3. Tick: simular gol de Boca
    let prevState = null;
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      if (fetchCount === 1) return { our: 0, rival: 0, status: 'live', minute: 1 };
      if (fetchCount === 2) return { our: 1, rival: 0, status: 'live', minute: 14 };
      return { our: 1, rival: 0, status: 'finished', minute: 90 };
    };

    const sentMessages = [];
    const sender = async (uid, phone, msg) => { sentMessages.push({ uid, phone, msg }); };

    // Cargar contactos del miia_sports
    const contacts = await sd.getAllContactsBySport(UID, 'futbol');
    const contactsForOrch = contacts.map(c => ({
      contactPhone: c.contactPhone,
      sports: [c.sport],
    }));

    // Tick 1: started
    let r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca Juniors' }, prevState, {
      fetcher, sender, contacts: contactsForOrch,
    });
    expect(r.event.event).toBe('started');
    expect(r.sent).toBe(1);
    prevState = r.currentState;

    // Tick 2: gol
    r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca Juniors' }, prevState, {
      fetcher, sender, contacts: contactsForOrch,
    });
    expect(r.event.event).toBe('goal_us');
    expect(r.sent).toBe(1);
    expect(sentMessages[1].msg).toMatch(/Boca|GOOOOL|GOLAZO/);
    prevState = r.currentState;

    // Tick 3: final
    r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca Juniors' }, prevState, {
      fetcher, sender, contacts: contactsForOrch,
    });
    expect(r.event.event).toBe('final');
    expect(r.sent).toBe(1);
    expect(sentMessages[2].msg).toMatch(/GANAMOS/);
  });
});

describe('E2E Piso 3: onboarding -> catalog -> search', () => {
  test('flujo completo: onboarding 5 pasos -> agregar productos -> buscar', async () => {
    ow.__setFirestoreForTests(makeBasicMockDb());
    cc.__setFirestoreForTests(makeBasicMockDb());

    // 1. Start onboarding
    let state = await ow.startOnboarding(UID);
    expect(state.currentStep).toBe('business_info');

    // 2. Save 5 steps
    let r = await ow.saveStep(UID, 'business_info', { name: 'Pizzeria Don Mario', vertical: 'food' });
    expect(r.nextStep).toBe('products');

    r = await ow.saveStep(UID, 'products', { products: [
      { name: 'Pizza Muzzarella', price: 12000 },
      { name: 'Pizza Napolitana', price: 14000 },
    ]});
    expect(r.nextStep).toBe('hours');

    r = await ow.saveStep(UID, 'hours', { timezone: 'AR', openTime: '19:00', closeTime: '00:00' });
    expect(r.nextStep).toBe('disclaimer_mode');

    r = await ow.saveStep(UID, 'disclaimer_mode', { mode: 'on_request' });
    expect(r.nextStep).toBe('test_message');

    r = await ow.saveStep(UID, 'test_message', { targetPhone: '+5491155667788' });
    expect(r.isComplete).toBe(true);

    // 3. Agregar productos via parser self-chat
    const parsed = cc.parseAddProductCommand('MIIA agregalo: Pizza Muzzarella $12000 stock 50');
    expect(parsed.name).toBe('Pizza Muzzarella');
    expect(parsed.price).toBe(12000);
    expect(parsed.stock).toBe(50);

    await cc.addProduct(UID, parsed);

    // 4. Buscar producto
    const found = await cc.searchProductByName(UID, 'pizza');
    expect(found.length).toBe(1);
    expect(found[0].name).toBe('Pizza Muzzarella');
  });
});

describe('E2E Audio: transcribe + synthesize integrado', () => {
  test('audio incoming pipeline', async () => {
    const transcriber = async () => 'hola, queria saber el precio de la pizza';
    const r = await aio.transcribeIncomingAudio('mock_buffer', { transcriber, languageHint: 'es' });
    expect(r.text).toContain('pizza');
  });

  test('audio outgoing condicional + synthesize', async () => {
    aio.__setFirestoreForTests(makeBasicMockDb());

    // Sin config -> false
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(false);

    // Habilitar
    await aio.setAudioPreferences(UID, { audioOutputEnabled: true, voiceId: 'antoni' });

    // Ahora -> true
    expect(await aio.shouldUseAudioOutput(UID, '+1')).toBe(true);

    // Sintetizar
    const synthesizer = async (text, voice) => Buffer.from(`audio:${voice}:${text}`);
    const audio = await aio.synthesizeAudioOutput('Hola, la pizza esta a 12000 pesos', {
      synthesizer, voiceId: 'antoni'
    });
    expect(audio).toBeDefined();
    expect(audio.toString()).toContain('antoni');
  });
});
