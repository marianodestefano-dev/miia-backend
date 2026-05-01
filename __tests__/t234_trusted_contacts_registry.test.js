'use strict';

const {
  addTrustedContact, removeTrustedContact, getTrustedContacts,
  verifyTrustedContact, initiateRecovery,
  buildVerificationMessage, buildRecoveryNotificationText,
  isValidTrustLevel, isValidContactRole,
  TRUST_LEVELS, CONTACT_ROLES, MAX_TRUSTED_CONTACTS, VERIFICATION_TTL_MS,
  __setFirestoreForTests,
} = require('../core/trusted_contacts_registry');

const UID = 'testUid1234567890';
const PHONE = '+541155667788';
const PHONE2 = '+541155667799';

function makeMockDb({ contacts = [], throwGet = false, throwSet = false, throwDelete = false } = {}) {
  const stored = {};
  contacts.forEach(c => { stored[c.id || c.phone.replace(/\D/g,'').slice(-10)] = c; });
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => {
            if (throwGet) throw new Error('get error');
            return { forEach: fn => Object.entries(stored).forEach(([id, data]) => fn({ id, data: () => data })) };
          },
          doc: (id) => ({
            set: async (data, opts) => {
              if (throwSet) throw new Error('set error');
              stored[id] = opts && opts.merge ? { ...(stored[id] || {}), ...data } : data;
            },
            delete: async () => { if (throwDelete) throw new Error('delete error'); delete stored[id]; },
          }),
        }),
      }),
    }),
  };
}

beforeEach(() => { __setFirestoreForTests(null); });
afterEach(() => { __setFirestoreForTests(null); });

describe('Constantes', () => {
  test('TRUST_LEVELS tiene 3 niveles', () => { expect(TRUST_LEVELS.length).toBe(3); });
  test('CONTACT_ROLES tiene 5 roles', () => { expect(CONTACT_ROLES.length).toBe(5); });
  test('frozen TRUST_LEVELS', () => { expect(() => { TRUST_LEVELS.push('x'); }).toThrow(); });
  test('MAX_TRUSTED_CONTACTS es 5', () => { expect(MAX_TRUSTED_CONTACTS).toBe(5); });
  test('VERIFICATION_TTL_MS es 48h', () => { expect(VERIFICATION_TTL_MS).toBe(48 * 60 * 60 * 1000); });
});

describe('isValidTrustLevel e isValidContactRole', () => {
  test('primary es trust level valido', () => { expect(isValidTrustLevel('primary')).toBe(true); });
  test('admin no es trust level valido', () => { expect(isValidTrustLevel('admin')).toBe(false); });
  test('family es contact role valido', () => { expect(isValidContactRole('family')).toBe(true); });
  test('friend no es contact role valido', () => { expect(isValidContactRole('friend')).toBe(false); });
});

describe('getTrustedContacts', () => {
  test('lanza si uid undefined', async () => {
    await expect(getTrustedContacts(undefined)).rejects.toThrow('uid requerido');
  });
  test('retorna array vacio si no hay contactos', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [] }));
    expect(await getTrustedContacts(UID)).toEqual([]);
  });
  test('fail-open retorna vacio si Firestore falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwGet: true }));
    expect(await getTrustedContacts(UID)).toEqual([]);
  });
});

describe('addTrustedContact', () => {
  test('lanza si uid undefined', async () => {
    await expect(addTrustedContact(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(addTrustedContact(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('agrega contacto sin error', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [] }));
    const r = await addTrustedContact(UID, PHONE, { name: 'Ana', role: 'family', trustLevel: 'primary' });
    expect(r.docId).toBeDefined();
    expect(r.record.phone).toBe(PHONE);
    expect(r.record.role).toBe('family');
    expect(r.record.trustLevel).toBe('primary');
    expect(r.record.verified).toBe(false);
  });
  test('lanza si se supera el maximo', async () => {
    const contacts = Array.from({ length: MAX_TRUSTED_CONTACTS }, (_, i) => ({
      phone: '+5411' + i, id: String(i).padStart(10, '0')
    }));
    __setFirestoreForTests(makeMockDb({ contacts }));
    await expect(addTrustedContact(UID, PHONE)).rejects.toThrow('maximo');
  });
  test('lanza si contacto ya existe', async () => {
    const docId = PHONE.replace(/\D/g,'').slice(-10);
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: PHONE, id: docId }] }));
    await expect(addTrustedContact(UID, PHONE)).rejects.toThrow('ya existe');
  });
  test('propaga error Firestore', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [], throwSet: true }));
    await expect(addTrustedContact(UID, PHONE)).rejects.toThrow('set error');
  });
});

describe('removeTrustedContact', () => {
  test('lanza si uid undefined', async () => {
    await expect(removeTrustedContact(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(removeTrustedContact(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('elimina sin error', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [] }));
    await expect(removeTrustedContact(UID, PHONE)).resolves.toBeUndefined();
  });
});

describe('verifyTrustedContact', () => {
  test('lanza si uid undefined', async () => {
    await expect(verifyTrustedContact(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('verifica sin error', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [] }));
    await expect(verifyTrustedContact(UID, PHONE)).resolves.toBeUndefined();
  });
});

describe('initiateRecovery', () => {
  test('lanza si uid undefined', async () => {
    await expect(initiateRecovery(undefined, PHONE)).rejects.toThrow('uid requerido');
  });
  test('lanza si phone undefined', async () => {
    await expect(initiateRecovery(UID, undefined)).rejects.toThrow('phone requerido');
  });
  test('lanza si contacto no registrado', async () => {
    __setFirestoreForTests(makeMockDb({ contacts: [] }));
    await expect(initiateRecovery(UID, PHONE)).rejects.toThrow('no registrado');
  });
  test('lanza si contacto no verificado', async () => {
    const docId = PHONE.replace(/\D/g,'').slice(-10);
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: PHONE, id: docId, verified: false, canInitiateRecovery: true }] }));
    await expect(initiateRecovery(UID, PHONE)).rejects.toThrow('no verificado');
  });
  test('lanza si contacto no tiene permiso recovery', async () => {
    const docId = PHONE.replace(/\D/g,'').slice(-10);
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: PHONE, id: docId, verified: true, canInitiateRecovery: false }] }));
    await expect(initiateRecovery(UID, PHONE)).rejects.toThrow('permiso de recovery');
  });
  test('inicia recovery con contacto valido', async () => {
    const docId = PHONE.replace(/\D/g,'').slice(-10);
    __setFirestoreForTests(makeMockDb({ contacts: [{ phone: PHONE, id: docId, verified: true, canInitiateRecovery: true }] }));
    const r = await initiateRecovery(UID, PHONE);
    expect(r.recoveryId).toMatch(/^rec_/);
    expect(r.record.status).toBe('pending');
    expect(r.record.initiatedBy).toBe(PHONE);
  });
});

describe('buildVerificationMessage y buildRecoveryNotificationText', () => {
  test('buildVerificationMessage menciona SI', () => {
    const msg = buildVerificationMessage(PHONE, UID);
    expect(msg).toContain('SI');
    expect(msg).toContain('MIIA');
  });
  test('buildRecoveryNotificationText menciona CONFIRMAR', () => {
    const msg = buildRecoveryNotificationText({ name: 'Ana', phone: PHONE });
    expect(msg).toContain('CONFIRMAR');
    expect(msg).toContain('Ana');
  });
  test('buildRecoveryNotificationText usa phone si no hay nombre', () => {
    const msg = buildRecoveryNotificationText({ phone: PHONE });
    expect(msg).toContain(PHONE);
  });
});
