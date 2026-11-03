import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PLANE_LABELS, createDefaultSampleShape, type LastProject, type ModelAsset, type ModelInfo, type PlaneKey, type SampleShape, type Vec3 } from './project';
import { createSampleLastGeometry, createSampleReference, disposeMaterial, disposeObject, textSprite } from './scene-geometry';
import { SoftwareRenderer } from './scene-software-renderer';
import { createShapedShoeSample } from './sample-shape';
import { DEFAULT_SAMPLE_KIND, type ShoeSampleKind } from './shoe-sample-catalog';
// Changed: reference export uses an isolated renderer without changing this scene.
import { captureModelReferences } from './reference-capture';
import type { ReferenceCaptureFunction } from './reference-capture-types';
import { applyModelLayerTransform } from './model-layer';
import { getReferenceDisplayBounds, getReferenceFrame, getReferencePlanePose } from './reference-frame';
import { computeModelSection, type SectionResult } from './section-analysis';

interface SceneCallbacks {
  onModelInfo: (info: ModelInfo) => void;
  onError: (message: string) => void;
  onMeasure: (distance: number | null) => void;
  onLoading: (loading: boolean) => void;
  onModelLoaded?: (name: string | null) => void;
  // Changed: Last-layer events cannot trigger the shoe import rollback path.
  onLastInfo?: (info: ModelInfo | null) => void;
  onLastError?: (message: string) => void;
  onLastLoaded?: (name: string | null) => void;
  onLastLoading?: (loading: boolean) => void;
  // Changed: saved-version overlays have an independent loading/error channel.
  onComparisonLoading?: (loading: boolean) => void;
  onComparisonError?: (message: string) => void;
  // Changed: exact cross-section results and local errors are separate from imports.
  onSection?: (result: SectionResult | null) => void;
  onRenderMode?: (mode: 'webgl' | 'software') => void;
  onNotice?: (message: string) => void;
}

export interface LastSceneController {
  setProject: (project: LastProject) => void;
  setComparison: (project: LastProject | null) => void;
  setMeasure: (enabled: boolean) => void;
  fit: () => void;
  screenshot: () => void;
  captureReferences: ReferenceCaptureFunction;
  // Changed: only built-in edited samples can be exported as world-mm STL.
  exportStl: () => Promise<Blob>;
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

export async function parseLastModel(asset: ModelAsset | null, sampleKind: ShoeSampleKind = DEFAULT_SAMPLE_KIND, sampleShape: SampleShape = createDefaultSampleShape()): Promise<THREE.Group> {
  // Changed: built-in shoes retain their authored upper, sole, and detail colors.
  if (!asset) return createShapedShoeSample(sampleKind, sampleShape);
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

// Changed: an independent Last uses the same file parser but a distinct cyan
// material. Its demo is a closed illustrative last, never a shoe sample.
export async function parseLastLayerModel(asset: ModelAsset | null): Promise<THREE.Group> {
  const root = asset ? await parseLastModel(asset) : new THREE.Group();
  if (!asset) {
    root.name = 'Demo Last · illustrative geometry';
    root.add(new THREE.Mesh(createSampleLastGeometry([244, 96, 105]), modelMaterial()));
  }
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) material.color.set('#4e9fbe');
    }
  });
  return root;
}

export interface ComparisonModels {
  root: THREE.Group;
  shoe: THREE.Group;
  last: THREE.Group | null;
}

// Changed: comparison models are freshly parsed from a saved recipe and own all
// their resources. They never borrow the current scene's meshes or materials.
export async function createComparisonModels(snapshot: LastProject): Promise<ComparisonModels> {
  const settings: LastProject['settings'] = {
    ...snapshot.settings, sampleShape: { ...snapshot.settings.sampleShape },
    modelPosition: [...snapshot.settings.modelPosition], modelRotation: [...snapshot.settings.modelRotation],
  };
  const lastSettings: LastProject['last'] = { ...snapshot.last, position: [...snapshot.last.position], rotation: [...snapshot.last.rotation] };
  const shoeAsset = snapshot.model;
  const tasks: [Promise<THREE.Group>, Promise<THREE.Group | null>] = [
    parseLastModel(shoeAsset, settings.sampleKind, settings.sampleShape),
    lastSettings.enabled ? parseLastLayerModel(lastSettings.model) : Promise.resolve(null),
  ];
  // Wait for both parsers even if one fails, so every successful sibling can be
  // disposed rather than leaking after an early Promise.all rejection.
  const results = await Promise.allSettled(tasks);
  const [shoeResult, lastResult] = results;
  if (shoeResult.status === 'rejected' || lastResult.status === 'rejected') {
    for (const result of results) if (result.status === 'fulfilled' && result.value) disposeObject(result.value);
    const reason: unknown = shoeResult.status === 'rejected' ? shoeResult.reason : lastResult.status === 'rejected' ? lastResult.reason : null;
    throw reason instanceof Error ? reason : new Error('저장된 비교 모델을 읽을 수 없습니다.');
  }
  const root = new THREE.Group();
  root.name = 'Saved-version comparison';
  root.userData.comparison = true;
  root.add(shoeResult.value);
  if (lastResult.value) root.add(lastResult.value);
  const replacedMaterials = new Set<THREE.Material>();
  try {
    const addLayer = (model: THREE.Group, name: string, transform: Pick<LastProject['last'], 'position' | 'rotation' | 'scale' | 'units' | 'up'>, sample: boolean): THREE.Group => {
      const pose = new THREE.Group(), normalization = new THREE.Group(), sourceAxis = new THREE.Group();
      pose.name = name;
      root.add(pose);
      pose.add(normalization); normalization.add(sourceAxis); sourceAxis.add(model);
      applyModelLayerTransform({ pose, normalization, sourceAxis }, transform, sample);
      // Stored view visibility is intentionally ignored at this top-level pose;
      // original hidden mesh/group children retain their authored visibility.
      pose.visible = true;
      return pose;
    };
    const shoe = addLayer(shoeResult.value, 'Comparison shoe', {
      position: settings.modelPosition, rotation: settings.modelRotation, scale: settings.modelScale,
      units: settings.modelUnits, up: settings.modelUp,
    }, shoeAsset === null);
    const last = lastResult.value ? addLayer(lastResult.value, 'Comparison Last', lastSettings, lastSettings.model === null) : null;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const originals: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
      originals.forEach((material) => replacedMaterials.add(material));
      child.material = new THREE.MeshStandardMaterial({ color: '#9875bd', opacity: 0.30, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.78, metalness: 0 });
      if (child instanceof THREE.InstancedMesh) child.instanceColor = null;
      child.castShadow = false;
      child.receiveShadow = false;
    });
    replacedMaterials.forEach(disposeMaterial);
    replacedMaterials.clear();
    root.updateMatrixWorld(true);
    return { root, shoe, last };
  } catch (error) {
    replacedMaterials.forEach(disposeMaterial);
    disposeObject(root);
    throw error;
  }
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
  // Changed: reject pending, superseded, or disposed model captures reliably.
  let modelLoading = false;
  let modelLoadedRevision = 0;
  let modelLoadError: string | null = null;
  let modelPoseRevision = 0;
  let captureQueue: Promise<unknown> = Promise.resolve();
  let modelSource: ModelAsset | null | undefined;
  let currentSample = true;
  let model: THREE.Group | null = null;
  const pose = new THREE.Group();
  const normalization = new THREE.Group();
  const sourceAxis = new THREE.Group();
  pose.add(normalization);
  normalization.add(sourceAxis);
  scene.add(pose);
  // Changed: the shoe and Last keep separate geometry, normalization, pose, and
  // loading revisions. Changing a shoe never removes or reloads its Last.
  let lastLayerModel: THREE.Group | null = null;
  let lastLayerSource: ModelAsset | null | undefined;
  let lastLayerRevision = 0;
  let lastLayerLoading = false;
  let lastLayerLoadedRevision = 0;
  let lastLayerLoadError: string | null = null;
  let lastLayerSample = true;
  let lastLayerTriangles = 0;
  let lastLayerInfoKey = '';
  const lastPose = new THREE.Group();
  const lastNormalization = new THREE.Group();
  const lastSourceAxis = new THREE.Group();
  lastPose.add(lastNormalization);
  lastNormalization.add(lastSourceAxis);
  lastPose.visible = false;
  scene.add(lastPose);
  // Changed: comparison is a sibling of current models and guides, so export,
  // surface picks, and section analysis keep their existing current-only roots.
  let comparisonRoot: THREE.Group | null = null;
  let comparisonSource: LastProject | null | undefined;
  let comparisonRevision = 0;
  let comparisonPending = false;
  const referenceRoot = new THREE.Group();
  scene.add(referenceRoot);
  const references = new Map<PlaneKey, ReferencePlane>();
  let referenceRevision = 0;
  let boundsGroup = new THREE.Group();
  let axes = new THREE.Group();
  const measurementGroup = new THREE.Group();
  const sectionGuide = new THREE.Group();
  scene.add(boundsGroup, axes, measurementGroup, sectionGuide);
  let sectionTimer: number | null = null;
  let sectionRevision = 0;
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

  // Changed: invalidate measurements immediately, before a debounced calculation
  // or model load. The guide is a separate scene object, excluded from PNGs/picks.
  function clearSection(): void {
    sectionRevision++;
    if (sectionTimer !== null) window.clearTimeout(sectionTimer);
    sectionTimer = null;
    for (const child of [...sectionGuide.children]) disposeObject(child);
    callbacks.onSection?.(null);
    invalidate();
  }

  function sectionError(message: string): SectionResult {
    const settings = project!.settings.section;
    const axes = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] } as const;
    const [uAxis, vAxis] = axes[settings.axis];
    return {
      axis: settings.axis, percent: settings.percent, coordinate: 0, uAxis, vAxis,
      shoe: [], last: [], bounds: [0, 0, 0, 0], minimumGap: null,
      closest: null, intersects: false, error: message,
    };
  }

  function updateSectionGuide(result: SectionResult): void {
    if (result.error) return;
    const [uMin, vMin, uMax, vMax] = result.bounds;
    if (![...result.bounds, result.coordinate].every(Number.isFinite) || uMax < uMin || vMax < vMin) return;
    const point = (u: number, v: number) => {
      const coordinate = { x: 0, y: 0, z: 0 };
      coordinate[result.axis] = result.coordinate;
      coordinate[result.uAxis] = u;
      coordinate[result.vAxis] = v;
      return new THREE.Vector3(coordinate.x, coordinate.y, coordinate.z);
    };
    const corners = [point(uMin, vMin), point(uMax, vMin), point(uMax, vMax), point(uMin, vMax), point(uMin, vMin)];
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: '#cf8a38', transparent: true, opacity: 0.96, depthTest: false }));
    outline.renderOrder = 15;
    sectionGuide.add(outline);
  }

  function requestSection(): void {
    clearSection();
    const section = project?.settings.section;
    if (disposed || !project || !section?.enabled) return;
    // Changed: a retained old mesh is never analyzed while its requested
    // replacement is loading or has failed. Hidden enabled Last still counts.
    if (modelLoading || (project.last.enabled && lastLayerLoading)) return;
    const error = modelLoadError ?? (project.last.enabled ? lastLayerLoadError : null);
    if (error) {
      callbacks.onSection?.(sectionError(`모델을 불러오지 못해 단면 계산을 중단했습니다. ${error}`));
      return;
    }
    if (!model || modelLoadedRevision !== modelRevision || (project.last.enabled && (!lastLayerModel || lastLayerLoadedRevision !== lastLayerRevision))) return;
    const revision = sectionRevision;
    const settings = { ...section };
    sectionTimer = window.setTimeout(() => {
      sectionTimer = null;
      if (disposed || revision !== sectionRevision || !project?.settings.section.enabled) return;
      let result: SectionResult;
      try {
        result = computeModelSection(pose, project.last.enabled ? lastPose : null, settings);
        if (disposed || revision !== sectionRevision) return;
        updateSectionGuide(result);
      } catch (error) {
        result = sectionError(error instanceof Error ? error.message : '현재 형상의 단면을 계산하지 못했습니다.');
      }
      callbacks.onSection?.(result);
      invalidate();
    }, 100);
  }

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
    // Changed: share the normalization math, never the layer transforms.
    applyModelLayerTransform({ pose, normalization, sourceAxis }, {
      position: s.modelPosition, rotation: s.modelRotation, scale: s.modelScale,
      units: s.modelUnits, up: s.modelUp,
    }, currentSample);
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

  async function updateModel(asset: ModelAsset | null, sampleKind: ShoeSampleKind, sampleShape: SampleShape): Promise<void> {
    const revision = ++modelRevision;
    modelLoading = true;
    modelLoadError = null;
    clearSection();
    callbacks.onLoading(true);
    try {
      const next = await parseLastModel(asset, sampleKind, sampleShape);
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
      modelLoadedRevision = revision;
      callbacks.onModelLoaded?.(asset?.name ?? null);
    } catch (error) {
      if (disposed || revision !== modelRevision) return;
      const message = error instanceof Error ? error.message : '3D 파일을 읽을 수 없습니다.';
      modelLoadError = message;
      callbacks.onError(message.includes('DRACO') || message.includes('Meshopt') ? '압축을 끈 GLB 또는 STL 파일을 사용해 주세요.' : message);
    } finally {
      if (!disposed && revision === modelRevision) {
        modelLoading = false;
        callbacks.onLoading(false);
        requestSection();
      }
    }
  }

  // Changed: Last visibility, materials, transforms and model information are
  // independent from the primary shoe and do not invalidate its PNG capture.
  function updateLastLayerTransform(): void {
    if (!project || !lastLayerModel) return;
    const layer = project.last;
    applyModelLayerTransform({ pose: lastPose, normalization: lastNormalization, sourceAxis: lastSourceAxis }, layer, lastLayerSample);
    lastPose.visible = layer.enabled && layer.visible;
    lastPose.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        const surface = material as THREE.Material & { wireframe?: boolean };
        const transparent = layer.opacity < 0.999;
        const changed = material.transparent !== transparent || (typeof surface.wireframe === 'boolean' && surface.wireframe !== layer.wireframe);
        material.opacity = layer.opacity;
        material.transparent = transparent;
        material.depthWrite = !transparent;
        if (typeof surface.wireframe === 'boolean') surface.wireframe = layer.wireframe;
        if (changed) material.needsUpdate = true;
      }
      child.castShadow = layer.opacity > 0.25 && !layer.wireframe;
      child.receiveShadow = true;
    });
    const size = new THREE.Box3().setFromObject(lastPose).getSize(new THREE.Vector3());
    const dimensions = size.toArray().map((value) => Math.max(0, value)) as Vec3;
    const infoKey = dimensions.map((value) => value.toFixed(3)).join(',') + `:${lastLayerTriangles}:${lastLayerSample}`;
    if (infoKey !== lastLayerInfoKey) {
      lastLayerInfoKey = infoKey;
      callbacks.onLastInfo?.({ dimensions, triangles: Math.round(lastLayerTriangles), sample: lastLayerSample });
    }
    invalidate();
  }

  async function updateLastLayerModel(asset: ModelAsset | null): Promise<void> {
    const revision = ++lastLayerRevision;
    lastLayerLoading = true;
    callbacks.onLastLoading?.(true);
    lastLayerLoadError = null;
    clearSection();
    try {
      const next = await parseLastLayerModel(asset);
      if (disposed || revision !== lastLayerRevision || !project?.last.enabled) { disposeObject(next); return; }
      if (lastLayerModel) disposeObject(lastLayerModel);
      lastLayerModel = next;
      lastLayerSample = asset === null;
      lastLayerInfoKey = '';
      lastLayerTriangles = 0;
      lastSourceAxis.add(next);
      next.traverse((child) => {
        if (child instanceof THREE.Mesh) lastLayerTriangles += (child.geometry.index?.count ?? child.geometry.getAttribute('position').count) / 3;
      });
      updateLastLayerTransform();
      fit();
      lastLayerLoadedRevision = revision;
      callbacks.onLastLoaded?.(asset?.name ?? null);
    } catch (error) {
      if (disposed || revision !== lastLayerRevision) return;
      const message = error instanceof Error ? error.message : 'Last 3D 파일을 읽을 수 없습니다.';
      lastLayerLoadError = message;
      callbacks.onLastError?.(message.includes('DRACO') || message.includes('Meshopt') ? '압축을 끈 GLB 또는 STL Last 파일을 사용해 주세요.' : message);
    } finally {
      if (!disposed && revision === lastLayerRevision) {
        lastLayerLoading = false;
        callbacks.onLastLoading?.(false);
        requestSection();
      }
    }
  }

  function removeLastLayer(): void {
    lastLayerRevision++;
    lastLayerLoading = false;
    callbacks.onLastLoading?.(false);
    lastLayerLoadError = null;
    lastLayerLoadedRevision = 0;
    clearSection();
    if (lastLayerModel) disposeObject(lastLayerModel);
    lastLayerModel = null;
    lastLayerSource = undefined;
    lastLayerInfoKey = '';
    lastLayerTriangles = 0;
    lastPose.visible = false;
    callbacks.onLastInfo?.(null);
    invalidate();
  }

  // Changed: switching or disabling a baseline removes its old ghost at once.
  // Parsing and errors are independent from current-model imports and metrics.
  function setComparison(snapshot: LastProject | null): void {
    if (disposed) return;
    if (snapshot === comparisonSource && (comparisonPending || comparisonRoot !== null || snapshot === null)) return;
    comparisonSource = snapshot;
    const revision = ++comparisonRevision;
    if (comparisonRoot) disposeObject(comparisonRoot);
    comparisonRoot = null;
    comparisonPending = snapshot !== null;
    callbacks.onComparisonLoading?.(comparisonPending);
    invalidate();
    if (snapshot) void loadComparison(snapshot, revision);
  }

  async function loadComparison(snapshot: LastProject, revision: number): Promise<void> {
    let nextRoot: THREE.Group | null = null;
    try {
      const next = await createComparisonModels(snapshot);
      nextRoot = next.root;
      if (disposed || revision !== comparisonRevision) { disposeObject(nextRoot); return; }
      comparisonRoot = nextRoot;
      scene.add(comparisonRoot);
      fit();
      invalidate();
    } catch (error) {
      if (nextRoot) {
        if (comparisonRoot === nextRoot) comparisonRoot = null;
        disposeObject(nextRoot);
      }
      if (disposed || revision !== comparisonRevision) return;
      callbacks.onComparisonError?.(error instanceof Error ? error.message : '저장된 비교 모델을 불러오지 못했습니다.');
    } finally {
      if (!disposed && revision === comparisonRevision) {
        comparisonPending = false;
        callbacks.onComparisonLoading?.(false);
      }
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
    const frame = getReferenceFrame(project.settings.dimensions, project.settings.referenceCenter);
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
      // Changed: translate the complete image frame; no cropping or rescaling of
      // captured content is needed when its physical frame dimensions are stored.
      const placement = getReferencePlanePose(frame, key, gap);
      ref.group.position.copy(placement.position);
      ref.group.quaternion.copy(placement.quaternion);
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
    const frame = getReferenceFrame(project.settings.dimensions, project.settings.referenceCenter);
    const box = frame.bounds;
    const boxHelper = new THREE.Box3Helper(box, new THREE.Color('#91a08a'));
    const boxMaterials = Array.isArray(boxHelper.material) ? boxHelper.material : [boxHelper.material];
    boxMaterials.forEach((material) => { material.transparent = true; material.opacity = 0.5; });
    boundsGroup.add(boxHelper);
    const labelHeight = Math.max(7, l / 35);
    const xLabel = textSprite(`${l.toFixed(1)} mm`, { height: labelHeight });
    xLabel.position.set(frame.center.x, box.min.y - 12, box.min.z);
    const yLabel = textSprite(`${w.toFixed(1)} mm`, { height: labelHeight });
    yLabel.position.set(box.max.x + 12, frame.center.y, box.min.z);
    const zLabel = textSprite(`${h.toFixed(1)} mm`, { height: labelHeight });
    zLabel.position.set(box.min.x - 12, box.max.y + 8, frame.center.z);
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

  function resize(renderImmediately = false): void {
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
    // Changed: resizing clears the canvas; redraw before paint to avoid a blank frame.
    if (renderImmediately) renderer.render(scene, camera);
    else invalidate();
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
    const box = getReferenceDisplayBounds(getReferenceFrame(s.dimensions, s.referenceCenter), s.gap);
    if (model && pose.visible) box.union(new THREE.Box3().setFromObject(pose));
    // Changed: fitting includes both visible model layers in the same workspace.
    if (lastLayerModel && lastPose.visible) box.union(new THREE.Box3().setFromObject(lastPose));
    if (comparisonRoot) box.union(new THREE.Box3().setFromObject(comparisonRoot));
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

  // Changed: panel resizing preserves the user's orbit, pan and zoom; fit stays explicit.
  const observer = new ResizeObserver(() => resize(true));
  observer.observe(host);
  resize();

  function setProject(next: LastProject): void {
    if (disposed) return;
    previousProject = project;
    project = next;
    const s = next.settings;
    const previous = previousProject?.settings;
    const dimensionChange = !previous || s.dimensions.some((n, i) => n !== previous.dimensions[i]);
    // Changed: an explicit reference center moves guides and fit without changing
    // either model layer's transform or the world-coordinate axes/grid.
    const centerChange = !previous || (s.referenceCenter === null) !== (previous.referenceCenter === null) || !!s.referenceCenter?.some((value, index) => value !== previous.referenceCenter?.[index]);
    const frameChange = dimensionChange || centerChange;
    if (frameChange) rebuildGuides();
    boundsGroup.visible = s.bounds;
    axes.visible = s.axes;
    grid.visible = s.grid;
    updateReferences(dimensionChange);
    // A new asset object is also a new import request when its bytes are equal.
    // Re-parse it so successful re-imports reliably clear the UI rollback state.
    // Changed: choosing another built-in shoe is also a new geometry request.
    // Changed: sample edits replace the built-in geometry, invalidating model
    // information, captures and sections while preserving the Last and references.
    const shapeChange = !previous || (Object.keys(s.sampleShape) as (keyof SampleShape)[]).some((key) => s.sampleShape[key] !== previous.sampleShape[key]);
    const sampleChange = next.model === null && (s.sampleKind !== previous?.sampleKind || shapeChange);
    const assetChange = modelSource === undefined || next.model !== modelSource || sampleChange;
    const transformChange = !previous || s.modelScale !== previous.modelScale || s.modelUp !== previous.modelUp || s.modelUnits !== previous.modelUnits || s.modelRotation.some((n, i) => n !== previous.modelRotation[i]) || s.modelPosition.some((n, i) => n !== previous.modelPosition[i]);
    const lastSourceChange = next.last.enabled && (lastLayerSource === undefined || next.last.model !== lastLayerSource);
    const previousLast = previousProject?.last;
    const lastTransformChange = !previousLast || next.last.scale !== previousLast.scale || next.last.units !== previousLast.units || next.last.up !== previousLast.up || next.last.position.some((value, index) => value !== previousLast.position[index]) || next.last.rotation.some((value, index) => value !== previousLast.rotation[index]);
    const sectionChange = !previous || s.section.enabled !== previous.section.enabled || s.section.axis !== previous.section.axis || s.section.percent !== previous.section.percent;
    const sectionInputsChanged = assetChange || transformChange || lastSourceChange || next.last.enabled !== previousLast?.enabled || (next.last.enabled && lastTransformChange) || sectionChange;
    if (sectionInputsChanged) clearSection();
    if (assetChange) {
      modelSource = next.model;
      void updateModel(next.model, s.sampleKind, s.sampleShape);
    } else {
      if (transformChange) {
        // Changed: a capture of an older pose cannot be delivered as the new pose.
        modelPoseRevision++;
        clearMeasurement();
      }
      updateModelTransform();
    }
    // Changed: only Last asset changes start its parser; shoe selection, camera,
    // references, and primary material controls preserve the loaded Last object.
    if (!next.last.enabled) {
      if (!previousProject || previousProject.last.enabled || lastLayerSource !== undefined || lastLayerModel) {
        removeLastLayer();
        fit();
      }
    } else if (lastSourceChange) {
      lastLayerSource = next.last.model;
      void updateLastLayerModel(next.last.model);
    } else updateLastLayerTransform();
    if (sectionInputsChanged) requestSection();
    if (!previous || frameChange || s.view !== previous.view || s.orthographic !== previous.orthographic) fit();
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

  // Changed: snapshot only the normalized model pose; display guides, opacity,
  // wireframe, visibility, and the user's camera stay completely independent.
  const captureReferences: ReferenceCaptureFunction = async (options) => {
    if (disposed) throw new Error('3D 화면이 닫혔습니다. 다시 열어 캡처해 주세요.');
    if (modelLoading) throw new Error('모델을 불러오는 중입니다. 완료된 뒤 다시 캡처해 주세요.');
    if (!model) throw new Error('캡처할 3D 모델을 먼저 불러와 주세요.');
    const revision = modelRevision;
    const poseRevision = modelPoseRevision;
    const requestOptions = { ...options };
    const assertCurrent = () => {
      if (disposed) throw new Error('3D 화면이 닫혀 캡처를 중단했습니다.');
      if (modelLoading || revision !== modelRevision || poseRevision !== modelPoseRevision) {
        throw new Error('모델이 바뀌었습니다. 현재 모델로 다시 캡처해 주세요.');
      }
    };
    // Changed: StrictMode and dialog reopen requests can overlap safely. Queue
    // renderers to bound memory; only a changed source/pose or disposal cancels.
    const pending = captureQueue.catch(() => {}).then(() => {
      assertCurrent();
      return captureModelReferences(pose, requestOptions, softwareMode, assertCurrent);
    });
    captureQueue = pending;
    return pending;
  };

  // Changed: export the actual current sample mesh and alignment, never static
  // downloadable source assets or the independent Last/reference/guide layers.
  async function exportStl(): Promise<Blob> {
    const revision = modelRevision;
    const poseRevision = modelPoseRevision;
    const assertCurrent = () => {
      if (disposed) throw new Error('3D 화면이 닫혔습니다. 다시 열어 저장해 주세요.');
      if (modelLoading || !model || modelLoadedRevision !== modelRevision || modelLoadError) throw new Error('샘플 형상을 준비하는 중입니다. 완료된 뒤 다시 저장해 주세요.');
      if (!currentSample || project?.model !== null) throw new Error('현재 형상 STL 저장은 기본 신발 샘플에서 사용할 수 있습니다.');
      if (revision !== modelRevision || poseRevision !== modelPoseRevision) throw new Error('형상이 바뀌었습니다. 현재 샘플로 다시 저장해 주세요.');
    };
    assertCurrent();
    const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
    assertCurrent();
    pose.updateMatrixWorld(true);
    const data = new STLExporter().parse(pose, { binary: true });
    assertCurrent();
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return new Blob([bytes], { type: 'model/stl' });
  }

  function dispose(): void {
    disposed = true;
    modelRevision++;
    lastLayerRevision++;
    comparisonRevision++;
    comparisonPending = false;
    callbacks.onLastLoading?.(false);
    callbacks.onComparisonLoading?.(false);
    clearSection();
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
    comparisonRoot = null;
    comparisonSource = null;
  }

  return { setProject, setComparison, setMeasure, fit, screenshot, captureReferences, exportStl, dispose };
}
