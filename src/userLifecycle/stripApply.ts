import type { Connection } from '@salesforce/core';
import { runAssignmentDeletes, runRecordUpdate } from './dmlRunner.js';
import type { StripStep, StripTargetState } from './stripPlan.js';
import type { LifecycleUserResult } from './types.js';

const runStripStep = async (conn: Connection, result: LifecycleUserResult, step: StripStep): Promise<void> => {
  if (step.kind === 'update') {
    await runRecordUpdate({ conn, result, sobject: step.sobject, rows: [step.row], actionKey: step.actionKey });
    return;
  }
  await runAssignmentDeletes({
    conn,
    result,
    sobject: step.sobject,
    ids: step.ids,
    actionKey: step.actionKey,
    items: step.items,
  });
};

export const applyStripState = async (conn: Connection, state: StripTargetState): Promise<void> =>
  state.steps.reduce<Promise<void>>(
    (chain, step) => chain.then(() => runStripStep(conn, state.result, step)),
    Promise.resolve()
  );
