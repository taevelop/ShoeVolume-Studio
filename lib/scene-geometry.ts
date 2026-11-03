import * as THREE from 'three';
import type { PlaneKey, Vec3 } from './project';

type Station = [number, number, number, number];

const LAST_STATIONS: Station[] = [
  [0, -124, 119, 92], [4, -129, 126, 99], [12, -130, 130, 100],
  [22, -127, 125, 97], [32, -123, 98, 92], [44, -118, 45, 80],
  [60, -111, -4, 65], [80, -104, -30, 53], [100, -98, -42, 44],
  [110, -94, -47, 39],
];

function catmull(a: number, b: number, c: number, d: number, t: number): number {
  return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
}

function stationAt(z: number): Station {
  let i = LAST_STATIONS.findIndex((s) => s[0] >= z) - 1;
  i = Math.max(0, Math.min(LAST_STATIONS.length - 2, i));
  const a = LAST_STATIONS[Math.max(0, i - 1)];
  const b = LAST_STATIONS[i];
  const c = LAST_STATIONS[i + 1];
  const d = LAST_STATIONS[Math.min(LAST_STATIONS.length - 1, i + 2)];
  const t = THREE.MathUtils.clamp((z - b[0]) / (c[0] - b[0]), 0, 1);
  return [z, catmull(a[1], b[1], c[1], d[1], t), catmull(a[2], b[2], c[2], d[2], t), catmull(a[3], b[3], c[3], d[3], t)];
}

/** A deliberately illustrative, closed last. It is not recovered from the supplied screenshots. */
export function createSampleLastGeometry(dimensions: Vec3 = [253, 105.31, 79.4]): THREE.BufferGeometry {
  const ringCount = 66;
  const segments = 112;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= ringCount; ring++) {
    const z = (ring / ringCount) * 110;
    const [, xMin, xMax, width] = stationAt(z);
    const blend = Math.min(1, z / 75);
    for (let j = 0; j < segments; j++) {
      const angle = (j / segments) * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const t = (c + 1) / 2;
      const x = (xMin + xMax) / 2 + (xMax - xMin) / 2 * c;
      const footprintWidth = 0.78 + 0.3 * Math.exp(-Math.pow((t - 0.7) / 0.24, 2));
      const shape = THREE.MathUtils.lerp(footprintWidth, 1, blend);
      const centerline = (1 - blend) * 2.6 * Math.sin(t * Math.PI);
      const y = Math.sign(s) * Math.pow(Math.abs(s), 0.76) * width / 2 * shape + centerline;
      positions.push(x, y, z);
    }
  }

  for (let ring = 0; ring < ringCount; ring++) {
    for (let j = 0; j < segments; j++) {
      const a = ring * segments + j;
      const b = ring * segments + (j + 1) % segments;
      const c = (ring + 1) * segments + j;
      const d = (ring + 1) * segments + (j + 1) % segments;
      indices.push(a, b, c, b, d, c);
    }
  }

  // Dedicated cap vertices keep the flat sole and ankle face visually distinct.
  for (const [ring, z, top] of [[0, 0, false], [ringCount, 110, true]] as const) {
    const start = positions.length / 3;
    let cx = 0;
    let cy = 0;
    for (let j = 0; j < segments; j++) {
      const source = (ring * segments + j) * 3;
      positions.push(positions[source], positions[source + 1], z);
      cx += positions[source];
      cy += positions[source + 1];
    }
    const center = positions.length / 3;
    positions.push(cx / segments, cy / segments, z);
    for (let j = 0; j < segments; j++) {
      const a = start + j;
      const b = start + (j + 1) % segments;
      if (top) indices.push(center, a, b);
      else indices.push(center, b, a);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -center.y, -box.min.z);
  geometry.scale(dimensions[0] / size.x, dimensions[1] / size.y, dimensions[2] / size.z);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

type Point2 = [number, number];

function convexHull(points: Point2[]): Point2[] {
  const sorted = points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Blueprint guides are projections of the sample, not manufactured-shoe images. */
export function createSampleReference(key: PlaneKey, dimensions: Vec3): string {
  const [length, width, height] = dimensions;
  const horizontal = key === 'side' || key === 'top' ? length : width;
  const vertical = key === 'top' ? width : height;
  const geometry = createSampleLastGeometry([260, 100, 110]);
  const vertices = geometry.getAttribute('position');
  const points: Point2[] = [];
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i) * length / 260;
    const y = vertices.getY(i) * width / 100;
    const z = vertices.getZ(i) * height / 110;
    if (key === 'side') points.push([x + length / 2, height - z]);
    else if (key === 'top') points.push([x + length / 2, width / 2 - y]);
    else points.push([width / 2 + y * (key === 'rear' ? -1 : 1), height - z]);
  }
  geometry.dispose();
  const hull = convexHull(points);
  const path = hull.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ') + ' Z';
  const stroke = Math.max(0.4, horizontal / 500);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${horizontal * 4}" height="${vertical * 4}" viewBox="0 0 ${horizontal} ${vertical}"><defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" fill="none" stroke="#ccd2c7" stroke-width="0.3"/></pattern><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M 0 0 L 0 5" stroke="#7b8c75" stroke-width="0.35"/></pattern></defs><rect width="100%" height="100%" fill="#f8faf5" fill-opacity="0.42"/><rect width="100%" height="100%" fill="url(#grid)"/><path d="${path}" fill="#a6b29a" fill-opacity="0.12" stroke="#6a7d65" stroke-width="${stroke}"/><path d="${path}" fill="url(#hatch)" opacity="0.4"/><path d="M${horizontal / 2},0 V${vertical} M0,${vertical / 2} H${horizontal}" fill="none" stroke="#98a88e" stroke-width="0.3" stroke-dasharray="3 2"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function textSprite(text: string, options: { color?: string; background?: string; height?: number; opacity?: number } = {}): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = '500 26px system-ui, sans-serif';
  const width = Math.ceil(context.measureText(text).width + 28);
  canvas.width = width;
  canvas.height = 48;
  context.font = '500 26px system-ui, sans-serif';
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, width, 48);
  }
  context.fillStyle = options.color ?? '#687561';
  context.textBaseline = 'middle';
  context.fillText(text, 14, 25);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, opacity: options.opacity ?? 1 });
  const sprite = new THREE.Sprite(material);
  const height = options.height ?? 9;
  sprite.scale.set(height * width / 48, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}

export function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) {
      const image = value.source?.data;
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
      value.dispose();
    }
  }
  material.dispose();
}

export function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) child.geometry.dispose();
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Sprite) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(disposeMaterial);
    }
  });
  object.removeFromParent();
}
