import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { assertOutputCompatibility, emitOutput, globalJsonPayload } from '../../src/userShared/outputFlags.js';

describe('shared output contract', () => {
  it('requires an output file when a machine output and global json are combined', () => {
    expect(() => assertOutputCompatibility('csv', undefined, true)).to.throw('--output-file');
    expect(() => assertOutputCompatibility('csv', 'audit.csv', true)).not.to.throw();
  });

  it('implements every combination-matrix output destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'warden-output-'));
    const cases = [
      { name: 'human', format: 'human' as const, jsonOutput: false, file: undefined, logs: ['human'] },
      { name: 'csv', format: 'csv' as const, jsonOutput: false, file: undefined, logs: ['csv'] },
      { name: 'csv file', format: 'csv' as const, jsonOutput: false, file: 'csv', logs: ['human'] },
      { name: 'global json', format: 'human' as const, jsonOutput: true, file: undefined, logs: [] },
      { name: 'csv file plus global json', format: 'csv' as const, jsonOutput: true, file: 'csv-json', logs: [] },
      { name: 'global json file', format: 'human' as const, jsonOutput: true, file: 'json', logs: [] },
    ];

    const results = await Promise.all(
      cases.map(async (testCase) => {
        const outputFile = testCase.file ? join(directory, `${testCase.file}.out`) : undefined;
        const logs: string[] = [];
        await emitOutput({
          result: { ok: true },
          format: testCase.format,
          outputFile,
          jsonOutput: testCase.jsonOutput,
          csv: 'csv',
          human: 'human',
          log: (message) => logs.push(message),
        });
        const fileContent = outputFile ? await readFile(outputFile, 'utf8') : undefined;
        return { testCase, logs, fileContent };
      })
    );

    for (const { testCase, logs, fileContent } of results) {
      expect(logs, testCase.name).to.deep.equal(testCase.logs);
      if (testCase.file === 'csv' || testCase.file === 'csv-json') {
        expect(fileContent, testCase.name).to.equal('csv\n');
      } else if (testCase.file === 'json') {
        expect(JSON.parse(fileContent as string)).to.deep.include({ status: 0 });
      }
    }

    expect(globalJsonPayload({ ok: true })).to.include('"status": 0');
  });
});
