import { MAX_ASSET_BYTES, type LastProject, type PlaneKey, type Vec3 } from './project';
import { validateProject } from './project-validation';
import type { ReferenceCaptureImage } from './reference-capture-types';
import { referenceCaptureFilename } from './reference-download';

const VIEW_KEYS: readonly PlaneKey[] = ['side', 'top', 'front', 'rear'];
const same = (first: number, second: number) => Math.abs(first - second) <= Math.max(1e-6, Math.abs(first) * 1e-8, Math.abs(second) * 1e-8);

export interface ReferenceRegistrationPlan {
  dimensions: Vec3;
  referenceCenter: Vec3;
  captures: Record<PlaneKey, ReferenceCaptureImage>;
}

// Changed: registration uses physical camera frames, including their padding.
// Pixel rounding must never be converted into a different physical shoe scale.
export function planReferenceRegistration(captures: ReferenceCaptureImage[]): ReferenceRegistrationPlan {
  if (!Array.isArray(captures) || captures.length !== 4) {
    throw new Error('측면·윗면·정면·후면 이미지를 각각 한 장씩 캡처해 주세요.');
  }
  const byView = {} as Record<PlaneKey, ReferenceCaptureImage>;
  for (const capture of captures) {
    if (!capture || !VIEW_KEYS.includes(capture.view) || byView[capture.view]) {
      throw new Error('중복되거나 지원하지 않는 참조 이미지 방향이 있습니다. 네 방향을 다시 캡처해 주세요.');
    }
    if (![capture.width, capture.height].every(value => Number.isInteger(value) && value > 0)
      || ![capture.frameWidthMm, capture.frameHeightMm].every(value => Number.isFinite(value) && value >= 1 && value <= 10000)) {
      throw new Error('참조 이미지의 픽셀 크기와 1~10000 mm 범위의 프레임 치수를 확인해 주세요.');
    }
    if (!Array.isArray(capture.frameCenter) || capture.frameCenter.length !== 3
      || !Array.from(capture.frameCenter).every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)) {
      throw new Error('참조 이미지의 중심 좌표를 확인할 수 없습니다. 네 방향을 다시 캡처해 주세요.');
    }
    byView[capture.view] = capture;
  }
  const dimensions: Vec3 = [byView.side.frameWidthMm, byView.top.frameHeightMm, byView.side.frameHeightMm];
  const referenceCenter: Vec3 = [...byView.side.frameCenter];
  const pixelsPerMm = byView.side.width / dimensions[0];
  for (const view of VIEW_KEYS) {
    const capture = byView[view];
    const frameWidth = view === 'front' || view === 'rear' ? dimensions[1] : dimensions[0];
    const frameHeight = view === 'top' ? dimensions[1] : dimensions[2];
    if (!same(capture.frameWidthMm, frameWidth) || !same(capture.frameHeightMm, frameHeight)
      || !capture.frameCenter.every((value, index) => same(value, referenceCenter[index]))) {
      throw new Error('네 이미지의 프레임 치수 또는 중심 좌표가 서로 다릅니다. 같은 형상에서 함께 다시 캡처해 주세요.');
    }
    if (!same(capture.width / capture.frameWidthMm, pixelsPerMm) || !same(capture.height / capture.frameHeightMm, pixelsPerMm)) {
      throw new Error('네 이미지의 픽셀 배율이 서로 다릅니다. 같은 해상도로 함께 다시 캡처해 주세요.');
    }
  }
  return { dimensions, referenceCenter, captures: byView };
}

// Changed: retain the original PNG bytes; do not crop, resize, or re-encode them.
async function captureDataUrl(capture: ReferenceCaptureImage): Promise<string> {
  if (!(capture.blob instanceof Blob) || capture.blob.size < 24 || capture.blob.size > MAX_ASSET_BYTES) {
    throw new Error('참조 PNG 한 장의 크기는 15 MB 이하여야 합니다. 해상도를 낮춰 다시 캡처해 주세요.');
  }
  const bytes = new Uint8Array(await capture.blob.slice(0, 24).arrayBuffer());
  const header = new DataView(bytes.buffer);
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    || header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== capture.width || header.getUint32(20) !== capture.height) {
    throw new Error('PNG 데이터와 기록된 이미지 크기가 일치하지 않습니다. 네 방향을 다시 캡처해 주세요.');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result) : reject(new Error('참조 PNG 파일을 읽지 못했습니다.'));
    reader.onerror = () => reject(new Error('참조 PNG 파일을 읽지 못했습니다. 다시 시도해 주세요.'));
    reader.onabort = () => reject(new Error('참조 PNG 파일 읽기가 취소되었습니다.'));
    reader.readAsDataURL(capture.blob.slice(0, capture.blob.size, 'image/png'));
  });
}

// Changed: replace only reference images and their frame; keep both model poses.
export async function applyCapturedReferences(
  project: LastProject,
  captures: ReferenceCaptureImage[],
  modelName: string,
): Promise<LastProject> {
  const plan = planReferenceRegistration(captures);
  const planes = { ...project.planes };
  for (const view of VIEW_KEYS) {
    planes[view] = {
      visible: true, flip: false,
      image: { name: referenceCaptureFilename(modelName, view), dataUrl: await captureDataUrl(plan.captures[view]) },
    };
  }
  return validateProject({
    ...project, planes,
    settings: { ...project.settings, dimensions: plan.dimensions, referenceCenter: plan.referenceCenter },
  });
}
