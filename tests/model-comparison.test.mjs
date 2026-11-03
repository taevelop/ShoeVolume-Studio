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

const { createComparisonModels } = await import('../lib/last-scene.ts');
const { createDefaultProject } = await import('../lib/project.ts');
const { createShapedShoeSample } = await import('../lib/sample-shape.ts');
const { planReferenceCapture } = await import('../lib/reference-capture.ts');
const { computeModelSection } = await import('../lib/section-analysis.ts');
const { disposeObject } = await import('../lib/scene-geometry.ts');
const near = (actual, expected, message, tolerance = 0.0001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
const vectorNear = (actual, expected, message) => actual.forEach((value, index) => near(value, expected[index], `${message}[${index}]`));

function meshes(root) { const list = []; root.traverse(object => { if (object instanceof THREE.Mesh) list.push(object); }); return list; }
function materials(root) { return new Set(meshes(root).flatMap(mesh => Array.isArray(mesh.material) ? mesh.material : [mesh.material])); }
function bounds(root) { root.updateMatrixWorld(true); return new THREE.Box3().setFromObject(root, true); }
function vertices(root) {
  root.updateMatrixWorld(true);
  const values = [], point = new THREE.Vector3();
  for (const mesh of meshes(root)) for (let index = 0; index < mesh.geometry.getAttribute('position').count; index++) {
    mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
    values.push(point.toArray());
  }
  return values;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('saved edited shoe and enabled Last reconstruct their exact separate world poses without mutating the snapshot', async () => {
  const snapshot = createDefaultProject();
  snapshot.settings.sampleKind = 'sneaker';
  snapshot.settings.sampleShape = { length: 281, ballWidthDelta: 18, heelWidthDelta: -5, toeHeightDelta: 9, instepHeightDelta: 13 };
  Object.assign(snapshot.settings, { modelPosition: [25, -12, 8], modelRotation: [0, 0, 90], modelScale: 1.1, showLast: false });
  Object.assign(snapshot.last, { enabled: true, visible: false, position: [-18, 9, 4], rotation: [0, 0, -90], scale: 0.95 });
  const before = JSON.stringify(snapshot);
  freeze(snapshot);
  const comparison = await createComparisonModels(snapshot);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(comparison.shoe.parent, comparison.root);
  assert.equal(comparison.last.parent, comparison.root);
  assert.equal(comparison.shoe.visible, true); assert.equal(comparison.last.visible, true);
  const source = createShapedShoeSample('sneaker', snapshot.settings.sampleShape), sourceBounds = bounds(source);
  const center = sourceBounds.getCenter(new THREE.Vector3());
  const originalVertices = vertices(source), restoredVertices = vertices(comparison.shoe);
  assert.equal(restoredVertices.length, originalVertices.length);
  for (let index = 0; index < originalVertices.length; index++) {
    const [x, y, z] = originalVertices[index];
    vectorNear(restoredVertices[index], [25 - (y - center.y) * 1.1, -12 + (x - center.x) * 1.1, 8 + (z - sourceBounds.min.z) * 1.1], 'saved shoe vertex after known 90° rotation');
  }
  const shoeBounds = bounds(comparison.shoe), lastBounds = bounds(comparison.last);
  near(shoeBounds.getSize(new THREE.Vector3()).y, 281 * 1.1, 'edited length and pose scale');
  vectorNear(lastBounds.getSize(new THREE.Vector3()).toArray(), [96 * 0.95, 244 * 0.95, 105 * 0.95], 'independent rotated Last dimensions');
  vectorNear(lastBounds.getCenter(new THREE.Vector3()).toArray(), [-18, 9, 4 + 105 * 0.95 / 2], 'independent Last center');
  disposeObject(source); disposeObject(comparison.root);
});

test('saved uploaded GLB and OBJ sources retain their own units and axis rules, overriding dormant sample settings', async () => {
  const snapshot = createDefaultProject();
  snapshot.model = {
    name: 'saved-sneaker.glb', format: 'glb',
    dataUrl: 'data:model/gltf-binary;base64,' + readFileSync(new URL('../public/samples/sneaker.glb', import.meta.url)).toString('base64'),
  };
  Object.assign(snapshot.settings, { sampleKind: 'ankle-boot', modelUnits: 'm', modelUp: 'y', modelPosition: [12, -7, 3], modelRotation: [0, 0, 90], modelScale: 1.2 });
  snapshot.settings.sampleShape.length = 330;
  const points = [[0, 0, 0], [24.4, 0, 0], [24.4, 9.6, 0], [0, 9.6, 0], [0, 0, 10.5], [24.4, 0, 10.5], [24.4, 9.6, 10.5], [0, 9.6, 10.5]];
  const obj = points.map(point => `v ${point.join(' ')}`).join('\n') + '\nf 1 2 3\nf 1 3 4\nf 5 7 6\nf 5 8 7\nf 1 5 6\nf 1 6 2\nf 4 3 7\nf 4 7 8\nf 1 4 8\nf 1 8 5\nf 2 6 7\nf 2 7 3\n';
  Object.assign(snapshot.last, {
    enabled: true, model: { name: 'saved-last.obj', format: 'obj', dataUrl: 'data:application/octet-stream;base64,' + Buffer.from(obj).toString('base64') },
    units: 'cm', up: 'z', scale: 0.9, position: [-8, 15, 11], rotation: [0, 0, 0],
  });
  const comparison = await createComparisonModels(freeze(snapshot));
  const shoe = bounds(comparison.shoe), last = bounds(comparison.last);
  vectorNear(shoe.getSize(new THREE.Vector3()).toArray(), [105.31 * 1.2, 253 * 1.2, 95 * 1.2], 'GLB metre/Y-up conversion');
  vectorNear(shoe.getCenter(new THREE.Vector3()).toArray(), [12, -7, 3 + 95 * 1.2 / 2], 'saved GLB pose');
  vectorNear(last.getSize(new THREE.Vector3()).toArray(), [244 * 0.9, 96 * 0.9, 105 * 0.9], 'independent OBJ centimetre conversion');
  vectorNear(last.getCenter(new THREE.Vector3()).toArray(), [-8, 15, 11 + 105 * 0.9 / 2], 'saved OBJ pose');
  disposeObject(comparison.root);
});

test('disabled Last is not parsed or included, even when a dormant file cannot produce geometry', async () => {
  const snapshot = createDefaultProject();
  snapshot.last.model = { name: 'dormant.obj', format: 'obj', dataUrl: 'data:application/octet-stream;base64,' + Buffer.from('# no mesh\n').toString('base64') };
  snapshot.last.enabled = false;
  const comparison = await createComparisonModels(snapshot);
  assert.equal(comparison.last, null); assert.deepEqual(comparison.root.children, [comparison.shoe]);
  assert.ok(meshes(comparison.shoe).length > 0);
  disposeObject(comparison.root);
});

test('comparison materials and geometry are independent, and disposing a baseline leaves current models untouched', async () => {
  const snapshot = createDefaultProject(); snapshot.last.enabled = true;
  const current = createShapedShoeSample(snapshot.settings.sampleKind, snapshot.settings.sampleShape);
  const currentVertices = vertices(current), currentMaterials = materials(current), currentGeometry = new Set(meshes(current).map(mesh => mesh.geometry));
  let currentDisposals = 0;
  for (const geometry of currentGeometry) geometry.addEventListener('dispose', () => { currentDisposals++; });
  for (const material of currentMaterials) material.addEventListener('dispose', () => { currentDisposals++; });
  const comparison = await createComparisonModels(snapshot);
  for (const material of materials(comparison.root)) {
    assert.equal(material.color.getHexString(), '9875bd');
    near(material.opacity, 0.30, 'comparison opacity');
    assert.equal(material.transparent, true); assert.equal(material.depthWrite, false);
    assert.equal(currentMaterials.has(material), false);
  }
  for (const mesh of meshes(comparison.root)) assert.equal(currentGeometry.has(mesh.geometry), false);
  disposeObject(comparison.root);
  assert.equal(currentDisposals, 0);
  assert.deepEqual(vertices(current), currentVertices);
  disposeObject(current);
});

test('adding a distant comparison sibling does not change current capture bounds or triangle section metrics', async () => {
  const current = new THREE.Group();
  const shoe = new THREE.Mesh(new THREE.BoxGeometry(30, 20, 20), new THREE.MeshStandardMaterial());
  const last = new THREE.Mesh(new THREE.BoxGeometry(26, 16, 16), new THREE.MeshStandardMaterial());
  current.add(shoe, last);
  const beforeCapture = planReferenceCapture(bounds(shoe), 1024);
  const beforeSection = computeModelSection(shoe, last, { axis: 'x', percent: 50 });
  const snapshot = createDefaultProject(); snapshot.settings.modelPosition = [15000, -8000, 3000]; snapshot.last.enabled = true;
  const comparison = await createComparisonModels(snapshot);
  current.add(comparison.root);
  current.updateMatrixWorld(true);
  assert.deepEqual(planReferenceCapture(bounds(shoe), 1024), beforeCapture);
  assert.deepEqual(computeModelSection(shoe, last, { axis: 'x', percent: 50 }), beforeSection);
  assert.equal(beforeSection.minimumGap, 2);
  assert.equal(shoe.children.includes(comparison.root), false);
  disposeObject(current);
});

test('a failed second parser disposes the already generated comparison shoe instead of leaking a partial baseline', async () => {
  const snapshot = createDefaultProject();
  snapshot.last.enabled = true;
  snapshot.last.model = { name: 'broken-last.obj', format: 'obj', dataUrl: 'data:application/octet-stream;base64,' + Buffer.from('# valid text without faces\n').toString('base64') };
  const sample = createShapedShoeSample(snapshot.settings.sampleKind, snapshot.settings.sampleShape);
  const expectedGeometry = new Set(meshes(sample).map(mesh => mesh.geometry)).size, expectedMaterials = materials(sample).size;
  disposeObject(sample);
  const disposedGeometry = new Set(), disposedMaterials = new Set();
  const geometryDispose = THREE.BufferGeometry.prototype.dispose, materialDispose = THREE.Material.prototype.dispose;
  THREE.BufferGeometry.prototype.dispose = function () { disposedGeometry.add(this); geometryDispose.call(this); };
  THREE.Material.prototype.dispose = function () { disposedMaterials.add(this); materialDispose.call(this); };
  try {
    await assert.rejects(() => createComparisonModels(snapshot));
    assert.ok(disposedGeometry.size >= expectedGeometry, 'fulfilled shoe geometries are all disposed');
    assert.ok(disposedMaterials.size >= expectedMaterials, 'fulfilled shoe materials are all disposed');
  } finally {
    THREE.BufferGeometry.prototype.dispose = geometryDispose;
    THREE.Material.prototype.dispose = materialDispose;
  }
});
