import type { Connection } from '@salesforce/core';
import { soqlIn } from '../userShared/sfUtils.js';
import type { UserPlan } from './provisionUserUseCase.js';

export type UserLicenseUsage = {
  licenseName: string;
  required: number;
  available: number | null;
  unlimited: boolean;
  shortfall: number;
  note?: string;
};

export type PermissionSetLicenseSummary = {
  evaluated: false;
  note: 'not evaluated';
};

type ProfileLicenseRecord = {
  Id: string;
  UserLicenseId?: string;
  UserLicense?: { Name?: string; MasterLabel?: string };
};

type UserLicenseRecord = {
  Id: string;
  Name?: string;
  MasterLabel?: string;
  TotalLicenses?: number;
  UsedLicenses?: number;
  Status?: string;
};

export const calculateUserLicenseUsage = async (conn: Connection, plans: UserPlan[]): Promise<UserLicenseUsage[]> => {
  const requiredByProfile = new Map<string, number>();
  for (const plan of plans) {
    if (plan.existing) continue;
    if (plan.errors.length > 0) continue;
    const profileId = typeof plan.target.ProfileId === 'string' ? plan.target.ProfileId : undefined;
    if (profileId) requiredByProfile.set(profileId, (requiredByProfile.get(profileId) ?? 0) + 1);
  }
  if (requiredByProfile.size === 0) return [];

  const profileRows = (
    await conn.query<ProfileLicenseRecord>(
      `SELECT Id, UserLicenseId, UserLicense.Name, UserLicense.MasterLabel FROM Profile WHERE Id IN (${soqlIn([
        ...requiredByProfile.keys(),
      ])})`
    )
  ).records;
  const requiredByLicense = new Map<string, { required: number; profileLicenseName?: string }>();
  for (const profile of profileRows) {
    if (!profile.UserLicenseId) continue;
    const required = requiredByProfile.get(profile.Id) ?? 0;
    const current = requiredByLicense.get(profile.UserLicenseId);
    requiredByLicense.set(profile.UserLicenseId, {
      required: (current?.required ?? 0) + required,
      profileLicenseName: current?.profileLicenseName ?? profile.UserLicense?.MasterLabel ?? profile.UserLicense?.Name,
    });
  }
  if (requiredByLicense.size === 0) return [];

  const licenseRows = (
    await conn.query<UserLicenseRecord>(
      `SELECT Id, Name, MasterLabel, TotalLicenses, UsedLicenses, Status FROM UserLicense WHERE Id IN (${soqlIn([
        ...requiredByLicense.keys(),
      ])})`
    )
  ).records;
  const licensesById = new Map(licenseRows.map((license) => [license.Id, license]));

  return [...requiredByLicense.entries()].map(([licenseId, requirement]) => {
    const license = licensesById.get(licenseId);
    const total = Number(license?.TotalLicenses ?? 0);
    const used = Number(license?.UsedLicenses ?? 0);
    const unlimited = total < 0;
    const active = license?.Status?.toLowerCase() === 'active';
    const available = unlimited ? null : active ? total - used : 0;
    const shortfall = unlimited ? 0 : Math.max(requirement.required - (available ?? 0), 0);
    return {
      licenseName: license?.MasterLabel ?? license?.Name ?? requirement.profileLicenseName ?? licenseId,
      required: requirement.required,
      available,
      unlimited,
      shortfall,
      ...(unlimited ? { note: 'unlimited' } : !active ? { note: `status ${license?.Status ?? 'unknown'}` } : {}),
    };
  });
};
