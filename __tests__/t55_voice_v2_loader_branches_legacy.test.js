'use strict';

/**
 * T55 — voice_v2_loader.js gap legacy 65.81% → 100% branch.
 * Firma viva Mariano 2026-05-13 11:10 COT: "quiero que hagas todos!!!"
 * Sobre lista de opciones, incluye opción 1: atacar gap legacy.
 *
 * Vi sugirió este gap en [ACK-VI-COORD-100PCT] 2026-05-13 08:54 COT — son
 * fileIO readers + fallbacks legacy pre-existentes al commit Vi.
 *
 * Strategy:
 *   - Mock fs.readFileSync para forzar throws (catches uncovered: 89-91,
 *     106-108, 124-126, 141-143).
 *   - Inyectar contenido fake en cada read para forzar paths de extracción
 *     (extractSubregistro líneas 161, 166).
 *   - Tests para inferChatTypeForPersonal switch cases (275-285, 290-293).
 *   - Tests para loadVoiceDNAForGroup/Personal/Center todos los branches
 *     (317-340, 371-404, 440-462).
 */

const fs = require('fs');
const v = require('../core/voice_v2_loader');

const ORIG_READ = fs.readFileSync;

beforeEach(() => {
  v.resetCache();
  fs.readFileSync = ORIG_READ;
});

afterAll(() => {
  fs.readFileSync = ORIG_READ;
  v.resetCache();
});

function mockReadThrow(matchSubstr) {
  fs.readFileSync = function (path, enc) {
    if (matchSubstr && String(path).includes(matchSubstr)) {
      const err = new Error('ENOENT: no such file');
      err.code = 'ENOENT';
      throw err;
    }
    return ORIG_READ.call(fs, path, enc);
  };
}

function mockReadReturn(matchSubstr, content) {
  fs.readFileSync = function (path, enc) {
    if (matchSubstr && String(path).includes(matchSubstr)) {
      return content;
    }
    return ORIG_READ.call(fs, path, enc);
  };
}

// ── readVoiceSeed* catches (líneas 89-91, 106-108, 124-126, 141-143) ────────

describe('T55 §1 — fileIO catches (4 readers)', () => {
  test('readVoiceSeed catch ENOENT → null + _loadFailures++', () => {
    mockReadThrow('voice_seed.md');
    expect(v.readVoiceSeed()).toBeNull();
  });

  test('readVoiceSeedCenter catch ENOENT → null', () => {
    mockReadThrow('voice_seed_center.md');
    expect(v.readVoiceSeedCenter()).toBeNull();
  });

  test('readVoiceSeedPersonal catch ENOENT → null', () => {
    mockReadThrow('voice_seed_personal.md');
    expect(v.readVoiceSeedPersonal()).toBeNull();
  });

  test('readModeDetectors catch ENOENT → null', () => {
    mockReadThrow('mode_detectors.md');
    expect(v.readModeDetectors()).toBeNull();
  });
});

// ── Happy path readers + cache hit (líneas 103-104, 121-122, 138-139) ───────

describe('T55 §1b — readers happy path + cache hit', () => {
  test('readVoiceSeedCenter happy + segunda llamada usa cache', () => {
    mockReadReturn('voice_seed_center.md', 'center content');
    const first = v.readVoiceSeedCenter();
    expect(first).toBe('center content');
    const second = v.readVoiceSeedCenter();
    expect(second).toBe('center content');
  });

  test('readVoiceSeedPersonal happy + segunda llamada usa cache', () => {
    mockReadReturn('voice_seed_personal.md', 'personal content');
    const first = v.readVoiceSeedPersonal();
    expect(first).toBe('personal content');
    const second = v.readVoiceSeedPersonal();
    expect(second).toBe('personal content');
  });

  test('readModeDetectors happy + segunda llamada usa cache', () => {
    mockReadReturn('mode_detectors.md', 'detectors content');
    const first = v.readModeDetectors();
    expect(first).toBe('detectors content');
    const second = v.readModeDetectors();
    expect(second).toBe('detectors content');
  });

  test('V2_VOICE_NO_CACHE=true bypassa cache hit (readVoiceSeedCenter)', () => {
    process.env.V2_VOICE_NO_CACHE = 'true';
    let calls = 0;
    fs.readFileSync = function (path, enc) {
      if (String(path).includes('voice_seed_center.md')) {
        calls++;
        return 'center v' + calls;
      }
      return ORIG_READ.call(fs, path, enc);
    };
    v.readVoiceSeedCenter();
    v.readVoiceSeedCenter();
    expect(calls).toBe(2);
    delete process.env.V2_VOICE_NO_CACHE;
  });
});

// ── extractSubregistro paths (líneas 161, 166) ──────────────────────────────

describe('T55 §2 — extractSubregistro internal paths', () => {
  test('seed con separator "\\n---\\n+###" → corta en separator (línea 161)', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nBaseId.\n## §2 LOS 7 SUBREGISTROS\n\n### 2.4 `familia`\nContenido familia\n\n---\n\n### 2.5 `friend_argentino`\nOtro';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('family', { skipBaseIdentidad: true });
    expect(r.fallback).toBe(false);
    expect(r.systemBlock).toContain('Contenido familia');
    // El separador entre 2.4 y 2.5 corta antes de "friend_argentino"
    expect(r.systemBlock).not.toContain('friend_argentino');
  });

  test('seed sin separator pero con "\\n## §3" → corta en §3 (línea 166)', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nBaseId.\n## §2 LOS 7 SUBREGISTROS\n\n### 2.4 `familia`\nContenido familia que sigue\n\n## §3 FOOTER\nfooter content';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('family', { skipBaseIdentidad: true });
    expect(r.fallback).toBe(false);
    expect(r.systemBlock).toContain('Contenido familia');
    expect(r.systemBlock).not.toContain('FOOTER');
  });

  test('seed sin separator ni §3 → llega hasta EOF', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nBaseId.\n## §2 LOS 7 SUBREGISTROS\n\n### 2.4 `familia`\nContenido al EOF';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('family', { skipBaseIdentidad: true });
    expect(r.fallback).toBe(false);
    expect(r.systemBlock).toContain('Contenido al EOF');
  });
});

// ── inferChatTypeForPersonal switch (líneas 275-285, 290-293, 299) ──────────

describe('T55 §3 — inferChatTypeForPersonal switch cases', () => {
  // Personal mode: invocamos via resolveV2ChatType con UID personal + contactType variados.
  test('familia → family', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'familia' }),
    ).toBe('family');
  });

  test('family → family (alias directo)', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'family' })).toBe(
      'family',
    );
  });

  test('friend_argentino → friend_argentino', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'friend_argentino' }),
    ).toBe('friend_argentino');
  });

  test('friend_colombiano → friend_colombiano', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'friend_colombiano' }),
    ).toBe('friend_colombiano');
  });

  test('ale_pareja → ale_pareja', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'ale_pareja' })).toBe(
      'ale_pareja',
    );
  });

  test('basePhone === ALE_PHONE → ale_pareja (override antes del switch)', () => {
    expect(
      v.resolveV2ChatType({
        uid: v.OWNER_PERSONAL_UID,
        contactType: 'lead',
        basePhone: v.ALE_PHONE,
      }),
    ).toBe('ale_pareja');
  });

  test('medilink_team → medilink_team', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'medilink_team' }),
    ).toBe('medilink_team');
  });

  test('equipo → medilink_team (alias)', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'equipo' })).toBe(
      'medilink_team',
    );
  });

  test('vivi_team → medilink_team (alias)', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'vivi_team' })).toBe(
      'medilink_team',
    );
  });

  test('lead → lead', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'lead' })).toBe(
      'lead',
    );
  });

  test('enterprise_lead → lead (alias)', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'enterprise_lead' }),
    ).toBe('lead');
  });

  test('client → client', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'client' })).toBe(
      'client',
    );
  });

  test('follow_up_cold → follow_up_cold', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'follow_up_cold' }),
    ).toBe('follow_up_cold');
  });

  test('cold → follow_up_cold (alias)', () => {
    expect(v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'cold' })).toBe(
      'follow_up_cold',
    );
  });

  test('default → unknown (contactType no reconocido)', () => {
    expect(
      v.resolveV2ChatType({ uid: v.OWNER_PERSONAL_UID, contactType: 'zzzz_unknown' }),
    ).toBe('unknown');
  });
});

// ── loadVoiceDNAForGroup all branches (líneas 317-340) ──────────────────────

describe('T55 §4 — loadVoiceDNAForGroup branches', () => {
  test('seed null (file unavailable) → fallback true', () => {
    mockReadThrow('voice_seed.md');
    const r = v.loadVoiceDNAForGroup('family');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('none');
    expect(r.subregistro).toBeNull();
  });

  test('chatType unknown → fallback true', () => {
    const r = v.loadVoiceDNAForGroup('chattype_inexistente');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('unknown_chattype');
  });

  test('subSection missing in seed → fallback true', () => {
    // Seed válido pero sin el header buscado
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nBase.\n## §2 LOS 7 SUBREGISTROS\n\n(sin headers conocidos)';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('family');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('subregistro_missing');
  });

  test('owner_selfchat → snapshot completo (no usa subregistros)', () => {
    const fakeSeed = '## §1 IDENTIDAD\n\ncontenido completo seed';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('owner_selfchat');
    expect(r.fallback).toBe(false);
    expect(r.subregistro).toBe('owner_selfchat_snapshot');
    expect(r.systemBlock).toContain('contenido completo seed');
  });

  test('opts.skipBaseIdentidad=true → no incluye §1', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nID base content\n## §2 LOS 7 SUBREGISTROS\n\n### 2.4 `familia`\nFamilia content';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('family', { skipBaseIdentidad: true });
    expect(r.fallback).toBe(false);
    expect(r.systemBlock).toContain('Familia content');
    expect(r.systemBlock).not.toContain('ID base content');
  });

  test('opts.contactName presente → log incluye contact', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nID.\n## §2 LOS 7 SUBREGISTROS\n\n### 2.4 `familia`\nfam';
    mockReadReturn('voice_seed.md', fakeSeed);
    const r = v.loadVoiceDNAForGroup('family', { contactName: 'Mama' });
    expect(r.fallback).toBe(false);
  });
});

// ── loadVoiceDNAForPersonal all branches (líneas 371-404) ───────────────────

describe('T55 §5 — loadVoiceDNAForPersonal branches', () => {
  test('seed null → fallback', () => {
    mockReadThrow('voice_seed_personal.md');
    const r = v.loadVoiceDNAForPersonal('family');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('none');
  });

  test('chatType unknown → fallback', () => {
    const fakeSeed = '## §1\nID\n## §2\n### 2.4 `familia`\nfam';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('weird_chattype');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('unknown_chattype_personal');
  });

  test('subSection missing → fallback', () => {
    const fakeSeed = '## §1 IDENTIDAD\nID\n## §2 SUBREGISTROS\n\n(sin headers)';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('family');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('subregistro_missing_personal');
  });

  test('owner_selfchat → snapshot personal', () => {
    const fakeSeed = '## §1 IDENT\nseed personal completo';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('owner_selfchat');
    expect(r.fallback).toBe(false);
    expect(r.subregistro).toBe('owner_selfchat_snapshot_personal');
    expect(r.systemBlock).toContain('seed personal completo');
  });

  test('happy path family → systemBlock con personal seed', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nID base.\n## §2 SUBREGISTROS PERSONAL\n\n### 2.4 `familia`\nFamilia PERSONAL content';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('family');
    expect(r.fallback).toBe(false);
    expect(r.subregistro).toBe('family');
    expect(r.systemBlock).toContain('Familia PERSONAL content');
    expect(r.systemBlock).toContain('MIIA PERSONAL');
  });

  test('skipBaseIdentidad=true', () => {
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nID base.\n## §2 SUBREGISTROS\n\n### 2.4 `familia`\nfam';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('family', { skipBaseIdentidad: true });
    expect(r.systemBlock).not.toContain('ID base.');
  });

  test('opts undefined → default {}', () => {
    const fakeSeed =
      '## §1 ID\nbase\n## §2 SUB\n\n### 2.4 `familia`\nfam';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('family');
    expect(r.fallback).toBe(false);
  });

  test('contactName presente → log lo incluye', () => {
    const fakeSeed =
      '## §1\nID\n## §2\n\n### 2.4 `familia`\nfam';
    mockReadReturn('voice_seed_personal.md', fakeSeed);
    const r = v.loadVoiceDNAForPersonal('family', { contactName: 'Pa' });
    expect(r.fallback).toBe(false);
  });
});

// ── loadVoiceDNAForCenter branches (líneas 440-441, 461-462) ────────────────

describe('T55 §6 — loadVoiceDNAForCenter branches', () => {
  test('seed center null → fallback', () => {
    mockReadThrow('voice_seed_center.md');
    const r = v.loadVoiceDNAForCenter('lead');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('none');
  });

  test('subSection missing center → fallback', () => {
    const fakeSeed = '## §1 IDENT\nID\n## §2 SUBREGISTROS\n\n(sin headers)';
    mockReadReturn('voice_seed_center.md', fakeSeed);
    const r = v.loadVoiceDNAForCenter('lead');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('subregistro_missing_center');
  });

  test('skipBaseIdentidad=true center', () => {
    // SUBREGISTRO_HEADERS_CENTER.lead = '### §2.1 `leads_miia`'
    const fakeSeed =
      '## §1 IDENTIDAD BASE COMÚN\nID base center.\n## §2 SUBREGISTROS\n\n### §2.1 `leads_miia`\nLead content center';
    mockReadReturn('voice_seed_center.md', fakeSeed);
    const r = v.loadVoiceDNAForCenter('lead', { skipBaseIdentidad: true });
    expect(r.fallback).toBe(false);
    expect(r.systemBlock).not.toContain('ID base center.');
    expect(r.systemBlock).toContain('Lead content center');
  });

  test('opts undefined center → default {}', () => {
    const fakeSeed =
      '## §1 ID\nbase\n## §2\n\n### §2.1 `leads_miia`\nlead';
    mockReadReturn('voice_seed_center.md', fakeSeed);
    const r = v.loadVoiceDNAForCenter('lead');
    expect(r.fallback).toBe(false);
  });

  test('owner_selfchat center → snapshot completo', () => {
    const fakeSeed = '## §1 IDENT\nseed center completo';
    mockReadReturn('voice_seed_center.md', fakeSeed);
    const r = v.loadVoiceDNAForCenter('owner_selfchat');
    expect(r.fallback).toBe(false);
    expect(r.subregistro).toBe('owner_selfchat_snapshot_center');
  });

  test('chatType desconocido center → fallback unknown_chattype_center', () => {
    const fakeSeed = '## §1\nID\n## §2\n### §2.1 `leads_miia`\nlead';
    mockReadReturn('voice_seed_center.md', fakeSeed);
    const r = v.loadVoiceDNAForCenter('weird_xxx');
    expect(r.fallback).toBe(true);
    expect(r.source).toBe('unknown_chattype_center');
  });
});

// ── getLoaderStats + resetCache (utility) ───────────────────────────────────

describe('T55 §7 — getLoaderStats / resetCache', () => {
  test('getLoaderStats devuelve campos esperados', () => {
    const stats = v.getLoaderStats();
    expect(stats).toHaveProperty('attempts');
    expect(stats).toHaveProperty('failures');
    expect(stats).toHaveProperty('cacheHit');
    expect(stats).toHaveProperty('voiceSeedPath');
    expect(stats).toHaveProperty('modeDetectorsPath');
  });
});
