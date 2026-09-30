// aloop work-item configuration for warden: luna implements, terra reviews,
// both at high effort. Task files live in ~/wiki/work-items (the work-item
// preset's separate task-file repository).
export default {
  preset: 'work-item',
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'jprichter',
  engines: {
    default: { name: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    review: { name: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
  },
  phases: ['implement', 'docs', 'gate', 'review', 'address', 'pr-description', 'publish'],
  gate: [
    'yarn install --frozen-lockfile --ignore-scripts',
    './node_modules/.bin/tsc -p . --noEmit',
    'yarn test',
  ],
  maxRounds: 3,
  timeoutMs: 60 * 60 * 1000,
};
