#!/usr/bin/env node
// Guard against publishing an empty package — the failure mode behind the
// command-less 0.1.0, where wireit's build cache let `oclif manifest` run
// against an empty lib/ and ship a 42-byte, command-less manifest.
//
// We inspect a real tarball produced by `npm pack` (run beforehand) rather
// than parsing `npm pack --dry-run --json` stdout: the prepack build prints
// ANSI progress codes (e.g. \x1b[2K\x1b[1G) whose '[' bytes corrupt naive
// JSON slicing. Reading the actual .tgz is immune to stdout noise, and the
// CI workflow then publishes this exact verified file (npm does not re-run
// prepack when given a tarball), so the published bytes are what we checked.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';

const tgz = process.argv[2] ?? readdirSync('.').find((f) => f.endsWith('.tgz'));
if (!tgz) {
  console.error('No tarball found. Run `npm pack` before this script.');
  process.exit(1);
}

const entries = execSync(`tar tzf ${tgz}`, { encoding: 'utf8' }).split(/\r?\n/);
const libCommands = entries.filter((p) => p.startsWith('package/lib/commands/') && p.endsWith('.js'));

execSync(`tar xzf ${tgz} package/oclif.manifest.json`);
const manifestText = readFileSync('package/oclif.manifest.json', 'utf8').replace(/^﻿/, '');
const manifest = JSON.parse(manifestText);
rmSync('package', { recursive: true, force: true });
const ids = Object.keys(manifest.commands ?? {});

if (libCommands.length === 0 || ids.length === 0) {
  console.error('Refusing to publish an empty package:');
  console.error(`  compiled command files: ${libCommands.length}`);
  console.error(`  manifest command ids:   ${ids.length}`);
  process.exit(1);
}

console.log(`Pack OK: ${libCommands.length} compiled command file(s); manifest commands: ${ids.join(', ')}`);
