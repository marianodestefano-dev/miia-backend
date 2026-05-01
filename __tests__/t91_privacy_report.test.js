'use strict';
const { buildPrivacyReport, __setFirestoreForTests } = require('../core/privacy_report');
const UID = 'testUid1234567890abcdefgh';
function makeMockDb({ convData=null,tdData=null,pbData=null,throwConv=false,throwTd=false,throwPb=false }={}) {
  return { collection: () => ({ doc: () => ({ collection: (col2) => ({ doc: (dn) => ({
    get: async () => {
      if (col2==='miia_persistent'&&dn==='tenant_conversations') {
        if (throwConv) throw new Error('err');
        return convData ? { exists: true, data: () => convData } : { exists: false };
      }
      if (col2==='miia_persistent'&&dn==='training_data') {
        if (throwTd) throw new Error('err');
        return tdData ? { exists: true, data: () => tdData } : { exists: false };
      }
      if (col2==='personal'&&dn==='personal_brain') {
        if (throwPb) throw new Error('err');
        return pbData ? { exists: true, data: () => pbData } : { exists: false };
      }
      return { exists: false };
    } }) }) }) }) };
}
afterEach(() => { __setFirestoreForTests(null); });

describe('buildPrivacyReport — validacion de inputs', () => {
  test('lanza error si uid es undefined', async () => {
    await expect(buildPrivacyReport(undefined)).rejects.toThrow('uid requerido');
  });
  test('lanza error si uid es string vacio', async () => {
    await expect(buildPrivacyReport('')).rejects.toThrow('uid requerido');
  });
  test('lanza error si uid no es string', async () => {
    await expect(buildPrivacyReport(12345)).rejects.toThrow('uid requerido');
  });
});

describe('buildPrivacyReport — campos requeridos en respuesta', () => {
  test('retorna todos los campos requeridos con Firestore vacio', async () => {
    __setFirestoreForTests(makeMockDb());
    const report = await buildPrivacyReport(UID);
    expect(report).toHaveProperty('uid', UID);
    expect(report).toHaveProperty('conversationsCount', 0);
    expect(report).toHaveProperty('oldestConversationDate', null);
    expect(report).toHaveProperty('contactTypesCount', 0);
    expect(report).toHaveProperty('staleCacheCount', 0);
    expect(report).toHaveProperty('trainingDataSize', 0);
    expect(report).toHaveProperty('personalBrainSize', 0);
    expect(report).toHaveProperty('generatedAt');
    expect(typeof report.generatedAt).toBe('string');
  });
});

describe('buildPrivacyReport — conteos de conversaciones', () => {
  test('cuenta correctamente el numero de conversaciones y tipos', async () => {
    const convData = {
      conversations: {
        '+573001111111': [{ text: 'hola', timestamp: 100 }],
        '+573002222222': []
      },
      contactTypes: {
        '+573001111111': 'lead',
        '+573002222222': 'client',
        '+573003333333': 'unknown'
      }
    };
    __setFirestoreForTests(makeMockDb({ convData }));
    const report = await buildPrivacyReport(UID);
    expect(report.conversationsCount).toBe(2);
    expect(report.contactTypesCount).toBe(3);
  });

  test('calcula oldestConversationDate como el timestamp mas antiguo', async () => {
    const convData = {
      conversations: {
        a: [{ timestamp: 500 }, { timestamp: 200 }],
        b: [{ timestamp: 100 }]
      },
      contactTypes: {}
    };
    __setFirestoreForTests(makeMockDb({ convData }));
    const report = await buildPrivacyReport(UID);
    expect(report.oldestConversationDate).toBe(100);
  });

  test('retorna null en oldestConversationDate sin timestamps', async () => {
    const convData = { conversations: { a: [{ text: 'sin ts' }] }, contactTypes: {} };
    __setFirestoreForTests(makeMockDb({ convData }));
    const report = await buildPrivacyReport(UID);
    expect(report.oldestConversationDate).toBeNull();
  });
});

describe('buildPrivacyReport -- training data y personal brain', () => {
  test('calcula trainingDataSize en bytes UTF-8 correctamente', async () => {
    const content = 'instruccion de entrenamiento larga con caracteres';
    __setFirestoreForTests(makeMockDb({ tdData: { content } }));
    const report = await buildPrivacyReport(UID);
    expect(report.trainingDataSize).toBe(Buffer.byteLength(content, 'utf8'));
    expect(report.trainingDataSize).toBeGreaterThan(0);
  });
  test('calcula personalBrainSize como bytes del JSON serializado', async () => {
    const pbData = { instruccion: 'responde en espanol', nivel: 42 };
    __setFirestoreForTests(makeMockDb({ pbData }));
    const report = await buildPrivacyReport(UID);
    expect(report.personalBrainSize).toBe(Buffer.byteLength(JSON.stringify(pbData), 'utf8'));
    expect(report.personalBrainSize).toBeGreaterThan(0);
  });
});

describe('buildPrivacyReport -- resiliencia a errores Firestore', () => {
  test('retorna resultado parcial si tenant_conversations falla', async () => {
    const tdData = { content: 'algo de training' };
    __setFirestoreForTests(makeMockDb({ throwConv: true, tdData }));
    const report = await buildPrivacyReport(UID);
    expect(report.conversationsCount).toBe(0);
    expect(report.trainingDataSize).toBeGreaterThan(0);
    expect(report.uid).toBe(UID);
  });
  test('retorna resultado parcial si training_data falla', async () => {
    const convData = { conversations: { a: [] }, contactTypes: {} };
    __setFirestoreForTests(makeMockDb({ convData, throwTd: true }));
    const report = await buildPrivacyReport(UID);
    expect(report.conversationsCount).toBe(1);
    expect(report.trainingDataSize).toBe(0);
  });
  test('retorna resultado parcial si personal_brain falla', async () => {
    __setFirestoreForTests(makeMockDb({ throwPb: true }));
    const report = await buildPrivacyReport(UID);
    expect(report.personalBrainSize).toBe(0);
    expect(report.uid).toBe(UID);
  });
});
