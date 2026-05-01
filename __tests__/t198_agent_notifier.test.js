'use strict';

const {
  formatContextForAgent, registerAgent, getAgentConfig,
  notifyAgent, getAgentNotificationHistory,
  NOTIFICATION_CHANNELS, MAX_CONTEXT_MESSAGES,
  __setFirestoreForTests, __setHttpClientForTests,
} = require('../core/agent_notifier');

const UID = 'testUid1234567890';
const AGENT_ID = 'agent123';
const TICKET_ID = 'ticket456';
const PHONE = '+541155667788';

function makeMockDb(opts) {
  opts = opts || {};
  var agentDoc = opts.agentDoc || null;
  var throwGet = opts.throwGet || false;
  var throwSet = opts.throwSet || false;
  var notifDocs = opts.notifDocs || [];

  var agentColl = {
    doc: function() {
      return {
        set: async function(data) { if (throwSet) throw new Error('set error'); },
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { exists: !!agentDoc, data: function() { return agentDoc; } };
        },
      };
    },
  };

  var sentColl = {
    doc: function() {
      return { set: async function(data) { if (throwSet) throw new Error('set error'); } };
    },
    where: function() {
      return {
        get: async function() {
          if (throwGet) throw new Error('get error');
          return { forEach: function(fn) { notifDocs.forEach(function(d, i) { fn({ data: function() { return d; }, id: 'n' + i }); }); } };
        },
      };
    },
  };

  var tenantsUidDoc = { collection: function(name) { return name === 'agents' ? agentColl : sentColl; } };
  var notifUidDoc = { collection: function() { return sentColl; } };

  return {
    collection: function(name) {
      if (name === 'tenants') return { doc: function() { return tenantsUidDoc; } };
      return { doc: function() { return notifUidDoc; } };
    },
  };
}

beforeEach(function() { __setFirestoreForTests(null); __setHttpClientForTests(null); });
afterEach(function() { __setFirestoreForTests(null); __setHttpClientForTests(null); });

describe('NOTIFICATION_CHANNELS y constants', function() {
  test('tiene push email whatsapp webhook', function() {
    expect(NOTIFICATION_CHANNELS).toContain('push');
    expect(NOTIFICATION_CHANNELS).toContain('webhook');
  });
  test('frozen', function() { expect(function() { NOTIFICATION_CHANNELS[0] = 'x'; }).toThrow(); });
  test('MAX_CONTEXT_MESSAGES es 5', function() { expect(MAX_CONTEXT_MESSAGES).toBe(5); });
});

describe('formatContextForAgent', function() {
  test('retorna string vacio si context null', function() {
    expect(formatContextForAgent(null)).toBe('');
  });
  test('incluye leadPhone en output', function() {
    const r = formatContextForAgent({ leadPhone: PHONE, reason: 'complaint', messageCount: 3 });
    expect(r).toContain(PHONE);
    expect(r).toContain('complaint');
  });
  test('incluye ultimos mensajes', function() {
    var msgs = [{ text: 'hola' }, { text: 'precio' }];
    const r = formatContextForAgent({ leadPhone: PHONE, recentMessages: msgs, messageCount: 2 });
    expect(r).toContain('hola');
  });
});

describe('registerAgent', function() {
  test('lanza si uid undefined', async function() {
    await expect(registerAgent(undefined, AGENT_ID, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si agentId undefined', async function() {
    await expect(registerAgent(UID, undefined, {})).rejects.toThrow('agentId requerido');
  });
  test('lanza si config no es objeto', async function() {
    await expect(registerAgent(UID, AGENT_ID, null)).rejects.toThrow('config requerido');
  });
  test('lanza si channel invalido', async function() {
    await expect(registerAgent(UID, AGENT_ID, { channel: 'fax' })).rejects.toThrow('invalido');
  });
  test('registra sin error', async function() {
    __setFirestoreForTests(makeMockDb());
    await expect(registerAgent(UID, AGENT_ID, { channel: 'push' })).resolves.toBeUndefined();
  });
  test('propaga error Firestore', async function() {
    __setFirestoreForTests(makeMockDb({ throwSet: true }));
    await expect(registerAgent(UID, AGENT_ID, { channel: 'push' })).rejects.toThrow('set error');
  });
});

describe('getAgentConfig', function() {
  test('lanza si uid undefined', async function() {
    await expect(getAgentConfig(undefined, AGENT_ID)).rejects.toThrow('uid requerido');
  });
  test('retorna null si agente no existe', async function() {
    __setFirestoreForTests(makeMockDb({ agentDoc: null }));
    const r = await getAgentConfig(UID, AGENT_ID);
    expect(r).toBeNull();
  });
  test('retorna config si existe', async function() {
    __setFirestoreForTests(makeMockDb({ agentDoc: { agentId: AGENT_ID, channel: 'push', active: true } }));
    const r = await getAgentConfig(UID, AGENT_ID);
    expect(r.channel).toBe('push');
  });
});

describe('notifyAgent', function() {
  test('lanza si uid undefined', async function() {
    await expect(notifyAgent(undefined, AGENT_ID, TICKET_ID, {})).rejects.toThrow('uid requerido');
  });
  test('lanza si ticketId undefined', async function() {
    await expect(notifyAgent(UID, AGENT_ID, undefined, {})).rejects.toThrow('ticketId requerido');
  });
  test('retorna notified false si agente no existe', async function() {
    __setFirestoreForTests(makeMockDb({ agentDoc: null }));
    const r = await notifyAgent(UID, AGENT_ID, TICKET_ID, {});
    expect(r.notified).toBe(false);
    expect(r.reason).toBe('agent_not_found');
  });
  test('retorna notified false si agente inactivo', async function() {
    __setFirestoreForTests(makeMockDb({ agentDoc: { agentId: AGENT_ID, active: false, channel: 'push' } }));
    const r = await notifyAgent(UID, AGENT_ID, TICKET_ID, {});
    expect(r.notified).toBe(false);
    expect(r.reason).toBe('agent_inactive');
  });
  test('notifica exitosamente con push', async function() {
    __setFirestoreForTests(makeMockDb({ agentDoc: { agentId: AGENT_ID, active: true, channel: 'push' } }));
    const r = await notifyAgent(UID, AGENT_ID, TICKET_ID, { leadPhone: PHONE, reason: 'complaint' });
    expect(r.notified).toBe(true);
    expect(r.channel).toBe('push');
  });
  test('usa webhook si channel es webhook', async function() {
    __setFirestoreForTests(makeMockDb({ agentDoc: { agentId: AGENT_ID, active: true, channel: 'webhook', endpoint: 'http://example.com/hook' } }));
    __setHttpClientForTests(async function(url, opts) { return { ok: true }; });
    const r = await notifyAgent(UID, AGENT_ID, TICKET_ID, { leadPhone: PHONE });
    expect(r.notified).toBe(true);
  });
});

describe('getAgentNotificationHistory', function() {
  test('lanza si uid undefined', async function() {
    await expect(getAgentNotificationHistory(undefined, AGENT_ID)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay historial', async function() {
    __setFirestoreForTests(makeMockDb({ notifDocs: [] }));
    const r = await getAgentNotificationHistory(UID, AGENT_ID);
    expect(r).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async function() {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    const r = await getAgentNotificationHistory(UID, AGENT_ID);
    expect(r).toEqual([]);
  });
});
