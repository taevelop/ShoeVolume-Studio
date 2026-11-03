import * as THREE from 'three';

type CanvasImage = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;
type Point = [number, number];
interface DrawRecord { depth: number; overlay: boolean; draw: (context: CanvasRenderingContext2D) => void }

function sourceImage(texture: THREE.Texture | null | undefined): CanvasImage | null {
  const image = texture?.source?.data;
  if (!image || typeof image !== 'object') return null;
  if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) return image;
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) return image;
  if (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) return image;
  return null;
}

function materialColor(material: THREE.Material): THREE.Color {
  const color = (material as THREE.Material & { color?: THREE.Color }).color;
  return color?.isColor ? color : new THREE.Color('#acb7a4');
}

function affineImage(context: CanvasRenderingContext2D, image: CanvasImage, dst: [Point, Point, Point], src: [Point, Point, Point]): void {
  const [[u0, v0], [u1, v1], [u2, v2]] = src;
  const [[x0, y0], [x1, y1], [x2, y2]] = dst;
  const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
  if (Math.abs(det) < 1e-10) return;
  const a = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det;
  const b = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / det;
  const c = (x0 * (u2 - u1) + x1 * (u0 - u2) + x2 * (u1 - u0)) / det;
  const d = (y0 * (u2 - u1) + y1 * (u0 - u2) + y2 * (u1 - u0)) / det;
  const e = (x0 * (u1 * v2 - u2 * v1) + x1 * (u2 * v0 - u0 * v2) + x2 * (u0 * v1 - u1 * v0)) / det;
  const f = (y0 * (u1 * v2 - u2 * v1) + y1 * (u2 * v0 - u0 * v2) + y2 * (u0 * v1 - u1 * v0)) / det;
  context.save();
  context.beginPath();
  context.moveTo(x0, y0); context.lineTo(x1, y1); context.lineTo(x2, y2); context.closePath();
  context.clip();
  context.transform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

/** Real geometry projection for browsers where WebGL is unavailable. */
export class SoftwareRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly capabilities = { getMaxAnisotropy: () => 1 };
  private context: CanvasRenderingContext2D;
  private ratio = 1;
  private width = 1;
  private height = 1;
  private disposed = false;
  private onDense: () => void;
  private denseNotified = false;

  constructor(onDense: () => void) {
    this.domElement = document.createElement('canvas');
    const context = this.domElement.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D 그래픽을 사용할 수 없습니다.');
    this.context = context;
    this.onDense = onDense;
  }

  setPixelRatio(ratio: number): void { this.ratio = Math.min(ratio, 1.5); }

  setSize(width: number, height: number, updateStyle = true): void {
    this.width = width; this.height = height;
    this.domElement.width = Math.max(1, Math.round(width * this.ratio));
    this.domElement.height = Math.max(1, Math.round(height * this.ratio));
    if (updateStyle) { this.domElement.style.width = `${width}px`; this.domElement.style.height = `${height}px`; }
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    const context = this.context;
    const width = this.width, height = this.height;
    context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    context.globalAlpha = 1;
    context.fillStyle = scene.background instanceof THREE.Color ? scene.background.getStyle() : '#f3f4f0';
    context.fillRect(0, 0, width, height);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const viewProjection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const draws: DrawRecord[] = [];
    const light = new THREE.Vector3(0.3, -0.55, 0.9).normalize();
    const cameraDirection = camera.getWorldDirection(new THREE.Vector3()).negate();

    const project = (point: THREE.Vector3): { point: Point; z: number; w: number } => {
      const p = new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(viewProjection);
      return { point: [(p.x / p.w + 1) * width / 2, (1 - p.y / p.w) * height / 2], z: p.z / p.w, w: p.w };
    };

    const mesh = (object: THREE.Mesh, worldMatrix: THREE.Matrix4): void => {
      const geometry = object.geometry;
      const positions = geometry.getAttribute('position');
      if (!positions) return;
      const index = geometry.index;
      const total = Math.floor((index?.count ?? positions.count) / 3);
      const stride = Math.max(1, Math.ceil(total / 60000));
      if (stride > 1 && !this.denseNotified) { this.denseNotified = true; this.onDense(); }
      const transform = new THREE.Matrix4().multiplyMatrices(viewProjection, worldMatrix);
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
      const m = transform.elements;
      const projected = new Float64Array(positions.count * 4);
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
        const clipW = m[3] * x + m[7] * y + m[11] * z + m[15];
        projected[i * 4] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / clipW + 1) * width / 2;
        projected[i * 4 + 1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / clipW) * height / 2;
        projected[i * 4 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / clipW;
        projected[i * 4 + 3] = clipW;
      }
      const normals = geometry.getAttribute('normal');
      const uv = geometry.getAttribute('uv');
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const groups = geometry.groups;
      const normal = new THREE.Vector3();
      for (let triangle = 0; triangle < total; triangle += stride) {
        const offset = triangle * 3;
        const a = index ? index.getX(offset) : offset;
        const b = index ? index.getX(offset + 1) : offset + 1;
        const c = index ? index.getX(offset + 2) : offset + 2;
        if (projected[a * 4 + 3] <= 0 || projected[b * 4 + 3] <= 0 || projected[c * 4 + 3] <= 0) continue;
        const zs = [projected[a * 4 + 2], projected[b * 4 + 2], projected[c * 4 + 2]];
        if (zs.every((z) => z < -1) || zs.every((z) => z > 1)) continue;
        const dst: [Point, Point, Point] = [[projected[a * 4], projected[a * 4 + 1]], [projected[b * 4], projected[b * 4 + 1]], [projected[c * 4], projected[c * 4 + 1]]];
        if (dst.every((p) => p[0] < 0) || dst.every((p) => p[0] > width) || dst.every((p) => p[1] < 0) || dst.every((p) => p[1] > height)) continue;
        const group = materials.length > 1 ? groups.find((g) => offset >= g.start && offset < g.start + g.count) : null;
        const material = materials[group?.materialIndex ?? 0] ?? materials[0];
        if (!material.visible || material.opacity <= 0 || material instanceof THREE.ShadowMaterial) continue;
        const mapped = material as THREE.Material & { map?: THREE.Texture; wireframe?: boolean };
        const image = sourceImage(mapped.map);
        const opacity = material.opacity;
        const wireframe = !!mapped.wireframe;
        let color = materialColor(material).getStyle();
        if (!image && !(material instanceof THREE.MeshBasicMaterial)) {
          if (normals) normal.set(normals.getX(a) + normals.getX(b) + normals.getX(c), normals.getY(a) + normals.getY(b) + normals.getY(c), normals.getZ(a) + normals.getZ(b) + normals.getZ(c)).applyMatrix3(normalMatrix).normalize();
          else normal.set(0, 0, 1);
          if (normal.dot(cameraDirection) < 0) normal.negate();
          const brightness = 0.55 + 0.45 * Math.max(0, normal.dot(light));
          color = materialColor(material).clone().multiplyScalar(brightness).getStyle();
        }
        const src: [Point, Point, Point] | null = image && uv ? [a, b, c].map((i) => [uv.getX(i) * image.width, (mapped.map?.flipY === false ? uv.getY(i) : 1 - uv.getY(i)) * image.height]) as [Point, Point, Point] : null;
        draws.push({ depth: (zs[0] + zs[1] + zs[2]) / 3, overlay: !material.depthTest, draw: (ctx) => {
          ctx.globalAlpha = opacity;
          if (image && src && !wireframe) { affineImage(ctx, image, dst, src); return; }
          ctx.beginPath(); ctx.moveTo(...dst[0]); ctx.lineTo(...dst[1]); ctx.lineTo(...dst[2]); ctx.closePath();
          if (wireframe) { ctx.strokeStyle = color; ctx.lineWidth = 0.55; ctx.stroke(); }
          else { ctx.fillStyle = color; ctx.fill(); }
        } });
      }
    };

    scene.traverseVisible((object) => {
      if (object instanceof THREE.Mesh) {
        if (object instanceof THREE.InstancedMesh) {
          const instance = new THREE.Matrix4();
          for (let i = 0; i < Math.min(object.count, 1000); i++) {
            object.getMatrixAt(i, instance);
            mesh(object, instance.premultiply(object.matrixWorld));
          }
        } else mesh(object, object.matrixWorld);
      } else if (object instanceof THREE.Line) {
        const geometry = object.geometry;
        const position = geometry.getAttribute('position');
        if (!position) return;
        const material = Array.isArray(object.material) ? object.material[0] : object.material;
        const index = geometry.index;
        const count = index?.count ?? position.count;
        const step = object instanceof THREE.LineSegments ? 2 : 1;
        const colors = geometry.getAttribute('color');
        const useVertexColors = material instanceof THREE.LineBasicMaterial && material.vertexColors && colors;
        const isFloorGrid = object instanceof THREE.GridHelper;
        for (let i = 0; i < count - 1; i += step) {
          const ia = index ? index.getX(i) : i;
          const ib = index ? index.getX(i + 1) : i + 1;
          const a = project(new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(object.matrixWorld));
          const b = project(new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(object.matrixWorld));
          if (a.w <= 0 || b.w <= 0 || a.z > 1 && b.z > 1 || a.z < -1 && b.z < -1) continue;
          const color = materialColor(material).clone();
          if (useVertexColors) color.multiply(new THREE.Color(
            (colors.getX(ia) + colors.getX(ib)) / 2,
            (colors.getY(ia) + colors.getY(ib)) / 2,
            (colors.getZ(ia) + colors.getZ(ib)) / 2,
          ));
          const lineColor = color.getStyle();
          draws.push({ depth: isFloorGrid ? Number.POSITIVE_INFINITY : (a.z + b.z) / 2, overlay: !material.depthTest, draw: (ctx) => {
            ctx.globalAlpha = material.opacity; ctx.strokeStyle = lineColor; ctx.lineWidth = material instanceof THREE.LineBasicMaterial ? Math.max(0.5, material.linewidth) : 1;
            ctx.beginPath(); ctx.moveTo(...a.point); ctx.lineTo(...b.point); ctx.stroke();
          } });
        }
      } else if (object instanceof THREE.Sprite) {
        const image = sourceImage(object.material.map);
        if (!image) return;
        const center = object.getWorldPosition(new THREE.Vector3());
        const scale = object.getWorldScale(new THREE.Vector3());
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(scale.x / 2);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).multiplyScalar(scale.y / 2);
        const a = project(center.clone().sub(right).add(up));
        const b = project(center.clone().add(right).sub(up));
        if (a.w <= 0 || a.z > 1 || a.z < -1) return;
        draws.push({ depth: (a.z + b.z) / 2, overlay: !object.material.depthTest, draw: (ctx) => {
          ctx.globalAlpha = object.material.opacity;
          ctx.drawImage(image, a.point[0], a.point[1], b.point[0] - a.point[0], b.point[1] - a.point[1]);
        } });
      }
    });
    draws.sort((a, b) => Number(a.overlay) - Number(b.overlay) || b.depth - a.depth);
    for (const record of draws) record.draw(context);
    context.globalAlpha = 1;
  }

  dispose(): void {
    this.disposed = true;
    this.domElement.width = 1; this.domElement.height = 1;
  }
}
