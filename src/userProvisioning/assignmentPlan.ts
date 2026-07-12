import type { GroupMemberRow, PermissionSetAssignmentRow } from '../userLifecycle/assignmentState.js';
import { type PersonaDefinition, normalizeMode } from './planner.js';

export type ResolvedRefs = {
  profilesByRef: Map<string, string>;
  rolesByRef: Map<string, string>;
  permissionSetIdsByRef: Map<string, string>;
  permissionSetGroupIdsByRef: Map<string, string>;
  publicGroupIdsByRef: Map<string, string>;
  queueIdsByRef: Map<string, string>;
  warnings: string[];
};

export type AssignmentCategoryDelta = {
  adds: string[];
  removes: string[];
  inBoth: string[];
  onlyInOrg: string[];
  mode?: 'additive' | 'sync';
};

export type AssignmentDelta = {
  permissionSets: AssignmentCategoryDelta;
  permissionSetGroups: AssignmentCategoryDelta;
  publicGroups: AssignmentCategoryDelta;
  queues: AssignmentCategoryDelta;
};

export type AssignmentDmlPlan = {
  permissionSets: { adds: string[]; removes: string[] };
  permissionSetGroups: { adds: string[]; removes: string[] };
  publicGroups: { adds: string[]; removes: string[] };
  queues: { adds: string[]; removes: string[] };
};

export const hasAssignmentIntent = (persona: PersonaDefinition, refs: ResolvedRefs): boolean => {
  const targetCounts = [
    ...(persona.permissionSets ?? []).map((ref) => refs.permissionSetIdsByRef.get(ref)),
    ...(persona.permissionSetGroups ?? []).map((ref) => refs.permissionSetGroupIdsByRef.get(ref)),
    ...(persona.publicGroups ?? []).map((ref) => refs.publicGroupIdsByRef.get(ref)),
    ...(persona.queues ?? []).map((ref) => refs.queueIdsByRef.get(ref)),
  ].filter(Boolean);
  return (
    targetCounts.length > 0 ||
    normalizeMode(persona.permissionSetMode) === 'sync' ||
    normalizeMode(persona.permissionSetGroupMode) === 'sync' ||
    normalizeMode(persona.publicGroupMode) === 'sync' ||
    normalizeMode(persona.queueMode) === 'sync'
  );
};

const resolveTargets = (refs: string[] | undefined, resolved: Map<string, string>): string[] =>
  (refs ?? []).map((ref) => resolved.get(ref)).filter((value): value is string => Boolean(value));

const computeCategoryDelta = (
  currentIds: string[],
  targetIds: string[],
  modeRaw: string | undefined
): AssignmentCategoryDelta => {
  const current = new Set(currentIds);
  const target = new Set(targetIds);
  const mode = normalizeMode(modeRaw);
  const onlyInOrg = [...current].filter((id) => !target.has(id));
  return {
    adds: [...target].filter((id) => !current.has(id)),
    removes: mode === 'sync' ? onlyInOrg : [],
    inBoth: [...target].filter((id) => current.has(id)),
    onlyInOrg,
    mode,
  };
};

export const extractCurrentIds = (
  assignmentRows: PermissionSetAssignmentRow[],
  membershipRows: GroupMemberRow[]
): { permissionSets: string[]; permissionSetGroups: string[]; publicGroups: string[]; queues: string[] } => {
  const permissionSets = assignmentRows
    .filter((row) => row.PermissionSetGroupId == null && row.PermissionSet?.IsOwnedByProfile !== true)
    .map((row) => row.PermissionSetId)
    .filter((value): value is string => Boolean(value));
  const permissionSetGroups = assignmentRows
    .map((row) => row.PermissionSetGroupId)
    .filter((value): value is string => Boolean(value));
  const publicGroups = membershipRows
    .filter((row) => row.Group?.Type === 'Regular')
    .map((row) => row.GroupId);
  const queues = membershipRows.filter((row) => row.Group?.Type === 'Queue').map((row) => row.GroupId);
  return { permissionSets, permissionSetGroups, publicGroups, queues };
};

export const computeAssignmentDeltaFromState = (
  persona: PersonaDefinition,
  refs: ResolvedRefs,
  assignmentRows: PermissionSetAssignmentRow[],
  membershipRows: GroupMemberRow[]
): AssignmentDelta => {
  const permissionSetTargets = resolveTargets(persona.permissionSets, refs.permissionSetIdsByRef);
  const permissionSetGroupTargets = resolveTargets(persona.permissionSetGroups, refs.permissionSetGroupIdsByRef);
  const publicTargets = resolveTargets(persona.publicGroups, refs.publicGroupIdsByRef);
  const queueTargets = resolveTargets(persona.queues, refs.queueIdsByRef);
  const current = extractCurrentIds(assignmentRows, membershipRows);

  return {
    permissionSets: computeCategoryDelta(current.permissionSets, permissionSetTargets, persona.permissionSetMode),
    permissionSetGroups: computeCategoryDelta(
      current.permissionSetGroups,
      permissionSetGroupTargets,
      persona.permissionSetGroupMode
    ),
    publicGroups: computeCategoryDelta(current.publicGroups, publicTargets, persona.publicGroupMode),
    queues: computeCategoryDelta(current.queues, queueTargets, persona.queueMode),
  };
};

export const toDmlPlan = (delta: AssignmentDelta, assignmentRows: PermissionSetAssignmentRow[], membershipRows: GroupMemberRow[]): AssignmentDmlPlan => {
  const findAssignmentIds = (ids: string[], getValue: (row: PermissionSetAssignmentRow) => string | null | undefined): string[] => {
    const wanted = new Set(ids);
    return assignmentRows.filter((row) => {
      const value = getValue(row);
      return value ? wanted.has(value) : false;
    }).map((row) => row.Id);
  };
  const findMembershipIds = (ids: string[], groupType: 'Regular' | 'Queue'): string[] => {
    const wanted = new Set(ids);
    return membershipRows
      .filter((row) => row.Group?.Type === groupType && wanted.has(row.GroupId))
      .map((row) => row.Id);
  };

  return {
    permissionSets: {
      adds: delta.permissionSets.adds,
      removes: findAssignmentIds(delta.permissionSets.removes, (row) => row.PermissionSetId),
    },
    permissionSetGroups: {
      adds: delta.permissionSetGroups.adds,
      removes: findAssignmentIds(delta.permissionSetGroups.removes, (row) => row.PermissionSetGroupId),
    },
    publicGroups: {
      adds: delta.publicGroups.adds,
      removes: findMembershipIds(delta.publicGroups.removes, 'Regular'),
    },
    queues: {
      adds: delta.queues.adds,
      removes: findMembershipIds(delta.queues.removes, 'Queue'),
    },
  };
};
