import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

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

const { createShoeSample } = await import('../lib/shoe-samples.ts');
const { createShapedShoeSample } = await import('../lib/sample-shape.ts');
const { SHOE_SAMPLES } = await import('../lib/shoe-sample-catalog.ts');
const { createDefaultSampleShape, SAMPLE_SHAPE_LIMITS } = await import('../lib/project.ts');
const { planReferenceCapture } = await import('../lib/reference-capture.ts');
const { computeModelSection } = await import('../lib/section-analysis.ts');
const { applyModelLayerTransform } = await import('../lib/model-layer.ts');
const { disposeObject } = await import('../lib/scene-geometry.ts');
const near = (actual, expected, message, tolerance = 0.0001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
const vectorNear = (actual, expected, message) => actual.forEach((value, index) => near(value, expected[index], `${message}[${index}]`));

function bounds(root) { root.updateMatrixWorld(true); return new THREE.Box3().setFromObject(root, true); }
function meshes(root) { const list = []; root.traverse(object => { if (object instanceof THREE.Mesh) list.push(object); }); return list; }
function triangles(root) { return meshes(root).reduce((total, mesh) => total + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0); }
function materialSignature(root) {
  return meshes(root).map(mesh => ({
    name: mesh.name,
    groups: mesh.geometry.groups,
    materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => ({
      color: material.color?.getHexString(), roughness: material.roughness, metalness: material.metalness,
    })),
  }));
}
function worldVertices(root) {
  root.updateMatrixWorld(true);
  const output = [], vertex = new THREE.Vector3();
  for (const mesh of meshes(root)) {
    const position = mesh.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index++) {
      mesh.getVertexPosition(index, vertex).applyMatrix4(mesh.matrixWorld);
      output.push(...vertex.toArray());
    }
  }
  return output;
}
function assertFiniteShape(root, label) {
  const box = bounds(root), size = box.getSize(new THREE.Vector3());
  assert.ok(size.toArray().every(value => Number.isFinite(value) && value > 0), `${label}: positive dimensions`);
  near(box.min.z, 0, `${label}: fixed floor`);
  assert.ok(worldVertices(root).every(Number.isFinite), `${label}: finite vertices`);
  for (const mesh of meshes(root)) assert.ok([...mesh.geometry.getAttribute('normal').array].every(Number.isFinite), `${label}: finite normals`);
}

test('default parameters preserve all five source shapes, their details, materials and triangle counts', () => {
  for (const sample of SHOE_SAMPLES) {
    const original = createShoeSample(sample.id), shaped = createShapedShoeSample(sample.id, createDefaultSampleShape());
    const expected = worldVertices(original), actual = worldVertices(shaped);
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index++) near(actual[index], expected[index], `${sample.id}: world vertex ${index}`);
    assert.equal(triangles(shaped), triangles(original));
    assert.deepEqual(materialSignature(shaped), materialSignature(original));
    vectorNear(bounds(shaped).getSize(new THREE.Vector3()).toArray(), sample.dimensions, `${sample.id}: default dimensions`);
    disposeObject(original); disposeObject(shaped);
  }
});

test('length reaches the exact target while zero local deltas retain width, height, centering and floor', () => {
  for (const sample of SHOE_SAMPLES) for (const length of [180, 253, 330]) {
    const shaped = createShapedShoeSample(sample.id, { ...createDefaultSampleShape(), length });
    const box = bounds(shaped);
    vectorNear(box.getSize(new THREE.Vector3()).toArray(), [length, sample.dimensions[1], sample.dimensions[2]], `${sample.id}/${length}: dimensions`);
    near((box.min.x + box.max.x) / 2, 0, 'length remains centered');
    near(box.min.z, 0, 'length edit preserves the floor');
    disposeObject(shaped);
  }
});

test('local controls preserve remote regions and keep each displacement within its stated millimetre envelope', () => {
  const controls = [
    { field: 'ballWidthDelta', value: 24, component: 1, support: [2 / 3 - 0.2, 2 / 3 + 0.2], maximum: 12 },
    { field: 'heelWidthDelta', value: 18, component: 1, support: [0.01, 0.29], maximum: 9 },
    { field: 'toeHeightDelta', value: 20, component: 2, support: [0.74, 1.06], maximum: 20 },
    { field: 'instepHeightDelta', value: 20, component: 2, support: [0.25, 0.65], maximum: 20 },
  ];
  for (const sample of SHOE_SAMPLES) {
    const original = createShoeSample(sample.id), baseline = worldVertices(original), box = bounds(original);
    for (const control of controls) {
      const shaped = createShapedShoeSample(sample.id, { ...createDefaultSampleShape(), [control.field]: control.value });
      const actual = worldVertices(shaped);
      let maximum = 0, remoteCount = 0;
      for (let offset = 0; offset < baseline.length; offset += 3) {
        const t = (baseline[offset] - box.min.x) / 253;
        for (let component = 0; component < 3; component++) {
          const difference = actual[offset + component] - baseline[offset + component];
          if (component !== control.component) near(difference, 0, `${sample.id}/${control.field}: other coordinate fixed`);
          else {
            maximum = Math.max(maximum, Math.abs(difference));
            assert.ok(Math.abs(difference) <= control.maximum + 0.0001, `${sample.id}/${control.field}: displacement stays within mm envelope`);
            if (t < control.support[0] - 0.0001 || t > control.support[1] + 0.0001) {
              near(difference, 0, `${sample.id}/${control.field}: remote region is unchanged`); remoteCount++;
            }
          }
        }
      }
      assert.ok(maximum > 0.05, `${sample.id}/${control.field}: intended region actually changes`);
      assert.ok(remoteCount > 0, 'there is an unaffected region');
      if (control.component === 2) {
        const beforeMeshes = meshes(original), afterMeshes = meshes(shaped);
        for (let index = 0; index < beforeMeshes.length; index++) {
          if (!/outsole|midsole|insole/.test(beforeMeshes[index].name)) continue;
          const before = worldVertices(beforeMeshes[index]), after = worldVertices(afterMeshes[index]);
          for (let offset = 2; offset < before.length; offset += 3) near(after[offset], before[offset], `${sample.id}: sole height remains fixed`);
        }
      }
      disposeObject(shaped);
    }
    disposeObject(original);
  }
});

test('heel and ball controls deliver the requested total section-width change at their named stations', () => {
  for (const sample of SHOE_SAMPLES) {
    const baseline = createShapedShoeSample(sample.id, createDefaultSampleShape());
    for (const [field, delta, percent] of [['heelWidthDelta', 18, 15], ['ballWidthDelta', 24, 100 * 2 / 3]]) {
      const shaped = createShapedShoeSample(sample.id, { ...createDefaultSampleShape(), [field]: delta });
      const before = computeModelSection(baseline, null, { axis: 'x', percent });
      const after = computeModelSection(shaped, null, { axis: 'x', percent });
      assert.equal(before.error, undefined); assert.equal(after.error, undefined);
      assert.ok(before.shoe.length && after.shoe.length);
      const originalWidth = before.bounds[2] - before.bounds[0];
      const editedWidth = after.bounds[2] - after.bounds[0];
      near(editedWidth - originalWidth, delta, `${sample.id}/${field}: actual outer section width in mm`, 0.1);
      disposeObject(shaped);
    }
    disposeObject(baseline);
  }
});

test('minimum and maximum combined edits remain finite and above the floor for every sample', () => {
  const extremes = [0, 1].map(index => Object.fromEntries(Object.entries(SAMPLE_SHAPE_LIMITS).map(([field, range]) => [field, range[index]])));
  for (const sample of SHOE_SAMPLES) {
    const original = createShoeSample(sample.id), count = triangles(original), colors = materialSignature(original);
    for (const shape of extremes) {
      const shaped = createShapedShoeSample(sample.id, shape);
      assertFiniteShape(shaped, `${sample.id}/${shape.length}`);
      near(bounds(shaped).getSize(new THREE.Vector3()).x, shape.length, 'combined edits preserve requested length');
      assert.equal(triangles(shaped), count); assert.deepEqual(materialSignature(shaped), colors);
      disposeObject(shaped);
    }
    disposeObject(original);
  }
});

test('regenerating A → B → A is deterministic, with independent resources and no cumulative deformation', () => {
  const a = { length: 279, ballWidthDelta: 16, heelWidthDelta: -6, toeHeightDelta: 11, instepHeightDelta: -3 };
  const b = { length: 190, ballWidthDelta: -14, heelWidthDelta: 16, toeHeightDelta: -7, instepHeightDelta: 18 };
  for (const sample of SHOE_SAMPLES) {
    const first = createShapedShoeSample(sample.id, a), snapshot = worldVertices(first);
    const middle = createShapedShoeSample(sample.id, b), second = createShapedShoeSample(sample.id, a);
    assert.deepEqual(worldVertices(first), snapshot, 'creating another variant does not mutate the first');
    assert.deepEqual(worldVertices(second), snapshot, `${sample.id}: A regenerates exactly`);
    assert.notEqual(meshes(first)[0].geometry, meshes(second)[0].geometry);
    assert.notEqual(meshes(first)[0].material, meshes(second)[0].material);
    disposeObject(first); disposeObject(middle); disposeObject(second);
  }
});

test('capture bounds and actual triangle sections reflect the edited shape for all five samples', () => {
  const shape = { length: 290, ballWidthDelta: 20, heelWidthDelta: 12, toeHeightDelta: 16, instepHeightDelta: 16 };
  for (const sample of SHOE_SAMPLES) {
    const original = createShoeSample(sample.id), shaped = createShapedShoeSample(sample.id, shape);
    const plan = planReferenceCapture(bounds(shaped), 1024);
    near(plan.modelDimensions[0], shape.length, `${sample.id}: capture uses edited length`);
    vectorNear(plan.modelDimensions, bounds(shaped).getSize(new THREE.Vector3()).toArray(), 'capture uses actual mesh bounds');
    const before = computeModelSection(original, null, { axis: 'x', percent: 70 });
    const after = computeModelSection(shaped, null, { axis: 'x', percent: 70 });
    assert.equal(before.error, undefined); assert.equal(after.error, undefined);
    near(after.coordinate, shape.length * 0.2, `${sample.id}: section plane follows edited length`);
    assert.ok(after.shoe.length > 0);
    assert.ok(after.bounds[2] - after.bounds[0] > before.bounds[2] - before.bounds[0] + 0.1, `${sample.id}: local forefoot section widens`);
    assert.notDeepEqual(after.shoe, before.shoe, 'section is recomputed from new vertices');
    disposeObject(original); disposeObject(shaped);
  }
});

test('binary STL roundtrip preserves every edited world-mm triangle and its transformed dimensions', () => {
  const shape = { length: 281, ballWidthDelta: 18, heelWidthDelta: -4, toeHeightDelta: 9, instepHeightDelta: 14 };
  for (const sample of SHOE_SAMPLES) {
    const shaped = createShapedShoeSample(sample.id, shape);
    const pose = new THREE.Group(), normalization = new THREE.Group(), sourceAxis = new THREE.Group();
    pose.add(normalization); normalization.add(sourceAxis); sourceAxis.add(shaped);
    applyModelLayerTransform({ pose, normalization, sourceAxis }, {
      position: [31, -42, 15], rotation: [0, 0, 17], scale: 1.2, units: 'mm', up: 'z',
    }, true);
    const expected = bounds(pose);
    const output = new STLExporter().parse(pose, { binary: true });
    const bytes = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    const restored = new STLLoader().parse(bytes);
    restored.computeBoundingBox();
    assert.equal(restored.getAttribute('position').count / 3, triangles(pose), `${sample.id}: STL triangle count`);
    vectorNear(restored.boundingBox.min.toArray(), expected.min.toArray(), `${sample.id}: STL world minimum`);
    vectorNear(restored.boundingBox.max.toArray(), expected.max.toArray(), `${sample.id}: STL world maximum`);
    assert.ok([...restored.getAttribute('normal').array].every(Number.isFinite));
    restored.dispose(); disposeObject(pose);
  }
});
