'use strict';
const { isGroupJid, isMentioned, shouldRespondToGroup, getGroupName, getGroupParticipants, GROUP_JID_SUFFIX, MIIA_TRIGGER_WORDS } = require('../core/group_handler');

describe('GROUP_JID_SUFFIX y MIIA_TRIGGER_WORDS', () => {
  test('sufijo correcto', () => { expect(GROUP_JID_SUFFIX).toBe('@g.us'); });
  test('trigger words incluyen hola miia', () => {
    expect(MIIA_TRIGGER_WORDS).toContain('hola miia');
    expect(MIIA_TRIGGER_WORDS).toContain('miia');
  });
});

describe('isGroupJid', () => {
  test('JID de grupo retorna true', () => {
    expect(isGroupJid('12345678901234567890@g.us')).toBe(true);
  });
  test('JID de contacto retorna false', () => {
    expect(isGroupJid('573001234567@s.whatsapp.net')).toBe(false);
  });
  test('null retorna false', () => { expect(isGroupJid(null)).toBe(false); });
  test('string vacio retorna false', () => { expect(isGroupJid('')).toBe(false); });
});

describe('isMentioned', () => {
  test('false si texto null y sin JIDs', () => {
    expect(isMentioned(null)).toBe(false);
  });
  test('false si sin menciones y sin trigger word', () => {
    expect(isMentioned('hola como estas')).toBe(false);
  });
  test('true si texto contiene "miia"', () => {
    expect(isMentioned('hola miia estas?')).toBe(true);
  });
  test('true si texto contiene "hola miia"', () => {
    expect(isMentioned('hola miia!')).toBe(true);
  });
  test('true si JID de MIIA en mentionedJids', () => {
    expect(isMentioned('texto', ['573001234567@s.whatsapp.net'], '573001234567@s.whatsapp.net')).toBe(true);
  });
  test('false si JID no coincide', () => {
    expect(isMentioned('texto', ['otro@s.whatsapp.net'], '573001234567@s.whatsapp.net')).toBe(false);
  });
  test('case insensitive para MIIA', () => {
    expect(isMentioned('MIIA respondeme')).toBe(true);
  });
});

describe('shouldRespondToGroup', () => {
  test('no es grupo = shouldRespond true', () => {
    const r = shouldRespondToGroup({ isGroup: false });
    expect(r.shouldRespond).toBe(true);
    expect(r.reason).toBe('not_a_group');
  });
  test('grupo sin menciones = false', () => {
    const r = shouldRespondToGroup({ isGroup: true, text: 'hola a todos' });
    expect(r.shouldRespond).toBe(false);
    expect(r.reason).toBe('group_no_mention');
  });
  test('grupo con trigger word = true', () => {
    const r = shouldRespondToGroup({ isGroup: true, text: 'miia que hora es?' });
    expect(r.shouldRespond).toBe(true);
    expect(r.reason).toBe('mentioned');
  });
  test('owner con trigger = shouldRespond true owner_trigger', () => {
    const r = shouldRespondToGroup({ isGroup: true, text: 'hola miia', isFromOwner: true });
    expect(r.shouldRespond).toBe(true);
    expect(r.reason).toBe('owner_trigger');
  });
  test('grupo con JID de MIIA mencionado = true', () => {
    const r = shouldRespondToGroup({
      isGroup: true,
      text: 'pregunta',
      mentionedJids: ['miia@s.whatsapp.net'],
      miiaJid: 'miia@s.whatsapp.net'
    });
    expect(r.shouldRespond).toBe(true);
    expect(r.reason).toBe('mentioned');
  });
  test('ctx null = shouldRespond true not_a_group', () => {
    const r = shouldRespondToGroup(null);
    expect(r.shouldRespond).toBe(true);
  });
});

describe('getGroupName y getGroupParticipants', () => {
  test('null = desconocido', () => {
    expect(getGroupName(null)).toBe('Grupo desconocido');
  });
  test('retorna subject del grupo', () => {
    expect(getGroupName({ subject: 'Mi Grupo' })).toBe('Mi Grupo');
  });
  test('null participants = array vacio', () => {
    expect(getGroupParticipants(null)).toEqual([]);
  });
  test('retorna participantes con jid y admin', () => {
    const meta = { participants: [
      { id: 'p1@s.whatsapp.net', admin: 'admin' },
      { id: 'p2@s.whatsapp.net', admin: null }
    ]};
    const parts = getGroupParticipants(meta);
    expect(parts[0].admin).toBe(true);
    expect(parts[1].admin).toBe(false);
    expect(parts[0].jid).toBe('p1@s.whatsapp.net');
  });
});
