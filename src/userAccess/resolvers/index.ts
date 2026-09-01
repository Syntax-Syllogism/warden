import type { AccessTargetResolver, AccessTargetType } from '../types.js';
import { UserAccessError } from '../types.js';
import { fieldResolver } from './field.js';
import { objectResolver } from './object.js';
import { apexClassResolver, customPermissionResolver, vfPageResolver } from './setupEntity.js';
import { tabResolver } from './tab.js';
import { recordTypeResolver } from './recordType.js';

const resolvers: Record<AccessTargetType, AccessTargetResolver> = {
  field: fieldResolver,
  object: objectResolver,
  'apex-class': apexClassResolver,
  'vf-page': vfPageResolver,
  'custom-permission': customPermissionResolver,
  tab: tabResolver,
  'record-type': recordTypeResolver,
};

export const getResolver = (type: string): AccessTargetResolver => {
  const resolver = resolvers[type as AccessTargetType];
  if (!resolver) throw new UserAccessError('errorUnsupportedAccessType', [type]);
  return resolver;
};
