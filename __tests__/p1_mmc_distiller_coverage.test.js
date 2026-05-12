'use strict';

// Test apuntado: branches no cubiertos de episode_distiller.js
// Lineas 112-115 (raw string / else throw), 124 (json parse fail), 127 (missing fields), 179-180 (lock fail)

const distiller = require('../core/mmc/episode_distiller');

const VALID_UID = 'uid_test_distiller_cov';
const PHONE_A = '+5491100001111';

const epData = {
  episodeId: 'ep_cov_01',
  ownerUid: VALID_UID,
  contactPhone: PHONE_A,
  messageIds: ['m1'],
  status: 'closed',
  summary: null,
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('P1 MMC -- episode_distiller branches sin cubrir', () => {
  test('raw es string puro (typeof raw === string) -> parsea como texto', async () => {
    const gemini = {
      async generateContent() {
        return JSON.stringify({ topic: 'tema raw string', summary: 'resumen raw string' });
      },
    };
    const r = await distiller.distillEpisode(epData, gemini);
    expect(r.topic).toBe('tema raw string');
    expect(r.summary).toBe('resumen raw string');
  });

  test('raw es numero (else branch) -> throw shape inesperado (lines 114-115)', async () => {
    const gemini = {
      async generateContent() { return 42; },
    };
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow('distill response shape inesperado');
  });

  test('raw.text con JSON invalido -> throw distill JSON parse fail (line 124)', async () => {
    const gemini = {
      async generateContent() {
        return { text: '{ esto es json invalido : sin cerrar' };
      },
    };
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow(/JSON parse fail|JSON detectable/);
  });

  test('raw.text con JSON valido pero sin topic string -> throw missing topic/summary (line 127)', async () => {
    const gemini = {
      async generateContent() {
        return { text: JSON.stringify({ nota: 'sin topic ni summary' }) };
      },
    };
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow(/missing topic\/summary/);
  });

  test('raw.text con topic number (no string) -> throw missing topic/summary', async () => {
    const gemini = {
      async generateContent() {
        return { text: JSON.stringify({ topic: 123, summary: 'ok' }) };
      },
    };
    await expect(distiller.distillEpisode(epData, gemini)).rejects.toThrow(/missing topic\/summary/);
  });
});
