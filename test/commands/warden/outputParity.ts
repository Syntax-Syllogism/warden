import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import sinon from 'sinon';
import { WardenCommand, type OutputContext } from '../../../src/wardenCommand.js';

type MachineOutput = { result: unknown; csv: string };
const goldenOutputs = {
  ...(JSON.parse(readFileSync(new URL('./fixtures/core-0.2-output.json', import.meta.url), 'utf8')) as Record<
    string,
    MachineOutput[]
  >),
  ...(JSON.parse(readFileSync(new URL('./fixtures/remaining-command-output.json', import.meta.url), 'utf8')) as Record<
    string,
    MachineOutput[]
  >),
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Goldens were captured on Linux (/tmp/warden-*). Match the platform temp dir too, as it appears
// inside serialized JSON (backslashes doubled on Windows), and normalize the separators after it.
const fixtureRoots = [...new Set(['/tmp', tmpdir()])]
  .map((root) => escapeRegExp(JSON.stringify(root).slice(1, -1)))
  .join('|');
const separator = String.raw`(?:/|\\\\)`;
const segment = String.raw`[^/"\\\s]+`;
const fixturePath = new RegExp(`(?:${fixtureRoots})${separator}warden-${segment}((?:${separator}${segment})*)`, 'g');

const normalize = (output: MachineOutput): MachineOutput =>
  JSON.parse(
    JSON.stringify(output).replace(fixturePath, (_match, rest: string) => `<fixture>${rest.replace(/\\\\/g, '/')}`)
  ) as MachineOutput;

/** Machine output captured before each command cutover; compare JSON key order and CSV bytes. */
export const checkLegacyOutput = (title: string): (() => void) => {
  const expected = goldenOutputs[title];
  if (!expected) return () => undefined;
  const prototype = WardenCommand.prototype as unknown as {
    emitResult: (context: OutputContext, payload: MachineOutput & { human: string }) => Promise<void>;
  };
  const original = prototype.emitResult;
  let calls = 0;
  sinon.stub(prototype, 'emitResult').callsFake(async function (this: unknown, context, payload) {
    expect(JSON.stringify(normalize({ result: payload.result, csv: payload.csv })), title).to.equal(
      JSON.stringify(expected[calls])
    );
    calls += 1;
    return original.call(this, context, payload);
  });
  return () => expect(calls, `${title}: emitted outputs`).to.equal(expected.length);
};
