# Contributing to warden

Thanks for helping out. warden is an open-source Salesforce CLI plugin, and we welcome all kinds of contributions.

## Ways to contribute

1. **Report a bug.** Open an issue with a clear description and steps to reproduce it.
2. **Suggest a feature.** Open an issue to discuss it before you start building.
3. **Send a pull request.**
   - Fork the repository and create a topic branch.
   - Write clear code and tests. Pull requests need unit tests.
   - Run `yarn build`, `yarn test`, and `yarn lint:md`.
   - Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/) style, such as `fix: handle a missing profile`. A commit hook checks them.
   - If you changed command help, run `yarn docs:cli-reference` to regenerate `docs/cli-reference.md`.
   - Open a pull request that describes the change and how you verified it.

## Development setup

You need Node.js, [yarn](https://classic.yarnpkg.com/), and the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli).

```bash
git clone git@github.com:Syntax-Syllogism/warden
cd warden
yarn install
yarn build
```

Run the plugin from source:

```bash
node ./bin/dev.js warden freeze --help
```

To run it from anywhere through the Salesforce CLI, link it:

```bash
sf plugins link .
sf plugins   # verify
```

For how the command layer and the shared `@syntax-syllogism/warden-core` library fit together, see the [architecture notes](docs/contributing/architecture.md). To learn how to use Warden, see [Getting started](docs/getting-started.md). [docs/cli-reference.md](docs/cli-reference.md) is generated, so change command help in `messages/` or the command classes instead of editing it by hand.

## Code of Conduct

This project follows a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By taking part, you agree to it.
