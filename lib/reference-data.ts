/**
 * Transcribed from the four user-provided dimension sheets on 2026-11-02.
 * All distances are millimetres. `ratio` values are fractions (0.15 = 15%).
 * Values preserve the source's rounding; do not derive an anatomical 3D surface
 * or a closed solid from these 2D registration and image-conversion records.
 */

export type ReferenceStatus = 'exact' | 'reference' | 'provisional';

export const REFERENCE_DIMENSIONS = {
  length: 253,
  width: 105.31,
  height: 79.4,
} as const;

export const REFERENCE_SOURCES = {
  side: { filename: 'image(20261102-074618).png', title: '측면뷰 · 디자인 적용 X·Y 치수표' },
  top: { filename: 'image(20261102-074623).png', title: '탑뷰 · 디자인 적용 X·Y 치수표' },
  front: { filename: 'image(20261102-074638).png', title: '정면뷰 · 디자인 적용 X·Y 치수표' },
  rear: { filename: 'image(20261102-074646).png', title: 'SHOOB F240 · 후면부 비율 및 X·Y 치수 이미지표' },
} as const;

export interface SidePoint {
  label: 'A' | 'B' | 'C' | 'D' | 'E';
  length: number;
  height: number;
  lengthRatio: number;
  heightRatio: number;
}

export const SIDE_POINTS: readonly SidePoint[] = [
  { label: 'A', length: 15.18, height: 79.4, lengthRatio: 0.06, heightRatio: 1 },
  { label: 'B', length: 75.90, height: 48.7, lengthRatio: 0.30, heightRatio: 0.613 },
  { label: 'C', length: 147.75, height: 32.6, lengthRatio: 0.584, heightRatio: 0.411 },
  { label: 'D', length: 186.46, height: 41.5, lengthRatio: 0.737, heightRatio: 0.523 },
  { label: 'E', length: 253.00, height: 15.7, lengthRatio: 1, heightRatio: 0.198 },
];

export interface ReferenceSection {
  label: 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'B' | 'S6' | 'S7';
  ratio: number;
  /** Distance from heel in the top view; not front/rear image height. */
  length: number;
  medial: number;
  lateral: number;
  /** Source's reported total projection width, including its rounding. */
  width: number;
  frontLeft: number;
  frontRight: number;
}

export const SECTIONS: readonly ReferenceSection[] = [
  { label: 'S1', ratio: 0.15, length: 37.95, medial: 37.19, lateral: 38.98, width: 76.17, frontLeft: 38.98, frontRight: 37.19 },
  { label: 'S2', ratio: 0.30, length: 75.90, medial: 36.47, lateral: 40.41, width: 76.88, frontLeft: 40.41, frontRight: 36.47 },
  { label: 'S3', ratio: 0.40, length: 101.20, medial: 32.18, lateral: 37.01, width: 69.20, frontLeft: 37.01, frontRight: 32.18 },
  { label: 'S4', ratio: 0.50, length: 126.50, medial: 38.80, lateral: 42.91, width: 81.71, frontLeft: 42.91, frontRight: 38.80 },
  { label: 'S5', ratio: 0.65, length: 164.45, medial: 49.53, lateral: 52.21, width: 101.74, frontLeft: 52.21, frontRight: 49.53 },
  { label: 'B', ratio: 0.667, length: 168.75, medial: 51.14, lateral: 53.28, width: 104.42, frontLeft: 53.28, frontRight: 51.14 },
  { label: 'S6', ratio: 0.75, length: 189.75, medial: 51.32, lateral: 51.85, width: 103.17, frontLeft: 51.85, frontRight: 51.32 },
  { label: 'S7', ratio: 0.90, length: 227.70, medial: 38.62, lateral: 37.37, width: 75.99, frontLeft: 37.37, frontRight: 38.62 },
];

export const TOP_REGISTRATION = {
  outsideLengthMm: 253.0,
  maxOutsideWidthMm: 105.31,
  maxWidthPositionRatio: 0.691,
  maxWidthPositionMm: 174.8,
  maxWidthPositionApproximate: true,
  widthBasis: '길이 253 mm 축척에서 환산',
  positionBasis: '현재 탑뷰에서 환산',
} as const;

export const FRONT_REGISTRATION = {
  totalWidthMm: 105.31,
  maxHeightMm: 79.4,
  unregisteredHeightMm: 78.7,
  unregisteredHeightApproximate: true,
  verticalScaleCorrection: 1.0083,
  widthBasis: '탑뷰 범위에 축척 등록',
  heightBasis: '측면 기준에 세로 등록',
  unregisteredHeightBasis: '같은 가로 축척 기준',
  correctionBasis: '등록 상태 대비 등록비',
} as const;

export interface RearLevel {
  name: string;
  kind: 'height' | 'width';
  standardMm: number;
  measuredMm: number;
  /** Source's image-converted height ratio; width row is total width ratio. */
  ratio: number;
  /** A stated target in the chart, only where explicitly printed. */
  targetRatio?: number;
  status: ReferenceStatus;
  measuredApproximate?: boolean;
}

export const REAR_LEVELS: readonly RearLevel[] = [
  { name: '최고높이 A', kind: 'height', standardMm: 79.40, measuredMm: 79.4, ratio: 1, targetRatio: 1, status: 'exact' },
  { name: '전체 투영폭', kind: 'width', standardMm: 105.31, measuredMm: 105.3, ratio: 1, targetRatio: 1, status: 'exact' },
  { name: '솔·어퍼 꺾임 K', kind: 'height', standardMm: 47.64, measuredMm: 47.1, ratio: 0.594, targetRatio: 0.6, status: 'reference', measuredApproximate: true },
  { name: '트레드 최상단', kind: 'height', standardMm: 31.76, measuredMm: 30.8, ratio: 0.388, targetRatio: 0.4, status: 'reference' },
  { name: 'T2 하단', kind: 'height', standardMm: 20.64, measuredMm: 21.4, ratio: 0.269, status: 'provisional' },
  { name: 'T1 상단', kind: 'height', standardMm: 18.26, measuredMm: 17.8, ratio: 0.225, status: 'provisional' },
];

export interface RearGap {
  label: '①' | '②';
  height: number;
  width: number;
  centerX: number;
  /** Boundaries repeated in the adjacent block table, not a depth measurement. */
  leftX: number;
  rightX: number;
  status: 'reference';
}

export const REAR_GAPS: readonly RearGap[] = [
  { label: '①', height: 25.3, width: 3.4, centerX: 1.2, leftX: -0.5, rightX: 2.9, status: 'reference' },
  { label: '②', height: 12.1, width: 3.4, centerX: 1.2, leftX: -0.5, rightX: 2.9, status: 'reference' },
];

export interface RearBlock {
  name: 'T2-L' | 'T2-R' | 'T1-L' | 'T1-R';
  side: 'medial' | 'lateral';
  label: '①' | '②';
  height: number;
  leftX: number;
  rightX: number;
  width: number;
  ratio: number;
}

export const REAR_BLOCKS: readonly RearBlock[] = [
  { name: 'T2-L', side: 'medial', label: '①', height: 25.3, leftX: -28.5, rightX: -0.5, width: 28.0, ratio: 0.266 },
  { name: 'T2-R', side: 'lateral', label: '①', height: 25.3, leftX: 2.9, rightX: 30.7, width: 27.8, ratio: 0.264 },
  { name: 'T1-L', side: 'medial', label: '②', height: 12.1, leftX: -28.7, rightX: -0.5, width: 28.2, ratio: 0.268 },
  { name: 'T1-R', side: 'lateral', label: '②', height: 12.1, leftX: 2.9, rightX: 31.1, width: 28.2, ratio: 0.268 },
];

export const REAR_REGISTRATION = {
  groundHeightMm: 0,
  maxHeightMm: 79.4,
  totalProjectionWidthMm: 105.3,
  topViewXMinMm: -51.85,
  topViewXMaxMm: 53.46,
  gapCenterOffsetMm: 1.2,
  leftIs: '내측',
  rightIs: '외측',
  sideViewRadiusReferenceMm: 35,
  radiusVerifiedFromRear: false,
} as const;

export const REFERENCE_NOTES = [
  '모든 치수의 단위는 mm입니다. 표의 등록값·환산값·임시값을 구분해야 합니다. exact 상태는 등록 기준을 뜻하며 제조 공차가 검증됐다는 뜻이 아닙니다.',
  '측면은 가로=공간 길이·세로=높이, 탑뷰는 가로=좌우·세로=길이, 정면·후면은 가로=좌우·세로=높이입니다.',
  '측면의 B점(길이 75.90 mm, 높이 48.7 mm)과 탑뷰·정면의 B단면(길이 168.75 mm)은 서로 다른 표기입니다.',
  'S1~S7·B의 힐부터 위치는 탑뷰 길이축의 위치이며 정면·후면의 세로축 높이가 아닙니다. 해당 폭을 정면·후면의 특정 높이 폭으로 단정하면 안 됩니다.',
  '다른 길이 위치의 외곽점들을 동일 단면으로 연결하지 말고, 확인된 길이·높이·기준축을 먼저 정의해야 합니다.',
  'S3의 전체 폭은 원문 69.20 mm를 유지했습니다. 내측 32.18 mm와 외측 37.01 mm의 합은 69.19 mm이며 0.01 mm의 반올림 차이가 있습니다.',
  '정면 표의 왼쪽 거리는 외측, 오른쪽 거리는 내측 값입니다. 정면과 후면의 좌우를 같은 방향으로 적용하면 안 됩니다.',
  '탑뷰의 회색 내부 표현은 원 이미지에 남아 있는 표현이며 풋베드 치수로 사용하지 않습니다.',
  '후면 T2 하단·T1 상단은 홈 인접부의 대표 위치입니다. 곡선 경계 전체가 그 높이에 놓인다는 뜻은 아닙니다.',
  '후면 블록 폭은 지정 높이에서의 투영폭으로, 곡면의 실제 길이나 최대 폭이 아닙니다. 전체 105.3 mm는 전족부까지 포함하는 전체 투영폭입니다.',
  '중앙 홈 폭 3.4 mm는 보이는 두 경계 사이 거리이며 깊이는 이 자료에서 산출할 수 없습니다. 홈 중심 X=+1.2 mm는 기존 기준선 대비 값입니다.',
  '안쪽 2 mm는 내부 공간 설계 설정으로만 기록됐습니다. 내부 면·풋베드·리브 두께·힐 보강·솔 두께는 이 표로 생성하거나 추정하지 않습니다.',
  'R35는 측면 앞뒤 방향 곡률의 참고값이며 후면에서 직접 검증한 값이 아닙니다.',
  '원근 오차, 단면 곡률, 이미지 간 같은 공간점의 대응은 별도 검증이 필요합니다. 소수점 표기는 CAD 정확도를 보장하지 않습니다.',
] as const;

export const REFERENCE_AMBIGUITIES = [
  '측면 B점과 탑뷰 B단면은 이름만 같고 길이 위치가 다릅니다.',
  'S3 폭 69.20 mm와 내·외측 합 69.19 mm 사이에 0.01 mm 차이가 있습니다.',
  '최대 폭 위치 약 69.1%·약 174.8 mm는 근사값입니다. B단면 66.7%·168.75 mm를 최대 폭 위치로 대체하면 안 됩니다.',
  '정면 등록 전 높이 약 78.7 mm와 세로 축척 보정 ×1.0083은 원문 값을 각각 유지했습니다. 근사 높이만으로 보정 계수를 다시 계산하지 않습니다.',
  '후면 높이 비율은 표에 기재된 값입니다. 반올림된 환산 mm 값에서 다시 계산한 비율과 미세한 차이가 있을 수 있습니다.',
] as const;
