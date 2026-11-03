import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLANE_LABELS, type LastProject, type ModelAsset, type ModelInfo, type PlaneKey, type Vec3 } from './project';
import { createSampleReference, disposeMaterial, disposeObject, textSprite } from './scene-geometry';
import { SoftwareRenderer } from './scene-software-renderer';
import { createShoeSample } from './shoe-samples';
import { DEFAULT_SAMPLE_KIND, type ShoeSampleKind } from './shoe-sample-catalog';

interface SceneCallbacks {
  onModelInfo: (info: ModelInfo) => void;
  onError: (message: string) => void;
  onMeasure: (distance: number | null) => void;
  onLoading: (loading: boolean) => void;
  onModelLoaded?: (name: string | null) => void;
  onRenderMode?: (mode: 'webgl' | 'software') => void;
  onNotice?: (message: string) => void;
}

export interface LastSceneController {
  setProject: (project: LastProject) => void;
  setMeasure: (enabled: boolean) => void;
  fit: () => void;
  screenshot: () => void;
  dispose: () => void;
}

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

interface ReferencePlane {
  group: THREE.Group;
  image: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  edge: THREE.LineSegments<THREE.EdgesGeometry, THREE.LineBasicMaterial>;
  key: PlaneKey;
  revision: number;
}

interface MaterialAppearance {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

function decodeDataUrl(value: string): ArrayBuffer {
  const comma = value.indexOf(',');
  if (comma < 0 || !value.startsWith('data:')) throw new Error('파일 데이터가 올바르지 않습니다. 파일을 다시 선택해 주세요.');
  const header = value.slice(0, comma);
  const content = value.slice(comma + 1);
  if (/;base64/i.test(header)) {
    const decoded = atob(content);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(content)).buffer as ArrayBuffer;
}

function assertSelfContainedGlb(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 20) throw new Error('GLB 파일을 읽을 수 없습니다. 원본 프로그램에서 다시 내보내 주세요.');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('glTF 2.0 형식의 GLB 파일이 필요합니다.');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || length > buffer.byteLength - 20) throw new Error('GLB 파일의 구조가 올바르지 않습니다.');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length))) as {
    buffers?: { uri?: string }[];
    images?: { uri?: string }[];
    extensionsRequired?: string[];
  };
  const references = [...(json.buffers ?? []), ...(json.images ?? [])];
  if (references.some((item) => item.uri && !item.uri.startsWith('data:'))) {
    throw new Error('외부 파일을 참조하는 GLB입니다. 형상과 텍스처를 포함한 단일 GLB로 내보내 주세요.');
  }
  const unsupported = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu'];
  if (json.extensionsRequired?.some((name) => unsupported.includes(name))) {
    throw new Error('이 GLB에는 압축된 형상이 포함되어 있습니다. 압축을 끄고 GLB로 내보내거나 STL을 사용해 주세요.');
  }
}

function modelMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: '#aeb8a2', roughness: 0.62, metalness: 0.06,
    clearcoat: 0.18, clearcoatRoughness: 0.65,
    side: THREE.DoubleSide,
  });
}

export async function parseLastModel(asset: ModelAsset | null, sampleKind: ShoeSampleKind = DEFAULT_SAMPLE_KIND): Promise<THREE.Group> {
  // Changed: built-in shoes retain their authored upper, sole, and detail colors.
  if (!asset) return createShoeSample(sampleKind);
  const root = new THREE.Group();
  const buffer = decodeDataUrl(asset.dataUrl);
  if (asset.format === 'stl') {
    const geometry = new STLLoader().parse(buffer);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    root.add(new THREE.Mesh(geometry, modelMaterial()));
  } else if (asset.format === 'obj') {
    root.add(new OBJLoader().parse(new TextDecoder().decode(buffer)));
  } else {
    assertSelfContainedGlb(buffer);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      if (url.startsWith('data:') || url.startsWith('blob:')) return url;
      throw new Error('외부 파일을 참조하는 GLB는 지원하지 않습니다. 단일 GLB로 다시 내보내 주세요.');
    });
    const gltf = await new GLTFLoader(manager).parseAsync(buffer, '');
    root.add(gltf.scene);
  }

  let triangles = 0;
  const remove: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const position = child.geometry.getAttribute('position');
      if (!position) { remove.push(child); return; }
      triangles += (child.geometry.index?.count ?? position.count) / 3;
      const oldMaterials = Array.isArray(child.material) ? child.material : [child.material];
      oldMaterials.forEach(disposeMaterial);
      child.material = modelMaterial();
      if (!child.geometry.getAttribute('normal')) child.geometry.computeVertexNormals();
    } else if (child instanceof THREE.Light || child instanceof THREE.Camera || child instanceof THREE.Line || child instanceof THREE.Points) {
      remove.push(child);
    }
  });
  remove.forEach(disposeObject);
  if (!triangles) {
    disposeObject(root);
    throw new Error('파일에서 표시할 수 있는 삼각형 형상을 찾지 못했습니다.');
  }
  if (triangles > 1_500_000) {
    disposeObject(root);
    throw new Error('형상이 너무 복잡합니다. 삼각형 수를 150만 개 이하로 줄여 다시 내보내 주세요.');
  }
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  if (![...size.toArray(), ...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite) || size.length() === 0) {
    disposeObject(root);
    throw new Error('형상의 좌표 또는 크기가 올바르지 않습니다.');
  }
  return root;
}

export function createLastScene(host: HTMLDivElement, callbacks: SceneCallbacks): LastSceneController {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#f3f4f0');
  let renderer: THREE.WebGLRenderer | SoftwareRenderer;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!context) throw new Error('WebGL unavailable');
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, alpha: false, preserveDrawingBuffer: true });
  } catch {
    renderer = new SoftwareRenderer(() => callbacks.onNotice?.('소프트웨어 모드 · 복잡한 메시를 간략 표시합니다. 실제 파일과 측정에는 원본 형상을 사용합니다.'));
  }
  const softwareMode = renderer instanceof SoftwareRenderer;
  callbacks.onRenderMode?.(softwareMode ? 'software' : 'webgl');
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  if (renderer instanceof THREE.WebGLRenderer) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
  renderer.domElement.setAttribute('aria-label', '3D 신발 모델과 다측면 이미지. 마우스로 회전하고 휠로 확대합니다.');
  renderer.domElement.setAttribute('role', 'img');
  host.appendChild(renderer.domElement);

  const perspective = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  const orthographic = new THREE.OrthographicCamera(-250, 250, 200, -200, 0.1, 10000);
  let camera: Camera = perspective;
  camera.up.set(0, 0, 1);
  camera.position.set(420, -520, 360);
  let controls = new OrbitControls(camera, renderer.domElement);
  let disposed = false;
  let renderRequest = 0;
  let project: LastProject | null = null;
  let previousProject: LastProject | null = null;
  let modelRevision = 0;
  let modelSource: ModelAsset | null | undefined;
  let currentSample = true;
  let model: THREE.Group | null = null;
  const pose = new THREE.Group();
  const normalization = new THREE.Group();
  const sourceAxis = new THREE.Group();
  pose.add(normalization);
  normalization.add(sourceAxis);
  scene.add(pose);
  const referenceRoot = new THREE.Group();
  scene.add(referenceRoot);
  const references = new Map<PlaneKey, ReferencePlane>();
  let referenceRevision = 0;
  let boundsGroup = new THREE.Group();
  let axes = new THREE.Group();
  const measurementGroup = new THREE.Group();
  scene.add(boundsGroup, axes, measurementGroup);
  let measuring = false;
  let measurementPoints: THREE.Vector3[] = [];
  let pointerStart: { x: number; y: number } | null = null;
  let width = 1;
  let height = 1;
  let orthoSpan = 360;
  let triangles = 0;
  let lastModelInfo = '';
  const materialAppearance = new WeakMap<THREE.Material, MaterialAppearance>();

  const hemisphere = new THREE.HemisphereLight('#ffffff', '#afb9a3', 2.3);
  hemisphere.position.set(0, 0, 500);
  scene.add(hemisphere);
  const keyLight = new THREE.DirectionalLight('#fff9ef', 3.2);
  keyLight.position.set(100, -250, 500);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = -350;
  keyLight.shadow.camera.right = 350;
  keyLight.shadow.camera.top = 350;
  keyLight.shadow.camera.bottom = -350;
  keyLight.shadow.camera.far = 1500;
  keyLight.shadow.normalBias = 0.8;
  keyLight.shadow.bias = -0.0001;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight('#e5eada', 1.5);
  fillLight.position.set(-200, 200, 250);
  scene.add(fillLight);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.ShadowMaterial({ color: '#5c6750', opacity: 0.12 }));
  floor.position.z = -0.6;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(800, 40, '#bec7b6', '#dce1d6');
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.8;
  const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
  gridMaterials.forEach((m) => { m.transparent = true; m.opacity = 0.6; });
  scene.add(grid);

  function invalidate(): void {
    if (disposed || renderRequest) return;
    renderRequest = requestAnimationFrame(() => {
      renderRequest = 0;
      if (disposed) return;
      const changed = controls.update();
      renderer.render(scene, camera);
      if (changed && controls.enableDamping) invalidate();
    });
  }

  function setupControls(): void {
    controls.enableDamping = !softwareMode;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.8;
    controls.minDistance = 15;
    controls.maxDistance = 8000;
    controls.minZoom = 0.08;
    controls.maxZoom = 30;
    controls.target.set(0, 0, 45);
    controls.addEventListener('change', invalidate);
    controls.addEventListener('start', invalidate);
    controls.update();
  }
  setupControls();

  function clearMeasurement(): void {
    measurementPoints = [];
    for (const child of [...measurementGroup.children]) disposeObject(child);
    callbacks.onMeasure(null);
    invalidate();
  }

  function updateMeasurement(point: THREE.Vector3): void {
    if (measurementPoints.length === 2) clearMeasurement();
    measurementPoints.push(point);
    const radius = Math.max(0.7, (project?.settings.dimensions[0] ?? 260) / 180);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), new THREE.MeshBasicMaterial({ color: '#a56a3c', depthTest: false }));
    marker.position.copy(point);
    marker.renderOrder = 20;
    measurementGroup.add(marker);
    if (measurementPoints.length === 2) {
      const [a, b] = measurementPoints;
      const distance = a.distanceTo(b);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: '#9a663d', depthTest: false }));
      line.renderOrder = 20;
      measurementGroup.add(line);
      const label = textSprite(`${distance.toFixed(2)} mm`, { color: '#80512b', background: '#fff9ed', height: 11 });
      label.position.copy(a.clone().add(b).multiplyScalar(0.5)).add(new THREE.Vector3(0, 0, radius * 5));
      measurementGroup.add(label);
      callbacks.onMeasure(distance);
    }
    invalidate();
  }

  function onPointerDown(event: PointerEvent): void {
    pointerStart = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent): void {
    if (!measuring || !model || !pose.visible || !pointerStart || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const moved = Math.hypot(pointerStart.x - event.clientX, pointerStart.y - event.clientY);
    pointerStart = null;
    if (moved > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    camera.updateMatrixWorld(true);
    pose.updateMatrixWorld(true);
    raycaster.setFromCamera(mouse, camera);
    const hit = raycaster.intersectObject(pose, true).find((item) => item.object instanceof THREE.Mesh);
    if (hit) updateMeasurement(hit.point.clone());
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  const onContextLost = (event: Event) => {
    event.preventDefault();
    callbacks.onError('3D 그래픽 연결이 중단되었습니다. 페이지를 새로고침해 주세요.');
  };
  renderer.domElement.addEventListener('webglcontextlost', onContextLost);

  function reportModelInfo(): void {
    if (!model) return;
    pose.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(pose).getSize(new THREE.Vector3());
    const dimensions = size.toArray().map((n) => Math.max(0, n)) as Vec3;
    const key = dimensions.map((n) => n.toFixed(3)).join(',') + `:${triangles}:${currentSample}`;
    if (key !== lastModelInfo) {
      lastModelInfo = key;
      callbacks.onModelInfo({ dimensions, triangles: Math.round(triangles), sample: currentSample });
    }
  }

  function updateModelTransform(): void {
    if (!project || !model) return;
    const s = project.settings;
    pose.position.set(0, 0, 0);
    pose.rotation.set(0, 0, 0);
    pose.scale.setScalar(1);
    normalization.position.set(0, 0, 0);
    sourceAxis.rotation.set(!currentSample && s.modelUp === 'y' ? Math.PI / 2 : 0, 0, 0);
    pose.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(sourceAxis);
    const center = box.getCenter(new THREE.Vector3());
    normalization.position.set(-center.x, -center.y, -box.min.z);
    const unit = currentSample ? 1 : { mm: 1, cm: 10, m: 1000, in: 25.4 }[s.modelUnits];
    pose.scale.setScalar(unit * s.modelScale);
    pose.rotation.set(...s.modelRotation.map(THREE.MathUtils.degToRad) as Vec3);
    pose.position.fromArray(s.modelPosition);
    pose.visible = s.showLast;
    pose.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          // Changed: support every shoe material while preserving its base opacity.
          let original = materialAppearance.get(material);
          if (!original) {
            original = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
            materialAppearance.set(material, original);
          }
          const opacity = original.opacity * s.lastOpacity;
          const transparent = original.transparent || opacity < 0.999;
          const surface = material as THREE.Material & { wireframe?: boolean };
          const hasWireframe = typeof surface.wireframe === 'boolean';
          const needsUpdate = material.transparent !== transparent || (hasWireframe && surface.wireframe !== s.wireframe);
          material.opacity = opacity;
          material.transparent = transparent;
          material.depthWrite = original.depthWrite && opacity >= 0.999;
          if (hasWireframe) surface.wireframe = s.wireframe;
          if (needsUpdate) material.needsUpdate = true;
        }
        child.castShadow = s.lastOpacity > 0.25 && !s.wireframe;
        child.receiveShadow = true;
      }
    });
    reportModelInfo();
    invalidate();
  }

  async function updateModel(asset: ModelAsset | null, sampleKind: ShoeSampleKind): Promise<void> {
    const revision = ++modelRevision;
    callbacks.onLoading(true);
    try {
      const next = await parseLastModel(asset, sampleKind);
      if (disposed || revision !== modelRevision) { disposeObject(next); return; }
      if (model) disposeObject(model);
      model = next;
      currentSample = asset === null;
      lastModelInfo = '';
      sourceAxis.add(model);
      triangles = 0;
      model.traverse((child) => {
        if (child instanceof THREE.Mesh) triangles += (child.geometry.index?.count ?? child.geometry.getAttribute('position').count) / 3;
      });
      clearMeasurement();
      updateModelTransform();
      fit();
      callbacks.onModelLoaded?.(asset?.name ?? null);
    } catch (error) {
      if (disposed || revision !== modelRevision) return;
      const message = error instanceof Error ? error.message : '3D 파일을 읽을 수 없습니다.';
      callbacks.onError(message.includes('DRACO') || message.includes('Meshopt') ? '압축을 끈 GLB 또는 STL 파일을 사용해 주세요.' : message);
    } finally {
      if (!disposed && revision === modelRevision) callbacks.onLoading(false);
    }
  }

  function referenceSize(key: PlaneKey): [number, number] {
    const [l, w, h] = project!.settings.dimensions;
    return [key === 'side' || key === 'top' ? l : w, key === 'top' ? w : h];
  }

  function buildReference(key: PlaneKey): ReferencePlane {
    const [horizontal, vertical] = referenceSize(key);
    const group = new THREE.Group();
    const image = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 8, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: project!.settings.imageOpacity, side: THREE.DoubleSide, depthWrite: false }));
    image.scale.set(horizontal, vertical, 1);
    image.renderOrder = 2;
    group.add(image);
    const edgeGeometry = new THREE.PlaneGeometry(horizontal, vertical);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(edgeGeometry), new THREE.LineBasicMaterial({ color: '#a4afa0', transparent: true, opacity: 0.7 }));
    edgeGeometry.dispose();
    group.add(edge);
    const label = textSprite(`${PLANE_LABELS[key].short}  ·  ${PLANE_LABELS[key].axis}`, { color: '#76816d', height: Math.max(7, Math.min(10, horizontal / 14)) });
    label.position.set(-horizontal / 2 + label.scale.x / 2, vertical / 2 + 7, 0);
    group.add(label);
    const result: ReferencePlane = { group, image, edge, key, revision: ++referenceRevision };
    referenceRoot.add(group);
    references.set(key, result);
    updateReferenceTexture(result);
    return result;
  }

  function updateReferenceTexture(ref: ReferencePlane): void {
    if (!project) return;
    const revision = ++ref.revision;
    const [horizontal, vertical] = referenceSize(ref.key);
    const asset = project.planes[ref.key].image;
    const url = asset?.dataUrl ?? createSampleReference(ref.key, project.settings.dimensions);
    new THREE.TextureLoader().load(url, (texture) => {
      if (disposed || ref.revision !== revision || references.get(ref.key) !== ref) { texture.dispose(); return; }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const img = texture.image as { width: number; height: number };
      const contain = Math.min(horizontal / img.width, vertical / img.height);
      ref.image.scale.set(img.width * contain * (project!.planes[ref.key].flip ? -1 : 1), img.height * contain, 1);
      ref.image.material.map?.dispose();
      ref.image.material.map = texture;
      ref.image.material.needsUpdate = true;
      invalidate();
    }, undefined, () => {
      if (!disposed && ref.revision === revision) callbacks.onError(`${PLANE_LABELS[ref.key].name} 이미지를 읽을 수 없습니다. PNG·JPEG·WebP 파일을 다시 선택해 주세요.`);
    });
  }

  function updateReferences(rebuild: boolean): void {
    if (!project) return;
    if (rebuild) {
      for (const ref of references.values()) disposeObject(ref.group);
      references.clear();
    }
    const [l, w, h] = project.settings.dimensions;
    const gap = project.settings.gap;
    for (const key of ['side', 'top', 'front', 'rear'] as const) {
      const existed = references.has(key);
      const ref = references.get(key) ?? buildReference(key);
      const state = project.planes[key];
      ref.group.visible = state.visible;
      ref.image.material.opacity = project.settings.imageOpacity;
      ref.edge.material.opacity = Math.max(0.25, project.settings.imageOpacity * 0.9);
      ref.image.scale.x = Math.abs(ref.image.scale.x) * (state.flip ? -1 : 1);
      if (existed && previousProject?.planes[key].image?.dataUrl !== state.image?.dataUrl) updateReferenceTexture(ref);
      if (key === 'side') {
        ref.group.position.set(0, -w / 2 - gap, h / 2);
        ref.group.rotation.set(Math.PI / 2, 0, 0);
      } else if (key === 'top') {
        ref.group.position.set(0, 0, h + gap);
        ref.group.rotation.set(0, 0, 0);
      } else {
        ref.group.position.set((l / 2 + gap) * (key === 'front' ? 1 : -1), 0, h / 2);
        const right = new THREE.Vector3(0, key === 'front' ? 1 : -1, 0);
        const up = new THREE.Vector3(0, 0, 1);
        const normal = new THREE.Vector3(key === 'front' ? 1 : -1, 0, 0);
        ref.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
      }
    }
    invalidate();
  }

  function rebuildGuides(): void {
    if (!project) return;
    disposeObject(boundsGroup);
    disposeObject(axes);
    boundsGroup = new THREE.Group();
    axes = new THREE.Group();
    scene.add(boundsGroup, axes);
    const [l, w, h] = project.settings.dimensions;
    const box = new THREE.Box3(new THREE.Vector3(-l / 2, -w / 2, 0), new THREE.Vector3(l / 2, w / 2, h));
    const boxHelper = new THREE.Box3Helper(box, new THREE.Color('#91a08a'));
    const boxMaterials = Array.isArray(boxHelper.material) ? boxHelper.material : [boxHelper.material];
    boxMaterials.forEach((material) => { material.transparent = true; material.opacity = 0.5; });
    boundsGroup.add(boxHelper);
    const labelHeight = Math.max(7, l / 35);
    const xLabel = textSprite(`${l.toFixed(1)} mm`, { height: labelHeight });
    xLabel.position.set(0, -w / 2 - 12, 0);
    const yLabel = textSprite(`${w.toFixed(1)} mm`, { height: labelHeight });
    yLabel.position.set(l / 2 + 12, 0, 0);
    const zLabel = textSprite(`${h.toFixed(1)} mm`, { height: labelHeight });
    zLabel.position.set(-l / 2 - 12, w / 2 + 8, h / 2);
    boundsGroup.add(xLabel, yLabel, zLabel);
    const origin = new THREE.Vector3(0, 0, -0.2);
    const axisSpecs: [THREE.Vector3, number, string, string][] = [
      [new THREE.Vector3(1, 0, 0), l / 2 + 55, '#b67e70', 'X'],
      [new THREE.Vector3(0, 1, 0), w / 2 + 65, '#779469', 'Y'],
      [new THREE.Vector3(0, 0, 1), h + 48, '#748aab', 'Z'],
    ];
    for (const [direction, length, color, text] of axisSpecs) {
      const arrow = new THREE.ArrowHelper(direction, origin, length, color, 5, 2.8);
      axes.add(arrow);
      const label = textSprite(text, { color, height: labelHeight + 1 });
      label.position.copy(direction.clone().multiplyScalar(length + 9));
      axes.add(label);
    }
    boundsGroup.visible = project.settings.bounds;
    axes.visible = project.settings.axes;
    invalidate();
  }

  function resize(): void {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    perspective.aspect = width / height;
    perspective.updateProjectionMatrix();
    orthographic.left = -orthoSpan * width / height / 2;
    orthographic.right = orthoSpan * width / height / 2;
    orthographic.top = orthoSpan / 2;
    orthographic.bottom = -orthoSpan / 2;
    orthographic.updateProjectionMatrix();
    invalidate();
  }

  function applyCameraType(): void {
    if (!project) return;
    const next = project.settings.orthographic || project.settings.view !== 'iso' ? orthographic : perspective;
    if (camera === next) return;
    const position = camera.position.clone();
    camera = next;
    camera.position.copy(position);
  }

  function fit(): void {
    if (!project || disposed) return;
    const s = project.settings;
    applyCameraType();
    const [l, w, h] = s.dimensions;
    const gap = s.gap;
    const box = new THREE.Box3(new THREE.Vector3(-l / 2 - gap, -w / 2 - gap, 0), new THREE.Vector3(l / 2 + gap, w / 2 + gap, h + gap));
    if (model && pose.visible) box.union(new THREE.Box3().setFromObject(pose));
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() / 2;
    const directions: Record<LastProject['settings']['view'], THREE.Vector3> = {
      iso: new THREE.Vector3(1.1, -1.6, 0.95),
      side: new THREE.Vector3(0, -1, 0),
      top: new THREE.Vector3(0, 0, 1),
      front: new THREE.Vector3(1, 0, 0),
      rear: new THREE.Vector3(-1, 0, 0),
    };
    const direction = directions[s.view].normalize();
    const aspect = width / height;
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(35 / 2)) * Math.max(1, 1 / aspect) * 1.06;
    camera.up.set(0, s.view === 'top' ? 1 : 0, s.view === 'top' ? 0 : 1);
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = Math.max(0.01, radius / 1000);
    camera.far = Math.max(10000, distance * 100);
    if (camera instanceof THREE.OrthographicCamera) {
      const viewWidth = s.view === 'front' || s.view === 'rear' ? size.y : s.view === 'iso' ? radius * 2 : size.x;
      const viewHeight = s.view === 'top' ? size.y : s.view === 'iso' ? radius * 1.55 : size.z;
      orthoSpan = Math.max(viewHeight * 1.25, viewWidth * 1.25 / aspect);
      camera.zoom = 1;
    }
    camera.lookAt(center);
    // OrbitControls caches its up-axis transform at construction. Recreate it
    // when fitting, so top-view and Z-up views also reset residual damping.
    controls.removeEventListener('change', invalidate);
    controls.removeEventListener('start', invalidate);
    controls.dispose();
    controls = new OrbitControls(camera, renderer.domElement);
    setupControls();
    controls.target.copy(center);
    controls.minDistance = Math.max(radius / 30, 0.1);
    controls.maxDistance = Math.max(radius * 60, 1000);
    controls.update();
    resize();
  }

  const observer = new ResizeObserver(() => {
    const previousAspect = width / height;
    resize();
    if (project && Math.abs((width / height) / previousAspect - 1) > 0.22) fit();
  });
  observer.observe(host);
  resize();

  function setProject(next: LastProject): void {
    if (disposed) return;
    previousProject = project;
    project = next;
    const s = next.settings;
    const previous = previousProject?.settings;
    const dimensionChange = !previous || s.dimensions.some((n, i) => n !== previous.dimensions[i]);
    if (dimensionChange) rebuildGuides();
    boundsGroup.visible = s.bounds;
    axes.visible = s.axes;
    grid.visible = s.grid;
    updateReferences(dimensionChange);
    // A new asset object is also a new import request when its bytes are equal.
    // Re-parse it so successful re-imports reliably clear the UI rollback state.
    // Changed: choosing another built-in shoe is also a new geometry request.
    const sampleChange = next.model === null && s.sampleKind !== previous?.sampleKind;
    const assetChange = modelSource === undefined || next.model !== modelSource || sampleChange;
    if (assetChange) {
      modelSource = next.model;
      void updateModel(next.model, s.sampleKind);
    } else {
      const transformChange = !previous || s.modelScale !== previous.modelScale || s.modelUp !== previous.modelUp || s.modelUnits !== previous.modelUnits || s.modelRotation.some((n, i) => n !== previous.modelRotation[i]) || s.modelPosition.some((n, i) => n !== previous.modelPosition[i]);
      if (transformChange) clearMeasurement();
      updateModelTransform();
    }
    if (!previous || s.view !== previous.view || s.orthographic !== previous.orthographic) fit();
    invalidate();
  }

  function setMeasure(enabled: boolean): void {
    if (enabled === measuring) return;
    measuring = enabled;
    renderer.domElement.style.cursor = enabled ? 'crosshair' : 'grab';
    clearMeasurement();
  }

  function screenshot(): void {
    if (disposed) return;
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
      if (!blob) { callbacks.onError('화면을 저장하지 못했습니다. 다시 시도해 주세요.'); return; }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(project?.title ?? 'last-studio').replace(/[<>:"/\\|?*]/g, '-')}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function dispose(): void {
    disposed = true;
    modelRevision++;
    if (renderRequest) cancelAnimationFrame(renderRequest);
    observer.disconnect();
    controls.removeEventListener('change', invalidate);
    controls.removeEventListener('start', invalidate);
    controls.dispose();
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
    disposeObject(scene);
    keyLight.shadow.dispose();
    renderer.dispose();
    if (renderer instanceof THREE.WebGLRenderer) renderer.forceContextLoss();
    renderer.domElement.remove();
    references.clear();
  }

  return { setProject, setMeasure, fit, screenshot, dispose };
}
