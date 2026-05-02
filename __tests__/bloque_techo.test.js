"use strict";

function makeDoc(data) { return { exists: !!data, data: () => data || {}, id: data && data.id ? data.id : "doc1" }; }
function makeSnap(docs) { const w = docs.map(d => ({ id: d.id || "x", data: () => d })); return { forEach: fn => w.forEach(fn), size: docs.length, empty: !docs.length }; }
function makeCol(docs) { docs = docs || []; const snap = makeSnap(docs); return { doc: id => ({ get: async () => makeDoc(docs.find(d => d.id === id) || null), set: async () => {}, collection: () => makeCol([]) }), where: () => ({ get: async () => snap }), get: async () => snap }; }

const mav = require("../core/mini_app_voice");

describe("mini_app_voice -- T432", () => {
  test("VOICE_TRIGGERS frozen with hola miia trigger", () => {
    expect(Object.isFrozen(mav.VOICE_TRIGGERS)).toBe(true);
    expect(mav.VOICE_TRIGGERS).toContain("hola miia");
  });
  test("APP_MODES frozen with 3 modes", () => {
    expect(Object.isFrozen(mav.APP_MODES)).toBe(true);
    expect(mav.APP_MODES.length).toBe(3);
  });
  test("detectVoiceTrigger -- hola miia detected", () => {
    const r = mav.detectVoiceTrigger("Hola MIIA cual es el stock?");
    expect(r.triggered).toBe(true);
    expect(r.trigger).toBe("hola miia");
    expect(r.command).toBe("cual es el stock?");
  });
  test("detectVoiceTrigger -- unrelated text not triggered", () => {
    const r = mav.detectVoiceTrigger("buenos dias como van las ventas");
    expect(r.triggered).toBe(false);
    expect(r.trigger).toBeNull();
  });
  test("createMobileSession -- hybrid mode creates session", async () => {
    mav.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await mav.createMobileSession("uid1", { mode: "hybrid" });
    expect(r.status).toBe("active");
    expect(r.voiceEnabled).toBe(true);
  });
  test("createMobileSession -- invalid mode throws", async () => {
    mav.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(mav.createMobileSession("uid1", { mode: "telepathy" })).rejects.toThrow("Invalid app mode");
  });
  test("recordVoiceCommand -- saves command with trigger detection", async () => {
    mav.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await mav.recordVoiceCommand("sess1", "Hola MIIA agenda una cita", "OK, agendando cita");
    expect(r.trigger.triggered).toBe(true);
    expect(r.sessionId).toBe("sess1");
  });
  test("endSession -- sets status ended", async () => {
    mav.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await mav.endSession("sess1");
    expect(r.status).toBe("ended");
  });
});

const mve = require("../core/miia_voice_engine");

describe("miia_voice_engine -- T433", () => {
  test("MIIA_VOICE_ACCENTS frozen with 6 countries", () => {
    expect(Object.isFrozen(mve.MIIA_VOICE_ACCENTS)).toBe(true);
    expect(Object.keys(mve.MIIA_VOICE_ACCENTS).length).toBe(6);
    expect(mve.MIIA_VOICE_ACCENTS.CO).toBeDefined();
    expect(mve.MIIA_VOICE_ACCENTS.BR).toBeDefined();
  });
  test("getVoiceForCountry -- known country returns accent", () => {
    const r = mve.getVoiceForCountry("CO");
    expect(r.countryCode).toBe("CO");
    expect(r.voiceId).toBe("miia-co-v1");
  });
  test("getVoiceForCountry -- unknown country returns default", () => {
    const r = mve.getVoiceForCountry("XX");
    expect(r.voiceId).toBe("miia-latam-default");
  });
  test("listAvailableAccents -- returns 6 accents", () => {
    const r = mve.listAvailableAccents();
    expect(r.length).toBe(6);
    expect(r[0].countryCode).toBeDefined();
  });
  test("registerCustomVoice -- creates voice in training status", async () => {
    mve.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await mve.registerCustomVoice("uid1", { countryCode: "CO", voiceId: "custom-v1" });
    expect(r.status).toBe("training");
    expect(r.uid).toBe("uid1");
  });
  test("buildVoiceSynthRequest -- builds synth request with voice config", async () => {
    const r = await mve.buildVoiceSynthRequest("uid1", "Hola que tal", "MX");
    expect(r.voiceId).toBe("miia-mx-v1");
    expect(r.provider).toBe("miia_voice_engine");
    expect(r.format).toBe("mp3");
  });
});

const smm = require("../core/social_media_manager");

describe("social_media_manager -- T434", () => {
  test("SOCIAL_PLATFORMS frozen with 5 platforms", () => {
    expect(Object.isFrozen(smm.SOCIAL_PLATFORMS)).toBe(true);
    expect(smm.SOCIAL_PLATFORMS.length).toBe(5);
    expect(smm.SOCIAL_PLATFORMS).toContain("instagram");
    expect(smm.SOCIAL_PLATFORMS).toContain("tiktok");
  });
  test("registerSocialAccount -- invalid platform throws", async () => {
    smm.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(smm.registerSocialAccount("uid1", "snapchat", {})).rejects.toThrow("Unsupported platform");
  });
  test("registerSocialAccount -- valid platform creates account", async () => {
    smm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await smm.registerSocialAccount("uid1", "instagram", { pageId: "p1" });
    expect(r.platform).toBe("instagram");
    expect(r.status).toBe("active");
  });
  test("receiveDM -- creates DM with received status", async () => {
    smm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await smm.receiveDM("uid1", "instagram", { senderId: "sender1", message: "Hola" });
    expect(r.status).toBe("received");
    expect(r.platform).toBe("instagram");
  });
  test("replyToDM -- sets status replied", async () => {
    smm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await smm.replyToDM("uid1", "dm1", "Gracias por escribir!");
    expect(r.status).toBe("replied");
    expect(r.reply).toBe("Gracias por escribir!");
  });
  test("schedulePost -- invalid platform throws", async () => {
    smm.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(smm.schedulePost("uid1", "myspace", {})).rejects.toThrow("Unsupported platform");
  });
  test("schedulePost -- creates scheduled post", async () => {
    smm.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await smm.schedulePost("uid1", "instagram", { content: "Post de prueba", scheduledAt: "2026-06-01T10:00:00Z" });
    expect(r.status).toBe("scheduled");
    expect(r.platform).toBe("instagram");
  });
});

const sd = require("../core/smart_domotics");

describe("smart_domotics -- T435", () => {
  test("IOT_DEVICE_TYPES frozen with 7 types", () => {
    expect(Object.isFrozen(sd.IOT_DEVICE_TYPES)).toBe(true);
    expect(sd.IOT_DEVICE_TYPES.length).toBe(7);
    expect(sd.IOT_DEVICE_TYPES).toContain("thermostat");
  });
  test("SCHEDULE_ACTIONS frozen with 6 actions", () => {
    expect(Object.isFrozen(sd.SCHEDULE_ACTIONS)).toBe(true);
    expect(sd.SCHEDULE_ACTIONS.length).toBe(6);
    expect(sd.SCHEDULE_ACTIONS).toContain("alarm_on");
  });
  test("registerDevice -- invalid type throws", async () => {
    sd.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(sd.registerDevice("uid1", { type: "drone" })).rejects.toThrow("Invalid device type");
  });
  test("registerDevice -- valid type creates device", async () => {
    sd.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await sd.registerDevice("uid1", { name: "Luz entrada", type: "light", deviceId: "dev1" });
    expect(r.type).toBe("light");
    expect(r.status).toBe("online");
  });
  test("scheduleBusinessHours -- missing openTime throws", async () => {
    sd.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(sd.scheduleBusinessHours("uid1", { closeTime: "18:00" })).rejects.toThrow("openTime and closeTime required");
  });
  test("scheduleBusinessHours -- creates schedule with defaults", async () => {
    sd.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await sd.scheduleBusinessHours("uid1", { openTime: "09:00", closeTime: "18:00" });
    expect(r.timezone).toBe("America/Bogota");
    expect(r.daysOfWeek).toEqual([1,2,3,4,5]);
    expect(r.status).toBe("active");
  });
  test("buildAutoScheduleMessage -- generates message string", () => {
    const schedule = { openTime: "09:00", closeTime: "18:00", timezone: "America/Bogota", daysOfWeek: [1,2,3,4,5] };
    const r = sd.buildAutoScheduleMessage(schedule);
    expect(r).toContain("09:00");
    expect(r).toContain("18:00");
    expect(r).toContain("America/Bogota");
  });
  test("sendDeviceCommand -- creates command record", async () => {
    sd.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await sd.sendDeviceCommand("uid1", "dev1", "turn_on", { brightness: 80 });
    expect(r.command).toBe("turn_on");
    expect(r.status).toBe("sent");
  });
});

const mo = require("../core/miia_os");

describe("miia_os -- T436b (MIIA OS vision)", () => {
  test("DISPLAY_MODES frozen with 4 modes", () => {
    expect(Object.isFrozen(mo.DISPLAY_MODES)).toBe(true);
    expect(mo.DISPLAY_MODES.length).toBe(4);
    expect(mo.DISPLAY_MODES).toContain("kiosk_pos");
  });
  test("VISION_MILESTONES frozen with 5 milestones to 1M", () => {
    expect(Object.isFrozen(mo.VISION_MILESTONES)).toBe(true);
    expect(mo.VISION_MILESTONES.length).toBe(5);
    expect(mo.VISION_MILESTONES[4].target).toBe(1000000);
  });
  test("getVisionProgress -- 0 businesses is 0% to M1", () => {
    const r = mo.getVisionProgress(0);
    expect(r.completedMilestones).toBe(0);
    expect(r.nextMilestone.id).toBe("M1");
    expect(r.visionComplete).toBe(false);
  });
  test("getVisionProgress -- 1M businesses completes vision", () => {
    const r = mo.getVisionProgress(1000000);
    expect(r.visionComplete).toBe(true);
    expect(r.completedMilestones).toBe(5);
  });
  test("getMIIAOSSummary -- returns vision 2028 summary", () => {
    const r = mo.getMIIAOSSummary();
    expect(r.targetYear).toBe(2028);
    expect(r.targetBusinesses).toBe(1000000);
    expect(r.pillars).toContain("whatsapp_first");
  });
  test("createTVDisplay -- invalid mode throws", async () => {
    mo.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(mo.createTVDisplay("uid1", { mode: "vhs" })).rejects.toThrow("Invalid display mode");
  });
  test("createTVDisplay -- valid mode creates display", async () => {
    mo.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await mo.createTVDisplay("uid1", { mode: "tv_status" });
    expect(r.mode).toBe("tv_status");
    expect(r.refreshIntervalSeconds).toBe(30);
  });
});

const vk = require("../core/vision_kitchen");

describe("vision_kitchen -- T436", () => {
  test("RECIPE_CATEGORIES frozen with 6 categories", () => {
    expect(Object.isFrozen(vk.RECIPE_CATEGORIES)).toBe(true);
    expect(vk.RECIPE_CATEGORIES.length).toBe(6);
    expect(vk.RECIPE_CATEGORIES).toContain("almuerzo");
  });
  test("VISION_CONFIDENCE_THRESHOLD is 0.7", () => {
    expect(vk.VISION_CONFIDENCE_THRESHOLD).toBe(0.7);
  });
  test("parseIngredientsFromVision -- high confidence labels extracted", () => {
    const labels = [{ label: "Tomato", confidence: 0.9 }, { label: "Cheese", confidence: 0.85 }, { label: "blur", confidence: 0.3 }];
    const r = vk.parseIngredientsFromVision(labels);
    expect(r.ingredients).toContain("tomato");
    expect(r.ingredients).toContain("cheese");
    expect(r.ingredients).not.toContain("blur");
    expect(r.count).toBe(2);
  });
  test("parseIngredientsFromVision -- empty labels returns empty", () => {
    const r = vk.parseIngredientsFromVision([]);
    expect(r.count).toBe(0);
    expect(r.highConfidence).toBe(false);
  });
  test("saveRecipe -- no name throws", async () => {
    vk.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(vk.saveRecipe("uid1", { category: "almuerzo" })).rejects.toThrow("name required");
  });
  test("saveRecipe -- invalid category throws", async () => {
    vk.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(vk.saveRecipe("uid1", { name: "Pizza", category: "merienda" })).rejects.toThrow("Invalid category");
  });
  test("saveRecipe -- valid recipe saved", async () => {
    vk.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await vk.saveRecipe("uid1", { name: "Arroz con pollo", category: "almuerzo", ingredients: ["arroz", "pollo"] });
    expect(r.name).toBe("Arroz con pollo");
    expect(r.category).toBe("almuerzo");
  });
  test("suggestRecipes -- invalid category throws", async () => {
    vk.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(vk.suggestRecipes("uid1", ["tomato"], "merienda")).rejects.toThrow("Invalid category");
  });
  test("suggestRecipes -- returns matching recipes sorted by score", async () => {
    const recipes = [
      { id: "r1", category: "almuerzo", ingredients: ["arroz", "pollo", "zanahoria"] },
      { id: "r2", category: "almuerzo", ingredients: ["arroz", "frijoles"] },
      { id: "r3", category: "cena", ingredients: ["pasta", "queso"] },
    ];
    vk.__setFirestoreForTests({ collection: () => makeCol(recipes) });
    const r = await vk.suggestRecipes("uid1", ["arroz", "pollo"], "almuerzo");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].matchScore).toBeGreaterThan(0);
  });
});

const bb = require("../core/brasil_beta");

describe("brasil_beta -- T437", () => {
  test("BRASIL_REGIONS frozen with 10 regions", () => {
    expect(Object.isFrozen(bb.BRASIL_REGIONS)).toBe(true);
    expect(bb.BRASIL_REGIONS.length).toBe(10);
    expect(bb.BRASIL_REGIONS).toContain("SP");
    expect(bb.BRASIL_REGIONS).toContain("RJ");
  });
  test("BETA_MAX_TESTERS is 100", () => {
    expect(bb.BETA_MAX_TESTERS).toBe(100);
  });
  test("buildBrasilWelcome -- generates pt-BR welcome", () => {
    const r = bb.buildBrasilWelcome("Joao", "SP");
    expect(r).toContain("Ola");
    expect(r).toContain("Joao");
    expect(r).toContain("SP");
  });
  test("buildBrasilWelcome -- unknown region defaults to BR", () => {
    const r = bb.buildBrasilWelcome("Maria", "ZZ");
    expect(r).toContain("BR");
  });
  test("registerBetaTester -- no phone throws", async () => {
    bb.__setFirestoreForTests({ collection: () => makeCol([]) });
    await expect(bb.registerBetaTester({ businessName: "Padaria" })).rejects.toThrow("Phone required");
  });
  test("registerBetaTester -- creates applicant", async () => {
    bb.__setFirestoreForTests({ collection: () => ({ doc: () => ({ set: async () => {} }) }) });
    const r = await bb.registerBetaTester({ phone: "+5511999888777", businessName: "Padaria SP", region: "SP" });
    expect(r.status).toBe("applicant");
    expect(r.language).toBe("pt-BR");
    expect(r.region).toBe("SP");
  });
  test("approveBetaTester -- tester not found throws", async () => {
    bb.__setFirestoreForTests({ collection: () => ({ doc: () => ({ get: async () => makeDoc(null) }) }) });
    await expect(bb.approveBetaTester("t_none")).rejects.toThrow("Tester not found");
  });
  test("approveBetaTester -- beta full throws", async () => {
    const tester = { id: "t1", status: "applicant" };
    const activeTesters = Array.from({ length: 100 }, (_, i) => ({ id: "a" + i, status: "active" }));
    const db = {
      collection: name => {
        if (name === "brasil_beta") return { doc: () => ({ get: async () => makeDoc(tester), set: async () => {} }), where: () => ({ get: async () => makeSnap(activeTesters) }) };
        return makeCol([]);
      }
    };
    bb.__setFirestoreForTests(db);
    await expect(bb.approveBetaTester("t1")).rejects.toThrow("Beta program full");
  });
  test("getBetaStats -- counts by status", async () => {
    const testers = [{ id: "t1", status: "active" }, { id: "t2", status: "applicant" }, { id: "t3", status: "active" }];
    bb.__setFirestoreForTests({ collection: () => makeCol(testers) });
    const r = await bb.getBetaStats();
    expect(r.total).toBe(3);
    expect(r.byStatus.active).toBe(2);
    expect(r.byStatus.applicant).toBe(1);
    expect(r.maxTesters).toBe(100);
  });
});
