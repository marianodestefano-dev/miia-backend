'use strict';

/**
 * T83 — Tests para lib/guards.js (utilidades de guard centralizadas)
 */

const {
  MIIA_CENTER_UID,
  getBasePhone,
  toJid,
  getSockBasePhone,
  isGroup,
  isStatus,
  isLid,
  isGroupOrStatus,
  isSamePhone,
  isTenantReady,
  isMiiaCenterUid,
} = require('../lib/guards');

// ─── getBasePhone ─────────────────────────────────────────────────────────────

describe('getBasePhone', () => {
  test('extrae base de JID normal', () => {
    expect(getBasePhone('573163937365@s.whatsapp.net')).toBe('573163937365');
  });

  test('extrae base con sufijo device :94', () => {
    expect(getBasePhone('573163937365:94@s.whatsapp.net')).toBe('573163937365');
  });

  test('phone sin @ lo devuelve limpio', () => {
    expect(getBasePhone('573163937365')).toBe('573163937365');
  });

  test('null/undefined retorna string vacío', () => {
    expect(getBasePhone(null)).toBe('');
    expect(getBasePhone(undefined)).toBe('');
    expect(getBasePhone('')).toBe('');
  });

  test('grupo @g.us extrae la parte antes de @', () => {
    expect(getBasePhone('123456789@g.us')).toBe('123456789');
  });
});

// ─── toJid ────────────────────────────────────────────────────────────────────

describe('toJid', () => {
  test('agrega @s.whatsapp.net si no hay @', () => {
    expect(toJid('573163937365')).toBe('573163937365@s.whatsapp.net');
  });

  test('JID completo lo devuelve sin modificar', () => {
    expect(toJid('573163937365@s.whatsapp.net')).toBe('573163937365@s.whatsapp.net');
  });

  test('grupo @g.us lo devuelve sin modificar', () => {
    expect(toJid('123456789@g.us')).toBe('123456789@g.us');
  });

  test('null/undefined retorna string vacío', () => {
    expect(toJid(null)).toBe('');
    expect(toJid('')).toBe('');
  });
});

// ─── getSockBasePhone ─────────────────────────────────────────────────────────

describe('getSockBasePhone', () => {
  test('extrae base de sock.user.id con sufijo device', () => {
    expect(getSockBasePhone('573163937365:94@s.whatsapp.net')).toBe('573163937365');
  });

  test('sock.user.id sin device sufijo', () => {
    expect(getSockBasePhone('573163937365@s.whatsapp.net')).toBe('573163937365');
  });

  test('null/undefined retorna string vacío', () => {
    expect(getSockBasePhone(null)).toBe('');
    expect(getSockBasePhone('')).toBe('');
  });
});

// ─── isGroup ─────────────────────────────────────────────────────────────────

describe('isGroup', () => {
  test('JID de grupo retorna true', () => {
    expect(isGroup('120363123456789@g.us')).toBe(true);
  });

  test('JID de persona retorna false', () => {
    expect(isGroup('573163937365@s.whatsapp.net')).toBe(false);
  });

  test('null retorna false', () => {
    expect(isGroup(null)).toBe(false);
    expect(isGroup('')).toBe(false);
  });
});

// ─── isStatus ─────────────────────────────────────────────────────────────────

describe('isStatus', () => {
  test('status@broadcast retorna true', () => {
    expect(isStatus('status@broadcast')).toBe(true);
  });

  test('JID normal retorna false', () => {
    expect(isStatus('573163937365@s.whatsapp.net')).toBe(false);
  });
});

// ─── isLid ────────────────────────────────────────────────────────────────────

describe('isLid', () => {
  test('JID con @lid retorna true', () => {
    expect(isLid('46510318301398@lid')).toBe(true);
  });

  test('JID que empieza con 8829 retorna true', () => {
    expect(isLid('882912345678901@s.whatsapp.net')).toBe(true);
  });

  test('JID con >13 dígitos retorna true', () => {
    expect(isLid('12345678901234@s.whatsapp.net')).toBe(true);
  });

  test('JID normal retorna false', () => {
    expect(isLid('573163937365@s.whatsapp.net')).toBe(false);
  });

  test('número de 10 dígitos retorna false', () => {
    expect(isLid('3163937365')).toBe(false);
  });

  test('null retorna false', () => {
    expect(isLid(null)).toBe(false);
  });
});

// ─── isGroupOrStatus ──────────────────────────────────────────────────────────

describe('isGroupOrStatus', () => {
  test('grupo retorna true', () => {
    expect(isGroupOrStatus('120363123@g.us')).toBe(true);
  });

  test('status retorna true', () => {
    expect(isGroupOrStatus('status@broadcast')).toBe(true);
  });

  test('JID normal retorna false', () => {
    expect(isGroupOrStatus('573163937365@s.whatsapp.net')).toBe(false);
  });
});

// ─── isSamePhone ──────────────────────────────────────────────────────────────

describe('isSamePhone', () => {
  test('mismo número = true', () => {
    expect(isSamePhone('573163937365@s.whatsapp.net', '573163937365@s.whatsapp.net')).toBe(true);
  });

  test('mismo número, uno con sufijo device = true', () => {
    expect(isSamePhone('573163937365:94@s.whatsapp.net', '573163937365@s.whatsapp.net')).toBe(true);
  });

  test('números distintos = false', () => {
    expect(isSamePhone('573001234567@s.whatsapp.net', '573163937365@s.whatsapp.net')).toBe(false);
  });

  test('null/undefined = false', () => {
    expect(isSamePhone(null, '573163937365@s.whatsapp.net')).toBe(false);
    expect(isSamePhone('573163937365@s.whatsapp.net', null)).toBe(false);
  });
});

// ─── isTenantReady ────────────────────────────────────────────────────────────

describe('isTenantReady', () => {
  test('sock + isReady=true = true', () => {
    expect(isTenantReady({ sock: {}, isReady: true })).toBe(true);
  });

  test('sock sin isReady = false', () => {
    expect(isTenantReady({ sock: {}, isReady: false })).toBe(false);
  });

  test('sin sock = false', () => {
    expect(isTenantReady({ sock: null, isReady: true })).toBe(false);
  });

  test('null = false', () => {
    expect(isTenantReady(null)).toBe(false);
    expect(isTenantReady(undefined)).toBe(false);
  });
});

// ─── isMiiaCenterUid ──────────────────────────────────────────────────────────

describe('isMiiaCenterUid', () => {
  test('UID MIIA CENTER retorna true', () => {
    expect(isMiiaCenterUid('A5pMeSWlfmPWCoCPRbwy85EzUzy2')).toBe(true);
    expect(isMiiaCenterUid(MIIA_CENTER_UID)).toBe(true);
  });

  test('UID diferente retorna false', () => {
    expect(isMiiaCenterUid('bq2BbtCVF8cZo30tum584zrGATJ3')).toBe(false);
    expect(isMiiaCenterUid('random_uid')).toBe(false);
  });

  test('null/undefined retorna false', () => {
    expect(isMiiaCenterUid(null)).toBe(false);
    expect(isMiiaCenterUid('')).toBe(false);
  });
});

// ─── MIIA_CENTER_UID constante ────────────────────────────────────────────────

describe('MIIA_CENTER_UID constante', () => {
  test('es un string no vacío', () => {
    expect(typeof MIIA_CENTER_UID).toBe('string');
    expect(MIIA_CENTER_UID.length).toBeGreaterThan(0);
  });

  test('valor correcto según §2 CLAUDE.md', () => {
    expect(MIIA_CENTER_UID).toBe('A5pMeSWlfmPWCoCPRbwy85EzUzy2');
  });
});
