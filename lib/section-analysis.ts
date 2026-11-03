import * as THREE from 'three';

export type SectionAxis = 'x' | 'y' | 'z';
export type SectionPoint = [number, number];
export type SectionSegment = [SectionPoint, SectionPoint];

export interface SectionResult {
  axis: SectionAxis;
  percent: number;
  coordinate: number;
  uAxis: SectionAxis;
  vAxis: SectionAxis;
  shoe: SectionSegment[];
  last: SectionSegment[];
  bounds: [number, number, number, number];
  /** Unsigned distance between the two section boundaries, in world mm. */
  minimumGap: number | null;
  closest: [SectionPoint, SectionPoint] | null;
  /** Boundary contact/crossing within numerical tolerance, not solid containment. */
  intersects: boolean;
  error?: string;
}

const MAX_TRIANGLES_PER_LAYER = 1_500_000;
const MAX_VERTEX_READS_PER_LAYER = 4_500_000;
const MAX_MESH_INSTANCES = 100_000;
const MAX_SECTION_POINTS = 250_000;
const MAX_COPLANAR_EDGES = 300_000;
const MAX_SEGMENTS = 30_000;
const MAX_DISTANCE_CHECKS = 3_000_000;
const MAX_TREE_VISITS = 6_000_000;

interface MeshEntry {
  mesh: THREE.Mesh;
  count: number;
  start: number;
  end: number;
}

const axesFor = (axis: SectionAxis): [SectionAxis, SectionAxis] => axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['x', 'z'] : ['x', 'y'];
const finitePoint = (point: THREE.Vector3) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);

// The pose visibility switch is a viewing control. Hidden source children still
// remain hidden, and no materials, vertex buffers, or source transforms change.
function collectMeshes(root: THREE.Object3D): MeshEntry[] {
  root.updateWorldMatrix(true, false);
  root.updateMatrixWorld(true);
  const entries: MeshEntry[] = [];
  let triangles = 0, vertexReads = 0, instances = 0;
  const visit = (object: THREE.Object3D, isRoot: boolean): void => {
    if (!isRoot && !object.visible) return;
    if (object instanceof THREE.Mesh) {
      const positions = object.geometry.getAttribute('position');
      if (positions) {
        const total = object.geometry.index?.count ?? positions.count;
        const start = Math.max(0, object.geometry.drawRange.start);
        const end = Math.min(total, start + object.geometry.drawRange.count);
        const count = object instanceof THREE.InstancedMesh ? object.count : 1;
        if (![total, start, end, count, positions.count].every(Number.isInteger) || start % 3 !== 0 || count < 0 || positions.itemSize < 3) {
          throw new Error('삼각형 형상의 정점 또는 인스턴스 구조가 올바르지 않습니다.');
        }
        const triangleCount = Math.floor(Math.max(0, end - start) / 3);
        triangles += triangleCount * count;
        vertexReads += triangleCount * 3 * count;
        instances += count;
        if (triangles > MAX_TRIANGLES_PER_LAYER || vertexReads > MAX_VERTEX_READS_PER_LAYER || instances > MAX_MESH_INSTANCES) {
          throw new Error('단면 계산 한도를 초과했습니다. 모델별 삼각형을 150만 개 이하로 줄이고 복제 형상을 단순화해 주세요.');
        }
        if (triangleCount && count) entries.push({ mesh: object, count, start, end: start + triangleCount * 3 });
      }
    }
    for (const child of object.children) visit(child, false);
  };
  visit(root, true);
  return entries;
}

function forEachInstance(entries: MeshEntry[], callback: (entry: MeshEntry, vertexMesh: THREE.Mesh, world: THREE.Matrix4) => void): void {
  const local = new THREE.Matrix4(), world = new THREE.Matrix4();
  for (const entry of entries) {
    const instanced = entry.mesh instanceof THREE.InstancedMesh ? entry.mesh : null;
    // Instanced morph weights belong to each instance, not to the source mesh.
    const morphMesh = instanced?.morphTexture ? new THREE.Mesh(entry.mesh.geometry, entry.mesh.material) : null;
    for (let index = 0; index < entry.count; index++) {
      if (instanced) {
        instanced.getMatrixAt(index, local);
        world.multiplyMatrices(instanced.matrixWorld, local);
        if (morphMesh) instanced.getMorphAt(index, morphMesh);
      } else world.copy(entry.mesh.matrixWorld);
      if (!world.elements.every(Number.isFinite)) throw new Error('모델 변환에 유효하지 않은 좌표가 있습니다.');
      callback(entry, morphMesh ?? entry.mesh, world);
    }
  }
}

function modelBounds(entries: MeshEntry[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  forEachInstance(entries, (entry, mesh, world) => {
    const geometry = entry.mesh.geometry;
    const count = geometry.getAttribute('position').count;
    for (let offset = entry.start; offset < entry.end; offset++) {
      const index = geometry.index ? geometry.index.getX(offset) : offset;
      if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error('삼각형이 존재하지 않는 정점을 참조합니다.');
      mesh.getVertexPosition(index, vertex).applyMatrix4(world);
      if (!finitePoint(vertex)) throw new Error('형상에 유효하지 않은 정점 좌표가 있습니다. 원본 모델을 확인해 주세요.');
      bounds.expandByPoint(vertex);
    }
  });
  return bounds;
}

class SectionCollector {
  readonly points: SectionPoint[] = [];
  private buckets = new Map<string, number[]>();
  private edges = new Map<string, [number, number]>();
  private connected = new Set<number>();

  constructor(private readonly tolerance: number) {}

  point(point: SectionPoint): number {
    const x = Math.floor(point[0] / this.tolerance), y = Math.floor(point[1] / this.tolerance);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const found = this.buckets.get(`${x + dx},${y + dy}`);
      if (found) for (const index of found) {
        const candidate = this.points[index];
        if (Math.hypot(candidate[0] - point[0], candidate[1] - point[1]) <= this.tolerance) return index;
      }
    }
    if (this.points.length >= MAX_SECTION_POINTS) throw new Error('절단면의 정점 수가 너무 많습니다. 모델을 단순화하거나 절단 위치를 바꿔 주세요.');
    const index = this.points.length;
    this.points.push(point);
    const key = `${x},${y}`;
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(index); else this.buckets.set(key, [index]);
    return index;
  }

  edge(first: number, second: number): void {
    const key = first <= second ? `${first},${second}` : `${second},${first}`;
    if (this.edges.has(key)) return;
    if (this.edges.size >= MAX_SEGMENTS) throw new Error('단면 선분 수가 3만 개를 초과했습니다. 모델을 단순화하거나 절단 위치를 바꿔 주세요.');
    this.edges.set(key, [first, second]);
    if (first !== second) { this.connected.add(first); this.connected.add(second); }
  }

  result(): SectionSegment[] {
    return [...this.edges.values()]
      .filter(([first, second]) => first !== second || !this.connected.has(first))
      .map(([first, second]) => [this.points[first], this.points[second]]);
  }
}

function sectionSegments(entries: MeshEntry[], axis: SectionAxis, coordinate: number, uAxis: SectionAxis, vAxis: SectionAxis, epsilon: number): SectionSegment[] {
  const collector = new SectionCollector(epsilon);
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
  const coplanarEdges = new Map<string, { first: number; second: number; count: number }>();
  const coplanarTriangles = new Set<string>();
  forEachInstance(entries, (entry, mesh, world) => {
    const geometry = entry.mesh.geometry;
    for (let offset = entry.start; offset < entry.end; offset += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const index = geometry.index ? geometry.index.getX(offset + corner) : offset + corner;
        if (!Number.isInteger(index) || index < 0 || index >= geometry.getAttribute('position').count) throw new Error('삼각형이 존재하지 않는 정점을 참조합니다.');
        mesh.getVertexPosition(index, vertices[corner]).applyMatrix4(world);
      }
      const distances = vertices.map(vertex => vertex[axis] - coordinate);
      const signs = distances.map(value => Math.abs(value) <= epsilon ? 0 : value > 0 ? 1 : -1);
      if (signs.every(value => value === 1) || signs.every(value => value === -1)) continue;
      ab.subVectors(vertices[1], vertices[0]); ac.subVectors(vertices[2], vertices[0]);
      if (cross.crossVectors(ab, ac).lengthSq() <= epsilon * epsilon * Math.max(ab.lengthSq(), ac.lengthSq())) continue;
      const project = (vertex: THREE.Vector3): SectionPoint => [vertex[uAxis], vertex[vAxis]];
      if (signs.every(value => value === 0)) {
        const ids = vertices.map(vertex => collector.point(project(vertex)));
        const key = [...ids].sort((first, second) => first - second).join(',');
        if (coplanarTriangles.has(key)) continue;
        coplanarTriangles.add(key);
        for (let edge = 0; edge < 3; edge++) {
          const first = ids[edge], second = ids[(edge + 1) % 3];
          const key = first <= second ? `${first},${second}` : `${second},${first}`;
          const previous = coplanarEdges.get(key);
          if (previous) {
            previous.count++;
            if (previous.count > 2) throw new Error('절단면과 겹친 면에 중복 연결이 있습니다. 절단 위치를 조금 옮기거나 원본 면을 정리해 주세요.');
          } else coplanarEdges.set(key, { first, second, count: 1 });
          if (coplanarEdges.size > MAX_COPLANAR_EDGES) throw new Error('절단면과 겹친 면이 너무 복잡합니다. 절단 위치를 조금 옮기거나 모델을 단순화해 주세요.');
        }
        continue;
      }
      const hits: number[] = [];
      for (let corner = 0; corner < 3; corner++) if (signs[corner] === 0) hits.push(collector.point(project(vertices[corner])));
      for (let edge = 0; edge < 3; edge++) {
        const next = (edge + 1) % 3;
        if (signs[edge] * signs[next] >= 0) continue;
        const fraction = distances[edge] / (distances[edge] - distances[next]);
        const point: SectionPoint = [
          vertices[edge][uAxis] + (vertices[next][uAxis] - vertices[edge][uAxis]) * fraction,
          vertices[edge][vAxis] + (vertices[next][vAxis] - vertices[edge][vAxis]) * fraction,
        ];
        hits.push(collector.point(point));
      }
      const unique = [...new Set(hits)];
      if (unique.length === 1) collector.edge(unique[0], unique[0]);
      else if (unique.length === 2) collector.edge(unique[0], unique[1]);
    }
  });
  // Shared coplanar edges are triangulation diagonals, including where an
  // importer split the same surface into multiple meshes or material groups.
  for (const edge of coplanarEdges.values()) if (edge.count === 1) collector.edge(edge.first, edge.second);
  return collector.result();
}

type Bounds2 = [number, number, number, number];
interface SegmentRecord { segment: SectionSegment; bounds: Bounds2 }
interface DistanceNode { bounds: Bounds2; records?: SegmentRecord[]; left?: DistanceNode; right?: DistanceNode }

function segmentBounds(segment: SectionSegment): Bounds2 {
  return [Math.min(segment[0][0], segment[1][0]), Math.min(segment[0][1], segment[1][1]), Math.max(segment[0][0], segment[1][0]), Math.max(segment[0][1], segment[1][1])];
}

function treeFor(records: SegmentRecord[]): DistanceNode {
  const bounds: Bounds2 = [Infinity, Infinity, -Infinity, -Infinity];
  for (const record of records) {
    bounds[0] = Math.min(bounds[0], record.bounds[0]); bounds[1] = Math.min(bounds[1], record.bounds[1]);
    bounds[2] = Math.max(bounds[2], record.bounds[2]); bounds[3] = Math.max(bounds[3], record.bounds[3]);
  }
  if (records.length <= 8) return { bounds, records };
  const axis = bounds[2] - bounds[0] >= bounds[3] - bounds[1] ? 0 : 1;
  records.sort((a, b) => (a.bounds[axis] + a.bounds[axis + 2]) - (b.bounds[axis] + b.bounds[axis + 2]));
  const middle = Math.floor(records.length / 2);
  return { bounds, left: treeFor(records.slice(0, middle)), right: treeFor(records.slice(middle)) };
}

function boxDistanceSquared(first: Bounds2, second: Bounds2): number {
  const u = Math.max(0, first[0] - second[2], second[0] - first[2]);
  const v = Math.max(0, first[1] - second[3], second[1] - first[3]);
  return u * u + v * v;
}

function closestOnSegment(point: SectionPoint, segment: SectionSegment): SectionPoint {
  const [first, second] = segment;
  const u = second[0] - first[0], v = second[1] - first[1];
  const squared = u * u + v * v;
  const fraction = squared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - first[0]) * u + (point[1] - first[1]) * v) / squared));
  return [first[0] + u * fraction, first[1] + v * fraction];
}

function segmentDistance(first: SectionSegment, second: SectionSegment): { squared: number; points: [SectionPoint, SectionPoint] } {
  const [a, b] = first, [c, d] = second;
  const ru = b[0] - a[0], rv = b[1] - a[1], su = d[0] - c[0], sv = d[1] - c[1];
  const denominator = ru * sv - rv * su;
  if (denominator !== 0) {
    const qu = c[0] - a[0], qv = c[1] - a[1];
    const t = (qu * sv - qv * su) / denominator, u = (qu * rv - qv * ru) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const point: SectionPoint = [a[0] + t * ru, a[1] + t * rv];
      return { squared: 0, points: [point, [...point]] };
    }
  }
  const pairs: [SectionPoint, SectionPoint][] = [
    [a, closestOnSegment(a, second)], [b, closestOnSegment(b, second)],
    [closestOnSegment(c, first), c], [closestOnSegment(d, first), d],
  ];
  let squared = Infinity, points = pairs[0];
  for (const pair of pairs) {
    const distance = (pair[0][0] - pair[1][0]) ** 2 + (pair[0][1] - pair[1][1]) ** 2;
    if (distance < squared) { squared = distance; points = pair; }
  }
  return { squared, points };
}

function boundaryDistance(shoe: SectionSegment[], last: SectionSegment[], epsilon: number): Pick<SectionResult, 'minimumGap' | 'closest' | 'intersects'> {
  if (!shoe.length || !last.length) return { minimumGap: null, closest: null, intersects: false };
  const tree = treeFor(last.map(segment => ({ segment, bounds: segmentBounds(segment) })));
  let best = Infinity, closest: [SectionPoint, SectionPoint] | null = null, checks = 0, visits = 0;
  for (const segment of shoe) {
    const bounds = segmentBounds(segment), stack = [tree];
    while (stack.length) {
      if (++visits > MAX_TREE_VISITS) throw new Error('정확한 단면 거리 계산량이 너무 많습니다. 모델을 단순화하거나 절단 위치를 바꿔 주세요.');
      const node = stack.pop()!;
      if (boxDistanceSquared(bounds, node.bounds) > best) continue;
      if (node.records) {
        for (const record of node.records) {
          if (boxDistanceSquared(bounds, record.bounds) > best) continue;
          if (++checks > MAX_DISTANCE_CHECKS) throw new Error('정확한 단면 거리 계산량이 너무 많습니다. 모델을 단순화하거나 절단 위치를 바꿔 주세요.');
          const candidate = segmentDistance(segment, record.segment);
          if (candidate.squared < best) { best = candidate.squared; closest = candidate.points; }
          if (best === 0) return { minimumGap: 0, closest, intersects: true };
        }
      } else {
        const left = node.left!, right = node.right!;
        if (boxDistanceSquared(bounds, left.bounds) <= boxDistanceSquared(bounds, right.bounds)) stack.push(right, left);
        else stack.push(left, right);
      }
    }
  }
  return { minimumGap: Math.sqrt(best), closest, intersects: best <= epsilon * epsilon };
}

/** Read-only world-mm triangle section; no bounding-box or convex-hull substitute. */
export function computeModelSection(
  shoeRoot: THREE.Object3D,
  lastRoot: THREE.Object3D | null,
  settings: { axis: SectionAxis; percent: number },
): SectionResult {
  const axis = ['x', 'y', 'z'].includes(settings.axis) ? settings.axis : 'x';
  const [uAxis, vAxis] = axesFor(axis);
  const result: SectionResult = {
    axis, percent: Number.isFinite(settings.percent) ? settings.percent : 50, coordinate: 0,
    uAxis, vAxis, shoe: [], last: [], bounds: [0, 0, 0, 0], minimumGap: null, closest: null, intersects: false,
  };
  try {
    if (axis !== settings.axis || !Number.isFinite(settings.percent) || settings.percent < 0 || settings.percent > 100) throw new Error('단면 축과 0~100% 범위의 절단 위치를 확인해 주세요.');
    const shoeMeshes = collectMeshes(shoeRoot), lastMeshes = lastRoot ? collectMeshes(lastRoot) : [];
    const shoeBounds = modelBounds(shoeMeshes);
    if (shoeBounds.isEmpty()) throw new Error('단면을 계산할 신발 삼각형 형상이 없습니다.');
    const lastBounds = modelBounds(lastMeshes);
    result.coordinate = shoeBounds.min[axis] + (shoeBounds.max[axis] - shoeBounds.min[axis]) * settings.percent / 100;
    const combined = shoeBounds.clone().union(lastBounds), size = combined.getSize(new THREE.Vector3());
    const magnitude = Math.max(...combined.min.toArray().map(Math.abs), ...combined.max.toArray().map(Math.abs));
    const epsilon = Math.max(1e-8, Math.max(size.x, size.y, size.z) * 1e-10, magnitude * Number.EPSILON * 64);
    const shoe = sectionSegments(shoeMeshes, axis, result.coordinate, uAxis, vAxis, epsilon);
    const last = sectionSegments(lastMeshes, axis, result.coordinate, uAxis, vAxis, epsilon);
    const bounds: Bounds2 = [Infinity, Infinity, -Infinity, -Infinity];
    for (const segment of [...shoe, ...last]) for (const point of segment) {
      bounds[0] = Math.min(bounds[0], point[0]); bounds[1] = Math.min(bounds[1], point[1]);
      bounds[2] = Math.max(bounds[2], point[0]); bounds[3] = Math.max(bounds[3], point[1]);
    }
    if (!Number.isFinite(bounds[0])) bounds.splice(0, 4, shoeBounds.min[uAxis], shoeBounds.min[vAxis], shoeBounds.max[uAxis], shoeBounds.max[vAxis]);
    return { ...result, shoe, last, bounds, ...boundaryDistance(shoe, last, epsilon) };
  } catch (cause) {
    return { ...result, error: cause instanceof Error ? cause.message : '단면을 계산하지 못했습니다. 원본 형상을 확인해 주세요.' };
  }
}
