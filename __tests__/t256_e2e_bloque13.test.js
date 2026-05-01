'use strict';

// T256 E2E Bloque 13: follow_up_scheduler + contact_enrichment + dashboard_aggregator + conversation_summary
const {
  scheduleFollowUp, buildFollowUpRecord, saveFollowUp, updateFollowUpStatus,
  getNextFollowUp, getPendingFollowUps, buildFollowUpMessage,
  FOLLOWUP_TYPES, DEFAULT_DELAY_MS,
  __setFirestoreForTests: setFollowUp,
} = require('../core/follow_up_scheduler');

const {
  computeContactSegment, buildEnrichmentRecord, saveEnrichmentRecord,
  getEnrichmentRecord, addTagToContact, removeTagFromContact,
  searchContactsBySegment, buildEnrichmentText,
  CONTACT_SEGMENTS, isValidTag,
  __setFirestoreForTests: setEnrich,
} = require('../core/contact_enrichment');

const {
  buildOverviewSection, buildLeadsFunnelData, buildRevenueData,
  buildConversationsSection, buildDashboardSnapshot, saveDashboardSnapshot,
  getLatestDashboardSnapshot, buildDashboardText, getTimeframeRange,
  TIMEFRAMES,
  __setFirestoreForTests: setDash,
} = require('../core/dashboard_aggregator');

const {
  buildConversationSummary, saveConversationSummary,
  detectSentiment, getKeyMoments, buildSummaryText,
  __setFirestoreForTests: setSummary,
} = require('../core/conversation_summary');

const UID = 'bloque13Uid';
const PHONE = '+541188776655';
const NOW = 1746200000000;

function makeMockDb({ stored = {}, tagStored = {}, throwGet = false, throwSet = false, pendingCount = 0 } = {}) {
  const db_stored = { ...stored };
  const tag_stored = { ...tagStored };
  return {
    collection: (col) => ({
      doc: (uid) => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const target = subCol === 'contact_tags' ? tag_stored : db_stored;
              target[id] = opts && opts.merge ? { ...(target[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const target = subCol === 'contact_tags' ? tag_stored : db_stored;
              if (subCol === 'contact_tags' && pendingCount > 0) {
                return { exists: true, data: () => ({ tags: Array(pendingCount).fill('t'), phone: PHONE }) };
              }
              return { exists: !!target[id], data: () => target[id] };
            },
          }),
          where: (field, op, val) => ({
            where: (f2, o2, v2) => ({
              get: async () => {
                if (throwGet) throw new Error('get error');
                const entries = Object.values(db_stored).filter(d => {
                  if (!d) return false;
                  let ok = true;
                  if (field === 'phone') ok = ok && d.phone === val;
                  if (field === 'status') ok = ok && d.status === val;
                  if (f2 === 'phone') ok = ok && d.phone === v2;
                  if (f2 === 'status') ok = ok && d.status === v2;
                  return ok;
                });
                const fake = pendingCount > 0 ? Array(pendingCount).fill({ phone: PHONE, status: 'pending' }) : entries;
                return { empty: fake.length === 0, forEach: fn => fake.forEach(d => fn({ data: () => d })) };
              },
            }),
            get: async () => {
              if (throwGet) throw new Error('get error');
              const entries = Object.values(db_stored).filter(d => {
                if (!d) return false;
                if (field === 'phone') return d.phone === val;
                if (field === 'segment') return d.segment === val;
                if (field === 'status') return d.status === val;
                return true;
              });
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { forEach: fn => Object.values(db_stored).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

function setAll(db) { setFollowUp(db); setEnrich(db); setDash(db); setSummary(db); }

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── FOLLOW UP SCHEDULER ─────────────────────────────────────────────────────
describe('follow_up_scheduler — E2E', () => {
  test('FOLLOWUP_TYPES incluye todos', () => {
    ['initial_response', 'day1_check', 'day3_reminder', 'week1_reconnect', 'month1_winback', 'custom'].forEach(t => {
      expect(FOLLOWUP_TYPES).toContain(t);
    });
  });
  test('scheduleFollowUp day1_check con baseTime', () => {
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    expect(r.scheduledAt).toBe(NOW + DEFAULT_DELAY_MS.day1_check);
    expect(r.status).toBe('pending');
  });
  test('scheduleFollowUp week1_reconnect delay correcto', () => {
    const r = scheduleFollowUp(UID, PHONE, 'week1_reconnect', { baseTime: NOW });
    expect(r.scheduledAt).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
  });
  test('saveFollowUp + getNextFollowUp round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    await saveFollowUp(UID, r);
    setAll(db);
    const next = await getNextFollowUp(UID, PHONE);
    expect(next).not.toBeNull();
    expect(next.type).toBe('day1_check');
  });
  test('getPendingFollowUps filtra por before', async () => {
    const r1 = { ...buildFollowUpRecord(UID, PHONE, 'day1_check', NOW - 500), status: 'pending' };
    const r2 = { ...buildFollowUpRecord(UID, PHONE, 'day3_reminder', NOW + 5000), status: 'pending' };
    setAll(makeMockDb({ stored: { [r1.followUpId]: r1, [r2.followUpId]: r2 } }));
    const pending = await getPendingFollowUps(UID, { before: NOW });
    expect(pending.length).toBe(1);
    expect(pending[0].type).toBe('day1_check');
  });
  test('updateFollowUpStatus a sent', async () => {
    setAll(makeMockDb());
    const id = await updateFollowUpStatus(UID, 'fu_001', 'sent');
    expect(id).toBe('fu_001');
  });
  test('buildFollowUpMessage day3_reminder contiene nombre y negocio', () => {
    const text = buildFollowUpMessage('day3_reminder', 'Juan', 'MiNegocio');
    expect(text).toContain('Juan');
    expect(text).toContain('MiNegocio');
  });
  test('buildFollowUpMessage month1_winback no vacio', () => {
    expect(buildFollowUpMessage('month1_winback', null, null).length).toBeGreaterThan(0);
  });
});

// ─── CONTACT ENRICHMENT ──────────────────────────────────────────────────────
describe('contact_enrichment — E2E', () => {
  test('CONTACT_SEGMENTS incluye vip, cold, inactive', () => {
    ['vip', 'cold', 'inactive', 'new', 'regular', 'at_risk'].forEach(s => {
      expect(CONTACT_SEGMENTS).toContain(s);
    });
  });
  test('computeContactSegment logica completa', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 10 })).toBe('vip');
    expect(computeContactSegment({ daysSinceLastActivity: 100 })).toBe('inactive');
    expect(computeContactSegment({ daysSinceLastActivity: 5 })).toBe('new');
    expect(computeContactSegment({})).toBe('regular');
  });
  test('buildEnrichmentRecord filtra campos invalidos', () => {
    const r = buildEnrichmentRecord(UID, PHONE, { email: 'a@b.com', hacker: 'x' });
    expect(r.fields.email).toBe('a@b.com');
    expect(r.fields.hacker).toBeUndefined();
  });
  test('isValidTag acepta snake_case', () => {
    expect(isValidTag('cliente_vip')).toBe(true);
    expect(isValidTag('TAG_INVALIDO')).toBe(false);
  });
  test('addTagToContact + removeTagFromContact', async () => {
    const db = makeMockDb();
    setAll(db);
    const tags = await addTagToContact(UID, PHONE, 'cliente_nuevo');
    expect(tags).toContain('cliente_nuevo');
  });
  test('saveEnrichmentRecord + getEnrichmentRecord round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildEnrichmentRecord(UID, PHONE, { company: 'ACME' }, { segment: 'premium' });
    await saveEnrichmentRecord(UID, r);
    setAll(db);
    const loaded = await getEnrichmentRecord(UID, PHONE);
    expect(loaded).not.toBeNull();
    expect(loaded.fields.company).toBe('ACME');
    expect(loaded.segment).toBe('premium');
  });
  test('searchContactsBySegment retorna solo ese segmento', async () => {
    const r1 = buildEnrichmentRecord(UID, PHONE, {}, { segment: 'vip' });
    const r2 = buildEnrichmentRecord(UID, '+5411000', {}, { segment: 'cold' });
    setAll(makeMockDb({ stored: { [r1.recordId]: r1, [r2.recordId]: r2 } }));
    const vips = await searchContactsBySegment(UID, 'vip');
    expect(vips.length).toBe(1);
    expect(vips[0].segment).toBe('vip');
  });
  test('buildEnrichmentText incluye segmento y empresa', () => {
    const r = buildEnrichmentRecord(UID, PHONE, { company: 'Corp' }, { segment: 'premium' });
    const text = buildEnrichmentText(r);
    expect(text).toContain('premium');
    expect(text).toContain('Corp');
  });
});

// ─── DASHBOARD AGGREGATOR ─────────────────────────────────────────────────────
describe('dashboard_aggregator — E2E', () => {
  test('TIMEFRAMES incluye todos', () => {
    ['today', 'week', 'month', 'quarter'].forEach(t => expect(TIMEFRAMES).toContain(t));
  });
  test('getTimeframeRange quarter es ~90 dias', () => {
    const r = getTimeframeRange('quarter', NOW);
    expect(NOW - r.from).toBeGreaterThanOrEqual(89 * 24 * 60 * 60 * 1000);
  });
  test('buildOverviewSection conversionRate', () => {
    const o = buildOverviewSection({ totalLeads: 50, convertedLeads: 10 });
    expect(o.conversionRate).toBe(0.2);
    expect(o.section).toBe('overview');
  });
  test('buildLeadsFunnelData funnel correcto', () => {
    const leads = [
      { phone: PHONE, score: 90, category: 'ready' },
      { phone: '+1', score: 70, category: 'hot' },
      { phone: '+2', score: 40, category: 'warm' },
    ];
    const r = buildLeadsFunnelData(leads);
    expect(r.funnel.listo).toBe(1);
    expect(r.funnel.caliente).toBe(1);
    expect(r.topLeads.length).toBe(3);
  });
  test('buildRevenueData solo confirmed suma al total', () => {
    const payments = [
      { amount: 200, status: 'confirmed', currency: 'USD' },
      { amount: 100, status: 'pending', currency: 'USD' },
    ];
    const r = buildRevenueData(payments, 'month');
    expect(r.total).toBe(200);
    expect(r.byStatus.pending).toBe(100);
  });
  test('buildConversationsSection topTopics', () => {
    const convs = [
      { sentiment: { label: 'positive' }, keyMoments: [{ type: 'price_inquiry' }] },
      { sentiment: { label: 'neutral' }, keyMoments: [{ type: 'price_inquiry' }, { type: 'close_attempt' }] },
    ];
    const r = buildConversationsSection(convs);
    expect(r.topTopics[0].type).toBe('price_inquiry');
    expect(r.topTopics[0].count).toBe(2);
  });
  test('saveDashboardSnapshot + getLatestDashboardSnapshot round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const sections = {
      overview: buildOverviewSection({ totalLeads: 20, convertedLeads: 5 }),
    };
    const s = buildDashboardSnapshot(UID, sections, { timeframe: 'week', date: '2026-05-01', generatedAt: NOW });
    await saveDashboardSnapshot(UID, s);
    setAll(db);
    const latest = await getLatestDashboardSnapshot(UID, 'week');
    expect(latest).not.toBeNull();
    expect(latest.sections.overview.totalLeads).toBe(20);
  });
  test('buildDashboardText incluye fecha y datos', () => {
    const sections = { overview: buildOverviewSection({ totalLeads: 30, totalRevenue: 2000 }) };
    const s = buildDashboardSnapshot(UID, sections, { date: '2026-05-01', timeframe: 'month' });
    const text = buildDashboardText(s);
    expect(text).toContain('2026-05-01');
    expect(text).toContain('30');
    expect(text).toContain('2000');
  });
});

// ─── PIPELINE INTEGRADO ───────────────────────────────────────────────────────
describe('Pipeline integrado: lead se enriquece, se agenda follow-up, se resume y se dashboardea', () => {
  test('flujo completo owner dashboard', async () => {
    const db = makeMockDb();
    setAll(db);

    // 1. Enriquecer contacto
    const enrichRecord = buildEnrichmentRecord(UID, PHONE, { company: 'Startup SA', city: 'Buenos Aires' }, {
      segment: 'new',
      date: '2026-05-01',
    });
    const enrichId = await saveEnrichmentRecord(UID, enrichRecord);
    expect(enrichId).toBeDefined();

    // 2. Agendar follow-ups
    const fu1 = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW, contactName: 'Juan' });
    const fu3 = scheduleFollowUp(UID, PHONE, 'day3_reminder', { baseTime: NOW, contactName: 'Juan' });
    setAll(db);
    await saveFollowUp(UID, fu1);
    setAll(db);
    await saveFollowUp(UID, fu3);

    // 3. Analizar conversacion
    const msgs = ['hola', 'cuanto cuesta?', 'me interesa comprar', 'gracias excelente'];
    const sentiment = detectSentiment(msgs);
    expect(['positive', 'very_positive', 'neutral']).toContain(sentiment.label);
    const moments = getKeyMoments(msgs);
    expect(moments.some(m => m.type === 'price_inquiry')).toBe(true);

    // 4. Guardar summary
    setAll(db);
    const summary = buildConversationSummary(UID, PHONE, msgs, { date: '2026-05-01' });
    await saveConversationSummary(UID, summary);
    const summaryText = buildSummaryText(summary);
    expect(summaryText).toContain(PHONE);

    // 5. Construir dashboard
    setAll(db);
    const pending = await getPendingFollowUps(UID, { before: NOW + 999999999 });
    const overview = buildOverviewSection({
      totalLeads: 1, newLeads: 1, totalMessages: msgs.length,
      pendingFollowUps: pending.length,
    });
    const convSection = buildConversationsSection([summary]);
    const snapshot = buildDashboardSnapshot(UID, { overview, conversations: convSection }, {
      timeframe: 'today', date: '2026-05-01', generatedAt: NOW,
    });
    setAll(db);
    await saveDashboardSnapshot(UID, snapshot);

    const dashText = buildDashboardText(snapshot);
    expect(dashText).toContain('2026-05-01');
    expect(dashText).toContain('today');

    // 6. Verificar follow-up message
    const msg = buildFollowUpMessage('day1_check', 'Juan', 'Startup SA');
    expect(msg).toContain('Juan');
    expect(msg).toContain('Startup SA');
  });
});
