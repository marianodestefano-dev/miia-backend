'use strict';

/**
 * #4 Wire-in mod_tonada en prompt_builder (firma Mariano 2026-05-12).
 * Valida que buildOwnerSelfChatPromptWithTonada agrega directiva tonada
 * cuando el baseline del owner tiene adaptacionActiva.
 */

const baselineLib = require('../core/mmc/baseline');
const { buildOwnerSelfChatPromptWithTonada } = require('../core/prompt_builder');

function makeBaselineMock(baseline) {
  const docRef = {
    get: jest.fn().mockResolvedValue({
      exists: baseline !== null && baseline !== undefined,
      data: () => baseline || {},
    }),
    set: jest.fn().mockResolvedValue({}),
  };
  return {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        collection: jest.fn(() => ({
          doc: jest.fn(() => docRef),
        })),
      })),
    })),
  };
}

const MARIANO = {
  uid: 'bq2BbtCVF8cZo30tum584zrGATJ3',
  name: 'Mariano',
  shortName: 'Mariano',
  businessName: 'MIIA',
  city: 'Bogotá',
  country: 'Colombia',
  whatsappOk: true,
  revealAsAI: true,
};

beforeEach(() => {
  baselineLib.__setFirestoreForTests(null);
});

describe('#4 buildOwnerSelfChatPromptWithTonada', () => {
  test('sin uid en profile + sin opts.uid -> base prompt sin tonada', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock(null));
    const profileNoUid = { ...MARIANO };
    delete profileNoUid.uid;
    const r = await buildOwnerSelfChatPromptWithTonada(profileNoUid, 'hola', {});
    expect(r).toContain('## 🚨 REGLA CERO');
    expect(r).not.toContain('## TONADA');
  });

  test('baseline inexistente -> sin tonada', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock(null));
    const r = await buildOwnerSelfChatPromptWithTonada(MARIANO, 'hola', {});
    expect(r).not.toContain('## TONADA');
  });

  test('baseline con adaptacionActiva=true y tonada=argentina -> incluye directiva', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({
      bootstrapComplete: true,
      adaptacionActiva: true,
      tonadaRegional: 'argentina',
    }));
    const r = await buildOwnerSelfChatPromptWithTonada(MARIANO, 'hola', {});
    expect(r).toContain('## TONADA');
    expect(r).toContain('voseo');
    expect(r).toContain('che');
  });

  test('baseline bootstrapComplete=false -> sin directiva', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({
      bootstrapComplete: false,
      adaptacionActiva: true,
      tonadaRegional: 'argentina',
    }));
    const r = await buildOwnerSelfChatPromptWithTonada(MARIANO, 'hola', {});
    expect(r).not.toContain('## TONADA');
  });

  test('tonada=colombia + adaptacionActiva -> directiva colombia', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({
      bootstrapComplete: true,
      adaptacionActiva: true,
      tonadaRegional: 'colombia',
    }));
    const r = await buildOwnerSelfChatPromptWithTonada(MARIANO, 'hola', {});
    expect(r).toContain('## TONADA');
    expect(r).toContain('parcero');
    expect(r).toContain('chévere');
  });

  test('chatType=lead -> sin directiva (no aplica owner)', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({
      bootstrapComplete: true,
      adaptacionActiva: true,
      tonadaRegional: 'argentina',
    }));
    const r = await buildOwnerSelfChatPromptWithTonada(MARIANO, 'hola', {}, { chatType: 'lead' });
    expect(r).not.toContain('## TONADA');
  });

  test('opts.uid override sobre profile.uid', async () => {
    baselineLib.__setFirestoreForTests(makeBaselineMock({
      bootstrapComplete: true,
      adaptacionActiva: true,
      tonadaRegional: 'mexico',
    }));
    const profileNoUid = { ...MARIANO };
    delete profileNoUid.uid;
    const r = await buildOwnerSelfChatPromptWithTonada(profileNoUid, 'hola', {}, { uid: 'override_uid_12345' });
    expect(r).toContain('## TONADA');
    expect(r).toContain('órale');
  });
});
