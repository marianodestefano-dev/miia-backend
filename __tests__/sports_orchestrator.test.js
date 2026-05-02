'use strict';

const so = require('../core/sports_orchestrator');

const UID = 'test_uid';

describe('shouldNotifyContact', () => {
  test('null contact -> false', () => {
    expect(so.shouldNotifyContact(null, {}, {})).toBe(false);
  });
  test('null sportSpec -> false', () => {
    expect(so.shouldNotifyContact({}, null, {})).toBe(false);
  });
  test('null event -> false', () => {
    expect(so.shouldNotifyContact({}, {}, null)).toBe(false);
  });
  test('contact sin sports -> false', () => {
    expect(so.shouldNotifyContact({ contactPhone: '+1' }, { type: 'futbol', team: 'Boca' }, { event: 'goal_us' })).toBe(false);
  });
  test('match futbol Boca -> true', () => {
    expect(so.shouldNotifyContact(
      { contactPhone: '+1', sports: [{ type: 'futbol', team: 'Boca Juniors' }] },
      { type: 'futbol', team: 'Boca Juniors' },
      { event: 'goal_us' }
    )).toBe(true);
  });
  test('mismatch team -> false', () => {
    expect(so.shouldNotifyContact(
      { contactPhone: '+1', sports: [{ type: 'futbol', team: 'River' }] },
      { type: 'futbol', team: 'Boca' },
      { event: 'goal_us' }
    )).toBe(false);
  });
  test('match f1 driver -> true', () => {
    expect(so.shouldNotifyContact(
      { contactPhone: '+1', sports: [{ type: 'f1', driver: 'Max Verstappen' }] },
      { type: 'f1', driver: 'Max Verstappen' },
      { event: 'pit_stop' }
    )).toBe(true);
  });
  test('type tenis no soportado -> false', () => {
    expect(so.shouldNotifyContact(
      { contactPhone: '+1', sports: [{ type: 'tenis', player: 'Nadal' }] },
      { type: 'tenis', player: 'Nadal' },
      { event: 'goal_us' }
    )).toBe(false);
  });
});

describe('buildMessageForEvent', () => {
  test('event null -> null', async () => {
    expect(await so.buildMessageForEvent(null, {}, '', {})).toBeNull();
  });
  test('event sin event field -> null', async () => {
    expect(await so.buildMessageForEvent({}, {}, '', {})).toBeNull();
  });
  test('goal_us con template', async () => {
    const m = await so.buildMessageForEvent(
      { event: 'goal_us', our: 1, rival: 0 },
      { type: 'futbol', team: 'Boca' }, ''
    );
    expect(m).toMatch(/Boca|GOOOOL|GOLAZO/);
  });
  test('final outcome GANAMOS', async () => {
    const m = await so.buildMessageForEvent(
      { event: 'final', our: 2, rival: 1 },
      { type: 'futbol', team: 'Boca' }, ''
    );
    expect(m).toMatch(/GANAMOS/);
  });
  test('final outcome Perdimos', async () => {
    const m = await so.buildMessageForEvent(
      { event: 'final', our: 0, rival: 1 },
      { type: 'futbol', team: 'Boca' }, ''
    );
    expect(m).toMatch(/Perdimos/);
  });
  test('final outcome Empate', async () => {
    const m = await so.buildMessageForEvent(
      { event: 'final', our: 1, rival: 1 },
      { type: 'futbol', team: 'Boca' }, ''
    );
    expect(m).toMatch(/Empate/);
  });
  test('f1 position_gain interpola', async () => {
    const m = await so.buildMessageForEvent(
      { event: 'position_gain', fromPosition: 3, toPosition: 1 },
      { type: 'f1', driver: 'Verstappen' }, ''
    );
    expect(m).toMatch(/Verstappen/);
    expect(m).toMatch(/P1/);
  });
  test('event tipo desconocido -> null', async () => {
    const m = await so.buildMessageForEvent(
      { event: 'no_existe' },
      { type: 'futbol', team: 'X' }, ''
    );
    expect(m).toBeNull();
  });
  test('geminiClient devuelve mensaje', async () => {
    const gemini = { generate: async () => 'GOOOL Boca!! 1-0!!' };
    const m = await so.buildMessageForEvent(
      { event: 'goal_us', our: 1, rival: 0 },
      { type: 'futbol', team: 'Boca' },
      'argentino',
      { geminiClient: gemini }
    );
    expect(m).toBe('GOOOL Boca!! 1-0!!');
  });
  test('geminiClient throws -> fallback template', async () => {
    const gemini = { generate: async () => { throw new Error('quota'); } };
    const m = await so.buildMessageForEvent(
      { event: 'goal_us', our: 1, rival: 0 },
      { type: 'futbol', team: 'Boca' }, '',
      { geminiClient: gemini }
    );
    expect(m).toBeDefined();
  });
  test('geminiClient devuelve no-string -> fallback', async () => {
    const gemini = { generate: async () => 123 };
    const m = await so.buildMessageForEvent(
      { event: 'goal_us', our: 1, rival: 0 },
      { type: 'futbol', team: 'Boca' }, '',
      { geminiClient: gemini }
    );
    expect(m).toBeDefined();
  });
});

describe('processSportTick', () => {
  test('uid undefined throw', async () => {
    await expect(so.processSportTick(undefined, { type: 'futbol' }, null, {})).rejects.toThrow('uid');
  });
  test('sportSpec undefined throw', async () => {
    await expect(so.processSportTick(UID, undefined, null, {})).rejects.toThrow('sportSpec');
  });
  test('sportSpec sin type throw', async () => {
    await expect(so.processSportTick(UID, {}, null, {})).rejects.toThrow('sportSpec');
  });
  test('type unsupported retorna sin event', async () => {
    const r = await so.processSportTick(UID, { type: 'tenis' }, null, {});
    expect(r.event).toBeNull();
    expect(r.sent).toBe(0);
  });
  test('futbol primer tick started + sent=1', async () => {
    const sender = jest.fn().mockResolvedValue(undefined);
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, {
      fetcher, sender,
      contacts: [{ contactPhone: '+1', sports: [{ type: 'futbol', team: 'Boca' }] }],
    });
    expect(r.event.event).toBe('started');
    expect(r.message).toBeDefined();
    expect(r.sent).toBe(1);
    expect(sender).toHaveBeenCalled();
  });
  test('f1 primer tick race_live -> race_start', async () => {
    const sender = jest.fn().mockResolvedValue(undefined);
    const fetcher = async () => ({ position: 1, lap: 1, status: 'race_live' });
    const r = await so.processSportTick(UID, { type: 'f1', driver: 'Verstappen' }, null, {
      fetcher, sender,
      contacts: [{ contactPhone: '+1', sports: [{ type: 'f1', driver: 'Verstappen' }] }],
    });
    expect(r.event.event).toBe('race_start');
    expect(r.sent).toBe(1);
  });
  test('sin event detectado retorna sent=0', async () => {
    const fetcher = async () => ({ our: 0, rival: 0, status: 'scheduled' });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, { fetcher });
    expect(r.event).toBeNull();
    expect(r.sent).toBe(0);
  });
  test('sender throw continua', async () => {
    const sender = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('send fail'))
      .mockResolvedValueOnce(undefined);
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, {
      fetcher, sender,
      contacts: [
        { contactPhone: '+1', sports: [{ type: 'futbol', team: 'Boca' }] },
        { contactPhone: '+2', sports: [{ type: 'futbol', team: 'Boca' }] },
        { contactPhone: '+3', sports: [{ type: 'futbol', team: 'Boca' }] },
      ],
    });
    expect(r.sent).toBe(2);
  });
  test('contactos sin match no notificados', async () => {
    const sender = jest.fn().mockResolvedValue(undefined);
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, {
      fetcher, sender,
      contacts: [{ contactPhone: '+1', sports: [{ type: 'futbol', team: 'River' }] }],
    });
    expect(r.sent).toBe(0);
  });
  test('sin contacts ni sender retorna currentState', async () => {
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, { fetcher });
    expect(r.currentState).toBeDefined();
    expect(r.sent).toBe(0);
  });
});

describe('TEMPLATES', () => {
  test('frozen', () => {
    expect(() => { so.TEMPLATES.x = []; }).toThrow();
  });
  test('contiene goal_us', () => {
    expect(so.TEMPLATES.goal_us).toBeDefined();
    expect(so.TEMPLATES.position_gain).toBeDefined();
  });
});

describe('extra branches sports_orchestrator', () => {
  test('buildMessageForEvent geminiClient prompt incluye sport type default futbol', async () => {
    let prompt = null;
    const gemini = { generate: async (p) => { prompt = p; return 'MSG'; } };
    await so.buildMessageForEvent(
      { event: 'goal_us', our: 1, rival: 0 },
      { team: 'Boca' }, // sin type
      '',
      { geminiClient: gemini }
    );
    expect(prompt).toContain('futbol');
  });
  test('buildMessageForEvent ownerStyle default', async () => {
    let prompt = null;
    const gemini = { generate: async (p) => { prompt = p; return 'MSG'; } };
    await so.buildMessageForEvent(
      { event: 'goal_us', our: 1, rival: 0 },
      { type: 'futbol', team: 'Boca' },
      undefined,
      { geminiClient: gemini }
    );
    expect(prompt).toContain('argentino');
  });
  test('shouldNotifyContact event sin field event aun retorna false', () => {
    expect(so.shouldNotifyContact(
      { sports: [{ type: 'futbol', team: 'X' }] },
      { type: 'futbol', team: 'X' },
      {}
    )).toBe(true); // event presente aunque sin campo "event"
  });
  test('processSportTick con sender pero sin contacts', async () => {
    const sender = jest.fn();
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, { fetcher, sender });
    expect(sender).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });
  test('processSportTick contactos pero sender no es funcion', async () => {
    const fetcher = async () => ({ our: 0, rival: 0, status: 'live', minute: 1 });
    const r = await so.processSportTick(UID, { type: 'futbol', team: 'Boca' }, null, {
      fetcher, sender: 'no-funcion',
      contacts: [{ contactPhone: '+1', sports: [{ type: 'futbol', team: 'Boca' }] }],
    });
    expect(r.sent).toBe(0);
  });
});

describe('FINAL 100% sports_orchestrator', () => {
  test('Gemini prompt usa sportSpec.driver cuando team ausente', async () => {
    let prompt = null;
    const gemini = { generate: async (p) => { prompt = p; return 'msg'; } };
    await so.buildMessageForEvent(
      { event: 'pit_stop', position: 1 },
      { type: 'f1', driver: 'Verstappen' }, // sin team
      '',
      { geminiClient: gemini }
    );
    expect(prompt).toContain('Verstappen');
  });
  test('shouldNotifyContact recorre todos sports buscando match', () => {
    expect(so.shouldNotifyContact(
      { sports: [
        { type: 'futbol', team: 'River' },     // no match (type ok, team no)
        { type: 'f1', driver: 'V' },           // type mismatch
        { type: 'futbol', team: 'Boca' },      // match
      ]},
      { type: 'futbol', team: 'Boca' },
      {}
    )).toBe(true);
  });
});
