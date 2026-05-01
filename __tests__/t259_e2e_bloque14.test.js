'use strict';

// T259 E2E Bloque 14: coupon_engine + appointment_engine + contact_enrichment + follow_up_scheduler
const {
  buildCouponRecord, saveCoupon, getCoupon, validateCoupon,
  redeemCoupon, listActiveCoupons, computeDiscount, buildCouponText,
  COUPON_TYPES,
  __setFirestoreForTests: setCoupon,
} = require('../core/coupon_engine');

const {
  buildAppointmentRecord, saveAppointment,
  getAppointmentsForDate, checkConflict, updateAppointmentStatus,
  buildAvailableSlots, buildAppointmentText, buildAvailabilityText,
  APPOINTMENT_STATUSES, isValidDatetime,
  __setFirestoreForTests: setAppt,
} = require('../core/appointment_engine');

const {
  computeContactSegment, buildEnrichmentRecord, saveEnrichmentRecord,
  getEnrichmentRecord, buildEnrichmentText, CONTACT_SEGMENTS,
  __setFirestoreForTests: setEnrich,
} = require('../core/contact_enrichment');

const {
  scheduleFollowUp, saveFollowUp, getNextFollowUp,
  buildFollowUpMessage, FOLLOWUP_TYPES,
  __setFirestoreForTests: setFollowUp,
} = require('../core/follow_up_scheduler');

const UID = 'bloque14Uid';
const PHONE = '+541177665544';
const DATE = '2026-06-01';
const DT = '2026-06-01T10:00';
const NOW = 1748000000000;

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
                if (field === 'status') return d.status === val;
                if (field === 'date') return d.date === val;
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

function setAll(db) { setCoupon(db); setAppt(db); setEnrich(db); setFollowUp(db); }

beforeEach(() => setAll(null));
afterEach(() => setAll(null));

// ─── COUPON ENGINE ────────────────────────────────────────────────────────────
describe('coupon_engine — E2E', () => {
  test('COUPON_TYPES incluye percentage y fixed', () => {
    expect(COUPON_TYPES).toContain('percentage');
    expect(COUPON_TYPES).toContain('fixed');
  });
  test('buildCouponRecord percentage 20%', () => {
    const c = buildCouponRecord(UID, 'MAYO20', 'percentage', 20);
    expect(c.type).toBe('percentage');
    expect(c.value).toBe(20);
    expect(c.status).toBe('active');
  });
  test('computeDiscount percentage sobre 150 = 30', () => {
    const c = buildCouponRecord(UID, 'P20', 'percentage', 20);
    expect(computeDiscount(c, 150)).toBe(30);
  });
  test('computeDiscount fixed min_order no cumplido = 0', () => {
    const c = buildCouponRecord(UID, 'F10', 'fixed', 10, { minOrderAmount: 100 });
    expect(computeDiscount(c, 50)).toBe(0);
  });
  test('saveCoupon + validateCoupon round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const c = buildCouponRecord(UID, 'PROMO10', 'percentage', 10);
    await saveCoupon(UID, c);
    setAll(db);
    const v = await validateCoupon(UID, 'PROMO10', 200);
    expect(v.valid).toBe(true);
    expect(v.discount).toBe(20);
  });
  test('validateCoupon retorna invalid si no existe', async () => {
    setAll(makeMockDb());
    const v = await validateCoupon(UID, 'NOEXISTE', 100);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('coupon_not_found');
  });
  test('redeemCoupon actualiza usedCount', async () => {
    const c = buildCouponRecord(UID, 'PROMO10', 'percentage', 10, { maxUses: 5 });
    const db = makeMockDb({ stored: { [c.couponId]: c } });
    setAll(db);
    const result = await redeemCoupon(UID, 'PROMO10', PHONE);
    expect(result.newCount).toBe(1);
    expect(result.newStatus).toBe('active');
  });
  test('listActiveCoupons retorna solo activos', async () => {
    const c1 = buildCouponRecord(UID, 'ACT1', 'percentage', 10);
    const c2 = { ...buildCouponRecord(UID, 'DIS1', 'fixed', 5), status: 'disabled' };
    setAll(makeMockDb({ stored: { [c1.couponId]: c1, [c2.couponId]: c2 } }));
    const activos = await listActiveCoupons(UID);
    expect(activos.every(c => c.status === 'active')).toBe(true);
  });
  test('buildCouponText incluye codigo y porcentaje', () => {
    const c = buildCouponRecord(UID, 'MAYO20', 'percentage', 20);
    const text = buildCouponText(c);
    expect(text).toContain('MAYO20');
    expect(text).toContain('20%');
  });
});

// ─── APPOINTMENT ENGINE ────────────────────────────────────────────────────────
describe('appointment_engine — E2E', () => {
  test('APPOINTMENT_STATUSES incluye confirmed y cancelled', () => {
    expect(APPOINTMENT_STATUSES).toContain('confirmed');
    expect(APPOINTMENT_STATUSES).toContain('cancelled');
  });
  test('isValidDatetime formato correcto', () => {
    expect(isValidDatetime('2026-06-01T10:00')).toBe(true);
    expect(isValidDatetime('2026-06-01 10:00')).toBe(false);
  });
  test('buildAppointmentRecord construye correctamente', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { type: 'remote', durationMin: 45 });
    expect(r.type).toBe('remote');
    expect(r.durationMin).toBe(45);
    expect(r.endsAtMs).toBe(r.timestampMs + 45 * 60 * 1000);
  });
  test('checkConflict detecta solapamiento', () => {
    const existing = buildAppointmentRecord(UID, '+5411', '2026-06-01T10:00');
    const newAppt = buildAppointmentRecord(UID, PHONE, '2026-06-01T10:20');
    expect(checkConflict(newAppt, [existing])).not.toBeNull();
  });
  test('checkConflict no detecta si hay espacio', () => {
    const existing = buildAppointmentRecord(UID, '+5411', '2026-06-01T10:00');
    const newAppt = buildAppointmentRecord(UID, PHONE, '2026-06-01T11:00');
    expect(checkConflict(newAppt, [existing])).toBeNull();
  });
  test('saveAppointment + getAppointmentsForDate round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildAppointmentRecord(UID, PHONE, DT);
    await saveAppointment(UID, r);
    setAll(db);
    const appts = await getAppointmentsForDate(UID, DATE);
    expect(appts.length).toBe(1);
    expect(appts[0].phone).toBe(PHONE);
  });
  test('updateAppointmentStatus confirmed', async () => {
    setAll(makeMockDb());
    const id = await updateAppointmentStatus(UID, 'appt_001', 'confirmed');
    expect(id).toBe('appt_001');
  });
  test('buildAvailableSlots genera horarios', () => {
    const slots = buildAvailableSlots(DATE, []);
    expect(slots.length).toBeGreaterThan(0);
    slots.forEach(s => expect(s.datetime).toContain(DATE));
  });
  test('buildAvailabilityText lista turnos', () => {
    const slots = buildAvailableSlots(DATE, []);
    const text = buildAvailabilityText(DATE, slots);
    expect(text).toContain(DATE);
    expect(text.length).toBeGreaterThan(20);
  });
  test('buildAppointmentText incluye datos clave', () => {
    const r = buildAppointmentRecord(UID, PHONE, DT, { contactName: 'Ana', price: 300, currency: 'ARS' });
    const text = buildAppointmentText(r);
    expect(text).toContain(PHONE);
    expect(text).toContain('300');
    expect(text).toContain('ARS');
  });
});

// ─── CONTACT ENRICHMENT ──────────────────────────────────────────────────────
describe('contact_enrichment — bloque 14', () => {
  test('computeContactSegment premium con 3 compras', () => {
    expect(computeContactSegment({ isConverted: true, totalPurchases: 3 })).toBe('premium');
  });
  test('saveEnrichmentRecord + getEnrichmentRecord', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = buildEnrichmentRecord(UID, PHONE, { email: 'ana@test.com' }, { segment: 'new' });
    await saveEnrichmentRecord(UID, r);
    setAll(db);
    const loaded = await getEnrichmentRecord(UID, PHONE);
    expect(loaded.segment).toBe('new');
    expect(loaded.fields.email).toBe('ana@test.com');
  });
  test('buildEnrichmentText sin campos extra', () => {
    const r = buildEnrichmentRecord(UID, PHONE, {}, { segment: 'cold' });
    const text = buildEnrichmentText(r);
    expect(text.length).toBeGreaterThan(0);
  });
});

// ─── FOLLOW UP SCHEDULER ─────────────────────────────────────────────────────
describe('follow_up_scheduler — bloque 14', () => {
  test('FOLLOWUP_TYPES incluye custom', () => { expect(FOLLOWUP_TYPES).toContain('custom'); });
  test('scheduleFollowUp month1_winback en 30 dias', () => {
    const r = scheduleFollowUp(UID, PHONE, 'month1_winback', { baseTime: NOW });
    expect(r.scheduledAt).toBe(NOW + 30 * 24 * 60 * 60 * 1000);
  });
  test('saveFollowUp + getNextFollowUp round-trip', async () => {
    const db = makeMockDb();
    setAll(db);
    const r = scheduleFollowUp(UID, PHONE, 'day1_check', { baseTime: NOW });
    await saveFollowUp(UID, r);
    setAll(db);
    const next = await getNextFollowUp(UID, PHONE);
    expect(next).not.toBeNull();
  });
  test('buildFollowUpMessage week1_reconnect', () => {
    const text = buildFollowUpMessage('week1_reconnect', 'Carlos', 'TiendaX');
    expect(text).toContain('Carlos');
    expect(text).toContain('TiendaX');
  });
});

// ─── PIPELINE INTEGRADO ───────────────────────────────────────────────────────
describe('Pipeline P3: cliente agenda turno con cupon + follow-up post-servicio', () => {
  test('flujo completo Piso 3', async () => {
    const db = makeMockDb();
    setAll(db);

    // 1. Crear cupon de descuento para el turno
    const coupon = buildCouponRecord(UID, 'TURNO20', 'percentage', 20, { maxUses: 50, description: 'Descuento primer turno' });
    await saveCoupon(UID, coupon);

    // 2. Validar cupon (orden = $200)
    setAll(db);
    const validation = await validateCoupon(UID, 'TURNO20', 200);
    expect(validation.valid).toBe(true);
    expect(validation.discount).toBe(40);

    // 3. Construir slot disponible y verificar conflictos
    const existingAppts = [];
    const slots = buildAvailableSlots(DATE, existingAppts);
    expect(slots.length).toBeGreaterThan(0);
    const chosenSlot = slots[0]; // 09:00

    // 4. Crear y guardar turno
    const appt = buildAppointmentRecord(UID, PHONE, chosenSlot.datetime, {
      contactName: 'Carlos',
      price: 200 - validation.discount,
      currency: 'ARS',
      notes: 'Cupon TURNO20 aplicado',
    });
    expect(checkConflict(appt, existingAppts)).toBeNull();
    setAll(db);
    const apptId = await saveAppointment(UID, appt);
    expect(apptId).toBe(appt.appointmentId);

    // 5. Canjear cupon
    setAll(db);
    const redemption = await redeemCoupon(UID, 'TURNO20', PHONE);
    expect(redemption.newCount).toBe(1);

    // 6. Enriquecer contacto como cliente convertido
    const enrichRecord = buildEnrichmentRecord(UID, PHONE, { notes: 'Primer turno agendado' }, {
      segment: 'new',
      date: DATE,
    });
    setAll(db);
    await saveEnrichmentRecord(UID, enrichRecord);

    // 7. Confirmar turno
    setAll(db);
    await updateAppointmentStatus(UID, apptId, 'confirmed');

    // 8. Agendar follow-up post-servicio
    const followUp = scheduleFollowUp(UID, PHONE, 'day3_reminder', {
      baseTime: appt.timestampMs,
      contactName: 'Carlos',
      businessName: 'MiNegocio',
    });
    setAll(db);
    const fuId = await saveFollowUp(UID, followUp);
    expect(fuId).toBe(followUp.followUpId);

    // 9. Verificar textos
    const apptText = buildAppointmentText(appt);
    expect(apptText).toContain(PHONE);

    const couponText = buildCouponText(coupon);
    expect(couponText).toContain('TURNO20');

    const avText = buildAvailabilityText(DATE, slots);
    expect(avText).toContain(DATE);

    const fuMsg = buildFollowUpMessage('day3_reminder', 'Carlos', 'MiNegocio');
    expect(fuMsg).toContain('Carlos');
    expect(fuMsg).toContain('MiNegocio');
  });
});
