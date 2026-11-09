// Formatting never fails a commit: Prettier rewrites staged files in place.
// markdownlint --fix repairs what it can after Prettier, then fails on the rest.
module.exports = {
  '*.md': ['prettier --write', 'markdownlint-cli2 --fix'],
  '*.{js,mjs,cjs,ts,mts,cts,json,jsonc,yml,yaml,css}': 'prettier --write --ignore-unknown',
};
