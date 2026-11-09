import { Messages } from '@salesforce/core';
import { UserAccessError, isWardenError } from '@syntax-syllogism/warden-core';
import { AccessRequestError } from '../userShared/accessRequest.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const accessMessages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.access');

const actionsFor = (code: string): string[] => {
  try {
    return accessMessages.getMessages(`${code}.actions`);
  } catch {
    return [];
  }
};

/** Converts known request validation failures to the sfd operation error shape. */
export const toOperationError = (error: unknown): never => {
  if (error instanceof AccessRequestError) {
    throw Object.assign(new Error(error.message), {
      code: `warden.${error.code}`,
      actions: actionsFor(error.code),
      retryable: 'no' as const,
    });
  }
  if (error instanceof UserAccessError || isWardenError(error)) {
    throw Object.assign(new Error(error.message), {
      code: `warden.${error.code}`,
      actions: [],
      retryable: 'no' as const,
    });
  }
  throw error;
};
