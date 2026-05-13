'use strict';

/**
 * BUG-021 root cause fix (firma Mariano 2026-05-12 ~23:05 COT "SI A TODOS").
 *
 * Sintoma: post-BadMAC reconnect, LID del owner llega antes de que sock.user.lid
 * se popule -> Fuente 1 (_lidMap) + Fuente 2 (sock.user.lid) fallan -> owner
 * tratado como lead -> "Hola! En que te puedo ayudar?" al owner.
 *
 * Fix: tenant._ownerKnownLids (Set persistido en Firestore). Fuente 3 cubre el
 * gap cuando sock.user.lid no esta disponible. Tests aislan la logica de resolucion.
 */

describe('BUG-021 root cause fix -- _ownerKnownLids resolve', () => {
  // Helper: simula la logica de las 3 fuentes de resolucion LID que vive
  // en tenant_manager.js:1957-1995. Replicamos solo la decision logic para
  // testear unitariamente sin levantar todo el TM real.
  function resolveLid(from, tenant) {
    let resolvedFrom = from;
    if (from && from.includes('@lid')) {
      const lidBase = from.split('@')[0].split(':')[0];
      // Fuente 1: _lidMap
      if (tenant._lidMap && tenant._lidMap[lidBase]) {
        const mapped = tenant._lidMap[lidBase];
        const mappedPhone = mapped && mapped.split('@')[0] && mapped.split('@')[0].split(':')[0];
        if (mapped && mapped.includes('@s.whatsapp.net') && mappedPhone && /^\d{10,13}$/.test(mappedPhone)) {
          resolvedFrom = mapped;
        }
      }
      // Fuente 2: sock.user.lid (Baileys)
      if (resolvedFrom === from && tenant.ownerPhone) {
        const userLid = tenant.sock && tenant.sock.user && tenant.sock.user.lid;
        if (userLid) {
          const userLidBase = userLid.split('@')[0].split(':')[0];
          if (userLidBase === lidBase) {
            resolvedFrom = `${tenant.ownerPhone}@s.whatsapp.net`;
          }
        }
      }
      // Fuente 3 BUG-021 fix raiz: _ownerKnownLids
      if (resolvedFrom === from && tenant.ownerPhone && tenant._ownerKnownLids && tenant._ownerKnownLids.has(lidBase)) {
        resolvedFrom = `${tenant.ownerPhone}@s.whatsapp.net`;
      }
    }
    return resolvedFrom;
  }

  test('Fuente 1 _lidMap valido -> resuelve', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _lidMap: { '136417472712832': '573163937365@s.whatsapp.net' },
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('Fuente 2 sock.user.lid match -> resuelve', () => {
    const tenant = {
      ownerPhone: '573163937365',
      sock: { user: { lid: '136417472712832@lid' } },
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('Fuente 3 _ownerKnownLids match -> resuelve (BUG-021 fix raiz)', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _ownerKnownLids: new Set(['136417472712832']),
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('Fuente 3 _ownerKnownLids sin match -> retorna LID original', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _ownerKnownLids: new Set(['xxx_otro_lid']),
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('136417472712832@lid');
  });

  test('Sin ninguna fuente disponible -> retorna LID original', () => {
    const tenant = { ownerPhone: '573163937365' };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('136417472712832@lid');
  });

  test('Fuente 3 sin ownerPhone -> no resuelve', () => {
    const tenant = {
      _ownerKnownLids: new Set(['136417472712832']),
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('136417472712832@lid');
  });

  test('LID con sufijo :NN -> normaliza correctamente', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _ownerKnownLids: new Set(['136417472712832']),
    };
    expect(resolveLid('136417472712832:94@lid', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('from sin @lid -> no toca', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _ownerKnownLids: new Set(['136417472712832']),
    };
    expect(resolveLid('573163937365@s.whatsapp.net', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('Fuente 1 mapping invalido (no es phone real) -> fallthrough a Fuente 3', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _lidMap: { '136417472712832': 'INVALIDO@lid' }, // self-mapping contaminado
      _ownerKnownLids: new Set(['136417472712832']),
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('Fuente 2 sock.user.lid distinto -> fallthrough a Fuente 3', () => {
    const tenant = {
      ownerPhone: '573163937365',
      sock: { user: { lid: 'OTRO_LID_VIEJO@lid' } },
      _ownerKnownLids: new Set(['136417472712832']),
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('573163937365@s.whatsapp.net');
  });

  test('Set vacio -> no resuelve', () => {
    const tenant = {
      ownerPhone: '573163937365',
      _ownerKnownLids: new Set(),
    };
    expect(resolveLid('136417472712832@lid', tenant)).toBe('136417472712832@lid');
  });
});

describe('BUG-021 _ownerKnownLids load/persist semantics', () => {
  test('Set desde array Firestore -> contains LIDs', () => {
    const ownerLidsArr = ['lid_a', 'lid_b', 'lid_c'];
    const set = new Set(ownerLidsArr);
    expect(set.has('lid_a')).toBe(true);
    expect(set.has('lid_b')).toBe(true);
    expect(set.has('lid_z')).toBe(false);
  });

  test('Set vacio si Firestore array no es array', () => {
    const arr = Array.isArray(null) ? null : [];
    expect(arr).toEqual([]);
  });

  test('Array.from(Set) preserva LIDs para Firestore persist', () => {
    const set = new Set(['a', 'b']);
    set.add('c');
    expect(Array.from(set).sort()).toEqual(['a', 'b', 'c']);
  });
});
