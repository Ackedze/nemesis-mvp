const fs = require('node:fs');
const path = require('node:path');

const referenceListPath = path.resolve(
  __dirname,
  '../src/reference/referenceSources.json',
);
const jsonsPath = path.resolve(
  __dirname,
  '../JSONS-MVP/referenceSourcesMVP.json',
);
const remoteReferenceUrl =
  'https://ackedze.github.io/nemesis-mvp/JSONS-MVP/referenceSourcesMVP.json';

function writeReferenceFiles(payload) {
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(referenceListPath, serialized);
  fs.writeFileSync(jsonsPath, serialized);
  console.log(
    `Prepared reference sources list with ${payload.catalogs?.length ?? 0} files → ${jsonsPath}`,
  );
}

async function main() {
  const response = await fetch(remoteReferenceUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch reference list (${response.status} ${response.statusText})`,
    );
  }
  const payload = await response.json();
  writeReferenceFiles(payload);
}

main().catch((error) => {
  console.error(`[Nemesis] Unable to load reference catalog list:`, error);
  process.exit(1);
});
