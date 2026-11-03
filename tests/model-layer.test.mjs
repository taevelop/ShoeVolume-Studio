import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as THREE from 'three';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

const { applyModelLayerTransform } = await import('../lib/model-layer.ts');
const { parseLastModel, parseLastLayerModel } = await import('../lib/last-scene.ts');
const { planReferenceCapture } = await import('../lib/reference-capture.ts');
const { disposeObject } = await import('../lib/scene-geometry.ts');
const defaults = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, units: 'mm', up: 'z' };

function near(actual, expected, message, tolerance = 0.0001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
}

function nearVector(actual, expected, message) {
  actual.forEach((value, index) => near(value, expected[index], `${message}[${index}]`));
}

function groupsFor(object) {
  const pose = new THREE.Group();
  const normalization = new THREE.Group();
  const sourceAxis = new THREE.Group();
  pose.add(normalization);
  normalization.add(sourceAxis);
  sourceAxis.add(object);
  return { pose, normalization, sourceAxis };
}

function shiftedBox(dimensions) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), new THREE.MeshStandardMaterial());
  mesh.position.set(0.17, 0.23, -0.41);
  return mesh;
}

function bounds(groups) {
  return new THREE.Box3().setFromObject(groups.pose);
}

test('all supported source units normalize off-origin meshes to millimetres without resizing the design', () => {
  const expected = [244, 96, 105];
  for (const [units, factor] of Object.entries({ mm: 1, cm: 10, m: 1000, in: 25.4 })) {
    const groups = groupsFor(shiftedBox(expected.map(value => value / factor)));
    applyModelLayerTransform(groups, { ...defaults, units }, false);
    const box = bounds(groups);
    nearVector(box.getSize(new THREE.Vector3()).toArray(), expected, `${units}: dimensions`);
    nearVector(box.getCenter(new THREE.Vector3()).toArray(), [0, 0, 52.5], `${units}: centered and grounded`);
    near(box.min.z, 0, `${units}: floor`);
    disposeObject(groups.pose);
  }
});

test('metre Y-up import applies scale, rotation and translation after normalization', () => {
  const groups = groupsFor(shiftedBox([0.244, 0.105, 0.096]));
  applyModelLayerTransform(groups, {
    ...defaults, units: 'm', up: 'y', scale: 1.5,
    rotation: [0, 0, 90], position: [24, -11, 7],
  }, false);
  const box = bounds(groups);
  nearVector(box.getSize(new THREE.Vector3()).toArray(), [144, 366, 157.5], 'rotated millimetre bounds');
  nearVector(box.getCenter(new THREE.Vector3()).toArray(), [24, -11, 85.75], 'posed center');
  near(box.min.z, 7, 'translation follows grounded source');
  disposeObject(groups.pose);
});

test('repeated unit and axis edits do not accumulate transforms or mutate original vertices', () => {
  const mesh = shiftedBox([0.244, 0.105, 0.096]);
  const originalVertices = mesh.geometry.getAttribute('position').array.slice();
  const groups = groupsFor(mesh);
  const target = { ...defaults, units: 'm', up: 'y', scale: 1.2, position: [20, 30, 4], rotation: [12, -7, 37] };
  applyModelLayerTransform(groups, target, false);
  const expectedMatrix = mesh.matrixWorld.toArray();
  const expectedBounds = bounds(groups).clone();
  for (let iteration = 0; iteration < 8; iteration++) {
    applyModelLayerTransform(groups, { ...defaults, units: 'in', scale: 4, position: [-8, 12, 25] }, false);
    applyModelLayerTransform(groups, target, false);
  }
  nearVector(mesh.matrixWorld.toArray(), expectedMatrix, 'repeatable world matrix');
  nearVector(bounds(groups).min.toArray(), expectedBounds.min.toArray(), 'repeatable lower bounds');
  nearVector(bounds(groups).max.toArray(), expectedBounds.max.toArray(), 'repeatable upper bounds');
  assert.deepEqual(mesh.geometry.getAttribute('position').array, originalVertices);
  disposeObject(groups.pose);
});

test('demo Last is a separate 244 × 96 × 105 mm object and ignores imported unit and up-axis settings', async () => {
  const model = await parseLastLayerModel(null);
  const groups = groupsFor(model);
  applyModelLayerTransform(groups, { ...defaults, units: 'm', up: 'y', position: [0, 0, 5] }, true);
  const box = bounds(groups);
  nearVector(box.getSize(new THREE.Vector3()).toArray(), [244, 96, 105], 'demo dimensions');
  near(box.min.z, 5, 'demo layer offset');
  const meshes = [];
  model.traverse(child => { if (child instanceof THREE.Mesh) meshes.push(child); });
  assert.equal(meshes.length, 1, 'demo is the illustrative last, not a multi-part shoe sample');
  assert.equal(meshes[0].material.color.getHexString(), '4e9fbe');
  disposeObject(groups.pose);
});

test('editing or removing a sibling Last leaves shoe bounds, world matrix and capture framing unchanged', () => {
  const scene = new THREE.Scene();
  const shoeMesh = shiftedBox([253, 105.31, 79.4]);
  const shoe = groupsFor(shoeMesh);
  const last = groupsFor(shiftedBox([244, 96, 105]));
  scene.add(shoe.pose, last.pose);
  applyModelLayerTransform(shoe, { ...defaults, position: [5, -6, 7] }, true);
  const before = planReferenceCapture(bounds(shoe), 1024);
  const shoeMatrix = shoeMesh.matrixWorld.toArray();
  applyModelLayerTransform(last, { ...defaults, scale: 3, position: [800, -350, 50], rotation: [35, 60, 75] }, true);
  scene.updateMatrixWorld(true);
  assert.deepEqual(planReferenceCapture(bounds(shoe), 1024), before);
  nearVector(shoeMesh.matrixWorld.toArray(), shoeMatrix, 'independent shoe matrix');
  disposeObject(last.pose);
  assert.deepEqual(planReferenceCapture(bounds(shoe), 1024), before);
  disposeObject(shoe.pose);
});

test('the same uploaded asset parsed for both layers owns independent geometry and material resources', async () => {
  const asset = {
    name: 'shared-source.obj', format: 'obj',
    dataUrl: 'data:application/octet-stream;base64,' + Buffer.from('v 0 0 0\nv 244 0 0\nv 0 96 105\nf 1 2 3\n').toString('base64'),
  };
  const shoe = await parseLastModel(asset);
  const last = await parseLastLayerModel(asset);
  const meshes = root => { const list = []; root.traverse(child => { if (child instanceof THREE.Mesh) list.push(child); }); return list; };
  const shoeMesh = meshes(shoe)[0];
  const lastMesh = meshes(last)[0];
  assert.notEqual(shoeMesh.geometry, lastMesh.geometry);
  assert.notEqual(shoeMesh.material, lastMesh.material);
  assert.equal(shoeMesh.material.color.getHexString(), 'aeb8a2', 'Last recoloring leaves shoe unchanged');
  assert.equal(lastMesh.material.color.getHexString(), '4e9fbe');
  let lastDisposals = 0;
  lastMesh.geometry.addEventListener('dispose', () => { lastDisposals++; });
  lastMesh.material.addEventListener('dispose', () => { lastDisposals++; });
  disposeObject(shoe);
  assert.equal(lastDisposals, 0, 'disposing the shoe does not dispose Last resources');
  nearVector(new THREE.Box3().setFromObject(last).getSize(new THREE.Vector3()).toArray(), [244, 96, 105], 'surviving Last bounds');
  disposeObject(last);
  assert.equal(lastDisposals, 2, 'Last disposes only its own geometry and material');
});
