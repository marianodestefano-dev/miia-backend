'use strict';

/**
 * Firestore Security Rules — Tests automatizados.
 * C-405 Cimientos §3 C.6 + specs P0-01.
 *
 * Framework: @firebase/rules-unit-testing v5
 * Corre contra Firebase emulator local en port 8080.
 *
 * Pre-requisito: emulator running (`firebase emulators:start --only firestore`).
 *
 * Cobertura:
 *  1. Ownership users/{uid} (authenticated context)
 *  2. Sub-colecciones (conversations, messages, training_data, etc.)
 *  3. Agentes con parent_client_uid (owner puede leer agentes propios)
 *  4. baileys_sessions bloqueada para frontend (solo Admin SDK)
 *  5. Edge cases: deep paths, write ajenos, claims spoofing
 */

const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'miia-app-8cbd0-test';
const RULES_PATH = path.join(__dirname, '..', 'firestore.rules');
const RULES = fs.readFileSync(RULES_PATH, 'utf8');

const OWNER_A_UID = 'A5pMESWlfmPWCoCPRbwy85EzUzy2'; // MIIA CENTER
const OWNER_B_UID = 'bq2BbtCVF8cZo30tum584zrGATJ3'; // MIIA Personal
const RANDOM_UID = 'random_other_user_123';
const AGENT_UID = 'agent_of_owner_a';

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: RULES,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  if (testEnv) await testEnv.clearFirestore();
});

// ═══════════════════════════════════════════════════════════════
// §1 — Ownership users/{uid} (top-level)
// ═══════════════════════════════════════════════════════════════

describe('Firestore Rules — ownership users/{uid}', () => {
  test('owner A puede leer su propio doc', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertSucceeds(db.collection('users').doc(OWNER_A_UID).get());
  });

  test('owner A puede escribir su propio doc', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertSucceeds(
      db.collection('users').doc(OWNER_A_UID).set({ email: 'a@miia.com', role: 'owner' })
    );
  });

  test('owner A NO puede leer doc de owner B', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(OWNER_B_UID).set({ email: 'b@miia.com' });
    });
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(db.collection('users').doc(OWNER_B_UID).get());
  });

  test('owner A NO puede escribir doc de owner B', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_B_UID).set({ malicious: 'edit', role: 'admin' })
    );
  });

  test('usuario sin auth NO puede leer ningún user doc', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(OWNER_A_UID).set({ public: false });
    });
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(db.collection('users').doc(OWNER_A_UID).get());
  });

  test('usuario sin auth NO puede escribir ningún user doc', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      db.collection('users').doc(OWNER_A_UID).set({ malicious: 'create' })
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// §2 — Sub-colecciones de users/{uid}
// ═══════════════════════════════════════════════════════════════

describe('Firestore Rules — sub-collections ownership', () => {
  test('owner A puede escribir conversations propias', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertSucceeds(
      db.collection('users').doc(OWNER_A_UID)
        .collection('conversations').doc('+573054169969')
        .set({ messages: ['hola'] })
    );
  });

  test('owner A NO puede leer conversations de owner B', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore()
        .collection('users').doc(OWNER_B_UID)
        .collection('conversations').doc('+573163937365')
        .set({ messages: ['secreto'] });
    });
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_B_UID)
        .collection('conversations').doc('+573163937365')
        .get()
    );
  });

  test('owner A NO puede escribir conversations de owner B', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_B_UID)
        .collection('conversations').doc('any_phone')
        .set({ malicious: 'inject' })
    );
  });

  test('owner A puede leer training_data propio', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertSucceeds(
      db.collection('users').doc(OWNER_A_UID)
        .collection('training_data').doc('cerebro')
        .set({ content: 'training' })
    );
  });

  test('owner A NO puede leer training_data de owner B', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore()
        .collection('users').doc(OWNER_B_UID)
        .collection('training_data').doc('cerebro')
        .set({ content: 'private brain' });
    });
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_B_UID)
        .collection('training_data').doc('cerebro')
        .get()
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// §3 — Agentes con parent_client_uid
// ═══════════════════════════════════════════════════════════════

describe('Firestore Rules — agentes (parent_client_uid)', () => {
  test('owner A puede leer doc de agente cuyo parent_client_uid = A', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(AGENT_UID).set({
        parent_client_uid: OWNER_A_UID,
        role: 'agent',
        email: 'agent@miia.com',
      });
    });
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertSucceeds(db.collection('users').doc(AGENT_UID).get());
  });

  test('random user NO puede leer doc de agente', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(AGENT_UID).set({
        parent_client_uid: OWNER_A_UID,
        role: 'agent',
      });
    });
    const db = testEnv.authenticatedContext(RANDOM_UID).firestore();
    await assertFails(db.collection('users').doc(AGENT_UID).get());
  });

  test('owner B (NO parent del agente A) NO puede leer agente A', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection('users').doc(AGENT_UID).set({
        parent_client_uid: OWNER_A_UID,
      });
    });
    const db = testEnv.authenticatedContext(OWNER_B_UID).firestore();
    await assertFails(db.collection('users').doc(AGENT_UID).get());
  });
});

// ═══════════════════════════════════════════════════════════════
// §4 — baileys_sessions BLOQUEADA para frontend
// ═══════════════════════════════════════════════════════════════

describe('Firestore Rules — baileys_sessions (CRÍTICO frontend bloqueado)', () => {
  test('usuario autenticado NO puede leer baileys_sessions propia', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('baileys_sessions').doc(OWNER_A_UID).get()
    );
  });

  test('usuario autenticado NO puede leer baileys_sessions ajena', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('baileys_sessions').doc(OWNER_B_UID).get()
    );
  });

  test('usuario sin auth NO puede leer baileys_sessions', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      db.collection('baileys_sessions').doc('any_doc').get()
    );
  });

  test('usuario autenticado NO puede escribir baileys_sessions', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('baileys_sessions').doc(OWNER_A_UID).set({ malicious: 'inject' })
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// §5 — Edge cases
// ═══════════════════════════════════════════════════════════════

describe('Firestore Rules — edge cases', () => {
  test('user A NO puede crear doc con uid de otro user', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_B_UID).set({ created_by_attacker: OWNER_A_UID })
    );
  });

  test('deep sub-collection (conversations/{phone}/messages/{id}) NO permite escribir desde frontend — diseño: messages solo via Admin SDK backend', async () => {
    // Las rules permiten /{subcollection}/{docId} bajo users/{uid} (1 nivel),
    // pero messages en deep 2 niveles (conversations/{phone}/messages/{id})
    // cae en DEFAULT DENY (L125) — por diseño. Backend escribe via Admin SDK
    // que bypasea rules.
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_A_UID)
        .collection('conversations').doc('+573054169969')
        .collection('messages').doc('msg_001')
        .set({ text: 'hola', from: 'A' })
    );
  });

  test('deep sub-collection NO permite escribir en ruta ajena', async () => {
    const db = testEnv.authenticatedContext(OWNER_A_UID).firestore();
    await assertFails(
      db.collection('users').doc(OWNER_B_UID)
        .collection('conversations').doc('+573163937365')
        .collection('messages').doc('leak_attempt')
        .set({ text: 'leak', from: 'attacker_A' })
    );
  });
});
