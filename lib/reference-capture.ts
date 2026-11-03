import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import type { PlaneKey, Vec3 } from './project';
import type { ReferenceCaptureImage, ReferenceCaptureOptions } from './reference-capture-types';
import { SoftwareRenderer } from './scene-software-renderer';

export interface ReferenceCaptureFrame {
  view: PlaneKey;
  width: number;
  height: number;
  frameWidthMm: number;
  frameHeightMm: number;
}

export interface ReferenceCapturePlan {
  modelDimensions: Vec3;
  center: THREE.Vector3;
  pixelsPerMm: number;
  frames: ReferenceCaptureFrame[];
}

const CAPTURE_VIEWS: readonly PlaneKey[] = ['side', 'top', 'front', 'rear'];
const SOFTWARE_TRIANGLE_LIMIT = 200_000;

// Changed: all views use one exact scale; integer-pixel rounding expands the
// physical frame, never its content, and the returned mm values include padding.
export function planReferenceCapture(bounds: THREE.Box3, maxSize: 1024 | 2048): ReferenceCapturePlan {
  if (maxSize !== 1024 && maxSize !== 2048) throw new Error('이미지 크기는 1024 또는 2048로 선택해 주세요.');
  const size = bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray(), ...size.toArray()].every(Number.isFinite) || extent <= 0) {
    throw new Error('형상의 크기를 계산할 수 없습니다. 3D 파일을 다시 불러와 주세요.');
  }
  const padding = extent * 0.04;
  const pixelsPerMm = maxSize / (extent + padding * 2);
  const framePixels = (millimeters: number) => Math.max(1, Math.min(maxSize, Math.ceil((millimeters + padding * 2) * pixelsPerMm - 1e-9)));
  const frames = CAPTURE_VIEWS.map((view): ReferenceCaptureFrame => {
    const width = framePixels(view === 'front' || view === 'rear' ? size.y : size.x);
    const height = framePixels(view === 'top' ? size.y : size.z);
    return { view, width, height, frameWidthMm: width / pixelsPerMm, frameHeightMm: height / pixelsPerMm };
  });
  return { modelDimensions: size.toArray() as Vec3, center: bounds.getCenter(new THREE.Vector3()), pixelsPerMm, frames };
}

// Changed: these camera bases match the live view and reference-plane axes.
// side: right +X/up +Z; top: right +X/up +Y; front: right +Y/up +Z;
// rear: right -Y/up +Z. The current model pose is left untouched.
export function createReferenceCamera(plan: ReferenceCapturePlan, frame: ReferenceCaptureFrame): THREE.OrthographicCamera {
  const radius = new THREE.Vector3(...plan.modelDimensions).length() / 2;
  const distance = Math.max(radius * 3, 1);
  const direction: Record<PlaneKey, THREE.Vector3> = {
    side: new THREE.Vector3(0, -1, 0),
    top: new THREE.Vector3(0, 0, 1),
    front: new THREE.Vector3(1, 0, 0),
    rear: new THREE.Vector3(-1, 0, 0),
  };
  const camera = new THREE.OrthographicCamera(-frame.frameWidthMm / 2, frame.frameWidthMm / 2, frame.frameHeightMm / 2, -frame.frameHeightMm / 2, Math.max(radius * 0.0001, 0.000001), distance + radius * 3 + 1);
  camera.up.set(0, frame.view === 'top' ? 1 : 0, frame.view === 'top' ? 0 : 1);
  camera.position.copy(plan.center).addScaledVector(direction[frame.view], distance);
  camera.lookAt(plan.center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function createCaptureRenderer(preferSoftware: boolean): THREE.WebGLRenderer | SoftwareRenderer {
  if (!preferSoftware) {
    const canvas = document.createElement('canvas');
    let context: WebGL2RenderingContext | null = null;
    try {
      context = canvas.getContext('webgl2', { antialias: true, alpha: true, preserveDrawingBuffer: true });
      if (context) {
        const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
        renderer.setClearColor('#ffffff', 0);
        return renderer;
      }
    } catch {
      context?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  // Changed: exports project every triangle and instance. Excessive geometry is
  // rejected explicitly below instead of silently using the interactive shortcut.
  return new SoftwareRenderer(() => {}, { alpha: true, maxTrianglesPerMesh: Infinity, maxInstances: Infinity, depthBuffer: true });
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG 이미지를 만들지 못했습니다. 이미지 크기를 낮춰 다시 시도해 주세요.'));
      }, 'image/png');
    } catch {
      reject(new Error('PNG 이미지를 만들지 못했습니다. 3D 파일을 다시 불러와 주세요.'));
    }
  });
}

// Changed: capture owns its scene, cameras, renderer, and material clones. Mesh
// geometry and texture data remain shared read-only and are never disposed here.
export async function captureModelReferences(
  pose: THREE.Object3D,
  options: ReferenceCaptureOptions,
  preferSoftware: boolean,
  assertCurrent: () => void,
): Promise<ReferenceCaptureImage[]> {
  assertCurrent();
  if (options.background !== 'white' && options.background !== 'transparent') throw new Error('이미지 배경을 다시 선택해 주세요.');
  const snapshot = cloneSkeleton(pose);
  snapshot.visible = true;
  snapshot.updateMatrixWorld(true);
  const materials = new Set<THREE.Material>();
  const skeletons = new Set<THREE.Skeleton>();
  const materialCopies = new Map<THREE.Material, THREE.Material>();
  let renderer: THREE.WebGLRenderer | SoftwareRenderer | null = null;
  let triangleCount = 0;
  try {
    snapshot.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child instanceof THREE.SkinnedMesh) skeletons.add(child.skeleton);
      const originals: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
      const copies = originals.map((original) => {
        let copy = materialCopies.get(original);
        if (!copy) {
          copy = original.clone();
          copy.opacity = 1;
          copy.transparent = false;
          copy.depthWrite = true;
          const surface = copy as THREE.Material & { wireframe?: boolean };
          if (typeof surface.wireframe === 'boolean') surface.wireframe = false;
          materialCopies.set(original, copy);
          materials.add(copy);
        }
        return copy;
      });
      child.material = Array.isArray(child.material) ? copies : copies[0];
      child.castShadow = false;
      child.receiveShadow = false;
    });
    snapshot.traverseVisible((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      triangleCount += Math.floor((child.geometry.index?.count ?? child.geometry.getAttribute('position')?.count ?? 0) / 3) * (child instanceof THREE.InstancedMesh ? child.count : 1);
    });
    if (!triangleCount) throw new Error('캡처할 3D 형상이 없습니다. 모델을 먼저 불러와 주세요.');
    const plan = planReferenceCapture(new THREE.Box3().setFromObject(snapshot, true), options.maxSize);
    const scene = new THREE.Scene();
    scene.background = options.background === 'white' ? new THREE.Color('#ffffff') : null;
    scene.add(snapshot);
    const hemisphere = new THREE.HemisphereLight('#ffffff', '#afb9a3', 2.3);
    hemisphere.position.set(0, 0, 500);
    const key = new THREE.DirectionalLight('#fff9ef', 3.2);
    key.position.set(100, -250, 500);
    const fill = new THREE.DirectionalLight('#e5eada', 1.5);
    fill.position.set(-200, 200, 250);
    scene.add(hemisphere, key, fill);
    renderer = createCaptureRenderer(preferSoftware);
    if (renderer instanceof SoftwareRenderer && triangleCount > SOFTWARE_TRIANGLE_LIMIT) {
      throw new Error('소프트웨어 캡처는 총 20만 개 이하의 삼각형을 지원합니다. 형상을 줄여 다시 불러오거나 WebGL이 활성화된 브라우저에서 저장해 주세요.');
    }
    renderer.setPixelRatio(1);
    const images: ReferenceCaptureImage[] = [];
    for (const frame of plan.frames) {
      assertCurrent();
      renderer.setSize(frame.width, frame.height, false);
      renderer.render(scene, createReferenceCamera(plan, frame));
      const blob = await pngBlob(renderer.domElement);
      assertCurrent();
      // Changed: preserve the pose's world center for exact image-plane placement.
      images.push({ ...frame, blob, frameCenter: plan.center.toArray() as Vec3, modelDimensions: [...plan.modelDimensions] });
    }
    return images;
  } finally {
    for (const material of materials) material.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
    if (renderer) {
      renderer.dispose();
      if (renderer instanceof THREE.WebGLRenderer) renderer.forceContextLoss();
      renderer.domElement.width = 1;
      renderer.domElement.height = 1;
    }
    snapshot.clear();
  }
}
