import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
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

const { planReferenceCapture, createReferenceCamera } = await import('../lib/reference-capture.ts');
const { planReferenceRegistration, applyCapturedReferences } = await import('../lib/reference-registration.ts');
const { getReferenceFrame, getReferencePlanePose } = await import('../lib/reference-frame.ts');
const { applyModelLayerTransform } = await import('../lib/model-layer.ts');
const { createDefaultProject } = await import('../lib/project.ts');
const PLANE_KEYS = ['side', 'top', 'front', 'rear'];

const near = (actual, expected, message, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
const nearVector = (actual, expected, message) => actual.forEach((value, index) => near(value, expected[index], `${message}[${index}]`));
const pngCache = new Map();
function png(width, height) {
  const key = `${width}x${height}`;
  if (pngCache.has(key)) return pngCache.get(key);
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length, 0); bytes.write(type, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const blob = new Blob([Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (width * 4 + 1)))), chunk('IEND', Buffer.alloc(0)),
  ])], { type: 'image/png' });
  pngCache.set(key, blob);
  return blob;
}
const basis = {
  side: { right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0], normalAxis: 1 },
  top: { right: [1, 0, 0], up: [0, 1, 0], normal: [0, 0, 1], normalAxis: 2 },
  front: { right: [0, 1, 0], up: [0, 0, 1], normal: [1, 0, 0], normalAxis: 0 },
  rear: { right: [0, -1, 0], up: [0, 0, 1], normal: [-1, 0, 0], normalAxis: 0 },
};

function captured(plan) {
  return plan.frames.map(frame => ({
    ...frame, blob: png(frame.width, frame.height), modelDimensions: [...plan.modelDimensions], frameCenter: plan.center.toArray(),
  }));
}

function fixture() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.253, 0.0794, 0.10531), new THREE.MeshStandardMaterial());
  mesh.position.set(0.084, -0.022, 0.038);
  const pose = new THREE.Group(), normalization = new THREE.Group(), sourceAxis = new THREE.Group();
  pose.add(normalization); normalization.add(sourceAxis); sourceAxis.add(mesh);
  applyModelLayerTransform({ pose, normalization, sourceAxis }, {
    units: 'm', up: 'y', scale: 1.27, rotation: [17, -9, 33], position: [42, -23, 17],
  }, false);
  return { pose, mesh, bounds: new THREE.Box3().setFromObject(pose, true) };
}

test('registration retains the exact padded and integer-quantized physical frame for every PNG', () => {
  const shape = fixture();
  for (const maxSize of [1024, 2048]) {
    const capture = planReferenceCapture(shape.bounds, maxSize);
    const registration = planReferenceRegistration(captured(capture).reverse());
    nearVector(registration.referenceCenter, shape.bounds.getCenter(new THREE.Vector3()).toArray(), 'world center');
    const frame = getReferenceFrame(registration.dimensions, registration.referenceCenter);
    const padding = Math.max(...capture.modelDimensions) * 0.04;
    registration.dimensions.forEach((value, axis) => {
      const unrounded = capture.modelDimensions[axis] + 2 * padding;
      assert.ok(value >= unrounded - 1e-7, `axis ${axis}: padding is included`);
      assert.ok(value - unrounded < 1 / capture.pixelsPerMm + 1e-7, `axis ${axis}: rounding expands by less than one pixel`);
    });
    for (const image of capture.frames) {
      const expectedSize = image.view === 'top'
        ? [frame.size.x, frame.size.y]
        : image.view === 'side' ? [frame.size.x, frame.size.z] : [frame.size.y, frame.size.z];
      nearVector([image.frameWidthMm, image.frameHeightMm], expectedSize, `${image.view}: frame dimensions`);
      near(image.width / expectedSize[0], capture.pixelsPerMm, `${image.view}: horizontal physical scale`);
      near(image.height / expectedSize[1], capture.pixelsPerMm, `${image.view}: vertical physical scale`);
    }
  }
  shape.mesh.geometry.dispose(); shape.mesh.material.dispose();
});

test('known model points project through PNG pixels back to the correct world axes on all four planes', () => {
  const shape = fixture();
  const points = [[0.091, 0.023, -0.031], [-0.074, -0.019, 0.044], [0.013, -0.032, -0.012]]
    .map(point => shape.mesh.localToWorld(new THREE.Vector3(...point)));
  for (const maxSize of [1024, 2048]) {
    const capture = planReferenceCapture(shape.bounds, maxSize);
    const registration = planReferenceRegistration(captured(capture));
    const frame = getReferenceFrame(registration.dimensions, registration.referenceCenter);
    for (const image of capture.frames) {
      const axes = basis[image.view];
      const right = new THREE.Vector3(...axes.right), up = new THREE.Vector3(...axes.up), normal = new THREE.Vector3(...axes.normal);
      const camera = createReferenceCamera(capture, image);
      for (const gap of [0, 28]) {
        const plane = getReferencePlanePose(frame, image.view, gap);
        nearVector(new THREE.Vector3(1, 0, 0).applyQuaternion(plane.quaternion).toArray(), axes.right, `${image.view}: positive image X`);
        nearVector(new THREE.Vector3(0, 1, 0).applyQuaternion(plane.quaternion).toArray(), axes.up, `${image.view}: positive image Y`);
        const expectedAnchor = capture.center.clone().addScaledVector(normal, registration.dimensions[axes.normalAxis] / 2 + gap);
        nearVector(plane.position.toArray(), expectedAnchor.toArray(), `${image.view}: frame center anchor`);
        for (const point of points) {
          const ndc = point.clone().project(camera);
          const pixelX = (ndc.x + 1) * image.width / 2;
          const pixelY = (1 - ndc.y) * image.height / 2;
          const imagePoint = new THREE.Vector3(
            (pixelX / image.width - 0.5) * image.frameWidthMm,
            (0.5 - pixelY / image.height) * image.frameHeightMm,
            0,
          ).applyQuaternion(plane.quaternion).add(plane.position);
          near(imagePoint.dot(right), point.dot(right), `${image.view}: horizontal world coordinate`);
          near(imagePoint.dot(up), point.dot(up), `${image.view}: vertical world coordinate`);
          near(imagePoint.dot(normal), expectedAnchor.dot(normal), `${image.view}: depth is the reference plane`);
        }
      }
    }
  }
  shape.mesh.geometry.dispose(); shape.mesh.material.dispose();
});

test('null reference center retains the original grounded legacy frame and front/rear handedness', () => {
  const dimensions = [253, 105.31, 79.4];
  const frame = getReferenceFrame(dimensions, null);
  nearVector(frame.center.toArray(), [0, 0, 39.7], 'legacy center');
  nearVector(frame.bounds.min.toArray(), [-126.5, -52.655, 0], 'legacy minimum');
  nearVector(frame.bounds.max.toArray(), [126.5, 52.655, 79.4], 'legacy maximum');
  const expected = {
    side: [0, -80.655, 39.7], top: [0, 0, 107.4],
    front: [154.5, 0, 39.7], rear: [-154.5, 0, 39.7],
  };
  for (const view of PLANE_KEYS) nearVector(getReferencePlanePose(frame, view, 28).position.toArray(), expected[view], `${view}: unchanged legacy anchor`);
});

test('registration rejects incomplete, duplicate or physically inconsistent capture sets', () => {
  const capture = planReferenceCapture(new THREE.Box3(new THREE.Vector3(-100, -50, 0), new THREE.Vector3(100, 50, 80)), 1024);
  const fresh = () => captured(capture);
  const broken = [
    fresh().slice(0, 3),
    fresh().map((image, index) => index === 3 ? { ...image, view: 'front' } : image),
    fresh().map((image, index) => index === 1 ? { ...image, frameCenter: [1, 0, 40] } : image),
    fresh().map((image, index) => index === 2 ? { ...image, frameWidthMm: image.frameWidthMm + 4 } : image),
    fresh().map((image, index) => index === 3 ? { ...image, frameHeightMm: image.frameHeightMm + 4 } : image),
    fresh().map((image, index) => index === 1 ? { ...image, width: image.width * 2 } : image),
    fresh().map((image, index) => index === 0 ? { ...image, frameCenter: [0, Infinity, 40] } : image),
  ];
  for (const images of broken) assert.throws(() => planReferenceRegistration(images));
});

test('applying PNGs changes only reference settings and images, preserving both model layers and their poses', async () => {
  const originalFileReader = globalThis.FileReader;
  globalThis.FileReader = class {
    result = null;
    readAsDataURL(blob) {
      void blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.(); this.onloadend?.();
      }).catch(error => { this.error = error; this.onerror?.(); });
    }
  };
  try {
    const project = createDefaultProject();
    project.settings.modelPosition = [42, -23, 17];
    project.settings.modelRotation = [17, -9, 33];
    project.settings.modelScale = 1.27;
    project.last = { ...project.last, enabled: true, position: [12, -4, 6], scale: 0.9, opacity: 0.43 };
    for (const view of PLANE_KEYS) project.planes[view] = { ...project.planes[view], visible: false, flip: true };
    const original = JSON.parse(JSON.stringify(project));
    const capture = planReferenceCapture(new THREE.Box3(new THREE.Vector3(-95, -72, 17), new THREE.Vector3(179, 26, 132)), 1024);
    const next = await applyCapturedReferences(project, captured(capture), '검토용 신발');
    assert.deepEqual(project, original, 'input is not modified');
    assert.deepEqual(next.model, original.model);
    assert.deepEqual(next.last, original.last);
    for (const field of ['modelPosition', 'modelRotation', 'modelScale', 'modelUnits', 'modelUp', 'sampleKind', 'gap']) {
      assert.deepEqual(next.settings[field], original.settings[field], `preserves ${field}`);
    }
    nearVector(next.settings.referenceCenter, capture.center.toArray(), 'registered center');
    for (const view of PLANE_KEYS) {
      assert.equal(next.planes[view].visible, true);
      assert.equal(next.planes[view].flip, false, 'capture already has the correct handedness');
      assert.ok(next.planes[view].image.dataUrl.startsWith('data:image/png;base64,'));
    }
  } finally {
    if (originalFileReader === undefined) delete globalThis.FileReader;
    else globalThis.FileReader = originalFileReader;
  }
});
