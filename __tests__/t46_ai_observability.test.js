'use strict';

/**
 * T46 — AI pipeline structured logging coverage
 *
 * Valida que callAI / callAIChat emiten eventos [AI-OBS] estructurados
 * con metadata + lengths + latency, SIN exponer prompt/response/system content.
 */

// Mock adapters BEFORE require ai_client
jest.mock('../ai/adapters/gemini_adapter', () => ({
  call: jest.fn(),
  callChat: jest.fn(),
}));
jest.mock('../ai/adapters/openai_adapter', () => ({ call: jest.fn(), callChat: jest.fn() }));
jest.mock('../ai/adapters/claude_adapter', () => ({ call: jest.fn(), callChat: jest.fn() }));
jest.mock('../ai/adapters/groq_adapter', () => ({ call: jest.fn(), callChat: jest.fn() }));
jest.mock('../ai/adapters/mistral_adapter', () => ({ call: jest.fn(), callChat: jest.fn() }));
jest.mock('../ai/key_pool', () => ({
  hasKeys: jest.fn().mockReturnValue(false),
  getKey: jest.fn(),
  getStats: jest.fn(),
  markSuccess: jest.fn(),
  markFailed: jest.fn(),
}));

const { callAI, callAIChat } = require('../ai/ai_client');
const geminiAdapter = require('../ai/adapters/gemini_adapter');

function captureLogs(fn) {
  return async () => {
    const captured = [];
    const orig = console.log;
    console.log = (...args) => captured.push(args.join(' '));
    try {
      await fn(captured);
    } finally {
      console.log = orig;
    }
    return captured;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('T46 §A — callAI emite [AI-OBS] start + ok', () => {
  test('callAI exitoso emite ai.call.start y ai.call.ok con metadata', captureLogs(async (captured) => {
    geminiAdapter.call.mockResolvedValue('respuesta de prueba');
    const result = await callAI('gemini', 'apikey', 'prompt de prueba', { model: 'gemini-2.5-flash' });
    expect(result).toBe('respuesta de prueba');

    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.length).toBe(2);
    expect(obs[0]).toContain('ai.call.start');
    expect(obs[0]).toContain('"provider":"gemini"');
    expect(obs[0]).toContain('"prompt_chars":16'); // 'prompt de prueba'.length = 16
    expect(obs[1]).toContain('ai.call.ok');
    expect(obs[1]).toContain('"response_chars":19'); // 'respuesta de prueba'.length = 19
    expect(obs[1]).toContain('"latency_ms"');

    // CRITICO: que NO se loguea contenido
    expect(obs.join('\n')).not.toContain('prompt de prueba');
    expect(obs.join('\n')).not.toContain('respuesta de prueba');
  }));

  test('callAI con error emite ai.call.fail con err_status', captureLogs(async (captured) => {
    const err = new Error('boom');
    err.status = 500;
    geminiAdapter.call.mockRejectedValue(err);
    await expect(callAI('gemini', 'apikey', 'p', { model: 'm' })).rejects.toThrow('boom');

    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('ai.call.start'))).toBe(true);
    expect(obs.some(l => l.includes('ai.call.fail') && l.includes('"err_status":500'))).toBe(true);
  }));
});

describe('T46 §B — callAIChat emite eventos chat', () => {
  test('callAIChat exitoso emite ai.chat.start y ai.chat.ok', captureLogs(async (captured) => {
    geminiAdapter.callChat.mockResolvedValue('chat resp');
    const messages = [
      { role: 'user', content: 'mensaje uno' },
      { role: 'assistant', content: 'respuesta uno' },
      { role: 'user', content: 'mensaje dos' },
    ];
    const result = await callAIChat('gemini', 'apikey', messages, 'system instr', { model: 'gemini-2.5-flash' });
    expect(result).toBe('chat resp');

    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('ai.chat.start') && l.includes('"msg_count":3'))).toBe(true);
    expect(obs.some(l => l.includes('ai.chat.ok'))).toBe(true);

    // No leak de contenido
    expect(obs.join('\n')).not.toContain('mensaje uno');
    expect(obs.join('\n')).not.toContain('respuesta uno');
    expect(obs.join('\n')).not.toContain('system instr');
    expect(obs.join('\n')).not.toContain('chat resp');
  }));

  test('callAIChat error emite ai.chat.fail', captureLogs(async (captured) => {
    geminiAdapter.callChat.mockRejectedValue(new Error('chat fail'));
    await expect(
      callAIChat('gemini', 'apikey', [{ role: 'user', content: 'x' }], 'sys', {})
    ).rejects.toThrow('chat fail');

    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('ai.chat.fail'))).toBe(true);
  }));
});

describe('T46 §C — sanitizacion: contenido NUNCA aparece en [AI-OBS]', () => {
  test('prompt con phone E.164 NO aparece en logs', captureLogs(async (captured) => {
    geminiAdapter.call.mockResolvedValue('ok');
    await callAI('gemini', 'apikey', 'mi telefono es +573054169969 quiero info', {});
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.join('\n')).not.toContain('573054169969');
    expect(obs.join('\n')).not.toContain('+57');
    expect(obs.join('\n')).not.toContain('quiero info');
  }));

  test('respuesta con email NO aparece en logs', captureLogs(async (captured) => {
    geminiAdapter.call.mockResolvedValue('escribime a juan@empresa.com');
    await callAI('gemini', 'apikey', 'cual es tu email?', {});
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.join('\n')).not.toContain('juan@empresa.com');
    expect(obs.join('\n')).not.toContain('cual es tu email');
  }));

  test('messages array con datos sensibles NO aparece', captureLogs(async (captured) => {
    geminiAdapter.callChat.mockResolvedValue('respuesta');
    await callAIChat('gemini', 'k', [
      { role: 'user', content: 'mi tarjeta termina en 4321 pin 0000' }
    ], 'sistema', {});
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.join('\n')).not.toContain('4321');
    expect(obs.join('\n')).not.toContain('pin 0000');
    expect(obs.join('\n')).not.toContain('sistema');
  }));
});

describe('T46 §D — total_msg_chars contabiliza correctamente', () => {
  test('suma chars de todos los mensajes', captureLogs(async (captured) => {
    geminiAdapter.callChat.mockResolvedValue('r');
    await callAIChat('gemini', 'k', [
      { role: 'user', content: 'aaa' },     // 3
      { role: 'assistant', content: 'bbbb' }, // 4
      { role: 'user', content: 'cc' },      // 2
    ], 'sys9chars', {}); // system 9 chars
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('"total_msg_chars":9'))).toBe(true);
    expect(obs.some(l => l.includes('"system_chars":9'))).toBe(true);
    expect(obs.some(l => l.includes('"msg_count":3'))).toBe(true);
  }));

  test('messages no-array → msg_count=0 total_msg_chars=0', captureLogs(async (captured) => {
    geminiAdapter.callChat.mockResolvedValue('r');
    await callAIChat('gemini', 'k', null, 'sys', {});
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('"msg_count":0'))).toBe(true);
    expect(obs.some(l => l.includes('"total_msg_chars":0'))).toBe(true);
  }));
});

describe('T46 §E — opciones has_search / has_thinking se reportan', () => {
  test('enableSearch=true → has_search:true', captureLogs(async (captured) => {
    geminiAdapter.call.mockResolvedValue('r');
    await callAI('gemini', 'k', 'p', { enableSearch: true });
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('"has_search":true'))).toBe(true);
  }));
  test('thinkingBudget=8192 → has_thinking:true', captureLogs(async (captured) => {
    geminiAdapter.call.mockResolvedValue('r');
    await callAI('gemini', 'k', 'p', { thinkingBudget: 8192 });
    const obs = captured.filter(l => l.includes('[AI-OBS]'));
    expect(obs.some(l => l.includes('"has_thinking":true'))).toBe(true);
  }));
});
