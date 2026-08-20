import type { Connection } from '@salesforce/core';
import { asArray, batch, formatSaveError, type SaveResult } from '../userShared/sfUtils.js';
import { RELATED_DML_CHUNK_SIZE } from './plan.js';
import type { RelatedRecordPlan, RelatedRecordResult } from './types.js';

type JsonRecord = Record<string, unknown>;

export type RelatedApplyEntry = { planId: string; relatedPlans: RelatedRecordPlan[]; savedUserId: string };

type PendingWrite = {
  planId: string;
  plan: RelatedRecordPlan;
  payload: JsonRecord;
};

const baseResult = (plan: RelatedRecordPlan): Pick<RelatedRecordResult, 'relationship' | 'phase' | 'sobject'> => ({
  relationship: plan.relationship,
  phase: plan.phase,
  sobject: plan.sobject,
});

/** Dry-run rendering: no DML, and no `recordId` for a record that does not exist yet. */
export const toDryRunResults = (plans: RelatedRecordPlan[]): RelatedRecordResult[] =>
  plans.map((plan) => {
    if (plan.status === 'failed') {
      return { ...baseResult(plan), action: 'wouldSkip', status: 'failed', error: plan.errors.join('; ') };
    }
    if (plan.status === 'skipped') return { ...baseResult(plan), action: 'wouldSkip', status: 'skipped' };
    return plan.existingId
      ? {
          ...baseResult(plan),
          recordId: plan.existingId,
          action:
            Object.keys(plan.fields).length === 0 && plan.pendingUserIdFields.length === 0 ? 'matched' : 'wouldUpdate',
          status: 'planned',
        }
      : { ...baseResult(plan), action: 'wouldCreate', status: 'planned' };
  });

/** Results for plans a live run never reached (user validation errors or a failed User save). */
export const toUnappliedResults = (plans: RelatedRecordPlan[]): RelatedRecordResult[] =>
  plans.map((plan) =>
    plan.status === 'failed'
      ? { ...baseResult(plan), action: 'skipped', status: 'failed', error: plan.errors.join('; ') }
      : { ...baseResult(plan), action: 'skipped', status: 'skipped' }
  );

const buildPayload = (plan: RelatedRecordPlan, savedUserId: string): JsonRecord => {
  const fields: JsonRecord = { ...plan.fields };
  for (const name of plan.pendingUserIdFields) fields[name] = savedUserId;
  if (plan.existingId) return { ...fields, Id: plan.existingId };
  return plan.recordTypeId ? { ...fields, RecordTypeId: plan.recordTypeId } : fields;
};

const isMatchedWithoutChanges = (plan: RelatedRecordPlan): boolean =>
  Boolean(plan.existingId) && Object.keys(plan.fields).length === 0 && plan.pendingUserIdFields.length === 0;

const recordOutcome = (
  write: PendingWrite,
  saveResult: SaveResult | undefined,
  resultsByPlanId: Map<string, RelatedRecordResult[]>
): void => {
  const { plan } = write;
  const isUpdate = Boolean(plan.existingId);
  const succeeded = saveResult?.success === true && Boolean(saveResult.id ?? plan.existingId);
  const results = resultsByPlanId.get(write.planId) ?? [];
  if (succeeded) {
    results.push({
      ...baseResult(plan),
      recordId: saveResult?.id ?? plan.existingId,
      action: isUpdate ? 'updated' : 'created',
      status: 'applied',
    });
  } else {
    const errors = (saveResult?.errors ?? []).map((error) => formatSaveError(error));
    const error = errors.length > 0 ? errors.join('; ') : 'Related record save returned no result.';
    plan.errors.push(error);
    plan.status = 'failed';
    results.push({
      ...baseResult(plan),
      ...(plan.existingId ? { recordId: plan.existingId } : {}),
      action: 'skipped',
      status: 'failed',
      error,
    });
  }
  resultsByPlanId.set(write.planId, results);
};

const runPartitionedDml = async (
  writes: PendingWrite[],
  operation: (payloads: JsonRecord[]) => Promise<SaveResult | SaveResult[]>,
  resultsByPlanId: Map<string, RelatedRecordResult[]>
): Promise<void> => {
  const partitions = batch(writes, RELATED_DML_CHUNK_SIZE);
  for (const partition of partitions) {
    // Ordered requests: each partition is at most 200 records, matching the User save shape.
    // eslint-disable-next-line no-await-in-loop
    const saveResults = asArray(await operation(partition.map((write) => write.payload)));
    partition.forEach((write, idx) => recordOutcome(write, saveResults[idx], resultsByPlanId));
  }
};

/**
 * Apply every `after`-phase related record for the batch as bulk DML per sObject.
 *
 * Failures are pushed onto the owning `UserPlan`'s errors so the existing status
 * derivation reports that user failed — without undoing the already-saved User.
 */
export const applyRelatedPhase = async (
  conn: Connection,
  entries: RelatedApplyEntry[],
  phase: 'after'
): Promise<Map<string, RelatedRecordResult[]>> => {
  const resultsByPlanId = new Map<string, RelatedRecordResult[]>();
  const writes: PendingWrite[] = [];
  for (const entry of entries) {
    for (const plan of entry.relatedPlans) {
      if (plan.phase !== phase) continue;
      if (plan.status !== 'planned') {
        resultsByPlanId.set(entry.planId, (resultsByPlanId.get(entry.planId) ?? []).concat(toUnappliedResults([plan])));
        continue;
      }
      if (isMatchedWithoutChanges(plan)) {
        resultsByPlanId.set(
          entry.planId,
          (resultsByPlanId.get(entry.planId) ?? []).concat({
            ...baseResult(plan),
            recordId: plan.existingId,
            action: 'matched',
            status: 'applied',
          })
        );
        continue;
      }
      writes.push({ planId: entry.planId, plan, payload: buildPayload(plan, entry.savedUserId) });
    }
  }
  if (writes.length === 0) return resultsByPlanId;

  const sobjects = [...new Set(writes.map((write) => write.plan.sobject))];
  for (const sobject of sobjects) {
    const forSobject = writes.filter((write) => write.plan.sobject === sobject);
    const creates = forSobject.filter((write) => !write.plan.existingId);
    const updates = forSobject.filter((write) => Boolean(write.plan.existingId));
    /* eslint-disable no-await-in-loop */
    if (creates.length > 0) {
      await runPartitionedDml(
        creates,
        (payloads) => conn.sobject(sobject).create(payloads, { allOrNone: false }) as Promise<SaveResult[]>,
        resultsByPlanId
      );
    }
    if (updates.length > 0) {
      await runPartitionedDml(
        updates,
        (payloads) =>
          conn.sobject(sobject).update(payloads as Array<JsonRecord & { Id: string }>, { allOrNone: false }) as Promise<
            SaveResult[]
          >,
        resultsByPlanId
      );
    }
    /* eslint-enable no-await-in-loop */
  }
  return resultsByPlanId;
};
