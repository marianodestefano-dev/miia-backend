const { FLAGS, scoreConversation, detectEscalation, getQualityTrend, flagConversation, __setFirestoreForTests } = require('../core/conversation_quality');

function makeDb() {
  const store = {};
  function makeDoc(p) {
    return {
      get: async () => { const d = store[p]; return { exists: !!d, data: () => d }; },
      set: async (data, opts) => {
        if (opts && opts.merge) store[p] = Object.assign({}, store[p] || {}, data);
        else store[p] = Object.assign({}, data);
      },
      collection: (sub) => makeCol(p + '/' + sub),
    };
  }
  function makeCol(p) {
    return {
      doc: (id) => makeDoc(p + '/' + id),
      where: (f, op, v) => ({
        where: (f2, op2, v2) => ({
          get: async () => {
            const prefix = p + '/';
            const docs = Object.entries(store)
              .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v && d[f2] === v2)
              .map(([, d]) => ({ data: () => d }));
            return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
          }
        }),
        get: async () => {
          const prefix = p + '/';
          const docs = Object.entries(store)
            .filter(([k, d]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && d[f] === v)
            .map(([, d]) => ({ data: () => d }));
          return { docs, forEach: fn => docs.forEach(fn), empty: docs.length === 0 };
        }
      }),
    };
  }
  return { collection: (col) => makeCol(col) };
}

beforeEach(() => { __setFirestoreForTests(makeDb()); });
afterAll(() => { __setFirestoreForTests(null); });

describe('T365 - conversation_quality', () => {
  test('FLAGS are frozen with correct keys', () => {
    expect(FLAGS.RESPONSE_TOO_SHORT).toBe('RESPONSE_TOO_SHORT');
    expect(FLAGS.ESCALATION_DETECTED).toBe('ESCALATION_DETECTED');
    expect(FLAGS.LOOP_DETECTED).toBe('LOOP_DETECTED');
    expect(FLAGS.PROMISE_BROKEN).toBe('PROMISE_BROKEN');
    expect(FLAGS.UNANSWERED_QUESTION).toBe('UNANSWERED_QUESTION');
    expect(Object.isFrozen(FLAGS)).toBe(true);
  });

  test('scoreConversation returns score 100 for good conversation', () => {
    const msgs = [
      { role: "lead", content: "Hola, que precio tiene?" },
      { role: "miia", content: "Buenos dias! El precio es de 500 mensuales, incluye todo el servicio." },
    ];
    const result = scoreConversation(msgs);
    expect(result.score).toBe(100);
    expect(result.flags).toHaveLength(0);
    expect(result.breakdown.messageCount).toBe(2);
  });

  test('scoreConversation detects RESPONSE_TOO_SHORT', () => {
    const msgs = [
      { role: "lead", content: "Hola que precio?" },
      { role: "miia", content: "Ok" },
    ];
    const result = scoreConversation(msgs);
    expect(result.flags).toContain('RESPONSE_TOO_SHORT');
    expect(result.score).toBeLessThan(100);
  });

  test('scoreConversation detects LOOP_DETECTED', () => {
    const repeated = "Lo siento, no puedo ayudar con eso en este momento.";
    const msgs = [
      { role: "lead", content: "p1" }, { role: "miia", content: repeated },
      { role: "lead", content: "p2" }, { role: "miia", content: repeated },
      { role: "lead", content: "p3" }, { role: "miia", content: repeated },
    ];
    const result = scoreConversation(msgs);
    expect(result.flags).toContain('LOOP_DETECTED');
  });

  test('scoreConversation detects ESCALATION_DETECTED', () => {
    const msgs = [
      { role: "lead", content: "humano por favor" },
      { role: "miia", content: "Entiendo tu solicitud, te voy a conectar con alguien." },
    ];
    const result = scoreConversation(msgs);
    expect(result.flags).toContain('ESCALATION_DETECTED');
  });

  test('detectEscalation detects escalation phrases', () => {
    expect(detectEscalation([{ role: "lead", content: "quiero hablar con alguien" }])).toBe(true);
    expect(detectEscalation([{ role: "lead", content: "humano por favor" }])).toBe(true);
    expect(detectEscalation([{ role: "lead", content: "que precio tiene?" }])).toBe(false);
  });

  test('getQualityTrend returns null when no data', async () => {
    const trend = await getQualityTrend('uid1', 7);
    expect(trend.average).toBeNull();
    expect(trend.count).toBe(0);
  });

  test('flagConversation stores flags', async () => {
    await expect(flagConversation('uid1', '+5491234', ['LOOP_DETECTED'])).resolves.toBeUndefined();
  });

  test('scoreConversation throws for non-array', () => {
    expect(() => scoreConversation("not array")).toThrow("messages must be array");
  });
});
