import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.sites-runtime', 'shoe-export-runtime');
const destination = path.join(root, 'public', 'samples');
await fs.mkdir(runtime, { recursive: true });
await fs.mkdir(destination, { recursive: true });

// The exporter uses FileReader for its in-memory binary Blob; no network or DOM is needed.
globalThis.FileReader ??= class {
  result = null;
  onloadend = null;
  onerror = null;
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((data) => {
      this.result = data;
      this.onloadend?.();
    }).catch((error) => this.onerror?.(error));
  }
};

for (const name of ['shoe-sample-catalog', 'shoe-samples']) {
  const source = (await fs.readFile(path.join(root, 'lib', `${name}.ts`), 'utf8'))
    .replaceAll("'./shoe-sample-catalog'", "'./shoe-sample-catalog.mjs'");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await fs.writeFile(path.join(runtime, `${name}.mjs`), output);
}

const { createShoeSample } = await import(pathToFileURL(path.join(runtime, 'shoe-samples.mjs')).href);
const { SHOE_SAMPLES } = await import(pathToFileURL(path.join(runtime, 'shoe-sample-catalog.mjs')).href);
const results = [];

function boundsOf(object) {
  object.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(object);
  return { min: bounds.min.toArray(), max: bounds.max.toArray(), dimensions: bounds.getSize(new THREE.Vector3()).toArray() };
}

function assertDimensions(actual, expected, tolerance, label) {
  if (actual.some((value, index) => !Number.isFinite(value) || Math.abs(value - expected[index]) > tolerance)) {
    throw new Error(`${label}: dimensions ${actual.join(', ')} differ from ${expected.join(', ')}`);
  }
}

for (const definition of SHOE_SAMPLES) {
  const model = createShoeSample(definition.id);
  const bounds = boundsOf(model);
  assertDimensions(bounds.dimensions, definition.dimensions, 0.0001, definition.id);
  if (Math.abs(bounds.min[2]) > 0.0001 || Math.abs(bounds.min[0] + bounds.max[0]) > 0.0001 || Math.abs(bounds.min[1] + bounds.max[1]) > 0.0001) throw new Error(`${definition.id}: coordinate origin mismatch`);
  let triangles = 0, meshes = 0;
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    meshes++;
    triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
    const position = object.geometry.getAttribute('position');
    const normal = object.geometry.getAttribute('normal');
    for (let i = 0; i < position.count; i++) {
      if (![position.getX(i), position.getY(i), position.getZ(i), normal.getX(i), normal.getY(i), normal.getZ(i)].every(Number.isFinite)) throw new Error(`${definition.id}: invalid vertex or normal`);
    }
  });
  if (triangles > 30000) throw new Error(`${definition.id}: triangle budget exceeded (${triangles})`);

  const binaryStl = new STLExporter().parse(model, { binary: true });
  const stlBytes = Buffer.from(binaryStl.buffer, binaryStl.byteOffset, binaryStl.byteLength);
  await fs.writeFile(path.join(destination, `${definition.id}.stl`), stlBytes);
  const stlGeometry = new STLLoader().parse(stlBytes.buffer.slice(stlBytes.byteOffset, stlBytes.byteOffset + stlBytes.byteLength));
  stlGeometry.computeBoundingBox();
  assertDimensions(stlGeometry.boundingBox.getSize(new THREE.Vector3()).toArray(), definition.dimensions, 0.001, `${definition.id} STL roundtrip`);
  stlGeometry.dispose();

  const glbRoot = new THREE.Group();
  glbRoot.name = `${definition.englishName} — concept shoe / metres / Y-up`;
  glbRoot.userData = { conceptOnly: true, sampleKind: definition.id, dimensionsMm: definition.dimensions };
  glbRoot.rotation.x = -Math.PI / 2;
  glbRoot.scale.setScalar(0.001);
  glbRoot.add(model);
  glbRoot.updateMatrixWorld(true);
  const glb = await new GLTFExporter().parseAsync(glbRoot, { binary: true, onlyVisible: true });
  const glbBytes = Buffer.from(glb);
  await fs.writeFile(path.join(destination, `${definition.id}.glb`), glbBytes);
  const imported = await new GLTFLoader().parseAsync(glb, '');
  const importedSize = boundsOf(imported.scene).dimensions;
  assertDimensions(importedSize, [definition.dimensions[0] / 1000, definition.dimensions[2] / 1000, definition.dimensions[1] / 1000], 0.000001, `${definition.id} GLB roundtrip`);
  results.push({ id: definition.id, name: definition.name, dimensionsMm: bounds.dimensions.map((n) => Math.round(n * 1000) / 1000), meshes, triangles, glbBytes: glbBytes.length, stlBytes: stlBytes.length });
}

const manifest = {
  description: 'Illustrative multi-part concept shoes, not measured production models. Some component solids overlap; manufacturing suitability has not been validated.',
  coordinateSystems: { stl: { units: 'mm', up: 'z', toe: '+x' }, glb: { units: 'm', up: 'y', toe: '+x' } },
  samples: results,
};
await fs.writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
