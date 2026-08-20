import { Messages } from '@salesforce/core';
import { Flags } from '@salesforce/sf-plugins-core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@syntax-syllogism/warden', 'warden.shared');

export const targetOrgFlag = Flags.requiredOrg({ summary: messages.getMessage('flags.target-org.summary') });
export const apiVersionFlag = Flags.orgApiVersion({ summary: messages.getMessage('flags.api-version.summary') });

export const userFlag = Flags.string({
  exactlyOne: ['user', 'users-def'],
  summary: messages.getMessage('flags.user.summary'),
});

export const usersDefFlag = Flags.file({
  exists: true,
  exactlyOne: ['user', 'users-def'],
  summary: messages.getMessage('flags.users-def.summary'),
});

export const externalIdFlag = Flags.string({ summary: messages.getMessage('flags.external-id.summary') });

export const inputFormatFlag = Flags.string({
  options: ['json', 'csv'] as const,
  summary: messages.getMessage('flags.input-format.summary'),
});

export const csvListDelimiterFlag = Flags.string({ summary: messages.getMessage('flags.csv-list-delimiter.summary') });
export const dryRunFlag = Flags.boolean({ default: false, summary: messages.getMessage('flags.dry-run.summary') });
export const noPromptFlag = Flags.boolean({ default: false, summary: messages.getMessage('flags.no-prompt.summary') });
