import {
  MAX_ASSET_BYTES,
  MAX_PROJECT_BYTES,
  createDefaultLastLayer,
  type ImageAsset,
  type LastLayer,
  type LastProject,
  type ModelAsset,
  type PlaneKey,
  type SceneSettings,
  type Vec3,
} from './project';
import { DEFAULT_SAMPLE_KIND, SAMPLE_KINDS } from './shoe-sample-catalog'; // Changed

export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLANE_KEYS: PlaneKey[] = ['side', 'top', 'front', 'rear'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MODEL_TYPES = ['application/octet-stream', 'model/stl', 'application/sla', 'model/obj', 'text/plain', 'model/gltf-binary'];

export class ProjectValidationError extends Error {
  constructor(message: string, public readonly code: 'invalid' | 'too-large' = 'invalid') {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectValidationError(`${label} 정보가 올바르지 않습니다.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new ProjectValidationError(`${label}은(는) 1~${max}자의 텍스트여야 합니다.`);
  }
  return value.trim();
}

function numeric(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ProjectValidationError(`${label} 값은 ${min}~${max} 범위의 숫자여야 합니다.`);
  }
  return value;
}

function vector(value: unknown, label: string, min: number, max: number): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new ProjectValidationError(`${label}에는 X, Y, Z 값이 필요합니다.`);
  }
  return Array.from(value, (item) => numeric(item, label, min, max)) as Vec3;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new ProjectValidationError(`${label} 설정이 올바르지 않습니다.`);
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new ProjectValidationError(`${label} 설정을 확인해 주세요.`);
  }
  return value as T;
}

function dataUrl(value: unknown, allowedTypes: string[], label: string): { url: string; mime: string; size: number; head: string } {
  if (typeof value !== 'string') throw new ProjectValidationError(`${label} 파일 데이터가 없습니다.`);
  const comma = value.indexOf(',');
  if (comma < 0 || comma > 100) throw new ProjectValidationError(`${label} 파일 형식이 올바르지 않습니다.`);
  const match = /^data:([a-z0-9.+/-]+);base64$/i.exec(value.slice(0, comma));
  if (!match || !allowedTypes.includes(match[1].toLowerCase())) {
    throw new ProjectValidationError(`${label}은(는) 지원되는 파일을 직접 첨부해야 합니다.`);
  }
  const payload = value.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const size = payload.length / 4 * 3 - padding;
  if (size > MAX_ASSET_BYTES) throw new ProjectValidationError('파일 하나의 크기는 15 MB 이하여야 합니다.', 'too-large');
  if (!payload.length || payload.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new ProjectValidationError(`${label} 파일 인코딩이 손상되었습니다.`);
  }
  let head: string;
  try {
    head = atob(payload.slice(0, Math.min(payload.length, 160)));
  } catch {
    throw new ProjectValidationError(`${label} 파일을 해석할 수 없습니다.`);
  }
  return { url: value, mime: match[1].toLowerCase(), size, head };
}

export function validateImageAsset(input: unknown): ImageAsset {
  const image = record(input, '이미지');
  const data = dataUrl(image.dataUrl, IMAGE_TYPES, '이미지');
  const valid = data.mime === 'image/png'
    ? data.head.startsWith('\x89PNG\r\n\x1a\n')
    : data.mime === 'image/jpeg'
      ? data.head.startsWith('\xff\xd8\xff')
      : data.head.startsWith('RIFF') && data.head.slice(8, 12) === 'WEBP';
  if (!valid) throw new ProjectValidationError('이미지 내용과 파일 형식이 일치하지 않습니다. PNG, JPG, WebP 파일을 사용해 주세요.');
  return { name: text(image.name, '이미지 이름', 180), dataUrl: data.url };
}

export function validateModelAsset(input: unknown): ModelAsset {
  const model = record(input, '라스트');
  const format = choice(model.format, ['stl', 'obj', 'glb'] as const, '라스트 형식');
  const data = dataUrl(model.dataUrl, MODEL_TYPES, '라스트');
  if (format === 'glb') {
    if (data.head.length < 20 || data.head.slice(0, 4) !== 'glTF') {
      throw new ProjectValidationError('올바른 GLB 파일이 아닙니다. GLB 2.0 파일을 사용해 주세요.');
    }
    const header = Uint8Array.from(data.head.slice(0, 12), (character) => character.charCodeAt(0));
    const view = new DataView(header.buffer);
    if (view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.size) {
      throw new ProjectValidationError('GLB 버전 또는 파일 크기 정보가 올바르지 않습니다.');
    }
  }
  return { name: text(model.name, '라스트 이름', 180), format, dataUrl: data.url };
}

// Changed: a stored secondary layer is fully validated, even while disabled.
function validateLastLayer(input: unknown): LastLayer {
  const last = record(input, '독립 라스트');
  return {
    enabled: boolean(last.enabled, '독립 라스트 사용'),
    model: last.model === null ? null : validateModelAsset(last.model),
    visible: boolean(last.visible, '독립 라스트 표시'),
    opacity: numeric(last.opacity, '독립 라스트 불투명도', 0, 1),
    wireframe: boolean(last.wireframe, '독립 라스트 와이어프레임'),
    position: vector(last.position, '독립 라스트 위치', -100000, 100000),
    rotation: vector(last.rotation, '독립 라스트 회전', -36000, 36000),
    scale: numeric(last.scale, '독립 라스트 배율', 0.000001, 10000),
    units: choice(last.units, ['mm', 'cm', 'm', 'in'] as const, '독립 라스트 원본 단위'),
    up: choice(last.up, ['z', 'y'] as const, '독립 라스트 위쪽 축'),
  };
}

/** Calculate serialized UTF-8 size without copying large base64 strings. */
export function estimateProjectBytes(project: LastProject): number {
  // Changed: both model payloads count toward the same portable-project budget.
  let assetCharacters = (project.model?.dataUrl.length ?? 0) + (project.last.model?.dataUrl.length ?? 0);
  const planes = Object.fromEntries(PLANE_KEYS.map((key) => {
    const plane = project.planes[key];
    assetCharacters += plane.image?.dataUrl.length ?? 0;
    return [key, { ...plane, image: plane.image ? { ...plane.image, dataUrl: '' } : null }];
  }));
  const envelope = {
    ...project, planes,
    model: project.model ? { ...project.model, dataUrl: '' } : null,
    last: { ...project.last, model: project.last.model ? { ...project.last.model, dataUrl: '' } : null },
  };
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength + assetCharacters;
}

export function validateProject(input: unknown): LastProject {
  const project = record(input, '프로젝트');
  if (project.schema !== 'last-studio' || project.version !== 1) {
    throw new ProjectValidationError('Last Studio 버전 1 프로젝트 파일을 선택해 주세요.');
  }
  const raw = record(project.settings, '화면 설정');
  const settings: SceneSettings = {
    // Changed: older version-1 projects have no selection; preserve their other data.
    sampleKind: raw.sampleKind === undefined ? DEFAULT_SAMPLE_KIND : choice(raw.sampleKind, SAMPLE_KINDS, '신발 샘플'),
    dimensions: vector(raw.dimensions, '기준 치수', 1, 10000),
    // Changed: missing or null retains legacy center [0, 0, height / 2].
    referenceCenter: raw.referenceCenter === undefined || raw.referenceCenter === null
      ? null : vector(raw.referenceCenter, '참조면 중심', -100000, 100000),
    gap: numeric(raw.gap, '면 간격', 0, 2000),
    imageOpacity: numeric(raw.imageOpacity, '이미지 불투명도', 0, 1),
    lastOpacity: numeric(raw.lastOpacity, '라스트 불투명도', 0, 1),
    grid: boolean(raw.grid, '격자'),
    axes: boolean(raw.axes, '좌표축'),
    bounds: boolean(raw.bounds, '기준 상자'),
    wireframe: boolean(raw.wireframe, '와이어프레임'),
    showLast: boolean(raw.showLast, '라스트 표시'),
    view: choice(raw.view, ['iso', 'side', 'top', 'front', 'rear'] as const, '시점'),
    orthographic: boolean(raw.orthographic, '정사영'),
    modelPosition: vector(raw.modelPosition, '라스트 위치', -100000, 100000),
    modelRotation: vector(raw.modelRotation, '라스트 회전', -36000, 36000),
    modelScale: numeric(raw.modelScale, '라스트 배율', 0.000001, 10000),
    modelUnits: choice(raw.modelUnits, ['mm', 'cm', 'm', 'in'] as const, '원본 단위'),
    modelUp: choice(raw.modelUp, ['z', 'y'] as const, '위쪽 축'),
  };
  const rawPlanes = record(project.planes, '다측면');
  const planes = {} as LastProject['planes'];
  for (const key of PLANE_KEYS) {
    const plane = record(rawPlanes[key], `${key} 면`);
    planes[key] = {
      visible: boolean(plane.visible, '면 표시'),
      flip: boolean(plane.flip, '이미지 좌우 반전'),
      image: plane.image === null ? null : validateImageAsset(plane.image),
    };
  }
  const clean: LastProject = {
    schema: 'last-studio', version: 1,
    title: text(project.title, '프로젝트 이름', 100),
    settings, planes,
    model: project.model === null ? null : validateModelAsset(project.model),
    // Changed: older files keep their primary model and gain an inactive last.
    last: project.last === undefined ? createDefaultLastLayer() : validateLastLayer(project.last),
  };
  if (project.savedAt !== undefined) {
    if (typeof project.savedAt !== 'string' || project.savedAt.length > 32 || !Number.isFinite(Date.parse(project.savedAt))) {
      throw new ProjectValidationError('프로젝트 저장 시간이 올바르지 않습니다.');
    }
    clean.savedAt = new Date(project.savedAt).toISOString();
  }
  if (estimateProjectBytes(clean) > MAX_PROJECT_BYTES) {
    throw new ProjectValidationError('프로젝트 전체 크기는 30 MB 이하여야 합니다. 이미지나 모델 용량을 줄여 주세요.', 'too-large');
  }
  return clean;
}
