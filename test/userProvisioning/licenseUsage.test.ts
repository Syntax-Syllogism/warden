import { expect } from 'chai';
import sinon from 'sinon';
import { calculateUserLicenseUsage } from '../../src/userProvisioning/licenseUsage.js';
import type { UserPlan } from '../../src/userProvisioning/provisionUserUseCase.js';

const planFor = (key: string, profileId: string, overrides: Partial<UserPlan> = {}): UserPlan => ({
  planId: key,
  order: 0,
  key,
  personas: ['persona'],
  effectivePersona: {},
  matchedBy: null,
  matchValue: null,
  target: { ProfileId: profileId },
  actions: [],
  errors: [],
  ...overrides,
});

describe('userProvisioning licenseUsage', () => {
  it('aggregates requirements and reports unlimited, inactive, and shortfall licenses', async () => {
    const query = sinon.stub().callsFake(async (soql: string) => {
      if (soql.includes('FROM Profile')) {
        return {
          records: [
            { Id: 'profile-unlimited', UserLicenseId: 'license-unlimited', UserLicense: { MasterLabel: 'Unlimited' } },
            { Id: 'profile-inactive', UserLicenseId: 'license-inactive', UserLicense: { Name: 'Inactive' } },
            { Id: 'profile-limited', UserLicenseId: 'license-limited', UserLicense: { Name: 'Limited' } },
          ],
        };
      }
      return {
        records: [
          { Id: 'license-unlimited', TotalLicenses: -1, UsedLicenses: 99, Status: 'Active' },
          { Id: 'license-inactive', Name: 'Inactive', TotalLicenses: 10, UsedLicenses: 2, Status: 'Inactive' },
          { Id: 'license-limited', MasterLabel: 'Limited', TotalLicenses: 2, UsedLicenses: 1, Status: 'Active' },
        ],
      };
    });
    const conn = { query } as never;

    const result = await calculateUserLicenseUsage(conn, [
      planFor('unlimited-1', 'profile-unlimited'),
      planFor('unlimited-2', 'profile-unlimited'),
      planFor('inactive', 'profile-inactive'),
      planFor('limited', 'profile-limited'),
      planFor('existing', 'profile-limited', { existing: { Id: '005existing' } }),
      planFor('invalid', 'profile-limited', { errors: ['invalid'] }),
    ]);

    expect(result).to.deep.equal([
      { licenseName: 'Unlimited', required: 2, available: null, unlimited: true, shortfall: 0, note: 'unlimited' },
      {
        licenseName: 'Inactive',
        required: 1,
        available: 0,
        unlimited: false,
        shortfall: 1,
        note: 'status Inactive',
      },
      { licenseName: 'Limited', required: 1, available: 1, unlimited: false, shortfall: 0 },
    ]);
  });
});
