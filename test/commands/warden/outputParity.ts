import { readFileSync } from 'node:fs';
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

const normalize = (output: MachineOutput): MachineOutput =>
  JSON.parse(JSON.stringify(output).replace(/\/tmp\/warden-[^/"\\\s]+/g, '<fixture>')) as MachineOutput;

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
