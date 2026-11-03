import * as THREE from 'three';
import { SHOE_SAMPLES, type SampleKind } from './shoe-sample-catalog';

type V3 = [number, number, number];
interface Ring {
  min: number;
  max: number;
  width: number;
  z: number;
  foot?: number;
  heelRaise?: number;
}
type Surface = (u: number, v: number) => THREE.Vector3;

const SEGMENTS = 72;

function material(color: string, roughness = 0.7, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, side: THREE.DoubleSide });
}

function addMesh(group: THREE.Group, name: string, geometry: THREE.BufferGeometry, paint: THREE.Material | THREE.Material[]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, paint);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function ringPoint(ring: Ring, angle: number): THREE.Vector3 {
  const c = Math.cos(angle), s = Math.sin(angle), t = (c + 1) / 2;
  const footShape = Math.sign(s) * Math.pow(Math.abs(s), 0.78) * (0.72 + 0.33 * Math.exp(-Math.pow((t - 0.68) / 0.27, 2)));
  const y = THREE.MathUtils.lerp(s, footShape, ring.foot ?? 0) * ring.width / 2;
  return new THREE.Vector3((ring.min + ring.max) / 2 + (ring.max - ring.min) / 2 * c, y, ring.z + (ring.heelRaise ?? 0) * (1 - c) / 2);
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  return 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
}

function loftPoint(rings: Ring[], u: number, angle: number): THREE.Vector3 {
  const interval = THREE.MathUtils.clamp(u, 0, 1) * (rings.length - 1);
  const i = Math.min(rings.length - 2, Math.floor(interval));
  const f = interval - i;
  const a = ringPoint(rings[Math.max(0, i - 1)], angle);
  const b = ringPoint(rings[i], angle);
  const c = ringPoint(rings[i + 1], angle);
  const d = ringPoint(rings[Math.min(rings.length - 1, i + 2)], angle);
  return new THREE.Vector3(cubic(a.x, b.x, c.x, d.x, f), cubic(a.y, b.y, c.y, d.y, f), cubic(a.z, b.z, c.z, d.z, f));
}

function geometry(positions: number[], indices: number[]): THREE.BufferGeometry {
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setIndex(indices);
  result.computeVertexNormals();
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

function solidLoft(rings: Ring[], segments = SEGMENTS): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  for (const ring of rings) for (let j = 0; j < segments; j++) positions.push(...ringPoint(ring, j / segments * Math.PI * 2).toArray());
  for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < segments; j++) {
    const a = r * segments + j, b = r * segments + (j + 1) % segments;
    const c = a + segments, d = b + segments;
    indices.push(a, b, c, b, d, c);
  }
  for (const [ringIndex, top] of [[0, false], [rings.length - 1, true]] as const) {
    const start = positions.length / 3;
    const center = new THREE.Vector3();
    for (let j = 0; j < segments; j++) {
      const point = ringPoint(rings[ringIndex], j / segments * Math.PI * 2);
      positions.push(...point.toArray()); center.add(point);
    }
    const middle = positions.length / 3;
    positions.push(...center.divideScalar(segments).toArray());
    for (let j = 0; j < segments; j++) {
      const a = start + j, b = start + (j + 1) % segments;
      if (top) indices.push(middle, a, b); else indices.push(middle, b, a);
    }
  }
  return geometry(positions, indices);
}

/** Closed-thickness upper walls with an actual open collar, not a capped last. */
function upperShell(group: THREE.Group, rings: Ring[], outside: THREE.Material, lining: THREE.Material, thickness = 2.6): Surface {
  const rows = Math.max(18, (rings.length - 1) * 4);
  const positions: number[] = [], indices: number[] = [];
  const rowLength = SEGMENTS;
  const layerCount = (rows + 1) * rowLength;
  for (let layer = 0; layer < 2; layer++) for (let i = 0; i <= rows; i++) for (let j = 0; j < SEGMENTS; j++) {
    const angle = j / SEGMENTS * Math.PI * 2;
    const point = loftPoint(rings, i / rows, angle);
    if (layer) { point.x -= Math.cos(angle) * thickness; point.y -= Math.sin(angle) * thickness; }
    positions.push(...point.toArray());
  }
  for (let layer = 0; layer < 2; layer++) for (let r = 0; r < rows; r++) for (let j = 0; j < SEGMENTS; j++) {
    const a = layer * layerCount + r * rowLength + j;
    const b = layer * layerCount + r * rowLength + (j + 1) % rowLength;
    const c = a + rowLength, d = b + rowLength;
    if (layer) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
  }
  const wallIndexCount = rows * SEGMENTS * 6;
  for (const [row, top] of [[0, false], [rows, true]] as const) for (let j = 0; j < SEGMENTS; j++) {
    const a = row * rowLength + j, b = row * rowLength + (j + 1) % rowLength;
    const ia = a + layerCount, ib = b + layerCount;
    if (top) indices.push(a, b, ia, b, ib, ia); else indices.push(a, ia, b, b, ia, ib);
  }
  const shape = geometry(positions, indices);
  shape.addGroup(0, wallIndexCount, 0);
  shape.addGroup(wallIndexCount, wallIndexCount, 1);
  shape.addGroup(wallIndexCount * 2, indices.length - wallIndexCount * 2, 0);
  addMesh(group, 'hollow-upper-and-open-collar', shape, [outside, lining]);
  return (u, v) => loftPoint(rings, u, v * Math.PI * 2);
}

/** Two skins plus edge walls make each strap/panel a thin solid. */
function solidSurface(surface: Surface, uSteps: number, vSteps: number, thickness: number): THREE.BufferGeometry {
  const positions: number[] = [], indices: number[] = [];
  const count = (uSteps + 1) * (vSteps + 1);
  for (let side = 0; side < 2; side++) for (let i = 0; i <= uSteps; i++) for (let j = 0; j <= vSteps; j++) {
    const u = i / uSteps, v = j / vSteps;
    const point = surface(u, v);
    const du = surface(Math.min(1, u + 0.001), v).sub(surface(Math.max(0, u - 0.001), v));
    const dv = surface(u, Math.min(1, v + 0.001)).sub(surface(u, Math.max(0, v - 0.001)));
    const normal = du.cross(dv).normalize();
    point.addScaledVector(normal, thickness / 2 * (side ? -1 : 1));
    positions.push(...point.toArray());
  }
  const index = (i: number, j: number) => i * (vSteps + 1) + j;
  for (let layer = 0; layer < 2; layer++) for (let i = 0; i < uSteps; i++) for (let j = 0; j < vSteps; j++) {
    const a = layer * count + index(i, j), b = layer * count + index(i + 1, j), c = a + 1, d = b + 1;
    if (layer) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
  }
  const border: number[] = [];
  for (let i = 0; i <= uSteps; i++) border.push(index(i, 0));
  for (let j = 1; j <= vSteps; j++) border.push(index(uSteps, j));
  for (let i = uSteps - 1; i >= 0; i--) border.push(index(i, vSteps));
  for (let j = vSteps - 1; j > 0; j--) border.push(index(0, j));
  for (let i = 0; i < border.length; i++) {
    const a = border[i], b = border[(i + 1) % border.length];
    indices.push(a, a + count, b, b, a + count, b + count);
  }
  return geometry(positions, indices);
}

function piping(group: THREE.Group, name: string, points: THREE.Vector3[], radius: number, paint: THREE.Material, closed = false): void {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal');
  addMesh(group, name, new THREE.TubeGeometry(curve, Math.max(16, Math.min(72, points.length * 3)), radius, 5, closed), paint);
}

function ringPiping(group: THREE.Group, name: string, surface: Surface, u: number, radius: number, paint: THREE.Material): void {
  const points = Array.from({ length: 36 }, (_, i) => surface(u, i / 36).add(new THREE.Vector3(0, 0, radius / 3)));
  piping(group, name, points, radius, paint, true);
}

function box(group: THREE.Group, name: string, dimensions: V3, center: V3, paint: THREE.Material): THREE.Mesh {
  const mesh = addMesh(group, name, new THREE.BoxGeometry(...dimensions), paint);
  mesh.position.fromArray(center);
  return mesh;
}

function sole(group: THREE.Group, options: { top: number; outsole: string; midsole: string; footbed?: string; chunky?: boolean; }): void {
  const bottom = options.chunky ? 4 : 2;
  const outsoleTop = options.chunky ? 10 : 7;
  const outer = material(options.outsole, 0.94);
  addMesh(group, 'rubber-outsole', solidLoft([
    { min: -126, max: 126, width: 108, z: bottom, foot: 1 },
    { min: -128, max: 128, width: 110, z: bottom + 1.5, foot: 1 },
    { min: -128, max: 128, width: 110, z: outsoleTop - 1, foot: 1 },
    { min: -126, max: 127, width: 108, z: outsoleTop, foot: 1 },
  ]), outer);
  const mid = material(options.midsole, 0.8);
  addMesh(group, 'layered-midsole', solidLoft([
    { min: -126, max: 126, width: 108, z: outsoleTop - 0.5, foot: 1 },
    { min: -126, max: 126, width: 108, z: options.top - 2, foot: 1 },
    { min: -123, max: 124, width: 103, z: options.top, foot: 1 },
  ]), mid);
  addMesh(group, 'visible-insole-footbed', solidLoft([
    { min: -120, max: 120, width: 96, z: options.top - 0.2, foot: 1 },
    { min: -118, max: 119, width: 94, z: options.top + 1.6, foot: 1 },
  ]), material(options.footbed ?? '#c6a582', 0.96));
  const tread = material(options.outsole, 1);
  for (let i = 0; i < 10; i++) {
    const x = -109 + i * 24;
    const t = (x + 128) / 256;
    const y = 48 * Math.pow(Math.sin(Math.PI * t), 0.65) * (0.72 + 0.25 * Math.exp(-Math.pow((t - 0.68) / 0.27, 2)));
    box(group, `outsole-tread-${i + 1}`, [options.chunky ? 13 : 10, y * 1.85, bottom + 0.4], [x, 0, bottom / 2], tread);
  }
}

function archedBand(group: THREE.Group, name: string, options: { x: number; width: number; halfY: number; base: number; arch: number; yStart?: number; yEnd?: number; thickness?: number; }, paint: THREE.Material): void {
  const { x, width, halfY, base, arch } = options;
  const yStart = options.yStart ?? -halfY, yEnd = options.yEnd ?? halfY;
  const surface: Surface = (u, v) => {
    const y = THREE.MathUtils.lerp(yStart, yEnd, v);
    const z = base + arch * Math.pow(Math.max(0, Math.cos(y / halfY * Math.PI / 2)), 0.78);
    return new THREE.Vector3(x + (u - 0.5) * width, y, z);
  };
  addMesh(group, name, solidSurface(surface, 2, 24, options.thickness ?? 2.6), paint);
}

function panel(group: THREE.Group, name: string, surface: Surface, range: [number, number, number, number], paint: THREE.Material, offset = 0.8): void {
  const [u0, u1, v0, v1] = range;
  const shape: Surface = (u, v) => {
    const angle = THREE.MathUtils.lerp(v0, v1, v) * Math.PI * 2;
    return surface(THREE.MathUtils.lerp(u0, u1, u), THREE.MathUtils.lerp(v0, v1, v))
      .add(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0).multiplyScalar(offset));
  };
  addMesh(group, name, solidSurface(shape, 8, 12, 0.9), paint);
}

function rectangularRibbon(group: THREE.Group, name: string, points: V3[], width: number, thickness: number, widthAxis: THREE.Vector3, paint: THREE.Material): void {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  const segments = 32;
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const point = curve.getPoint(i / segments);
    const tangent = curve.getTangent(i / segments).normalize();
    const wide = widthAxis.clone().sub(tangent.clone().multiplyScalar(widthAxis.dot(tangent))).normalize();
    const normal = tangent.clone().cross(wide).normalize();
    for (const [w, d] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) positions.push(...point.clone().addScaledVector(wide, w * width / 2).addScaledVector(normal, d * thickness / 2).toArray());
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < 4; j++) {
    const a = i * 4 + j, b = i * 4 + (j + 1) % 4;
    indices.push(a, b, a + 4, b, b + 4, a + 4);
  }
  indices.push(0, 2, 1, 0, 3, 2);
  const end = segments * 4;
  indices.push(end, end + 1, end + 2, end, end + 2, end + 3);
  addMesh(group, name, geometry(positions, indices), paint);
}

function buckle(group: THREE.Group, name: string, center: V3, width: number, height: number, paint: THREE.Material): void {
  const [x, y, z] = center;
  box(group, `${name}-top`, [width, 2, 1.8], [x, y, z + height / 2], paint);
  box(group, `${name}-bottom`, [width, 2, 1.8], [x, y, z - height / 2], paint);
  box(group, `${name}-left`, [1.8, 2, height], [x - width / 2, y, z], paint);
  box(group, `${name}-right`, [1.8, 2, height], [x + width / 2, y, z], paint);
  box(group, `${name}-pin`, [width - 2, 1.2, 1.2], [x, y - 0.7, z], paint);
}

function loafer(group: THREE.Group, color: string): void {
  sole(group, { top: 14, outsole: '#383832', midsole: '#82684c', footbed: '#c8a781' });
  const leather = material(color, 0.48), lining = material('#b58c68', 0.92), trim = material('#a77a55', 0.72);
  const surface = upperShell(group, [
    { min: -121, max: 122, width: 100, z: 14, foot: 1 },
    { min: -122, max: 122, width: 101, z: 23, foot: 1 },
    { min: -119, max: 114, width: 99, z: 33, foot: 1 },
    { min: -116, max: 92, width: 90, z: 41, foot: 0.8 },
    { min: -113, max: 61, width: 80, z: 47, foot: 0.5 },
    { min: -111, max: 29, width: 70, z: 53, foot: 0.25 },
    { min: -108, max: 2, width: 61, z: 49, heelRaise: 15 },
  ], leather, lining, 2.8);
  ringPiping(group, 'rolled-open-collar-edge', surface, 1, 1.35, trim);
  const vamp = Array.from({ length: 30 }, (_, i) => surface(0.52, (-0.18 + i / 29 * 0.36 + 1) % 1).add(new THREE.Vector3(0, 0, 0.7)));
  piping(group, 'raised-moccasin-vamp-seam', vamp, 0.8, trim);
  const band = material('#75482f', 0.5);
  archedBand(group, 'penny-band-left', { x: 32, width: 19, halfY: 42, base: 31, arch: 26, yStart: -42, yEnd: -10 }, band);
  archedBand(group, 'penny-band-right', { x: 32, width: 19, halfY: 42, base: 31, arch: 26, yStart: 10, yEnd: 42 }, band);
  for (const offset of [-7.5, 7.5]) archedBand(group, 'penny-slot-edge', { x: 32 + offset, width: 4, halfY: 42, base: 31, arch: 26, yStart: -10, yEnd: 10 }, band);
}

function sneaker(group: THREE.Group, color: string): void {
  sole(group, { top: 26, outsole: '#696c5d', midsole: '#ebe8dc', footbed: '#b7b5a4', chunky: true });
  const upper = material(color, 0.9), lining = material('#8e9988', 0.96), sage = material('#6b7c64', 0.85);
  const surface = upperShell(group, [
    { min: -121, max: 122, width: 101, z: 26, foot: 1 },
    { min: -121, max: 121, width: 100, z: 37, foot: 1 },
    { min: -119, max: 104, width: 97, z: 46, foot: 1 },
    { min: -117, max: 79, width: 89, z: 55, foot: 0.8 },
    { min: -115, max: 47, width: 78, z: 63, foot: 0.5 },
    { min: -113, max: 10, width: 69, z: 70, foot: 0.1 },
    { min: -109, max: -22, width: 62, z: 74, heelRaise: 3 },
  ], upper, lining, 3.4);
  panel(group, 'rubber-toe-cap', surface, [0.01, 0.30, -0.105, 0.105], material('#e7e5d9', 0.84), 1.1);
  panel(group, 'lateral-leather-panel', surface, [0.12, 0.55, 0.16, 0.36], sage, 1.2);
  panel(group, 'medial-leather-panel', surface, [0.12, 0.55, 0.64, 0.84], sage, 1.2);
  panel(group, 'heel-counter', surface, [0.05, 0.48, 0.38, 0.62], material('#64715c', 0.8), 1.3);
  ringPiping(group, 'padded-collar', surface, 1, 2.2, sage);
  const tongue: Surface = (u, v) => {
    const x = -35 + u * 91;
    const y = (v - 0.5) * (u < 0.2 ? 34 : 31);
    return new THREE.Vector3(x, y, 91 - u * 32 + 3 * Math.cos((v - 0.5) * Math.PI));
  };
  addMesh(group, 'separate-raised-tongue', solidSurface(tongue, 10, 6, 3.2), material('#c6cabb', 0.93));
  const lace = material('#f3efe1', 0.9), eyelet = material('#9ca18f', 0.36, 0.5);
  for (let row = 0; row < 5; row++) {
    const x = -17 + row * 15;
    const z = 91 - (x + 35) / 91 * 32;
    for (const side of [-1, 1]) {
      const ring = addMesh(group, `eyelet-${row}-${side}`, new THREE.TorusGeometry(2.15, 0.6, 5, 14), eyelet);
      ring.position.set(x, side * 20.5, z - 1);
      const points = [new THREE.Vector3(x, side * 20.5, z), new THREE.Vector3(x + 3, 0, z + 4.2), new THREE.Vector3(x + 6, -side * 20.5, z - 1.8)];
      piping(group, `cross-lace-${row}-${side}`, points, 0.85, lace);
    }
  }
  rectangularRibbon(group, 'heel-pull-loop', [[-109, -5, 72], [-118, -5, 84], [-111, -5, 85], [-106, -5, 73]], 8, 1.6, new THREE.Vector3(0, 1, 0), sage);
}

function maryJane(group: THREE.Group, color: string): void {
  sole(group, { top: 13, outsole: '#333431', midsole: '#4f453d', footbed: '#d3b78f' });
  const leather = material(color, 0.45), lining = material('#c7a884', 0.92);
  const surface = upperShell(group, [
    { min: -121, max: 122, width: 101, z: 13, foot: 1 },
    { min: -122, max: 121, width: 101, z: 22, foot: 1 },
    { min: -119, max: 110, width: 98, z: 31, foot: 1 },
    { min: -116, max: 83, width: 89, z: 37, foot: 0.5 },
    { min: -111, max: 47, width: 75, z: 35, heelRaise: 19 },
  ], leather, lining, 2.6);
  ringPiping(group, 'open-throat-edge', surface, 1, 1.1, material('#956b6b', 0.65));
  archedBand(group, 'instep-strap', { x: -31, width: 19, halfY: 37, base: 30, arch: 36, thickness: 3 }, leather);
  const brass = material('#b9a06a', 0.28, 0.72);
  buckle(group, 'strap-buckle', [-31, -35, 43], 21, 13, brass);
  const seam = Array.from({ length: 25 }, (_, i) => surface(0.52, (-0.17 + i / 24 * 0.34 + 1) % 1).add(new THREE.Vector3(0, 0, 0.5)));
  piping(group, 'rounded-toe-seam', seam, 0.55, material('#a7837d', 0.75));
}

function sandal(group: THREE.Group, color: string): void {
  sole(group, { top: 15, outsole: '#685c43', midsole: '#b99b72', footbed: '#d2ad79' });
  const leather = material(color, 0.66), edge = material('#916a44', 0.8);
  const rim = (u: number, v: number) => ringPoint({ min: -119, max: 120, width: 97, z: 16.6, foot: 1 }, v * Math.PI * 2);
  ringPiping(group, 'raised-footbed-edge', rim, 0, 1.7, edge);
  archedBand(group, 'wide-forefoot-strap', { x: 66, width: 34, halfY: 45, base: 17, arch: 25, thickness: 3.2 }, leather);
  archedBand(group, 'instep-strap', { x: -22, width: 27, halfY: 37, base: 17, arch: 35, thickness: 3.1 }, leather);
  rectangularRibbon(group, 'heel-retaining-strap', [[-22, -37, 22], [-67, -33, 34], [-107, -27, 37], [-121, 0, 39], [-107, 27, 37], [-67, 33, 34], [-22, 37, 22]], 10, 2.8, new THREE.Vector3(0, 0, 1), edge);
  const brass = material('#b9a477', 0.3, 0.65);
  buckle(group, 'sandal-buckle', [-23, -33, 33], 22, 12, brass);
}

function ankleBoot(group: THREE.Group, color: string): void {
  sole(group, { top: 21, outsole: '#31352e', midsole: '#4b4c3e', footbed: '#b89a74', chunky: true });
  const leather = material(color, 0.59), lining = material('#b59a76', 0.95), elastic = material('#2f3931', 0.98);
  const surface = upperShell(group, [
    { min: -121, max: 122, width: 101, z: 21, foot: 1 },
    { min: -121, max: 120, width: 100, z: 32, foot: 1 },
    { min: -119, max: 96, width: 96, z: 43, foot: 0.9 },
    { min: -116, max: 39, width: 88, z: 59, foot: 0.5 },
    { min: -112, max: -7, width: 76, z: 81, foot: 0.1 },
    { min: -107, max: -22, width: 69, z: 102 },
    { min: -103, max: -25, width: 65, z: 123 },
    { min: -101, max: -24, width: 64, z: 140 },
  ], leather, lining, 3.3);
  panel(group, 'elastic-side-gusset', surface, [0.46, 0.94, 0.17, 0.36], elastic, 0.9);
  panel(group, 'elastic-medial-gusset', surface, [0.46, 0.94, 0.64, 0.83], elastic, 0.9);
  const ribs = material('#454c3e', 0.96);
  for (const interval of [[0.18, 0.35], [0.65, 0.82]]) for (let i = 0; i < 7; i++) {
    const v = THREE.MathUtils.lerp(interval[0], interval[1], i / 6);
    const angle = v * Math.PI * 2;
    const points = Array.from({ length: 10 }, (_, j) => surface(0.48 + j / 9 * 0.44, v).add(new THREE.Vector3(Math.cos(angle) * 1.6, Math.sin(angle) * 1.6, 0)));
    piping(group, `elastic-rib-${interval[0]}-${i}`, points, 0.38, ribs);
  }
  ringPiping(group, 'open-boot-collar', surface, 1, 1.4, material('#76806a', 0.7));
  rectangularRibbon(group, 'back-pull-loop', [[-101, 0, 135], [-108, 0, 150], [-103, 0, 155], [-95, 0, 149], [-98, 0, 135]], 12, 2.1, new THREE.Vector3(0, 1, 0), material('#434c3d', 0.78));
}

const BUILDERS: Record<SampleKind, (group: THREE.Group, color: string) => void> = {
  loafer, sneaker, 'mary-jane': maryJane, sandal, 'ankle-boot': ankleBoot,
};

/** Reproducible concept shoes in mm / Z-up. Imported user geometry never uses this normalization. */
export function createShoeSample(kind: SampleKind): THREE.Group {
  const definition = SHOE_SAMPLES.find((sample) => sample.id === kind);
  if (!definition) throw new Error('알 수 없는 신발 샘플입니다.');
  const design = new THREE.Group();
  design.name = `${definition.englishName} concept geometry`;
  BUILDERS[kind](design, definition.color);
  design.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(design);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const normalized = new THREE.Group();
  normalized.name = `${definition.name} · 개념 샘플`;
  normalized.userData = { sampleKind: kind, conceptOnly: true, units: 'mm', upAxis: 'z', nominalDimensions: [...definition.dimensions] };
  normalized.add(design);
  design.position.set(-center.x, -center.y, -bounds.min.z);
  normalized.scale.set(definition.dimensions[0] / size.x, definition.dimensions[1] / size.y, definition.dimensions[2] / size.z);
  normalized.updateMatrixWorld(true);
  return normalized;
}
