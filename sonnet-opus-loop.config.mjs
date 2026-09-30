// Sonnet/Opus variant of luna-terra-loop.config.mjs: used to finish in-flight
// runs while codex usage is unavailable. Only the engines differ.
// aloop work-item configuration for warden: Sonnet 5 (high) implements, Opus 5.5 (medium)
// reviews. Task files live in ~/wiki/work-items (the work-item
// preset's separate task-file repository).
export default {
  preset: 'work-item',
  baseBranch: 'master',
  branchPrefix: 'feat/',
  remote: 'jprichter',
  engines: {
    default: { name: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    review: { name: 'claude', model: 'claude-opus-5-5', effort: 'medium' },
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
