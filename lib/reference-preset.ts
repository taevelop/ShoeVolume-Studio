import { createDefaultProject, type ImageAsset, type LastProject, type PlaneKey } from './project';
import { REFERENCE_DIMENSIONS } from './reference-data';

export const REFERENCE_IMAGE_NOTE = '치수표의 외곽 범위를 기준 치수에 맞춰 등록한 참고 이미지입니다. 검증된 CAD 형상이나 실제 3D 단면은 아닙니다.';

interface ReferenceImageSpec {
  source: string;
  name: string;
  /** Registered outside bounds in the unchanged 1200 × 867 source sheet. */
  crop: readonly [x: number, y: number, width: number, height: number];
  clockwise?: boolean;
}

const REFERENCE_IMAGES: Record<PlaneKey, ReferenceImageSpec> = {
  side: {
    source: '/references/dimensions-side.png',
    name: 'SHOOB F240 · 측면 등록 참고.png',
    crop: [209, 165, 775, 244],
  },
  top: {
    source: '/references/dimensions-top.png',
    name: 'SHOOB F240 · 윗면 등록 참고.png',
    crop: [143.8, 158, 219.7, 528],
    clockwise: true,
  },
  front: {
    source: '/references/dimensions-front.png',
    name: 'SHOOB F240 · 정면 등록 참고.png',
    crop: [112, 249, 419, 315],
  },
  rear: {
    source: '/references/dimensions-rear.png',
    name: 'SHOOB F240 · 후면 등록 참고.png',
    crop: [143, 153, 491, 370],
  },
};

function loadReferenceImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
    };
    image.onload = () => { finish(); resolve(image); };
    image.onerror = () => { finish(); reject(new Error('등록 참고 이미지를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.')); };
    timer = setTimeout(() => {
      finish();
      image.src = '';
      reject(new Error('참고 이미지 로딩 시간이 초과되었습니다. 연결을 확인하고 다시 시도해 주세요.'));
    }, 15000);
    image.src = source;
  });
}

async function rasterizeReference(spec: ReferenceImageSpec): Promise<ImageAsset> {
  const image = await loadReferenceImage(spec.source);
  if (image.naturalWidth !== 1200 || image.naturalHeight !== 867) {
    throw new Error('참고 치수표의 해상도가 변경되었습니다. 원본 등록 범위를 다시 확인해야 합니다.');
  }
  const [x, y, width, height] = spec.crop;
  const cropWidth = Math.round(width);
  const cropHeight = Math.round(height);
  const canvas = document.createElement('canvas');
  canvas.width = spec.clockwise ? cropHeight : cropWidth;
  canvas.height = spec.clockwise ? cropWidth : cropHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('이 브라우저에서 참고 이미지를 준비할 수 없습니다. 다른 브라우저에서 다시 열어 주세요.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (spec.clockwise) {
    // In the source top view the toe is at the top; the viewport expects +X right.
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
  }
  context.drawImage(image, x, y, width, height, 0, 0, cropWidth, cropHeight);
  try {
    return { name: spec.name, dataUrl: canvas.toDataURL('image/png') };
  } catch {
    throw new Error('참고 이미지를 프로젝트에 포함하지 못했습니다. 새로고침 후 다시 시도해 주세요.');
  }
}

let referenceAssets: Promise<Record<PlaneKey, ImageAsset>> | undefined;

function getReferenceAssets(): Promise<Record<PlaneKey, ImageAsset>> {
  if (!referenceAssets) {
    const entries = Object.entries(REFERENCE_IMAGES) as [PlaneKey, ReferenceImageSpec][];
    referenceAssets = Promise.all(entries.map(async ([key, spec]) => [key, await rasterizeReference(spec)] as const))
      .then((images) => Object.fromEntries(images) as Record<PlaneKey, ImageAsset>)
      .catch((error: unknown) => { referenceAssets = undefined; throw error; });
  }
  return referenceAssets;
}

export async function createReferenceProject(): Promise<LastProject> {
  if (typeof window === 'undefined') throw new Error('등록 참고 프로젝트는 브라우저에서 열어 주세요.');
  const images = await getReferenceAssets();
  const project = createDefaultProject();
  project.settings.dimensions = [REFERENCE_DIMENSIONS.length, REFERENCE_DIMENSIONS.width, REFERENCE_DIMENSIONS.height];
  for (const key of Object.keys(REFERENCE_IMAGES) as PlaneKey[]) {
    project.planes[key].image = { ...images[key] };
  }
  return project;
}
