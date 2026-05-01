'use strict';
const { summarizeConversation, buildContextSummary } = require('../core/conversation_summarizer');

describe('summarizeConversation', () => {
  test('array vacio retorna 0s', () => {
    const r = summarizeConversation([]);
    expect(r.messageCount).toBe(0);
    expect(r.fromMe).toBe(0);
    expect(r.preview).toEqual([]);
  });
  test('null/undefined retorna fallback', () => {
    expect(summarizeConversation(null).messageCount).toBe(0);
    expect(summarizeConversation(undefined).messageCount).toBe(0);
  });
  test('cuenta fromMe y fromContact', () => {
    const msgs = [
      { text: 'hola', fromMe: true },
      { text: 'como estas', fromMe: false },
      { text: 'bien', fromMe: true }
    ];
    const r = summarizeConversation(msgs);
    expect(r.fromMe).toBe(2);
    expect(r.fromContact).toBe(1);
  });
  test('calcula oldest y newest timestamps', () => {
    const msgs = [
      { text: 'a', timestamp: 100 },
      { text: 'b', timestamp: 300 },
      { text: 'c', timestamp: 200 }
    ];
    const r = summarizeConversation(msgs);
    expect(r.oldestTimestamp).toBe(100);
    expect(r.newestTimestamp).toBe(300);
  });
  test('calcula avgMessageLength correctamente', () => {
    const msgs = [
      { text: '12345' }, // 5
      { text: '1234567890' } // 10
    ];
    const r = summarizeConversation(msgs);
    expect(r.avgMessageLength).toBe(8); // round((5+10)/2) = 7 → pero 15/2=7.5 round=8
  });
  test('preview limita a maxPreview mensajes', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ text: `m${i}`, fromMe: false }));
    const r = summarizeConversation(msgs, { maxPreview: 3 });
    expect(r.preview.length).toBe(3);
    expect(r.preview[0].text).toBe('m7'); // últimos 3
  });
  test('preview trunca textos a 100 chars', () => {
    const msgs = [{ text: 'x'.repeat(200) }];
    const r = summarizeConversation(msgs);
    expect(r.preview[0].text.length).toBe(100);
  });
});

describe('buildContextSummary', () => {
  test('null → fallback', () => {
    expect(buildContextSummary(null).total).toBe(0);
  });
  test('cuenta conversations correctamente', () => {
    const convs = { '+573001': [{ text: 'a' }], '+573002': [] };
    const r = buildContextSummary(convs);
    expect(r.total).toBe(2);
    expect(r.summaries['+573001'].messageCount).toBe(1);
  });
});
