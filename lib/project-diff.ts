import { PLANE_LABELS, type ImageAsset, type LastProject, type ModelAsset, type PlaneKey, type SampleShape, type Vec3 } from './project';
import { SHOE_SAMPLES } from './shoe-sample-catalog';

export interface ProjectDifference {
  key: string;
  label: string;
  before: string;
  after: string;
  delta?: string;
}

const AXES = ['X', 'Y', 'Z'] as const;
const SHAPE_LABELS: Record<keyof SampleShape, string> = {
  length: '샘플 길이', ballWidthDelta: '샘플 발볼 폭 조절', heelWidthDelta: '샘플 뒤꿈치 폭 조절',
  toeHeightDelta: '샘플 앞코 높이 조절', instepHeightDelta: '샘플 발등 높이 조절',
};
const VIEW_LABELS = { iso: '사시', side: '측면', top: '윗면', front: '정면', rear: '후면' } as const;
const numberText = (value: number) => value !== 0 && Math.abs(value) < 0.000001
  ? value.toExponential(3) : Number(value.toFixed(6)).toString();
const valueText = (value: number, unit: string) => `${numberText(value)}${unit === 'mm' ? ' ' : ''}${unit}`;
const sampleName = (kind: string) => SHOE_SAMPLES.find(sample => sample.id === kind)?.name ?? kind;

function assetSize(dataUrl: string): string {
  const length = dataUrl.length - dataUrl.indexOf(',') - 1;
  const bytes = length / 4 * 3 - (dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0);
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Changed: compare only design/display values; save timestamps and embedded
// data URLs never enter the output. Identical filenames can still report new data.
export function compareProjects(before: LastProject, after: LastProject): ProjectDifference[] {
  const changes: ProjectDifference[] = [];
  const text = (key: string, label: string, first: string, second: string) => {
    if (first !== second) changes.push({ key, label, before: first, after: second });
  };
  const number = (key: string, label: string, first: number, second: number, unit: string, deltaUnit = unit) => {
    if (first === second) return;
    const delta = second - first;
    changes.push({
      key, label, before: valueText(first, unit), after: valueText(second, unit),
      delta: `${delta > 0 ? '+' : ''}${valueText(delta, deltaUnit)}`,
    });
  };
  const vector = (key: string, label: string, first: Vec3, second: Vec3, unit: string) => {
    AXES.forEach((axis, index) => number(`${key}.${axis.toLowerCase()}`, `${label} ${axis}`, first[index], second[index], unit));
  };
  const flag = (key: string, label: string, first: boolean, second: boolean) => text(key, label, first ? '켜짐' : '꺼짐', second ? '켜짐' : '꺼짐');
  const asset = (key: string, label: string, first: ImageAsset | ModelAsset | null, second: ImageAsset | ModelAsset | null, empty: string) => {
    const describe = (value: ImageAsset | ModelAsset | null) => !value ? empty : 'format' in value ? `${value.name} (${value.format.toUpperCase()})` : `파일 · ${value.name}`;
    text(`${key}.source`, label, describe(first), describe(second));
    if (first && second && first.dataUrl !== second.dataUrl) {
      changes.push({ key: `${key}.content`, label: `${label} 내용`, before: assetSize(first.dataUrl), after: assetSize(second.dataUrl), delta: '내용 변경' });
    }
  };

  text('title', '프로젝트 이름', before.title, after.title);
  const first = before.settings, second = after.settings;
  text('settings.sampleKind', '신발 샘플', sampleName(first.sampleKind), sampleName(second.sampleKind));
  asset('model', '신발 원본', before.model, after.model, '내장 샘플');
  for (const key of Object.keys(SHAPE_LABELS) as (keyof SampleShape)[]) {
    number(`settings.sampleShape.${key}`, SHAPE_LABELS[key], first.sampleShape[key], second.sampleShape[key], 'mm');
  }
  vector('settings.modelPosition', '신발 위치', first.modelPosition, second.modelPosition, 'mm');
  vector('settings.modelRotation', '신발 회전', first.modelRotation, second.modelRotation, '°');
  number('settings.modelScale', '신발 균일 배율', first.modelScale, second.modelScale, '×');
  text('settings.modelUnits', '신발 원본 단위', first.modelUnits, second.modelUnits);
  text('settings.modelUp', '신발 원본 위쪽 축', first.modelUp.toUpperCase(), second.modelUp.toUpperCase());
  flag('settings.showLast', '신발 표시', first.showLast, second.showLast);
  flag('settings.wireframe', '신발 와이어프레임', first.wireframe, second.wireframe);
  number('settings.lastOpacity', '신발 불투명도', first.lastOpacity * 100, second.lastOpacity * 100, '%', '%p');

  const firstLast = before.last, secondLast = after.last;
  flag('last.enabled', '독립 라스트 사용', firstLast.enabled, secondLast.enabled);
  asset('last.model', '라스트 원본', firstLast.model, secondLast.model, '데모 라스트');
  vector('last.position', '라스트 위치', firstLast.position, secondLast.position, 'mm');
  vector('last.rotation', '라스트 회전', firstLast.rotation, secondLast.rotation, '°');
  number('last.scale', '라스트 균일 배율', firstLast.scale, secondLast.scale, '×');
  text('last.units', '라스트 원본 단위', firstLast.units, secondLast.units);
  text('last.up', '라스트 원본 위쪽 축', firstLast.up.toUpperCase(), secondLast.up.toUpperCase());
  flag('last.visible', '라스트 표시', firstLast.visible, secondLast.visible);
  flag('last.wireframe', '라스트 와이어프레임', firstLast.wireframe, secondLast.wireframe);
  number('last.opacity', '라스트 불투명도', firstLast.opacity * 100, secondLast.opacity * 100, '%', '%p');

  vector('settings.dimensions', '참조면 크기', first.dimensions, second.dimensions, 'mm');
  if (first.referenceCenter && second.referenceCenter) {
    vector('settings.referenceCenter', '참조면 중심', first.referenceCenter, second.referenceCenter, 'mm');
  } else if (first.referenceCenter !== second.referenceCenter) {
    const center = (settings: LastProject['settings']) => settings.referenceCenter
      ? `지정 (${settings.referenceCenter.map(numberText).join(', ')}) mm`
      : `자동 (0, 0, ${numberText(settings.dimensions[2] / 2)}) mm`;
    text('settings.referenceCenter', '참조면 중심', center(first), center(second));
  }
  number('settings.gap', '참조면 간격', first.gap, second.gap, 'mm');
  number('settings.imageOpacity', '참조 이미지 불투명도', first.imageOpacity * 100, second.imageOpacity * 100, '%', '%p');
  for (const view of Object.keys(PLANE_LABELS) as PlaneKey[]) {
    const firstPlane = before.planes[view], secondPlane = after.planes[view], label = PLANE_LABELS[view].name;
    asset(`planes.${view}.image`, `${label} 이미지`, firstPlane.image, secondPlane.image, '이미지 없음');
    flag(`planes.${view}.visible`, `${label} 참조면 표시`, firstPlane.visible, secondPlane.visible);
    flag(`planes.${view}.flip`, `${label} 좌우 반전`, firstPlane.flip, secondPlane.flip);
  }
  flag('settings.section.enabled', '단면 표시', first.section.enabled, second.section.enabled);
  text('settings.section.axis', '단면 방향', first.section.axis.toUpperCase(), second.section.axis.toUpperCase());
  number('settings.section.percent', '단면 위치', first.section.percent, second.section.percent, '%', '%p');
  for (const [key, label] of [['grid', '격자 표시'], ['axes', '좌표축 표시'], ['bounds', '기준 상자 표시']] as const) {
    flag(`settings.${key}`, label, first[key], second[key]);
  }
  text('settings.view', '시점', VIEW_LABELS[first.view], VIEW_LABELS[second.view]);
  text('settings.orthographic', '투영 방식', first.orthographic ? '정사영' : '원근', second.orthographic ? '정사영' : '원근');
  return changes;
}
