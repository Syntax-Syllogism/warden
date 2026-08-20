import { expect } from 'chai';
import UserAccess from '../../src/commands/warden/access.js';
import UserDiff from '../../src/commands/warden/diff.js';
import UserFreeze from '../../src/commands/warden/freeze.js';
import UserProvision from '../../src/commands/warden/provision.js';
import UserRestore from '../../src/commands/warden/restore.js';
import UserSnapshot from '../../src/commands/warden/snapshot.js';
import UserStrip from '../../src/commands/warden/strip.js';
import UserUnfreeze from '../../src/commands/warden/unfreeze.js';
import {
  apiVersionFlag,
  csvListDelimiterFlag,
  dryRunFlag,
  externalIdFlag,
  inputFormatFlag,
  noPromptFlag,
  targetOrgFlag,
  userFlag,
  usersDefFlag,
} from '../../src/userShared/targetFlags.js';

describe('shared target flags', () => {
  it('uses the shared target-org and api-version flags in every command', () => {
    for (const command of [
      UserAccess,
      UserDiff,
      UserFreeze,
      UserProvision,
      UserRestore,
      UserSnapshot,
      UserStrip,
      UserUnfreeze,
    ]) {
      expect(command.flags['target-org']).to.equal(targetOrgFlag);
      expect(command.flags['api-version']).to.equal(apiVersionFlag);
    }
  });

  it('uses shared selection, input, and lifecycle flags at their matching call sites', () => {
    for (const command of [UserFreeze, UserSnapshot, UserStrip, UserUnfreeze]) {
      expect(command.flags.user).to.equal(userFlag);
      expect(command.flags['users-def']).to.equal(usersDefFlag);
    }
    expect(UserDiff.flags['users-def']).to.equal(usersDefFlag);

    for (const command of [UserDiff, UserFreeze, UserSnapshot, UserStrip, UserUnfreeze]) {
      expect(command.flags['external-id']).to.equal(externalIdFlag);
    }
    for (const command of [UserDiff, UserFreeze, UserProvision, UserSnapshot, UserStrip, UserUnfreeze]) {
      expect(command.flags['input-format']).to.equal(inputFormatFlag);
      expect(command.flags['csv-list-delimiter']).to.equal(csvListDelimiterFlag);
    }
    for (const command of [UserFreeze, UserProvision, UserRestore, UserStrip, UserUnfreeze]) {
      expect(command.flags['dry-run']).to.equal(dryRunFlag);
    }
    for (const command of [UserFreeze, UserRestore, UserStrip, UserUnfreeze]) {
      expect(command.flags['no-prompt']).to.equal(noPromptFlag);
    }
  });

  it('retains deliberate command-specific flag definitions', () => {
    expect(UserDiff.flags.user).not.to.equal(userFlag);
    expect(UserProvision.flags['users-def']).not.to.equal(usersDefFlag);
    expect(UserProvision.flags['external-id']).not.to.equal(externalIdFlag);
    expect(UserProvision.flags['no-prompt']).not.to.equal(noPromptFlag);
  });
});
