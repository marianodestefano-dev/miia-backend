'use strict';

/**
 * T355 -- E2E Bloque 53
 * Pipeline: notification_engine -> campaign_engine -> referral_engine
 */

const {
  buildNotificationRecord, buildNotificationBody, scheduleNotification,
} = require('../core/notification_engine');

const {
  buildCampaignRecord, startCampaign, pauseCampaign,
  resumeCampaign, completeCampaign, recordSend, computeCampaignStats,
} = require('../core/campaign_engine');

const {
  buildReferralProgramRecord, buildReferralRecord,
  qualifyReferral, rewardReferral,
  isProgramActive, computeConversionRate, applyProgramStats,
} = require('../core/referral_engine');

const UID = 'owner_bloque53_001';
const PHONE_A = '+5719990000';
const PHONE_B = '+5710001111';

describe('T355 -- E2E Bloque 53: notification_engine + campaign_engine + referral_engine', () => {

  test('Paso 1 -- crear notificacion appointment_reminder', () => {
    const n = buildNotificationRecord(UID, {
      type: 'appointment_reminder',
      channel: 'whatsapp',
      recipientPhone: PHONE_A,
    });
    expect(n.type).toBe('appointment_reminder');
    expect(n.status).toBe('pending');
    expect(n.channel).toBe('whatsapp');
  });

  test('Paso 2 -- generar body del reminder con datos', () => {
    const body = buildNotificationBody('appointment_reminder', {
      contactName: 'Luis', businessName: 'Consultorio A', datetime: '20 mayo 14:00'
    });
    expect(body).toContain('Luis');
    expect(body).toContain('20 mayo 14:00');
  });

  test('Paso 3 -- crear campana broadcast y activarla', () => {
    const c = buildCampaignRecord(UID, { name: 'Promo Mayo', type: 'broadcast' });
    expect(c.status).toBe('draft');
    const active = startCampaign(c, 1000);
    expect(active.status).toBe('active');
    expect(active.audienceSize).toBe(1000);
  });

  test('Paso 4 -- registrar envios y calcular stats', () => {
    const c = buildCampaignRecord(UID, { name: 'Promo Stats' });
    let active = startCampaign(c, 100);
    active = recordSend(active, { delivered: true });
    active = recordSend(active, { delivered: true });
    active = recordSend(active, { error: true });
    const stats = computeCampaignStats(active);
    expect(stats.sentCount).toBe(3);
    expect(stats.deliveredCount).toBe(2);
    expect(stats.errorCount).toBe(1);
    expect(stats.sentRate).toBe(3); // 3/100 = 3%
  });

  test('Paso 5 -- programa de referidos activo, registrar referido', () => {
    const prog = buildReferralProgramRecord(UID, { referrerRewardAmount: 1000 });
    expect(isProgramActive(prog)).toBe(true);
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, { code: prog.code });
    expect(ref.status).toBe('pending');
    expect(ref.code).toBe(prog.code);
  });

  test('Paso 6 -- referido calificado y recompensado', () => {
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    const qualified = qualifyReferral(ref);
    expect(qualified.status).toBe('qualified');
    const rewarded = rewardReferral(qualified);
    expect(rewarded.status).toBe('rewarded');
    expect(rewarded.referrerRewarded).toBe(true);
  });

  test('Pipeline completo -- notif + campana + referido', () => {
    // A: Notificacion de nueva campana
    const n = buildNotificationRecord(UID, { type: 'broadcast_complete', priority: 'high' });
    expect(n.priority).toBe('high');

    // B: Body para notif de campana
    const body = buildNotificationBody('broadcast_complete', { broadcastName: 'Promo Mayo' });
    expect(body).toContain('Promo Mayo');

    // C: Campana ciclo completo
    const c = buildCampaignRecord(UID, { name: 'Campana Referidos' });
    const active = startCampaign(c, 500);
    const paused = pauseCampaign(active);
    const resumed = resumeCampaign(paused);
    const completed = completeCampaign(resumed);
    expect(completed.status).toBe('completed');

    // D: Programa de referidos y stats
    let prog = buildReferralProgramRecord(UID, { referrerRewardAmount: 500 });
    prog = applyProgramStats(prog, 'referred');
    prog = applyProgramStats(prog, 'referred');
    prog = applyProgramStats(prog, 'qualified');
    expect(prog.referredCount).toBe(2);
    expect(prog.qualifiedCount).toBe(1);
    expect(computeConversionRate(prog)).toBe(50); // 1/2 = 50%

    // E: Referido completo
    const ref = buildReferralRecord(UID, PHONE_A, PHONE_B, {});
    const q = qualifyReferral(ref);
    const r = rewardReferral(q);
    expect(r.referrerRewarded).toBe(true);
    expect(r.referredRewarded).toBe(true);
  });
});
