import { readFile, writeFile } from 'node:fs/promises';

const [source, ...extraArgs] = process.argv.slice(2);
if (!source || extraArgs.length) {
  console.error('Usage: npm run sync:base-contract -- <path-or-url>');
  process.exitCode = 1;
} else {
  try {
    let contents;
    if (/^https?:\/\//i.test(source)) {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
      contents = await response.text();
    } else {
      contents = await readFile(source, 'utf8');
    }

    const contract = JSON.parse(contents);
    const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (
      contract?.package !== 'warden-base' ||
      typeof contract.version !== 'string' ||
      !isRecord(contract.objects) ||
      Object.keys(contract.objects).length === 0 ||
      !Object.values(contract.objects).every(
        (object) => isRecord(object?.fields) && isRecord(object.childRelationships)
      ) ||
      !isRecord(contract.permissionSets)
    ) {
      throw new Error('Expected a warden-base contract with a version, objects, and permission sets.');
    }

    await writeFile(new URL('../test/fixtures/warden-base-contract.json', import.meta.url), contents);
    console.log(`Pinned warden-base contract ${contract.version}.`);
  } catch (error) {
    console.error(`Could not sync warden-base contract: ${error.message}`);
    process.exitCode = 1;
  }
}
