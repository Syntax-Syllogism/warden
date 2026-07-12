#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const smokeProjectDir = resolve(repoRoot, 'smoke');
const args = process.argv.slice(2);
const assumeYes = args.includes('--yes');
const runId = timestamp();
const commandsPath = getOption('--commands');
if (!commandsPath) {
  console.error('Usage: node scripts/run-smoke-tests.mjs --commands <commands.md> [--project-dir <sfdx-project>] [--yes]');
  process.exit(1);
}
const commandsFile = resolve(commandsPath);
const projectDir = resolve(getOption('--project-dir', smokeProjectDir));
const reportFile = resolve(getOption('--report', resolve(repoRoot, `smoke-test-report-${runId}.md`)));
const failuresFile = resolve(getOption('--failures', resolve(repoRoot, `smoke-test-failures-${runId}.md`)));

function getOption(name, fallback) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

function extractCommands(markdown) {
  const commands = [];
  let section = 'Uncategorized';
  let check;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^#{1,6}\s+/.test(line) && !line.startsWith('# Check:')) {
      section = line.replace(/^#+\s+/, '');
    }
    if (line.startsWith('# Check:')) {
      check = line.slice('# Check:'.length).trim();
    }
    if (line.startsWith('./bin/dev.js ')) {
      commands.push({ command: line, section, check: check ?? inferCheck(line) });
      check = undefined;
    }
  }

  return commands;
}

function inferCheck(command) {
  if (command.includes('provision')) return 'Review planned users, profiles, assignments, warnings, and changes.';
  if (command.includes('diff')) return 'Review the reported profile, role, and assignment differences.';
  if (command.includes('snapshot')) return 'Confirm the snapshot contains the intended existing users and assignments.';
  if (command.includes('restore')) return 'Confirm the snapshot resolves and the restore plan is additive.';
  if (command.includes('unfreeze')) return 'Confirm only login restoration is planned.';
  if (command.includes('freeze')) return 'Confirm only login state changes are planned.';
  if (command.includes('strip')) return 'Confirm the snapshot is written and no destructive DML occurs in dry-run mode.';
  if (command.includes('access')) return 'Confirm the target resolves and the structured access result is valid.';
  return 'Review the command output and files it created.';
}

function splitArguments(value) {
  return [...value.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)].map((match) =>
    match[0].replace(/^(['"])(.*)\1$/, '$2')
  );
}

function runCommand(command) {
  const commandArgs = splitArguments(command.slice('./bin/dev.js '.length).trim());
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [resolve(repoRoot, 'bin/dev.js'), ...commandArgs], {
      cwd: projectDir,
      env: process.env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      output.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      output.write(chunk);
    });
    child.on('error', (error) => resolveResult({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

async function askYesNo(rl, question) {
  while (true) {
    const answer = (await rl.question(`${question} [y/n] `)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log('Please answer y or n.');
  }
}

function markdownDetails(value) {
  return value ? `\n\n\`\`\`text\n${value.trim().replaceAll('```', '\`\`\\`')}\n\`\`\`` : '';
}

async function validateProject() {
  const projectFile = resolve(projectDir, 'sfdx-project.json');
  await stat(projectFile);
  await mkdir(resolve(projectDir, 'snapshots'), { recursive: true });
  await mkdir(resolve(projectDir, 'sfdx-reference'), { recursive: true });
}

const markdown = await readFile(commandsFile, 'utf8');
const commands = extractCommands(markdown);
if (commands.length === 0) {
  throw new Error(`No executable commands found in ${commandsFile}`);
}
await validateProject();

const rl = createInterface({ input, output });
const results = [];

try {
  console.log(`Running ${commands.length} smoke tests from ${commandsFile}`);
  console.log(`Working directory: ${projectDir}\n`);

  for (let index = 0; index < commands.length; index += 1) {
    const test = commands[index];
    console.log(`\n=== ${index + 1}/${commands.length} ===`);
    console.log(`[${test.section}]`);
    console.log(`Check: ${test.check}`);
    console.log(`$ ${test.command}`);
    const execution = await runCommand(test.command);

    if (execution.exitCode === 0) {
      console.log('\nCommand completed successfully.');
    } else {
      console.log(`\nCommand failed with exit code ${execution.exitCode ?? 'unknown'}.`);
      console.log('Captured output is included in the final report.');
    }

    const worked = assumeYes ? true : await askYesNo(rl, 'Did this work as expected?');
    if (worked) {
      results.push({ ...test, status: execution.exitCode === 0 ? 'worked' : 'failed', execution });
      continue;
    }

    const details = (await rl.question('What did not work as expected? ')).trim();
    results.push({
      ...test,
      status: execution.exitCode === 0 ? 'user-reported-issue' : 'failed',
      details,
      execution,
    });
  }
} finally {
  rl.close();
}

const failedResults = results.filter((result) => result.status !== 'worked');
const report = [
  '# Smoke Test Report',
  '',
  `- Run at: ${new Date().toISOString()}`,
  `- Commands file: \`${commandsFile}\``,
  `- Working directory: \`${projectDir}\``,
  `- Failed commands file: \`${failuresFile}\``,
  `- Total: ${results.length}`,
  `- Worked: ${results.filter((result) => result.status === 'worked').length}`,
  `- Failed: ${results.filter((result) => result.status === 'failed').length}`,
  `- User-reported issues: ${results.filter((result) => result.status === 'user-reported-issue').length}`,
  '',
  '## Results',
  '',
  ...results.flatMap((result, index) => [
    `### ${index + 1}. ${result.status}`,
    '',
    `**${result.section}**`,
    '',
    `Check: ${result.check}`,
    '',
    `\`${result.command}\``,
    '',
    `- Exit code: ${result.execution.exitCode ?? 'unknown'}`,
    ...(result.details ? [`- User details: ${result.details}`] : []),
    ...(result.execution.exitCode !== 0 && (result.execution.stderr.trim() || result.execution.stdout.trim())
      ? [`- Captured error/output:${markdownDetails(`${result.execution.stderr}\n${result.execution.stdout}`)}`]
      : []),
    '',
  ]),
].join('\n');

const failures = [
  '# Failed Smoke Test Commands',
  '',
  `- Run at: ${new Date().toISOString()}`,
  `- Source commands file: \`${commandsFile}\``,
  `- Working directory: \`${projectDir}\``,
  '',
  ...(failedResults.length === 0
    ? ['No failed or user-reported commands.']
    : failedResults.flatMap((result, index) => [
        `## ${index + 1}. ${result.status} — ${result.section}`,
        '',
        `# Check: ${result.check}`,
        ...(result.details ? [`# User details: ${result.details}`] : []),
        ...(result.execution.exitCode !== 0 ? [`# Exit code: ${result.execution.exitCode ?? 'unknown'}`] : []),
        result.command,
        '',
      ])),
].join('\n');

await writeFile(reportFile, `${report}\n`, 'utf8');
await writeFile(failuresFile, `${failures}\n`, 'utf8');
console.log(`\nReport written to ${reportFile}`);
console.log(`Failed commands written to ${failuresFile}`);
