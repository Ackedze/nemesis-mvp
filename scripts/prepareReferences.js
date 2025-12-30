const fs = require('fs');
const path = require('path');

const referenceListPath = path.resolve(
  __dirname,
  '../src/reference/referenceSources.json',
);
const outputPath = path.resolve(
  __dirname,
  '../JSONS-MVP/referenceSourcesMVP.json',
);

if (!fs.existsSync(outputPath)) {
  const payload = JSON.parse(fs.readFileSync(referenceListPath, 'utf8'));
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
  console.log(
    `Prepared reference sources list with ${payload.catalogs?.length ?? 0} files → ${outputPath}`,
  );
} else {
  console.log(
    `Skipping reference sources copy; ${outputPath} already exists and will not be overwritten.`,
  );
}
