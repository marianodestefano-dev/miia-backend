'use strict';

const {
  buildNotificationRecord, buildNotificationBody, scheduleNotification,
  NOTIFICATION_TYPES, NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES, NOTIFICATION_PRIORITIES,
  MAX_NOTIFICATION_BODY_LENGTH, MAX_NOTIFICATION_TITLE_LENGTH,
} = require('../core/notification_engine');

const {
  buildCampaignRecord, buildDripStep, buildCampaignWithDripSteps,
  startCampaign, pauseCampaign, resumeCampaign,
  completeCampaign, cancelCampaign, recordSend, computeCampaignStats,
  CAMPAIGN_STATUSES, CAMPAIGN_TYPES, CAMPAIGN_CHANNELS, TRIGGER_EVENTS,
  MAX_AUDIENCE_SIZE, MAX_STEPS_PER_DRIP, MIN_STEP_DELAY_MS,
} = require('../core/campaign_engine');

const {
  buildReferralProgramRecord, buildReferralRecord,
  qualifyReferral, rewardReferral, expireReferral,
  isProgramActive, computeConversionRate, generateReferralCode,
  applyProgramStats,
  REFERRAL_STATUSES, REWARD_TRIGGERS,
  CODE_LENGTH, MAX_REFERRALS_PER_CODE, CODE_EXPIRY_DAYS,
} = require('../core/referral_engine');

const UID = 'uid_t354';
const PHONE_A = '+5715556666';
const PHONE_B = '+5717778888';

describe('T354 -- notification_engine + campaign_engine + referral_engine (32 tests)', () => {

  // ── NOTIFICATION ENGINE ──────────────────────────────────────────────────────

  test('NOTIFICATION_TYPES frozen, contiene 10 tipos', () => {
    expect(() => { NOTIFICATION_TYPES.push('hack'); }).toThrow();
    expect(NOTIFICATION_TYPES).toContain('appointment_reminder');
    expect(NOTIFICATION_TYPES).toContain('payment_received');
    expect(NOTIFICATION_TYPES).toContain('new_lead');
    expect(NOTIFICATION_TYPES).toContain('custom');
    expect(NOTIFICATION_TYPES.length).toBe(10);
  });

  test('NOTIFICATION_CHANNELS frozen: whatsapp/email/push/sms/in_app', () => {
    expect(() => { NOTIFICATION_CHANNELS.push('hack'); }).toThrow();
    expect(NOTIFICATION_CHANNELS).toContain('whatsapp');
    expect(NOTIFICATION_CHANNELS).toContain('email');
    expect(NOTIFICATION_CHANNELS).toContain('push');
    expect(NOTIFICATION_CHANNELS).toContain('sms');
    expect(NOTIFICATION_CHANNELS).toContain('in_app');
  });

  test('NOTIFICATION_STATUSES frozen: pending/scheduled/sent/failed/cancelled/read', () => {
    expect(() => { NOTIFICATION_STATUSES.push('hack'); }).toThrow();
    expect(NOTIFICATION_STATUSES).toContain('pending');
    expect(NOTIFICATION_STATUSES).toContain('sent');
    expect(NOTIFICATION_STATUSES).toContain('failed');
    expect(NOTIFICATION_STATUSES).toContain('read');
  });

  test('NOTIFICATION_PRIORITIES frozen: low/normal/high/urgent', () => {
    expect(() => { NOTIFICATION_PRIORITIES.push('hack'); }).toThrow();
    expect(NOTIFICATION_PRIORITIES).toContain('low');
    expect(NOTIFICATION_PRIORITIES).toContain('normal');
    expect(NOTIFICATION_PRIORITIES).toContain('high');
    expect(NOTIFICATION_PRIORITIES).toContain('urgent');
    expect(NOTIFICATION_PRIORITIES.length).toBe(4);
  });

  test('buildNotificationRecord: defaults type=custom, status=pending, channel=whatsapp, priority=normal', () => {
    const n = buildNotificationRecord(UID, {});
    expect(n.uid).toBe(UID);
    expect(n.type).toBe('custom');
    expect(n.status).toBe('pending');
    expect(n.channel).toBe('whatsapp');
    expect(n.priority).toBe('normal');
    expect(n.notificationId).toBeDefined();
  });

  test('buildNotificationRecord: tipo/canal/prioridad validos se respetan', () => {
    const n = buildNotificationRecord(UID, {
      type: 'payment_received',
      channel: 'email',
      priority: 'high',
      title: 'Pago recibido',
      body: 'Se acredito el pago',
      recipientPhone: PHONE_A,
    });
    expect(n.type).toBe('payment_received');
    expect(n.channel).toBe('email');
    expect(n.priority).toBe('high');
    expect(n.title).toBe('Pago recibido');
    expect(n.recipientPhone).toBe(PHONE_A);
  });

  test('buildNotificationBody: appointment_reminder contiene nombre y negocio', () => {
    const body = buildNotificationBody('appointment_reminder', {
      contactName: 'Ana', businessName: 'Salon Bella', datetime: '15 mayo 10:00'
    });
    expect(body).toContain('Ana');
    expect(body).toContain('Salon Bella');
  });

  test('buildNotificationBody: payment_received contiene amount y currency', () => {
    const body = buildNotificationBody('payment_received', { amount: 5000, currency: 'COP' });
    expect(body).toContain('5000');
    expect(body).toContain('COP');
  });

  test('buildNotificationBody: new_lead contiene nombre del contacto', () => {
    const body = buildNotificationBody('new_lead', { contactName: 'Pedro', businessName: 'Mi Tienda' });
    expect(body).toContain('Pedro');
    expect(body).toContain('Mi Tienda');
  });

  test('scheduleNotification: scheduledAt pasado lanza', () => {
    const n = buildNotificationRecord(UID, { type: 'custom' });
    expect(() => scheduleNotification(n, Date.now() - 1000)).toThrow('scheduledAt debe ser timestamp futuro');
  });

  test('scheduleNotification: pending + futuro -> status=scheduled', () => {
    const n = buildNotificationRecord(UID, { type: 'custom' });
    const future = Date.now() + 3600000;
    const scheduled = scheduleNotification(n, future);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledAt).toBe(future);
  });

  // ── CAMPAIGN ENGINE ──────────────────────────────────────────────────────────

  test('CAMPAIGN_STATUSES frozen: draft/scheduled/active/paused/completed/cancelled/failed', () => {
    expect(() => { CAMPAIGN_STATUSES.push('hack'); }).toThrow();
    expect(CAMPAIGN_STATUSES).toContain('draft');
    expect(CAMPAIGN_STATUSES).toContain('active');
    expect(CAMPAIGN_STATUSES).toContain('completed');
    expect(CAMPAIGN_STATUSES).toContain('cancelled');
    expect(CAMPAIGN_STATUSES.length).toBe(7);
  });

  test('CAMPAIGN_TYPES/CHANNELS/TRIGGER_EVENTS frozen con valores correctos', () => {
    expect(() => { CAMPAIGN_TYPES.push('hack'); }).toThrow();
    expect(CAMPAIGN_TYPES).toContain('broadcast');
    expect(CAMPAIGN_TYPES).toContain('drip');
    expect(CAMPAIGN_CHANNELS).toContain('whatsapp');
    expect(TRIGGER_EVENTS).toContain('first_purchase');
    expect(TRIGGER_EVENTS).toContain('loyalty_tier_up');
  });

  test('MAX_AUDIENCE_SIZE=10000, MAX_STEPS_PER_DRIP=20, MIN_STEP_DELAY_MS=60000', () => {
    expect(MAX_AUDIENCE_SIZE).toBe(10000);
    expect(MAX_STEPS_PER_DRIP).toBe(20);
    expect(MIN_STEP_DELAY_MS).toBe(60000);
  });

  test('buildCampaignRecord: defaults type=broadcast, status=draft, channel=whatsapp', () => {
    const c = buildCampaignRecord(UID, { name: 'Promo Enero' });
    expect(c.uid).toBe(UID);
    expect(c.type).toBe('broadcast');
    expect(c.status).toBe('draft');
    expect(c.channel).toBe('whatsapp');
    expect(c.sentCount).toBe(0);
    expect(c.audienceSize).toBe(0);
  });

  test('buildCampaignRecord: scheduledAt futuro -> status=scheduled', () => {
    const c = buildCampaignRecord(UID, { scheduledAt: Date.now() + 3600000 });
    expect(c.status).toBe('scheduled');
    expect(c.scheduledAt).toBeGreaterThan(Date.now());
  });

  test('buildDripStep: delayMs < MIN -> clamped a MIN_STEP_DELAY_MS', () => {
    const step = buildDripStep({ body: 'Hola', delayMs: 100 }, 0);
    expect(step.delayMs).toBe(MIN_STEP_DELAY_MS);
    expect(step.stepIndex).toBe(0);
  });

  test('startCampaign: draft -> active con audienceSize correcto', () => {
    const c = buildCampaignRecord(UID, {});
    const started = startCampaign(c, 500);
    expect(started.status).toBe('active');
    expect(started.audienceSize).toBe(500);
    expect(started.startedAt).toBeDefined();
  });

  test('startCampaign: completed lanza', () => {
    const c = buildCampaignRecord(UID, {});
    const active = startCampaign(c, 100);
    const completed = completeCampaign(active);
    expect(() => startCampaign(completed, 100)).toThrow();
  });

  test('pauseCampaign: active -> paused; non-active lanza', () => {
    const c = buildCampaignRecord(UID, {});
    const active = startCampaign(c, 100);
    const paused = pauseCampaign(active);
    expect(paused.status).toBe('paused');
    expect(() => pauseCampaign(c)).toThrow('Solo se puede pausar una campana activa');
  });

  test('resumeCampaign: paused -> active; non-paused lanza', () => {
    const c = buildCampaignRecord(UID, {});
    const active = startCampaign(c, 100);
    const paused = pauseCampaign(active);
    const resumed = resumeCampaign(paused);
    expect(resumed.status).toBe('active');
    expect(() => resumeCampaign(active)).toThrow('Solo se puede reanudar una campana pausada');
  });

  test('cancelCampaign: completed lanza; draft OK', () => {
    const c = buildCampaignRecord(UID, {});
    const active = startCampaign(c, 100);
    const completed = completeCampaign(active);
    expect(() => cancelCampaign(completed)).toThrow();
    // draft se puede cancelar
    const c2 = buildCampaignRecord(UID, {});
    expect(cancelCampaign(c2).status).toBe('cancelled');
  });

  // ── REFERRAL ENGINE ──────────────────────────────────────────────────────────

  test('REFERRAL_STATUSES frozen: pending/qualified/rewarded/expired/cancelled', () => {
    expect(() => { REFERRAL_STATUSES.push('hack'); }).toThrow();
    expect(REFERRAL_STATUSES).toContain('pending');
    expect(REFERRAL_STATUSES).toContain('qualified');
    expect(REFERRAL_STATUSES).toContain('rewarded');
    expect(REFERRAL_STATUSES).toContain('expired');
    expect(REFERRAL_STATUSES.length).toBe(5);
  });

  test('REWARD_TRIGGERS frozen, CODE_LENGTH=6, MAX_REFERRALS_PER_CODE=100', () => {
    expect(() => { REWARD_TRIGGERS.push('hack'); }).toThrow();
    expect(REWARD_TRIGGERS).toContain('first_purchase');
    expect(REWARD_TRIGGERS).toContain('signup');
    expect(CODE_LENGTH).toBe(6);
    expect(MAX_REFERRALS_PER_CODE).toBe(100);
    expect(CODE_EXPIRY_DAYS).toBe(90);
  });

  test('generateReferralCode: longitud=6, sin O/0/I/1', () => {
    const code = generateReferralCode(UID, 'seed_test');
    expect(code.length).toBe(CODE_LENGTH);
    expect(code).not.toMatch(/[O0I1]/);
  });

  test('generateReferralCode: mismo uid+seed -> mismo code', () => {
    const c1 = generateReferralCode(UID, 'same_seed');
    const c2 = generateReferralCode(UID, 'same_seed');
    expect(c1).toBe(c2);
  });

  test('buildReferralProgramRecord: retorna programa con code y active=true', () => {
    const prog = buildReferralProgramRecord(UID, { referrerRewardAmount: 500 });
    expect(prog.uid).toBe(UID);
    expect(prog.active).toBe(true);
    expect(typeof prog.code).toBe('string');
    expect(prog.code.length).toBe(CODE_LENGTH);
    expect(prog.referrerRewardAmount).toBe(500);
    expect(prog.referredCount).toBe(0);
  });

  test('buildReferralRecord: retorna referral con status=pending', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, { code: 'ABCDEF' });
    expect(ref.uid).toBe(UID);
    expect(ref.referrerPhone).toBe(PHONE_A);
    expect(ref.referredPhone).toBe(PHONE_B);
    expect(ref.status).toBe('pending');
    expect(ref.code).toBe('ABCDEF');
    expect(ref.referrerRewarded).toBe(false);
  });

  test('qualifyReferral: pending -> qualified', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    const qualified = qualifyReferral(ref);
    expect(qualified.status).toBe('qualified');
    expect(qualified.qualifiedAt).toBeDefined();
  });

  test('qualifyReferral: non-pending lanza', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    const qualified = qualifyReferral(ref);
    expect(() => qualifyReferral(qualified)).toThrow();
  });

  test('rewardReferral: qualified -> rewarded, ambos rewarded=true', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    const qualified = qualifyReferral(ref);
    const rewarded = rewardReferral(qualified);
    expect(rewarded.status).toBe('rewarded');
    expect(rewarded.referrerRewarded).toBe(true);
    expect(rewarded.referredRewarded).toBe(true);
  });

  test('rewardReferral: non-qualified lanza', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    expect(() => rewardReferral(ref)).toThrow();
  });

  test('expireReferral: rewarded lanza; pending OK', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    const qualified = qualifyReferral(ref);
    const rewarded = rewardReferral(qualified);
    expect(() => expireReferral(rewarded)).toThrow();
    // pending se puede expirar
    const ref2 = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    expect(expireReferral(ref2).status).toBe('expired');
  });

  test('isProgramActive/computeConversionRate', () => {
    const prog = buildReferralProgramRecord(UID, {});
    expect(isProgramActive(prog)).toBe(true);
    // 0 referidos -> 0%
    expect(computeConversionRate(prog)).toBe(0);
    // Actualizar stats
    const withReferreds = applyProgramStats(prog, 'referred');
    const withQualified = applyProgramStats(withReferreds, 'qualified');
    expect(computeConversionRate(withQualified)).toBe(100); // 1/1 = 100%
  });
});
