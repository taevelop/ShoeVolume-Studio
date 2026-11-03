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

const { computeModelSection } = await import('../lib/section-analysis.ts');
const near = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
const vectorNear = (actual, expected, message) => actual.forEach((value, index) => near(value, expected[index], `${message}[${index}]`));
const totalLength = segments => segments.reduce((total, [a, b]) => total + Math.hypot(a[0] - b[0], a[1] - b[1]), 0);

function box(dimensions = [30, 20, 20], center = [0, 0, 0], nonindexed = false) {
  let geometry = new THREE.BoxGeometry(...dimensions);
  if (nonindexed) { const next = geometry.toNonIndexed(); geometry.dispose(); geometry = next; }
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(...center);
  return mesh;
}

function triangle(points) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

function section(shoe, last = null, axis = 'x', percent = 50) {
  const result = computeModelSection(shoe, last, { axis, percent });
  assert.equal(result.error, undefined, result.error);
  return result;
}

function assertClosest(result, expected) {
  near(result.minimumGap, expected, 'boundary distance');
  assert.ok(result.closest);
  near(Math.hypot(result.closest[0][0] - result.closest[1][0], result.closest[0][1] - result.closest[1][1]), expected, 'reported closest points');
}

test('nested boxes have a true 2 mm boundary gap without claiming containment is a crossing', () => {
  for (const nonindexed of [false, true]) {
    const result = section(box([30, 20, 20], [0, 0, 0], nonindexed), box([26, 16, 16]));
    near(result.coordinate, 0, 'half-length plane');
    assert.equal(result.uAxis, 'y'); assert.equal(result.vAxis, 'z');
    assertClosest(result, 2);
    assert.equal(result.intersects, false);
    near(totalLength(result.shoe), 80, 'outer perimeter');
    near(totalLength(result.last), 64, 'inner perimeter');
    vectorNear(result.bounds, [-10, -10, 10, 10], 'section bounds');
  }
});

test('disjoint, touching, crossing, and diagonal sections yield their analytic distances', () => {
  const shoe = box();
  const separated = section(shoe, box([30, 8, 8], [0, 16, 0]));
  assertClosest(separated, 2); assert.equal(separated.intersects, false);
  const touching = section(shoe, box([30, 4, 4], [0, 12, 0]));
  assertClosest(touching, 0); assert.equal(touching.intersects, true);
  const crossing = section(shoe, box([30, 16, 16], [0, 8, 8]));
  assertClosest(crossing, 0); assert.equal(crossing.intersects, true);
  const diagonal = section(shoe, box([30, 4, 4], [0, 14, 15]));
  assertClosest(diagonal, Math.sqrt(13)); assert.equal(diagonal.intersects, false);
  vectorNear(diagonal.closest[0], [10, 10], 'outer corner');
  vectorNear(diagonal.closest[1], [12, 13], 'inner corner');
});

test('the closest point can lie strictly inside a segment, not just at sampled vertices', () => {
  const shoe = triangle([[0, 0, 0], [1, 3, 0], [-1, 3, 0]]);
  const last = triangle([[0, 1, 2], [1, 1, 4], [-1, 1, 4]]);
  const result = section(shoe, last);
  assertClosest(result, 2);
  vectorNear(result.closest[0], [1, 0], 'projection onto segment interior');
  vectorNear(result.closest[1], [1, 2], 'other section endpoint');
});

test('hierarchical pruning preserves the analytic minimum across many nested polygon edges', () => {
  const sides = 128;
  const polygon = radius => {
    const root = new THREE.Group();
    for (let index = 0; index < sides; index++) {
      const angle = index * 2 * Math.PI / sides, next = (index + 1) * 2 * Math.PI / sides;
      const a = [radius * Math.cos(angle), radius * Math.sin(angle)];
      const b = [radius * Math.cos(next), radius * Math.sin(next)];
      root.add(triangle([[-1, ...a], [1, ...a], [0, ...b]]));
    }
    return root;
  };
  const result = section(polygon(10), polygon(8));
  assert.equal(result.shoe.length, sides); assert.equal(result.last.length, sides);
  assertClosest(result, 2 * Math.cos(Math.PI / sides));
  assert.equal(result.intersects, false);
});

test('world translation, rotation and negative scale preserve real transformed section geometry', () => {
  const shoe = box([30, 20, 20], [7, -23, 5]);
  const last = box([20, 12, 12], [7, -23, 5]);
  shoe.rotation.x = last.rotation.x = Math.PI / 4;
  shoe.scale.x = last.scale.x = -2;
  const result = section(shoe, last);
  near(result.coordinate, 7, 'world-space section plane');
  assertClosest(result, 4);
  assert.equal(result.intersects, false);
  vectorNear(result.bounds, [-23 - 10 * Math.SQRT2, 5 - 10 * Math.SQRT2, -23 + 10 * Math.SQRT2, 5 + 10 * Math.SQRT2], 'rotated square bounds');
  near(totalLength(result.shoe), 80, 'rotation preserves perimeter');
});

test('all axes use the expected coordinate signs and dimensions for negative model coordinates', () => {
  const shoe = box([10, 20, 30], [-12, -23, -34]);
  const cases = {
    x: { coordinate: -14.5, axes: ['y', 'z'], bounds: [-33, -49, -13, -19] },
    y: { coordinate: -28, axes: ['x', 'z'], bounds: [-17, -49, -7, -19] },
    z: { coordinate: -41.5, axes: ['x', 'y'], bounds: [-17, -33, -7, -13] },
  };
  for (const [axis, expected] of Object.entries(cases)) {
    const result = section(shoe, null, axis, 25);
    near(result.coordinate, expected.coordinate, `${axis}: 25 percent plane`);
    assert.deepEqual([result.uAxis, result.vAxis], expected.axes);
    vectorNear(result.bounds, expected.bounds, `${axis}: bounds`);
  }
});

test('a plane coincident with a triangulated box face has only its four perimeter edges', () => {
  for (const nonindexed of [false, true]) for (const percent of [0, 100]) {
    const result = section(box([30, 20, 16], [3, -10, -5], nonindexed), null, 'x', percent);
    near(result.coordinate, percent === 0 ? -12 : 18, 'box face plane');
    assert.equal(result.shoe.length, 4, 'no triangulation diagonal or duplicate adjacent edge');
    near(totalLength(result.shoe), 72, 'face perimeter');
    for (const [a, b] of result.shoe) assert.ok(a[0] === b[0] || a[1] === b[1], 'each edge belongs to the rectangular boundary');
  }
});

test('coplanar triangles split across source meshes remove shared diagonals before measuring gap', () => {
  const shoe = new THREE.Group();
  shoe.add(triangle([[-5, -5, 0], [5, -5, 0], [5, 5, 0]]));
  shoe.add(triangle([[-5, -5, 0], [5, 5, 0], [-5, 5, 0]]));
  shoe.add(triangle([[-5, -5, 0], [5, -5, 0], [5, 5, 0]])); // duplicate face should not cancel the perimeter
  const last = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
  const result = section(shoe, last, 'z');
  assert.equal(result.shoe.length, 4);
  near(totalLength(result.shoe), 40, 'split surface perimeter');
  assertClosest(result, 4);
  assert.equal(result.intersects, false, 'internal triangulation does not create false contact');
});

test('unused indexed vertices and triangles outside drawRange do not move the percentage plane', () => {
  const shoe = box([10, 10, 10]);
  const original = shoe.geometry.getAttribute('position').array;
  shoe.geometry.setAttribute('position', new THREE.Float32BufferAttribute([...original, 1000, 0, 0], 3));
  near(section(shoe).coordinate, 0, 'unreferenced far vertex');

  const surface = triangle([[1000, 0, 0], [1001, 1, 0], [1002, 0, 1], [-1, 0, 0], [1, 2, 0], [-1, 2, 0]]);
  surface.geometry.setDrawRange(3, 3);
  const result = section(surface);
  near(result.coordinate, 0, 'draw-range excludes remote triangle');
  assert.equal(result.shoe.length, 1);
  near(totalLength(result.shoe), 1, 'actual active triangle intersection');
});

test('instanced meshes retain separate sections and hidden pose toggles do not hide source geometry from analysis', () => {
  const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshStandardMaterial(), 2);
  instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, -8, 0));
  instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 8, 0));
  const shoe = new THREE.Group(); shoe.visible = false; shoe.add(instances);
  const hidden = box([10, 10, 10], [1000, 0, 0]); hidden.visible = false; shoe.add(hidden);
  const result = section(shoe);
  near(result.coordinate, 0, 'hidden child does not alter bounds');
  near(totalLength(result.shoe), 32, 'both disjoint instance perimeters');
  vectorNear(result.bounds, [-10, -2, 10, 2], 'instance bounds');
  for (const segment of result.shoe) assert.ok(segment.every(point => point[0] <= -6) || segment.every(point => point[0] >= 6), 'no convex-hull bridge across the instances');
  assert.equal(shoe.visible, false, 'visibility is not mutated');
});

test('missing Last section is not reported as zero clearance or a collision', () => {
  const result = section(box(), box([4, 4, 4], [100, 0, 0]));
  assert.ok(result.shoe.length);
  assert.deepEqual(result.last, []);
  assert.equal(result.minimumGap, null); assert.equal(result.closest, null); assert.equal(result.intersects, false);
});

test('isolated tangent points and degenerate triangles remain finite and do not invent contour lines', () => {
  const shoe = triangle([[-1, 0, 0], [1, -2, 0], [1, 2, 0]]);
  const result = section(shoe, null, 'x', 0);
  assert.equal(result.shoe.length, 1);
  assert.deepEqual(result.shoe[0], [[0, 0], [0, 0]]);
  const degenerate = triangle([[-1, 0, 0], [1, 0, 0], [1, 0, 0]]);
  const empty = section(degenerate);
  assert.deepEqual(empty.shoe, []);
  assert.ok(empty.bounds.every(Number.isFinite));
});

test('invalid data or explicit workload limits return no partial measurement', () => {
  const invalid = box(); invalid.geometry.getAttribute('position').setX(0, NaN);
  const tooMany = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 1);
  tooMany.count = 125001; // Budget must reject before attempting to read matrices.
  const results = [
    computeModelSection(invalid, box(), { axis: 'x', percent: 50 }),
    computeModelSection(tooMany, null, { axis: 'x', percent: 50 }),
    computeModelSection(box(), null, { axis: 'x', percent: 101 }),
    computeModelSection(new THREE.Group(), null, { axis: 'x', percent: 50 }),
  ];
  for (const result of results) {
    assert.ok(result.error);
    assert.deepEqual(result.shoe, []); assert.deepEqual(result.last, []);
    assert.equal(result.minimumGap, null); assert.equal(result.closest, null); assert.equal(result.intersects, false);
  }
});

test('section computation does not change original vertices, materials or model pose', () => {
  const shoe = box(); shoe.rotation.z = 0.37; shoe.scale.set(1.1, 0.9, 1.2); shoe.position.set(4, -3, 6);
  const before = {
    vertices: shoe.geometry.getAttribute('position').array.slice(), material: shoe.material,
    position: shoe.position.toArray(), rotation: shoe.rotation.toArray(), scale: shoe.scale.toArray(),
  };
  section(shoe, box([16, 16, 16]));
  assert.deepEqual(shoe.geometry.getAttribute('position').array, before.vertices);
  assert.equal(shoe.material, before.material);
  assert.deepEqual(shoe.position.toArray(), before.position);
  assert.deepEqual(shoe.rotation.toArray(), before.rotation);
  assert.deepEqual(shoe.scale.toArray(), before.scale);
});
