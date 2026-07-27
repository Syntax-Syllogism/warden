import type { Connection } from '@salesforce/core';
import { queryAllInChunks, soqlIn } from './soql.js';

type MutingComponentRow = { PermissionSetGroupId: string; PermissionSetId: string };

export type PsgMutingState<TMask> = {
  permissionSetIdsByGroup: Map<string, string[]>;
  masksByPermissionSetId: Map<string, TMask>;
};

export async function loadPsgMuting<TMask>(
  conn: Connection,
  psgIds: string[],
  loadMasks: (permissionSetIds: string[]) => Promise<Map<string, TMask>>
): Promise<PsgMutingState<TMask>> {
  if (psgIds.length === 0) {
    return { permissionSetIdsByGroup: new Map(), masksByPermissionSetId: new Map() };
  }
  const components = await queryAllInChunks<MutingComponentRow>(conn, psgIds, (chunk) =>
    [
      'SELECT PermissionSetGroupId, PermissionSetId',
      'FROM PermissionSetGroupComponent',
      `WHERE PermissionSetGroupId IN (${soqlIn(chunk)})`,
      "AND PermissionSet.Type = 'Muting'",
    ].join(' ')
  );
  const permissionSetIdsByGroup = new Map<string, string[]>();
  for (const component of components) {
    const ids = permissionSetIdsByGroup.get(component.PermissionSetGroupId) ?? [];
    ids.push(component.PermissionSetId);
    permissionSetIdsByGroup.set(component.PermissionSetGroupId, ids);
  }
  const permissionSetIds = [...new Set(components.map((component) => component.PermissionSetId))];
  return { permissionSetIdsByGroup, masksByPermissionSetId: await loadMasks(permissionSetIds) };
}

export const combinePsgMuting = <TMask>(
  psgId: string | undefined,
  state: PsgMutingState<TMask>,
  emptyMask: TMask,
  combine: (left: TMask, right: TMask) => TMask
): TMask =>
  (state.permissionSetIdsByGroup.get(psgId ?? '') ?? []).reduce(
    (muted, permissionSetId) => combine(muted, state.masksByPermissionSetId.get(permissionSetId) ?? emptyMask),
    emptyMask
  );
