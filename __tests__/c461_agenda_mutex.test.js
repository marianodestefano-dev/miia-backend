/**
 * Tests: C-461-AGENDA-MUTEX — mutex per-task en executeWithConcentration.
 *
 * Origen: C-458 audit §B CONDICIONAL #2. APROBADO Wi autoridad delegada
 * 2026-04-28 (mail Wi -> Vi 11:12 COT post C-460-RESERVATIONS-TX cierre).
 *
 * Bug previo: task_scheduler.executeWithConcentration NO tenia mutex
 * per-task. Si setInterval (5min) y setTimeout (3min post-startup)
 * invocaban el mismo task concurrentemente, ambos ejecutaban -> doble
 * envio recordatorios al owner self-chat.
 *
 * Fix: Map<taskName, isRunning>. Si task ya esta corriendo, skip
 * silencioso (success=false, skipped=true). Lock release garantizado
 * via try/finally.
 *
 * Cross-link: C-456 audit + C-458 audit + C-457/C-460 patterns.
 */

'use strict';

const taskScheduler = require('../core/task_scheduler');

beforeEach(() => {
  taskScheduler._resetRunningTasksForTests();
});

describe('C-461-AGENDA-MUTEX §A — lock acquired/released', () => {
  test('A.1 — task NO running antes de invocar executeWithConcentration', () => {
    expect(taskScheduler._isTaskRunning('task_x')).toBe(false);
  });

  test('A.2 — durante taskFn execution, isTaskRunning=true', async () => {
    let observedDuringRun = false;
    await taskScheduler.executeWithConcentration(1, 'task_a', async () => {
      observedDuringRun = taskScheduler._isTaskRunning('task_a');
      return 'ok';
    });
    expect(observedDuringRun).toBe(true);
  });

  test('A.3 — post-completion, lock released (isTaskRunning=false)', async () => {
    await taskScheduler.executeWithConcentration(1, 'task_b', async () => 'ok');
    expect(taskScheduler._isTaskRunning('task_b')).toBe(false);
  });

  test('A.4 — task throws → lock released igual (try/finally)', async () => {
    const r = await taskScheduler.executeWithConcentration(1, 'task_c', async () => {
      throw new Error('boom');
    });
    expect(r.success).toBe(false);
    // Despues de tirar y los retries fallar, lock release garantizado.
    expect(taskScheduler._isTaskRunning('task_c')).toBe(false);
  });
});

describe('C-461-AGENDA-MUTEX §B — concurrencia per-task', () => {
  test('B.1 — 2 invocaciones concurrentes mismo task → 1 ejecuta + 1 skip', async () => {
    let runCount = 0;
    const taskFn = async () => {
      runCount++;
      // Simular trabajo lento para asegurar overlap.
      await new Promise((res) => setTimeout(res, 30));
      return 'ok';
    };
    const [r1, r2] = await Promise.all([
      taskScheduler.executeWithConcentration(1, 'task_concurrent', taskFn),
      taskScheduler.executeWithConcentration(1, 'task_concurrent', taskFn),
    ]);
    expect(runCount).toBe(1); // Solo 1 ejecuto.
    const successes = [r1, r2].filter((r) => r.success === true);
    const skipped = [r1, r2].filter((r) => r.skipped === true);
    expect(successes.length).toBe(1);
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toBe('already_running');
  });

  test('B.2 — 2 invocaciones tasks DIFERENTES → ambas ejecutan', async () => {
    let runs = { a: 0, b: 0 };
    await Promise.all([
      taskScheduler.executeWithConcentration(1, 'task_diff_a', async () => {
        runs.a++;
        await new Promise((res) => setTimeout(res, 30));
      }),
      taskScheduler.executeWithConcentration(1, 'task_diff_b', async () => {
        runs.b++;
        await new Promise((res) => setTimeout(res, 30));
      }),
    ]);
    expect(runs.a).toBe(1);
    expect(runs.b).toBe(1);
  });

  test('B.3 — secuencial: task A completa → task A puede correr de nuevo', async () => {
    let runs = 0;
    await taskScheduler.executeWithConcentration(1, 'task_seq', async () => { runs++; });
    await taskScheduler.executeWithConcentration(1, 'task_seq', async () => { runs++; });
    expect(runs).toBe(2);
  });

  test('B.4 — skip metric incrementa en skipped concurrent', async () => {
    const metricsBefore = taskScheduler.getTaskMetrics();
    const skipped0 = metricsBefore.skippedConcurrent || 0;

    const taskFn = async () => {
      await new Promise((res) => setTimeout(res, 30));
    };
    await Promise.all([
      taskScheduler.executeWithConcentration(1, 'task_metric', taskFn),
      taskScheduler.executeWithConcentration(1, 'task_metric', taskFn),
    ]);

    const metricsAfter = taskScheduler.getTaskMetrics();
    expect((metricsAfter.skippedConcurrent || 0) - skipped0).toBeGreaterThanOrEqual(1);
  });
});

describe('C-461-AGENDA-MUTEX §C — source markers', () => {
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(
    path.resolve(__dirname, '../core/task_scheduler.js'),
    'utf8'
  );

  test('C.1 — comentario C-461-AGENDA-MUTEX presente', () => {
    expect(SRC).toContain('C-461-AGENDA-MUTEX');
  });

  test('C.2 — Map _runningTasks presente', () => {
    expect(SRC).toMatch(/_runningTasks\s*=\s*new Map\(\)/);
  });

  test('C.3 — try/finally con _markTaskFinished en executeWithConcentration', () => {
    expect(SRC).toMatch(/finally\s*\{[\s\S]{0,200}?_markTaskFinished/);
  });

  test('C.4 — skippedConcurrent metric en _metrics', () => {
    expect(SRC).toMatch(/skippedConcurrent:/);
  });
});
