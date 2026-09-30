export default {
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'jprichter',
  engines: {
    default: { name: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    review: { name: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
  },
  phases: ['implement', 'gate', 'review', 'address', 'docs', 'git'],
  gate: [
    'yarn install --frozen-lockfile --ignore-scripts',
    './node_modules/.bin/tsc -p . --noEmit',
    'yarn test',
  ],
  maxRounds: 3,
  timeoutMs: 60 * 60 * 1000,
  worktrees: true,
  commitWorkItem: true,
};
