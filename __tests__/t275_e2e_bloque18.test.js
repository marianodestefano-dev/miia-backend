'use strict';

// T275 E2E Bloque 18: webhook_dispatcher + email_engine + subscription_engine + loyalty_engine
const {
  buildDispatchRecord, buildDispatchResult, applyDispatchResult, shouldRetry,
  saveDispatch, getDispatch, updateDispatch, listPendingDispatches,
  dispatchWebhook,
  __setFirestoreForTests: setWebhook,
} = require('../core/webhook_dispatcher');

const {
  buildEmailRecord, validateEmailData, addRecipients, scheduleEmail,
  buildEmailStats, buildEmailSummaryText,
  saveEmail, getEmail, updateEmailStatus, updateEmailStats,
  __setFirestoreForTests: setEmail,
} = require('../core/email_engine');

const {
  buildSubscriptionRecord, computeSubscriptionPrice, computeNextBillingDate,
  recordBilling, cancelSubscription,
  saveSubscription, getSubscription, updateSubscription, listDueBillings,
  buildSubscriptionSummaryText,
  __setFirestoreForTests: setSubscription,
} = require('../core/subscription_engine');

const {
  buildLoyaltyAccount, earnPoints, redeemPoints, buildRewardRecord,
  canRedeemReward, computePointsFromAmount, computeTier,
  saveLoyaltyAccount, getLoyaltyAccount, updateLoyaltyAccount, saveTransaction,
  buildLoyaltySummaryText,
  __setFirestoreForTests: setLoyalty,
} = require('../core/loyalty_engine');

const UID = 'bloque18Uid';
const PHONE = '+5491155558888';

function makeMockDb({ stored = {}, txStored = {}, throwGet = false, throwSet = false } = {}) {
  const stores = { stored, txStored };
  function getStore(subCol) {
    return subCol === 'loyalty_transactions' ? stores.txStored : stores.stored;
  }
  return {
    collection: () => ({
      doc: () => ({
        collection: (subCol) => ({
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              const s = getStore(subCol);
              s[id] = opts && opts.merge ? { ...(s[id] || {}), ...data } : data;
            },
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              return { exists: !!s[id], data: () => s[id] };
            },
          }),
          where: (field, op, val) => ({
            get: async () => {
              if (throwGet) throw new Error('get error');
              const s = getStore(subCol);
              const entries = Object.values(s).filter(d => d && d[field] === val);
              return { empty: entries.length === 0, forEach: fn => entries.forEach(d => fn({ data: () => d })) };
            },
          }),
          get: async () => {
            if (throwGet) throw new Error('get error');
            const s = getStore(subCol);
            return { empty: Object.keys(s).length === 0, forEach: fn => Object.values(s).forEach(d => fn({ data: () => d })) };
          },
        }),
      }),
    }),
  };
}

function setAll(db) { setWebhook(db); setEmail(db); setSubscription(db); setLoyalty(db); }

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── WEBHOOK DISPATCHER ───────────────────────────────────────────────────────
describe('webhook_dispatcher — bloque 18', () => {
  test('buildDispatchRecord defaults y applyDispatchResult success', async () => {
    const r = buildDispatchRecord('integ_001', 'evt_001', {
      webhookUrl: 'https://erp.test/hook', payload: { event: 'subscription_created' },
    });
    expect(r.status).toBe('pending');
    const mockFetch = async () => ({ status: 200, text: async () => 'OK' });
    const result = await dispatchWebhook(r, mockFetch);
    const applied = applyDispatchResult(r, result);
    expect(applied.status).toBe('success');
    expect(applied.attempts).toBe(1);
  });

  test('shouldRetry true para retrying con attempts < max', () => {
    const r = buildDispatchRecord('i', 'e', { maxAttempts: 3 });
    const failed = applyDispatchResult(r, buildDispatchResult(false, 500, null, 'Error'));
    expect(shouldRetry(failed)).toBe(true);
  });

  test('saveDispatch + listPendingDispatches', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildDispatchRecord('integ_x', 'evt_y', { webhookUrl: 'https://test.com' });
    await saveDispatch(UID, r);
    setAll(db);
    const pending = await listPendingDispatches(UID);
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── EMAIL ENGINE ─────────────────────────────────────────────────────────────
describe('email_engine — bloque 18', () => {
  test('buildEmailRecord + validateEmailData + addRecipients', () => {
    let email = buildEmailRecord(UID, {
      subject: 'Bienvenido a tu suscripcion',
      bodyText: 'Gracias por suscribirte.',
      type: 'welcome',
    });
    const v = validateEmailData({ subject: email.subject, bodyText: email.bodyText });
    expect(v.valid).toBe(true);
    email = addRecipients(email, ['client@test.com']);
    expect(email.recipientCount).toBe(1);
  });

  test('scheduleEmail para email draft', () => {
    const email = buildEmailRecord(UID, { subject: 'Promo', bodyText: 'X' });
    const future = Date.now() + 7200000;
    const scheduled = scheduleEmail(email, future);
    expect(scheduled.status).toBe('queued');
    expect(scheduled.scheduledAt).toBe(future);
  });

  test('saveEmail + updateEmailStatus + buildEmailStats', async () => {
    const db = makeMockDb();
    setAll(db);
    const email = buildEmailRecord(UID, {
      subject: 'Tu suscripcion esta activa',
      bodyText: 'Todo listo.',
      type: 'transactional',
      recipients: ['a@t.com', 'b@t.com'],
      emailId: 'em_sub_conf',
    });
    await saveEmail(UID, email);
    setAll(db);
    await updateEmailStatus(UID, 'em_sub_conf', 'sent');
    setAll(db);
    await updateEmailStats(UID, 'em_sub_conf', { openCount: 1, clickCount: 0 });
    setAll(db);
    const loaded = await getEmail(UID, 'em_sub_conf');
    expect(loaded.status).toBe('sent');
    expect(loaded.sentAt).toBeDefined();
    const stats = buildEmailStats(loaded);
    expect(stats.openRate).toBe(50); // 1/2 * 100
  });
});

// ─── SUBSCRIPTION ENGINE ──────────────────────────────────────────────────────
describe('subscription_engine — bloque 18', () => {
  test('buildSubscriptionRecord con trial', () => {
    const s = buildSubscriptionRecord(UID, { name: 'Plan Mensual', price: 1500, trialDays: 7 });
    expect(s.status).toBe('trial');
    expect(s.trialEndsAt).toBeGreaterThan(Date.now());
  });

  test('computeSubscriptionPrice con descuento', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X', price: 2000, discountPercent: 15 });
    expect(computeSubscriptionPrice(s)).toBe(1700);
  });

  test('recordBilling exitoso avanza nextBillingAt', () => {
    const s = buildSubscriptionRecord(UID, { name: 'X', nextBillingAt: 1000 });
    const billed = recordBilling(s, true);
    expect(billed.billingCount).toBe(1);
    expect(billed.nextBillingAt).toBeGreaterThan(1000);
  });

  test('saveSubscription + listDueBillings', async () => {
    const db = makeMockDb();
    setAll(db);
    const pastTs = Date.now() - 1000;
    const sub = buildSubscriptionRecord(UID, { name: 'Vencida', nextBillingAt: pastTs, subscriptionId: 'sub_due_b18' });
    await saveSubscription(UID, sub);
    setAll(db);
    const due = await listDueBillings(UID, Date.now());
    expect(due.some(s => s.subscriptionId === 'sub_due_b18')).toBe(true);
  });
});

// ─── LOYALTY ENGINE ───────────────────────────────────────────────────────────
describe('loyalty_engine — bloque 18', () => {
  test('earnPoints acumula y sube tier', () => {
    let acc = buildLoyaltyAccount(UID, PHONE, {});
    const { account } = earnPoints(acc, 550);
    expect(account.tier).toBe('silver');
    expect(account.points).toBe(550);
  });

  test('redeemPoints descuenta y actualiza totalRedeemed', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 800 });
    const { account } = redeemPoints(acc, 200);
    expect(account.points).toBe(600);
    expect(account.totalRedeemed).toBe(200);
  });

  test('canRedeemReward verifica tier y puntos', () => {
    const acc = buildLoyaltyAccount(UID, PHONE, { points: 1000, totalEarned: 2200 });
    const reward = buildRewardRecord(UID, 'discount', { pointsCost: 500, requiredTier: 'gold' });
    const { canRedeem } = canRedeemReward(acc, reward);
    expect(canRedeem).toBe(true);
  });

  test('computePointsFromAmount con multiplier', () => {
    expect(computePointsFromAmount(1000, 1.5)).toBe(1500);
  });
});

// ─── PIPELINE INTEGRADO: alta + email + webhook + loyalty ────────────────────
describe('Pipeline P6: suscripcion + email bienvenida + webhook + puntos fidelidad', () => {
  test('flujo completo bloque 18', async () => {
    const db = makeMockDb();
    setAll(db);

    // 1. Cliente se suscribe (Plan Oro - 3000 ARS/mes, 10% desc)
    let subscription = buildSubscriptionRecord(UID, {
      name: 'Plan Oro',
      price: 3000,
      billingCycle: 'monthly',
      currency: 'ARS',
      contactPhone: PHONE,
      contactName: 'Valentina',
      discountPercent: 10,
      subscriptionId: 'sub_oro_001',
    });
    const effectivePrice = computeSubscriptionPrice(subscription);
    expect(effectivePrice).toBe(2700); // 3000 * 0.9
    await saveSubscription(UID, subscription);

    // 2. Enviar email de bienvenida
    let welcomeEmail = buildEmailRecord(UID, {
      subject: 'Bienvenida al Plan Oro — MIIA',
      bodyText: 'Hola Valentina! Tu suscripcion Plan Oro esta activa.',
      type: 'welcome',
      from: 'noreply@miia-app.com',
      emailId: 'em_welcome_oro',
    });
    welcomeEmail = addRecipients(welcomeEmail, [PHONE.replace('+', '') + '@example.com']);
    setAll(db);
    await saveEmail(UID, welcomeEmail);
    setAll(db);
    await updateEmailStatus(UID, 'em_welcome_oro', 'sent');

    // 3. Verificar email enviado
    setAll(db);
    const sentEmail = await getEmail(UID, 'em_welcome_oro');
    expect(sentEmail.status).toBe('sent');
    expect(sentEmail.sentAt).toBeDefined();

    // 4. Crear cuenta de fidelidad para el cliente
    let loyaltyAccount = buildLoyaltyAccount(UID, PHONE, { contactName: 'Valentina' });
    setAll(db);
    await saveLoyaltyAccount(UID, loyaltyAccount);

    // 5. Ganar puntos por primer pago (2700 ARS = 2700 puntos x1)
    const { account: accountAfterEarn, transaction: earnTx } = earnPoints(
      loyaltyAccount,
      computePointsFromAmount(effectivePrice),
      { description: 'Suscripcion Plan Oro mes 1', referenceId: 'sub_oro_001' }
    );
    expect(accountAfterEarn.points).toBe(2700);
    expect(accountAfterEarn.tier).toBe('gold'); // 2700 >= 2000
    loyaltyAccount = accountAfterEarn;
    setAll(db);
    await saveTransaction(UID, earnTx);
    await updateLoyaltyAccount(UID, loyaltyAccount.accountId, {
      points: loyaltyAccount.points,
      totalEarned: loyaltyAccount.totalEarned,
      tier: loyaltyAccount.tier,
      transactionCount: loyaltyAccount.transactionCount,
    });

    // 6. Crear despacho webhook a ERP externo por nueva suscripcion
    const webhookDispatch = buildDispatchRecord('integ_erp', 'evt_sub_oro', {
      webhookUrl: 'https://erp.example.com/subscriptions',
      payload: { event: 'subscription_created', subscriptionId: 'sub_oro_001', amount: effectivePrice },
    });
    setAll(db);
    await saveDispatch(UID, webhookDispatch);

    // 7. Ejecutar despacho (mock exitoso)
    const mockFetch = async () => ({ status: 200, text: async () => 'Accepted' });
    const dispatchResult = await dispatchWebhook(webhookDispatch, mockFetch);
    const updatedDispatch = applyDispatchResult(webhookDispatch, dispatchResult);
    expect(updatedDispatch.status).toBe('success');
    setAll(db);
    await updateDispatch(UID, updatedDispatch.dispatchId, {
      status: updatedDispatch.status, attempts: updatedDispatch.attempts, succeededAt: updatedDispatch.succeededAt,
    });

    // 8. Segundo mes: cobro exitoso → mas puntos
    const billedSub = recordBilling(subscription, true);
    expect(billedSub.billingCount).toBe(1);
    setAll(db);
    await updateSubscription(UID, 'sub_oro_001', { billingCount: billedSub.billingCount, lastBilledAt: billedSub.lastBilledAt });

    const { account: accountAfterEarn2, transaction: earnTx2 } = earnPoints(
      loyaltyAccount,
      computePointsFromAmount(effectivePrice),
      { description: 'Suscripcion Plan Oro mes 2' }
    );
    loyaltyAccount = accountAfterEarn2;
    expect(loyaltyAccount.totalEarned).toBe(5400); // 2700 * 2
    expect(loyaltyAccount.tier).toBe('platinum'); // 5400 >= 5000
    setAll(db);
    await saveTransaction(UID, earnTx2);

    // 9. Crear recompensa gold para canjear
    const reward = buildRewardRecord(UID, 'discount', {
      name: 'Mes gratis',
      pointsCost: 2000,
      value: 2700,
      requiredTier: 'gold',
    });
    const { canRedeem } = canRedeemReward(loyaltyAccount, reward);
    expect(canRedeem).toBe(true); // es platinum, tiene 5400 pts

    // 10. Canjear recompensa
    const { account: accountAfterRedeem, transaction: redeemTx } = redeemPoints(
      loyaltyAccount, reward.pointsCost, { description: 'Canje: Mes gratis' }
    );
    loyaltyAccount = accountAfterRedeem;
    expect(loyaltyAccount.points).toBe(5400 - 2000); // 3400
    setAll(db);
    await saveTransaction(UID, redeemTx);
    await updateLoyaltyAccount(UID, loyaltyAccount.accountId, {
      points: loyaltyAccount.points, totalRedeemed: loyaltyAccount.totalRedeemed,
      transactionCount: loyaltyAccount.transactionCount,
    });

    // 11. Email de confirmacion de canje
    let redeemEmail = buildEmailRecord(UID, {
      subject: 'Canje exitoso — Mes gratis Plan Oro',
      bodyText: 'Valentina, canjeaste 2000 puntos por un mes gratis!',
      type: 'transactional',
      emailId: 'em_redeem_conf',
    });
    redeemEmail = addRecipients(redeemEmail, [PHONE.replace('+', '') + '@example.com']);
    setAll(db);
    await saveEmail(UID, redeemEmail);
    setAll(db);
    await updateEmailStatus(UID, 'em_redeem_conf', 'sent');

    // 12. Verificar estado final
    setAll(db);
    const finalLoyalty = await getLoyaltyAccount(UID, loyaltyAccount.accountId);
    expect(finalLoyalty.points).toBe(3400);
    expect(finalLoyalty.totalRedeemed).toBe(2000);

    setAll(db);
    const finalDispatch = await getDispatch(UID, updatedDispatch.dispatchId);
    expect(finalDispatch.status).toBe('success');

    setAll(db);
    const finalSub = await getSubscription(UID, 'sub_oro_001');
    expect(finalSub.billingCount).toBe(1);

    // 13. Textos finales
    const loyaltyText = buildLoyaltySummaryText(loyaltyAccount);
    expect(loyaltyText).toContain('PLATINUM');
    expect(loyaltyText).toContain('3400');

    const subText = buildSubscriptionSummaryText(billedSub);
    expect(subText).toContain('Plan Oro');
    expect(subText).toContain('active');

    const emailText = buildEmailSummaryText(sentEmail);
    expect(emailText).toContain('Bienvenida');
  });
});
