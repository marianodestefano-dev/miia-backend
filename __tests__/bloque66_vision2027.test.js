"use strict";

const vs = require("../core/voice_selection");
const vm = require("../core/voice_multilang");
const lc = require("../core/latam_config");
const sh = require("../core/smarthome_integration");
const ww = require("../core/web_widget");
const sl = require("../core/social_listening");
const mc = require("../core/multichannel");

function makeDoc(data) {
  return { exists: !!data, data: () => data || {}, id: (data && data.id) || "doc1" };
}
function makeCol(docs) {
  const arr = (docs || []).map(d => makeDoc(d));
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: (n) => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
  return {
    doc: (id) => ({
      get: async () => makeDoc((docs || []).find(d => d && d.id === id) || null),
      set: async () => {},
      update: async () => {},
    }),
    where: () => q,
    orderBy: () => q,
    get: async () => ({ docs: arr, empty: arr.length === 0, forEach: (fn) => arr.forEach(fn) }),
  };
}

let _db;
beforeEach(() => {
  _db = { collection: () => makeCol([]) };
  vs.__setFirestoreForTests(_db);
  sh.__setFirestoreForTests(_db);
  ww.__setFirestoreForTests(_db);
  sl.__setFirestoreForTests(_db);
  mc.__setFirestoreForTests(_db);
});

describe("Voice Selection", () => {
  test("VS-1: AVAILABLE_VOICES frozen with 9+ voices", () => {
    expect(Object.isFrozen(vs.AVAILABLE_VOICES)).toBe(true);
    expect(vs.AVAILABLE_VOICES.length).toBeGreaterThanOrEqual(9);
  });

  test("VS-2: listVoices returns all voices without filter", () => {
    const voices = vs.listVoices();
    expect(voices.length).toBe(vs.AVAILABLE_VOICES.length);
  });

  test("VS-3: listVoices filters by language", () => {
    const esVoices = vs.listVoices("es");
    expect(esVoices.length).toBeGreaterThan(0);
    esVoices.forEach(v => expect(v.lang).toBe("es"));
  });

  test("VS-4: setVoice throws on invalid voiceId", async () => {
    await expect(vs.setVoice("uid1", "invalid_voice_xyz")).rejects.toThrow("invalid voiceId");
  });

  test("VS-5: setVoice updates owner record", async () => {
    const validId = vs.AVAILABLE_VOICES[0].id;
    const result = await vs.setVoice("uid1", validId);
    expect(result.uid).toBe("uid1");
    expect(result.voice.id).toBe(validId);
  });

  test("VS-6: getVoice returns default voice for unknown uid", async () => {
    const voice = await vs.getVoice("uid_unknown");
    expect(voice).not.toBeNull();
    expect(voice.id).toBe(vs.AVAILABLE_VOICES[0].id);
  });
});

describe("Voice Multilang", () => {
  test("VM-1: LANGUAGE_PATTERNS and VOICE_BY_LANG frozen", () => {
    expect(Object.isFrozen(vm.LANGUAGE_PATTERNS)).toBe(true);
    expect(Object.isFrozen(vm.VOICE_BY_LANG)).toBe(true);
  });

  test("VM-2: detectLanguage returns es by default", () => {
    expect(vm.detectLanguage("Hola como estas")).toBe("es");
    expect(vm.detectLanguage("")).toBe("es");
    expect(vm.detectLanguage(null)).toBe("es");
  });

  test("VM-3: detectLanguage detects English", () => {
    expect(vm.detectLanguage("thank you very much")).toBe("en");
  });

  test("VM-4: detectLanguage detects Portuguese", () => {
    expect(vm.detectLanguage("obrigado por favor")).toBe("pt");
  });

  test("VM-5: selectVoice returns lang and voiceId", () => {
    const result = vm.selectVoice("thank you hello", null);
    expect(result.lang).toBe("en");
    expect(result.voiceId).toBeDefined();
  });

  test("VM-6: selectVoice uses ownerVoiceId when provided", () => {
    const result = vm.selectVoice("hola", "custom_voice_id");
    expect(result.voiceId).toBe("custom_voice_id");
  });
});

describe("LATAM Config", () => {
  test("LC-1: LATAM_CONFIGS frozen with 6 countries", () => {
    expect(Object.isFrozen(lc.LATAM_CONFIGS)).toBe(true);
    expect(Object.keys(lc.LATAM_CONFIGS).length).toBeGreaterThanOrEqual(6);
  });

  test("LC-2: getConfig returns Colombia config", () => {
    const cfg = lc.getConfig("CO");
    expect(cfg).not.toBeNull();
    expect(cfg.currency).toBe("COP");
    expect(cfg.phone_prefix).toBe("+57");
  });

  test("LC-3: getConfig returns Brasil config", () => {
    const cfg = lc.getConfig("BR");
    expect(cfg.locale).toBe("pt-BR");
    expect(cfg.currency).toBe("BRL");
  });

  test("LC-4: getConfig returns null for unknown country", () => {
    expect(lc.getConfig("XX")).toBeNull();
  });

  test("LC-5: formatCurrency formats amount with symbol", () => {
    const result = lc.formatCurrency(50000, "CO");
    expect(result).toContain("$");
  });

  test("LC-6: detectCountryFromPhone detects Colombia", () => {
    expect(lc.detectCountryFromPhone("+573054169969")).toBe("CO");
  });

  test("LC-7: detectCountryFromPhone detects Brasil", () => {
    expect(lc.detectCountryFromPhone("+5511999999999")).toBe("BR");
  });
});

describe("SmartHome Integration", () => {
  test("SH-1: SMARTHOME_PROVIDERS frozen", () => {
    expect(Object.isFrozen(sh.SMARTHOME_PROVIDERS)).toBe(true);
    expect(sh.SMARTHOME_PROVIDERS).toContain("alexa");
    expect(sh.SMARTHOME_PROVIDERS).toContain("google_home");
  });

  test("SH-2: registerSmartHomeWebhook creates config", async () => {
    const result = await sh.registerSmartHomeWebhook("uid1", {
      provider: "alexa",
      webhookUrl: "https://example.com/hook",
    });
    expect(result.provider).toBe("alexa");
    expect(result.active).toBe(true);
    expect(result.id).toBeDefined();
  });

  test("SH-3: registerSmartHomeWebhook throws on invalid provider", async () => {
    await expect(sh.registerSmartHomeWebhook("uid1", {
      provider: "siri_fake",
      webhookUrl: "https://example.com/hook",
    })).rejects.toThrow("invalid provider");
  });

  test("SH-4: processSmartHomeCommand logs command", async () => {
    const result = await sh.processSmartHomeCommand("uid1", "turn_on_lights", { room: "living" });
    expect(result.processed).toBe(true);
    expect(result.command).toBe("turn_on_lights");
  });
});

describe("Web Widget", () => {
  test("WW-1: generateWidgetSnippet returns HTML string", () => {
    const snippet = ww.generateWidgetSnippet("uid1");
    expect(typeof snippet).toBe("string");
    expect(snippet).toContain("miia-widget");
    expect(snippet).toContain("uid1");
  });

  test("WW-2: generateWidgetSnippet uses custom color", () => {
    const snippet = ww.generateWidgetSnippet("uid1", { color: "#FF0000" });
    expect(snippet).toContain("#FF0000");
  });

  test("WW-3: createWidgetConfig stores config and returns snippet", async () => {
    const result = await ww.createWidgetConfig("uid1", { color: "#25D366" });
    expect(result.uid).toBe("uid1");
    expect(result.snippet).toBeDefined();
    expect(result.active).toBe(true);
  });
});

describe("Social Listening", () => {
  test("SL-1: SOCIAL_PLATFORMS frozen", () => {
    expect(Object.isFrozen(sl.SOCIAL_PLATFORMS)).toBe(true);
    expect(sl.SOCIAL_PLATFORMS).toContain("twitter");
    expect(sl.SOCIAL_PLATFORMS).toContain("instagram");
  });

  test("SL-2: registerMentionWebhook creates config", async () => {
    const result = await sl.registerMentionWebhook("uid1", {
      platform: "twitter",
      webhookUrl: "https://example.com/mention",
      keywords: ["miia", "chatbot"],
    });
    expect(result.platform).toBe("twitter");
    expect(result.active).toBe(true);
    expect(result.keywords).toContain("miia");
  });

  test("SL-3: registerMentionWebhook throws on invalid platform", async () => {
    await expect(sl.registerMentionWebhook("uid1", {
      platform: "snapchat_fake",
      webhookUrl: "https://example.com/hook",
    })).rejects.toThrow("invalid platform");
  });

  test("SL-4: processMention stores mention record", async () => {
    const mention = { platform: "instagram", author: "user123", text: "MIIA es genial!", sentiment: "positive" };
    const result = await sl.processMention("uid1", mention);
    expect(result.uid).toBe("uid1");
    expect(result.platform).toBe("instagram");
    expect(result.sentiment).toBe("positive");
  });

  test("SL-5: getMentionStats returns stats object", async () => {
    const stats = await sl.getMentionStats("uid1");
    expect(stats).toHaveProperty("total");
    expect(stats).toHaveProperty("byPlatform");
    expect(stats).toHaveProperty("bySentiment");
  });
});

describe("Multichannel", () => {
  test("MC-1: SUPPORTED_CHANNELS frozen", () => {
    expect(Object.isFrozen(mc.SUPPORTED_CHANNELS)).toBe(true);
    expect(mc.SUPPORTED_CHANNELS).toContain("whatsapp");
    expect(mc.SUPPORTED_CHANNELS).toContain("telegram");
    expect(mc.SUPPORTED_CHANNELS).toContain("web_widget");
  });

  test("MC-2: registerChannel creates config", async () => {
    const result = await mc.registerChannel("uid1", "telegram", { botToken: "abc123" });
    expect(result.channel).toBe("telegram");
    expect(result.active).toBe(true);
  });

  test("MC-3: registerChannel throws on invalid channel", async () => {
    await expect(mc.registerChannel("uid1", "pigeon_post")).rejects.toThrow("invalid channel");
  });

  test("MC-4: routeMessage stores routed record", async () => {
    const result = await mc.routeMessage("uid1", "hola!", "whatsapp");
    expect(result.status).toBe("routed");
    expect(result.sourceChannel).toBe("whatsapp");
  });

  test("MC-5: disableChannel marks channel inactive", async () => {
    const result = await mc.disableChannel("uid1", "telegram");
    expect(result.active).toBe(false);
  });

  test("MC-6: getActiveChannels returns channels list", async () => {
    const channels = await mc.getActiveChannels("uid1");
    expect(Array.isArray(channels)).toBe(true);
  });
});
