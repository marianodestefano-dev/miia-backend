'use strict';

const { buildPostRaceMessage, sendPostRaceNotifications } = require('../sports/f1_dashboard/f1_notifications');

jest.mock('firebase-admin', () => {
  const docs = new Map();
  const mockDb = {
    doc: jest.fn(path => ({
      get: jest.fn().mockResolvedValue({
        exists: docs.has(path),
        data: () => docs.get(path) || {},
      }),
    })),
    collection: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [], empty: true }),
    })),
    collectionGroup: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      get: jest.fn().mockResolvedValue({ docs: [], size: 0 }),
    })),
    _docs: docs,
  };
  return { firestore: jest.fn(() => mockDb), _mockDb: mockDb };
});

const admin = require('firebase-admin');

describe('F1.8 — Notificaciones WhatsApp post-carrera', () => {

  // ─── buildPostRaceMessage ───
  describe('buildPostRaceMessage', () => {
    test('genera mensaje P1 con trofeo', () => {
      const msg = buildPostRaceMessage('Lewis Hamilton', 'Ferrari', 1, 25, 'GP Monaco', 3, 120, 'GP Canada', '2025-06-15');
      expect(msg).toContain('🏆');
      expect(msg).toContain('Hamilton');
      expect(msg).toContain('P1');
      expect(msg).toContain('+25 puntos');
      expect(msg).toContain('GP Canada');
    });

    test('genera mensaje P3 con emoji correcto', () => {
      const msg = buildPostRaceMessage('Max Verstappen', 'Red Bull', 3, 15, 'GP Monaco', 1, 145, null, null);
      expect(msg).toContain('P3');
      expect(msg).toContain('+15 puntos');
      expect(msg).not.toContain('Próximo');
    });

    test('genera mensaje para piloto fuera del podio', () => {
      const msg = buildPostRaceMessage('Yuki Tsunoda', 'Racing Bulls', 8, 4, 'GP Monaco', 10, 40, 'GP Canada', '2025-06-15');
      expect(msg).toContain('🏎️');
      expect(msg).toContain('P8');
    });

    test('omite linea de proximo GP si no hay datos', () => {
      const msg = buildPostRaceMessage('Norris', 'McLaren', 1, 25, 'GP Abu Dhabi', 1, 354, '', '');
      expect(msg).not.toContain('Próximo:');
    });
  });

  // ─── sendPostRaceNotifications ───
  describe('sendPostRaceNotifications', () => {
    test('retorna { sent:0, skipped:0, errors:0 } si GP no existe', async () => {
      const fs = admin._mockDb;
      fs.doc.mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }) });
      const result = await sendPostRaceNotifications('unknown_gp', jest.fn());
      expect(result.sent).toBe(0);
      expect(result.errors).toBe(0);
    });

    test('retorna { sent:0 } si no hay owners con notificaciones activadas', async () => {
      const fs = admin._mockDb;
      // GP existe pero resultado no
      fs.doc.mockReturnValueOnce({ get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ name: 'GP Monaco', date: '2025-05-25' }) }) });
      fs.doc.mockReturnValueOnce({ get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }) });
      const result = await sendPostRaceNotifications('monaco', jest.fn());
      expect(result.sent).toBe(0);
    });

    test('sendPostRaceNotifications retorna objeto con sent/skipped/errors', async () => {
      const fs = admin._mockDb;
      fs.doc.mockReturnValue({ get: jest.fn().mockResolvedValue({ exists: false, data: () => ({}) }) });
      const result = await sendPostRaceNotifications('monaco', jest.fn());
      expect(result).toHaveProperty('sent');
      expect(result).toHaveProperty('skipped');
      expect(result).toHaveProperty('errors');
    });
  });
});
