import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as THREE from 'three';

// Exercise the production projection helpers without a browser or build output.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});

const { planReferenceCapture, createReferenceCamera } = await import('../lib/reference-capture.ts');
const near = (actual, expected, message, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
const shoeBounds = () => new THREE.Box3(new THREE.Vector3(-126.5, -52.655, 0), new THREE.Vector3(126.5, 52.655, 79.4));
const viewAxes = {
  side: { right: [1, 0, 0], up: [0, 0, 1], direction: [0, 1, 0], size: [0, 2] },
  top: { right: [1, 0, 0], up: [0, 1, 0], direction: [0, 0, -1], size: [0, 1] },
  front: { right: [0, 1, 0], up: [0, 0, 1], direction: [-1, 0, 0], size: [1, 2] },
  rear: { right: [0, -1, 0], up: [0, 0, 1], direction: [1, 0, 0], size: [1, 2] },
};

function corners(bounds) {
  return [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y].flatMap(y =>
    [bounds.min.z, bounds.max.z].map(z => new THREE.Vector3(x, y, z)),
  ));
}

function assertVisibleBounds(plan, bounds) {
  for (const frame of plan.frames) {
    const camera = createReferenceCamera(plan, frame);
    camera.updateMatrixWorld(true);
    for (const point of corners(bounds)) {
      const projected = point.clone().project(camera);
      assert.ok(Math.abs(projected.x) < 1, `${frame.view}: horizontal padding contains the model`);
      assert.ok(Math.abs(projected.y) < 1, `${frame.view}: vertical padding contains the model`);
      assert.ok(projected.z >= -1 && projected.z <= 1, `${frame.view}: depth is not clipped`);
    }
  }
}

test('all four PNG frames share one physical pixel scale, including rounded padding', () => {
  for (const maxSize of [1024, 2048]) {
    const plan = planReferenceCapture(shoeBounds(), maxSize);
    assert.deepEqual(new Set(plan.frames.map(frame => frame.view)), new Set(Object.keys(viewAxes)));
    plan.modelDimensions.forEach((value, i) => near(value, [253, 105.31, 79.4][i], 'model dimension'));
    assert.ok(Number.isFinite(plan.pixelsPerMm) && plan.pixelsPerMm > 0);
    for (const frame of plan.frames) {
      assert.ok(Number.isInteger(frame.width) && frame.width > 0 && frame.width <= maxSize);
      assert.ok(Number.isInteger(frame.height) && frame.height > 0 && frame.height <= maxSize);
      near(frame.width / frame.frameWidthMm, plan.pixelsPerMm, `${frame.view}: horizontal pixels/mm`);
      near(frame.height / frame.frameHeightMm, plan.pixelsPerMm, `${frame.view}: vertical pixels/mm`);
      const [widthAxis, heightAxis] = viewAxes[frame.view].size;
      assert.ok(frame.frameWidthMm > plan.modelDimensions[widthAxis], `${frame.view}: width contains padding`);
      assert.ok(frame.frameHeightMm > plan.modelDimensions[heightAxis], `${frame.view}: height contains padding`);
    }
    assertVisibleBounds(plan, shoeBounds());
  }
});

test('orthographic directions agree with workspace planes and front/rear are correctly opposed', () => {
  const plan = planReferenceCapture(shoeBounds(), 1024);
  for (const frame of plan.frames) {
    const camera = createReferenceCamera(plan, frame);
    assert.equal(camera.isOrthographicCamera, true);
    camera.updateMatrixWorld(true);
    const expected = viewAxes[frame.view];
    const direction = camera.getWorldDirection(new THREE.Vector3());
    direction.toArray().forEach((value, i) => near(value, expected.direction[i], `${frame.view}: look direction`));
    const center = plan.center.clone().project(camera);
    near(center.x, 0, `${frame.view}: centered horizontally`);
    near(center.y, 0, `${frame.view}: centered vertically`);
    const right = plan.center.clone().addScaledVector(new THREE.Vector3(...expected.right), 10).project(camera);
    const up = plan.center.clone().addScaledVector(new THREE.Vector3(...expected.up), 10).project(camera);
    assert.ok(right.x > center.x, `${frame.view}: intended world axis points right`);
    assert.ok(up.y > center.y, `${frame.view}: intended world axis points up`);
    near((right.x - center.x) * frame.width / 2, 10 * plan.pixelsPerMm, `${frame.view}: 10 mm horizontal scale`);
    near((up.y - center.y) * frame.height / 2, 10 * plan.pixelsPerMm, `${frame.view}: 10 mm vertical scale`);
  }
});

test('capture planning retains applied GLB metre/Y-up conversion, user scale, rotation and translation', () => {
  const geometry = new THREE.BoxGeometry(.253, .0794, .10531);
  const material = new THREE.MeshStandardMaterial();
  const sourceAxis = new THREE.Group();
  sourceAxis.add(new THREE.Mesh(geometry, material));
  sourceAxis.rotation.x = Math.PI / 2;
  const sourceBounds = new THREE.Box3().setFromObject(sourceAxis);
  const sourceCenter = sourceBounds.getCenter(new THREE.Vector3());
  const normalization = new THREE.Group();
  normalization.position.set(-sourceCenter.x, -sourceCenter.y, -sourceBounds.min.z);
  normalization.add(sourceAxis);
  const pose = new THREE.Group();
  pose.add(normalization);
  pose.scale.setScalar(1000 * 1.5);
  pose.rotation.z = Math.PI / 2;
  pose.position.set(24, -11, 7);
  const bounds = new THREE.Box3().setFromObject(pose);
  const plan = planReferenceCapture(bounds, 2048);
  plan.modelDimensions.forEach((value, i) => near(value, [105.31 * 1.5, 253 * 1.5, 79.4 * 1.5][i], 'transformed dimension', .001));
  plan.center.toArray().forEach((value, i) => near(value, [24, -11, 7 + 79.4 * 1.5 / 2][i], 'transformed center', .001));
  assertVisibleBounds(plan, bounds);
  geometry.dispose();
  material.dispose();
});

test('thin or flat geometry still produces finite padded frames rather than zero-sized PNGs', () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-150, 0, 0), new THREE.Vector3(150, 0, 0));
  const plan = planReferenceCapture(bounds, 1024);
  for (const frame of plan.frames) {
    assert.ok(frame.width >= 1 && frame.height >= 1);
    assert.ok(Number.isFinite(frame.frameWidthMm) && frame.frameWidthMm > 0);
    assert.ok(Number.isFinite(frame.frameHeightMm) && frame.frameHeightMm > 0);
  }
  assertVisibleBounds(plan, bounds);
});

test('empty, non-finite and point-only model bounds fail before rendering', () => {
  for (const bounds of [
    new THREE.Box3(),
    new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Infinity, 10, 10)),
    new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, Number.NaN, 10)),
    new THREE.Box3(new THREE.Vector3(5, 5, 5), new THREE.Vector3(5, 5, 5)),
  ]) assert.throws(() => planReferenceCapture(bounds, 1024));
});
