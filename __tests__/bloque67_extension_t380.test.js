"use strict";

const nd = require("../core/network_directory");
const mp = require("../core/marketplace");
const sp = require("../core/social_proof");
const sl = require("../core/sla_manager");
const ls = require("../core/location_service");
const ab = require("../core/advanced_booking");
const ss = require("../core/smart_scheduler");
const sv = require("../core/sales_strategy");

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: (data && data.id) || "doc1" };
}
function makeCol(docs) {
  const arr = (docs || []).map(d => makeDoc(d));
  const q = {
    where: () => q, orderBy: () => q, limit: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
  return {
    doc: (id) => ({
      get: async () => makeDoc((docs || []).find(d => d && d.id === id) || null),
      set: async () => {},
      update: async () => {},
    }),
    where: () => q, orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  nd.__setFirestoreForTests(_db);
  mp.__setFirestoreForTests(_db);
  sp.__setFirestoreForTests(_db);
  sl.__setFirestoreForTests(_db);
  ls.__setFirestoreForTests(_db);
  ab.__setFirestoreForTests(_db);
  ss.__setFirestoreForTests(_db);
});

describe("Network Directory", () => {
  test("ND-1: BUSINESS_CATEGORIES frozen", () => {
    expect(Object.isFrozen(nd.BUSINESS_CATEGORIES)).toBe(true);
    expect(nd.BUSINESS_CATEGORIES).toContain("salud");
    expect(nd.BUSINESS_CATEGORIES.length).toBeGreaterThanOrEqual(8);
  });

  test("ND-2: registerBusiness creates entry", async () => {
    const biz = await nd.registerBusiness("uid1", { name: "Clinica Norte", category: "salud" });
    expect(biz.uid).toBe("uid1");
    expect(biz.visible).toBe(true);
  });

  test("ND-3: registerBusiness throws on invalid category", async () => {
    await expect(nd.registerBusiness("uid1", { name: "Test", category: "invalid_cat" })).rejects.toThrow("invalid category");
  });

  test("ND-4: searchDirectory returns results", async () => {
    const results = await nd.searchDirectory("clinica");
    expect(Array.isArray(results)).toBe(true);
  });

  test("ND-5: recommendBusiness returns null for empty directory", async () => {
    const rec = await nd.recommendBusiness("uid1", "necesito un dentista");
    expect(rec).toBeNull();
  });
});

describe("Marketplace", () => {
  test("MP-1: OFFER_STATUS frozen", () => {
    expect(Object.isFrozen(mp.OFFER_STATUS)).toBe(true);
    expect(mp.OFFER_STATUS).toContain("active");
  });

  test("MP-2: createOffer creates offer", async () => {
    const offer = await mp.createOffer("uid1", { title: "50% off servicio", price: 50000 });
    expect(offer.uid).toBe("uid1");
    expect(offer.status).toBe("active");
    expect(offer.id).toBeDefined();
  });

  test("MP-3: createOffer throws without required fields", async () => {
    await expect(mp.createOffer("uid1", {})).rejects.toThrow("price required");
  });

  test("MP-4: updateOfferStatus changes status", async () => {
    const result = await mp.updateOfferStatus("uid1", "offer-123", "paused");
    expect(result.status).toBe("paused");
  });

  test("MP-5: trackInquiry records inquiry", async () => {
    const result = await mp.trackInquiry("offer-123", "+573001234567");
    expect(result.offerId).toBe("offer-123");
    expect(result.recordedAt).toBeDefined();
  });
});

describe("Social Proof", () => {
  test("SP-1: PROOF_TYPES frozen", () => {
    expect(Object.isFrozen(sp.PROOF_TYPES)).toBe(true);
    expect(sp.PROOF_TYPES).toContain("testimonial");
  });

  test("SP-2: addTestimonial creates entry with defaults", async () => {
    const t = await sp.addTestimonial("uid1", { text: "Excelente servicio!" });
    expect(t.uid).toBe("uid1");
    expect(t.authorName).toBe("Anonimo");
    expect(t.rating).toBe(5);
  });

  test("SP-3: getTopTestimonials returns sorted list", async () => {
    const list = await sp.getTopTestimonials("uid1");
    expect(Array.isArray(list)).toBe(true);
  });

  test("SP-4: syncGoogleReviews creates stub config", async () => {
    const result = await sp.syncGoogleReviews("uid1", "ChIJ_place_id");
    expect(result.status).toBe("synced_stub");
    expect(result.placeId).toBe("ChIJ_place_id");
  });

  test("SP-5: buildSocialProofSnippet returns formatted text", () => {
    const testimonials = [{ text: "Muy bueno", authorName: "Juan", rating: 5 }];
    const snippet = sp.buildSocialProofSnippet(testimonials);
    expect(snippet).toContain("Juan");
    expect(snippet).toContain("5/5");
  });

  test("SP-6: buildSocialProofSnippet returns empty for no testimonials", () => {
    expect(sp.buildSocialProofSnippet([])).toBe("");
  });
});

describe("SLA Manager", () => {
  test("SL-1: DEFAULT_SLA frozen with correct fields", () => {
    expect(Object.isFrozen(sl.DEFAULT_SLA)).toBe(true);
    expect(sl.DEFAULT_SLA.first_response_minutes).toBe(30);
  });

  test("SL-2: setSLA creates config", async () => {
    const sla = await sl.setSLA("uid1", "lead", { first_response_minutes: 15, resolution_hours: 12, escalation_minutes: 45 });
    expect(sla.contactType).toBe("lead");
    expect(sla.first_response_minutes).toBe(15);
  });

  test("SL-3: setSLA throws on invalid contactType", async () => {
    await expect(sl.setSLA("uid1", "robot")).rejects.toThrow("invalid contactType");
  });

  test("SL-4: getSLA returns default when no config", async () => {
    const sla = await sl.getSLA("uid1", "vip");
    expect(sla.isDefault).toBe(true);
    expect(sla.first_response_minutes).toBe(30);
  });

  test("SL-5: checkSLABreach detects breach", () => {
    const sla = { first_response_minutes: 5, escalation_minutes: 10 };
    const tenMinutesAgo = Date.now() - 15 * 60 * 1000;
    const result = sl.checkSLABreach(sla, tenMinutesAgo);
    expect(result.breached).toBe(true);
    expect(result.escalate).toBe(true);
  });

  test("SL-6: checkSLABreach no breach for recent message", () => {
    const sla = { first_response_minutes: 30, escalation_minutes: 60 };
    const result = sl.checkSLABreach(sla, Date.now() - 60000);
    expect(result.breached).toBe(false);
  });
});

describe("Location Service", () => {
  test("LS-1: setBusinessLocation creates location", async () => {
    const loc = await ls.setBusinessLocation("uid1", { address: "Calle 123 #45-67", city: "Medellin" });
    expect(loc.uid).toBe("uid1");
    expect(loc.city).toBe("Medellin");
  });

  test("LS-2: getBusinessLocation returns null for unknown uid", async () => {
    const loc = await ls.getBusinessLocation("uid_unknown");
    expect(loc).toBeNull();
  });

  test("LS-3: buildLocationMessage returns address string", () => {
    const loc = { address: "Calle 1 #2-3", city: "Bogota", googleMapsUrl: "https://maps.google.com/..." };
    const msg = ls.buildLocationMessage(loc);
    expect(msg).toContain("Calle 1 #2-3");
    expect(msg).toContain("Bogota");
  });

  test("LS-4: buildMapsLink returns Google Maps URL", () => {
    const url = ls.buildMapsLink(6.2518, -75.5636, "Mi Negocio");
    expect(url).toContain("maps.google.com");
    expect(url).toContain("6.2518");
  });

  test("LS-5: buildMapsLink returns null when no coords", () => {
    expect(ls.buildMapsLink(null, null)).toBeNull();
  });
});

describe("Advanced Booking", () => {
  test("AB-1: CANCEL_POLICIES frozen", () => {
    expect(Object.isFrozen(ab.CANCEL_POLICIES)).toBe(true);
    expect(ab.CANCEL_POLICIES).toContain("free_cancel");
  });

  test("AB-2: createAdvancedBooking creates booking with deposit", async () => {
    const booking = await ab.createAdvancedBooking("uid1", {
      phone: "+573001234567", date: "2026-06-01", service: "Consulta",
      depositAmount: 50000, depositCurrency: "COP",
    });
    expect(booking.status).toBe("pending_deposit");
    expect(booking.depositAmount).toBe(50000);
  });

  test("AB-3: recordDepositPaid confirms booking", async () => {
    const result = await ab.recordDepositPaid("booking-123", "MP-REF-001");
    expect(result.depositPaid).toBe(true);
    expect(result.status).toBe("confirmed");
  });

  test("AB-4: cancelWithPolicy free_cancel gives full refund", async () => {
    const result = await ab.cancelWithPolicy("booking-123", "free_cancel", 48);
    expect(result.status).toBe("cancelled");
  });

  test("AB-5: cancelWithPolicy throws on invalid policy", async () => {
    await expect(ab.cancelWithPolicy("booking-123", "partial_refund", 48)).rejects.toThrow("invalid policy");
  });
});

describe("Smart Scheduler", () => {
  test("SS-1: DARK_HOURS frozen with correct values", () => {
    expect(Object.isFrozen(ss.DARK_HOURS)).toBe(true);
    expect(ss.DARK_HOURS.start).toBe(22);
    expect(ss.DARK_HOURS.end).toBe(7);
  });

  test("SS-2: isDarkHour returns boolean", () => {
    const result = ss.isDarkHour(Date.now());
    expect(typeof result).toBe("boolean");
  });

  test("SS-3: recordOpenTime records hour", async () => {
    const result = await ss.recordOpenTime("uid1", "+573001234567", Date.now());
    expect(result.uid).toBe("uid1");
    expect(result.hour).toBeGreaterThanOrEqual(0);
  });

  test("SS-4: getOptimalHour returns default 10 for no history", async () => {
    const hour = await ss.getOptimalHour("uid1", "+573001234567");
    expect(hour).toBe(10);
  });

  test("SS-5: shouldSendNow returns boolean", () => {
    const result = ss.shouldSendNow(Date.now(), "America/Bogota");
    expect(typeof result).toBe("boolean");
  });
});

describe("Sales Strategy", () => {
  test("SV-1: STRATEGY_SIGNALS frozen", () => {
    expect(Object.isFrozen(sv.STRATEGY_SIGNALS)).toBe(true);
    expect(sv.STRATEGY_SIGNALS.high_intent).toBeDefined();
  });

  test("SV-2: detectStrategyContext detects high intent", () => {
    const msgs = [{ role: "lead", text: "cuanto cuesta y cuando puedo comprarlo?" }];
    const result = sv.detectStrategyContext(msgs);
    expect(result.context).toBe("high_intent");
  });

  test("SV-3: detectStrategyContext returns neutral for generic message", () => {
    const msgs = [{ role: "lead", text: "hola buenos dias" }];
    const result = sv.detectStrategyContext(msgs);
    expect(result.context).toBe("neutral");
  });

  test("SV-4: detectStrategyContext detects objection", () => {
    const msgs = [{ role: "lead", text: "esta muy caro, lo voy a pensar" }];
    const result = sv.detectStrategyContext(msgs);
    expect(result.context).toBe("objection");
  });

  test("SV-5: buildStrategyPrompt returns string for each context", () => {
    for (const ctx of ["high_intent", "objection", "ready_to_close", "neutral", "unknown"]) {
      const prompt = sv.buildStrategyPrompt(ctx, "MIIA Pro");
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(10);
    }
  });

  test("SV-6: detectStrategyContext handles empty messages", () => {
    const result = sv.detectStrategyContext([]);
    expect(result.context).toBe("neutral");
  });
});
