import { Messages, type Connection } from '@salesforce/core';
import {
  access,
  describeUserFields,
  flattenAccessRow,
  getResolver,
  parseUserFlag,
  resolveTargetField,
  resolveTargets,
  reverseCsvColumns,
  serializeCsv,
  type AccessTargetType,
  type ResolvedTargetUser,
  type UserAccessResult,
  type UserAccessRow,
} from '@syntax-syllogism/warden-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.access');

export type AccessRequestInput = {
  type: AccessTargetType;
  target?: string;
  user?: string;
  sobject?: string;
};

export type AccessRequestResult = {
  result: UserAccessResult;
  rows: UserAccessRow[];
  csvColumns: string[];
  csv: string;
  resolvedUser?: ResolvedTargetUser;
};

export class AccessRequestError extends Error {
  public constructor(
    public readonly code: string,
    public readonly args: string[] = [],
    message = messages.getMessage(code, args)
  ) {
    super(message);
    this.name = 'AccessRequestError';
  }
}

const stableOrder = (rows: UserAccessRow[]): UserAccessRow[] =>
  [...rows].sort(
    (a, b) =>
      a.userName.localeCompare(b.userName) ||
      a.userId.localeCompare(b.userId) ||
      a.targetName.localeCompare(b.targetName) ||
      a.assignmentType.localeCompare(b.assignmentType) ||
      a.sourceName.localeCompare(b.sourceName) ||
      (a.viaPermissionSetName ?? '').localeCompare(b.viaPermissionSetName ?? '') ||
      JSON.stringify(a.access).localeCompare(JSON.stringify(b.access)) ||
      a.sourceId.localeCompare(b.sourceId) ||
      (a.viaPermissionSetId ?? '').localeCompare(b.viaPermissionSetId ?? '')
  );

/** Executes the shared non-interactive access audit used by oclif and sfd. */
// eslint-disable-next-line complexity
export const runAccessRequest = async (conn: Connection, input: AccessRequestInput): Promise<AccessRequestResult> => {
  const userMode = typeof input.user === 'string' && input.user.length > 0;
  const hasTarget = typeof input.target === 'string' && input.target.length > 0;
  const hasSobject = typeof input.sobject === 'string' && input.sobject.length > 0;
  if (hasTarget && hasSobject) throw new AccessRequestError('errorUserModeScopesMutuallyExclusive');
  if (!userMode && hasSobject) throw new AccessRequestError('errorSobjectRequiresUser');
  if (!userMode && !hasTarget) throw new AccessRequestError('errorTargetRequired');
  if (userMode && !hasTarget && !hasSobject) throw new AccessRequestError('errorUserModeRequiresScope');

  const resolver = getResolver(input.type);
  if (hasTarget) {
    await resolver.validateTarget(conn, input.target as string);
  } else {
    if (input.type !== 'field' && input.type !== 'object') {
      throw new AccessRequestError('errorSobjectUnsupported', [input.type]);
    }
    await getResolver('object').validateTarget(conn, input.sobject as string);
  }

  let resolvedUser: ResolvedTargetUser | undefined;
  if (userMode) {
    let parsedUser: { field: string; value: string };
    try {
      parsedUser = parseUserFlag(input.user as string);
    } catch {
      throw new AccessRequestError('errorInvalidUserValue', [input.user as string]);
    }
    const fieldMap = await describeUserFields(conn);
    const matchField = resolveTargetField(parsedUser.field, fieldMap);
    if (!matchField) throw new AccessRequestError('errorInvalidUserMatchField', [parsedUser.field]);
    const resolution = await resolveTargets(
      conn,
      [{ key: `${matchField}:${parsedUser.value}`, field: matchField, value: parsedUser.value, order: 0 }],
      fieldMap
    );
    if (resolution.errors.length > 0)
      throw new AccessRequestError('errorUserResolutionFailed', [], resolution.errors[0].message);
    resolvedUser = resolution.targets[0];
    if (!resolvedUser) throw new AccessRequestError('errorUserResolutionFailed');
  }

  const result = await access.run(conn, input);
  const rows = stableOrder(result.rows);
  const orderedResult = { ...result, rows };
  const csvColumns = resolvedUser ? reverseCsvColumns(result.targetType) : resolver.csvColumns();
  return {
    result: orderedResult,
    rows,
    csvColumns,
    csv: serializeCsv(
      rows.map((row) => flattenAccessRow(row, csvColumns)),
      csvColumns
    ),
    resolvedUser,
  };
};
