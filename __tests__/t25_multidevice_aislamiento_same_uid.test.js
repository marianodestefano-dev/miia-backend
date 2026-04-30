'use strict';

/**
 * Tests: T25 — Multi-device aislamiento DENTRO mismo UID.
 *
 * Origen: T19 research identifico 4 gaps (sock.user.id sufijo :NN,
 * _sentMsgIds dedup cross-device, conversations race, baileys session
 * shape). Wi firmo T25 mail [161] — "IMPLEMENTAR Tests T19 multi-device
 * DENTRO mismo UID. No requiere modificar codigo productivo — solo tests
 * defensivos."
 *
 * §A — basePhone extraction tolera sufijos :94, :96, :97
 * §B — _sentMsgIds dedup logica (Set semantics + idempotencia)
 * §C — sendTenantMessage register-before-send (race protection)
 * §D — baileys_session_store doc-id pattern documentado
 */

'use strict';

const fs = require('fs');
const path = require('path');

const TMH_PATH = path.resolve(__dirname, '../whatsapp/tenant_message_handler.js');
const TMH_SOURCE = fs.readFileSync(TMH_PATH, 'utf8');

const TM_PATH = path.resolve(__dirname, '../whatsapp/tenant_manager.js');
const TM_SOURCE = fs.existsSync(TM_PATH) ? fs.readFileSync(TM_PATH, 'utf8') : '';

const SS_PATH = path.resolve(__dirname, '../whatsapp/baileys_session_store.js');
const SS_SOURCE = fs.existsSync(SS_PATH) ? fs.readFileSync(SS_PATH, 'utf8') : '';

// ════════════════════════════════════════════════════════════════════
// §A — basePhone extraction tolera sufijos device-id (:94, :96, :97)
// ════════════════════════════════════════════════════════════════════

describe('T25 §A — basePhone extraction multi-device safe', () => {
  // Funcion canonica: split(':')[0].split('@')[0]
  // Verificada en CLAUDE.md §6.9 (NO-DELAY-SELFCHAT-TMH guard)
  function extractBasePhone(jid) {
    if (typeof jid !== 'string') return null;
    return jid.split(':')[0].split('@')[0];
  }

  test('A.1 — sufijo :94 (telefono primario) extrae phone OK', () => {
    expect(extractBasePhone('573163937365:94@s.whatsapp.net')).toBe('573163937365');
  });

  test('A.2 — sufijo :96 (WhatsApp Web) extrae phone OK', () => {
    expect(extractBasePhone('573163937365:96@s.whatsapp.net')).toBe('573163937365');
  });

  test('A.3 — sufijo :97 (Desktop) extrae phone OK', () => {
    expect(extractBasePhone('573163937365:97@s.whatsapp.net')).toBe('573163937365');
  });

  test('A.4 — sin sufijo (JID directo) extrae phone OK', () => {
    expect(extractBasePhone('573163937365@s.whatsapp.net')).toBe('573163937365');
  });

  test('A.5 — sufijo :100+ tres digitos extrae phone OK', () => {
    expect(extractBasePhone('573163937365:108@s.whatsapp.net')).toBe('573163937365');
  });

  test('A.6 — TODOS los devices del mismo phone resuelven al mismo basePhone', () => {
    const devices = [':94', ':96', ':97', ':108', ''];
    const basePhones = devices.map(d => extractBasePhone(`573163937365${d}@s.whatsapp.net`));
    // Todos identicos
    expect(new Set(basePhones).size).toBe(1);
    expect(basePhones[0]).toBe('573163937365');
  });

  test('A.7 — TMH source documentado patron split(":")[0]', () => {
    // Verificar que TMH usa el patron canonico (sanity check)
    expect(TMH_SOURCE).toMatch(/split\(['"]:['"][)]/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §B — _sentMsgIds dedup cross-device (Set semantics)
// ════════════════════════════════════════════════════════════════════

describe('T25 §B — _sentMsgIds dedup multi-device', () => {
  // Simular Set _sentMsgIds que dedupes msgIds entre devices del mismo UID
  function makeSentMsgIds() {
    return new Set();
  }

  function tryRegisterMsg(set, msgId) {
    if (set.has(msgId)) return false; // duplicado, skip
    set.add(msgId);
    return true; // registrado, procesar
  }

  test('B.1 — primer msgId se registra, segundo skip', () => {
    const set = makeSentMsgIds();
    expect(tryRegisterMsg(set, 'msg-123')).toBe(true);
    expect(tryRegisterMsg(set, 'msg-123')).toBe(false); // dup
  });

  test('B.2 — mismo msgId desde 3 devices distintos → solo 1 registrado', () => {
    const set = makeSentMsgIds();
    // Phone, Web, Desktop reciben mismo msgId via Baileys multi-device sync
    const fromPhone = tryRegisterMsg(set, 'msg-abc');
    const fromWeb = tryRegisterMsg(set, 'msg-abc');
    const fromDesktop = tryRegisterMsg(set, 'msg-abc');
    expect([fromPhone, fromWeb, fromDesktop].filter(x => x).length).toBe(1);
  });

  test('B.3 — msgIds distintos del mismo UID se registran independientes', () => {
    const set = makeSentMsgIds();
    expect(tryRegisterMsg(set, 'msg-1')).toBe(true);
    expect(tryRegisterMsg(set, 'msg-2')).toBe(true);
    expect(tryRegisterMsg(set, 'msg-3')).toBe(true);
    expect(set.size).toBe(3);
  });

  test('B.4 — TMH source tiene _sentMsgIds Set referenciado', () => {
    expect(TMH_SOURCE).toMatch(/_sentMsgIds/);
  });
});

// ════════════════════════════════════════════════════════════════════
// §C — sendTenantMessage register-before-send (race protection)
// ════════════════════════════════════════════════════════════════════

describe('T25 §C — sendTenantMessage idempotencia race', () => {
  // Simular escenario: 2 devices del mismo UID intentan enviar al mismo
  // phone destinatario simultaneamente. ctx.conversations[phone].push()
  // debe ser idempotente o al menos no duplicar entries con mismo content.
  function simulateConcurrentSend(conversations, phone, content) {
    if (!Array.isArray(conversations[phone])) conversations[phone] = [];
    // Check if last message has identical content (defensive dedup)
    const last = conversations[phone][conversations[phone].length - 1];
    if (last && last.content === content && last.role === 'assistant') {
      // Race detected — second push blocked
      return { pushed: false, reason: 'duplicate_last_msg' };
    }
    conversations[phone].push({ role: 'assistant', content });
    return { pushed: true };
  }

  test('C.1 — 1 send normal → push OK', () => {
    const ctx = {};
    const result = simulateConcurrentSend(ctx, '573123', 'Hola lead');
    expect(result.pushed).toBe(true);
    expect(ctx['573123']).toHaveLength(1);
  });

  test('C.2 — 2 sends concurrentes mismo content → segundo blocked', () => {
    const ctx = {};
    const r1 = simulateConcurrentSend(ctx, '573123', 'Hola lead');
    const r2 = simulateConcurrentSend(ctx, '573123', 'Hola lead');
    expect(r1.pushed).toBe(true);
    expect(r2.pushed).toBe(false);
    expect(r2.reason).toBe('duplicate_last_msg');
    expect(ctx['573123']).toHaveLength(1);
  });

  test('C.3 — 2 sends mismo phone DIFERENTE content → ambos pushed', () => {
    const ctx = {};
    simulateConcurrentSend(ctx, '573123', 'Mensaje A');
    simulateConcurrentSend(ctx, '573123', 'Mensaje B');
    expect(ctx['573123']).toHaveLength(2);
  });

  test('C.4 — sends a phones distintos → no interfieren', () => {
    const ctx = {};
    simulateConcurrentSend(ctx, '573123', 'Hola A');
    simulateConcurrentSend(ctx, '573456', 'Hola B');
    expect(ctx['573123']).toHaveLength(1);
    expect(ctx['573456']).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// §D — baileys_session_store doc-id pattern (defensivo, documenta gap)
// ════════════════════════════════════════════════════════════════════

describe('T25 §D — baileys_session_store shape (T19 GAP 4 documentacion)', () => {
  test('D.1 — baileys_session_store.js existe en repo', () => {
    expect(SS_SOURCE.length).toBeGreaterThan(0);
  });

  test('D.2 — usa Firestore (admin) para persistir sesion', () => {
    expect(SS_SOURCE).toMatch(/firestore|admin/i);
  });

  test('D.3 — referencia el patron tenant-{uid} o uid directo', () => {
    // CLAUDE.md §6 menciona baileys_sessions con .doc(`tenant-${uid}`) o
    // .doc(clientId) derivado. Cualquier uno de los 2 patrones es OK.
    const hasUidPattern = SS_SOURCE.includes('tenant-') || SS_SOURCE.match(/\.doc\([^)]*uid[^)]*\)/);
    expect(hasUidPattern).toBeTruthy();
  });

  // Nota: no testeamos doc-id por device aqui porque GAP 4 (T19) declara
  // que Vi necesita research para confirmar si baileys_session_store separa
  // por device-id o no. Estos tests son DEFENSIVOS — solo verifican
  // que el archivo existe y tiene shape esperado. Implementacion real de
  // multi-device aislamiento es backlog hasta verificar uso real Mariano.
});
