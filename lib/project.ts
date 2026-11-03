import { DEFAULT_SAMPLE_KIND, type SampleKind } from './shoe-sample-catalog'; // Changed

export const PROJECT_VERSION = 1;
export const MAX_ASSET_BYTES = 15 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 30 * 1024 * 1024;

export type PlaneKey = 'side' | 'top' | 'front' | 'rear';
export type ViewKey = 'iso' | 'side' | 'top' | 'front' | 'rear';
export type Vec3 = [number, number, number];

// Changed: section selection is saved independently of both model transforms.
export type SectionAxis = 'x' | 'y' | 'z';
export interface SectionSettings {
  enabled: boolean;
  axis: SectionAxis;
  percent: number;
}

export interface ImageAsset {
  name: string;
  dataUrl: string;
}

export interface PlaneState {
  visible: boolean;
  flip: boolean;
  image: ImageAsset | null;
}

export interface ModelAsset {
  name: string;
  format: 'stl' | 'obj' | 'glb';
  dataUrl: string;
}

// Changed: the optional last layer has its own source, display, and transform.
export interface LastLayer {
  enabled: boolean;
  model: ModelAsset | null;
  visible: boolean;
  opacity: number;
  wireframe: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: number;
  units: 'mm' | 'cm' | 'm' | 'in';
  up: 'z' | 'y';
}

export interface SceneSettings {
  sampleKind: SampleKind; // Changed: stored selection; uploaded model retains priority.
  dimensions: Vec3;
  referenceCenter: Vec3 | null; // Changed: null keeps the original ground-based frame.
  section: SectionSettings; // Changed
  gap: number;
  imageOpacity: number;
  lastOpacity: number;
  grid: boolean;
  axes: boolean;
  bounds: boolean;
  wireframe: boolean;
  showLast: boolean;
  view: ViewKey;
  orthographic: boolean;
  modelPosition: Vec3;
  modelRotation: Vec3;
  modelScale: number;
  modelUnits: 'mm' | 'cm' | 'm' | 'in';
  modelUp: 'z' | 'y';
}

export interface LastProject {
  schema: 'last-studio';
  version: 1;
  title: string;
  savedAt?: string;
  settings: SceneSettings;
  planes: Record<PlaneKey, PlaneState>;
  model: ModelAsset | null;
  last: LastLayer; // Changed: a null model uses the demo only when enabled.
}

export interface ModelInfo {
  dimensions: Vec3;
  triangles: number;
  sample: boolean;
}

export const PLANE_LABELS: Record<PlaneKey, { name: string; axis: string; short: string }> = {
  side: { name: '측면', axis: 'XZ', short: 'SIDE' },
  top: { name: '윗면', axis: 'XY', short: 'TOP' },
  front: { name: '정면', axis: 'YZ', short: 'FRONT' },
  rear: { name: '후면', axis: 'YZ', short: 'REAR' },
};

// Changed: fresh values also provide a lossless default for older version-1 files.
export function createDefaultLastLayer(): LastLayer {
  return {
    enabled: false, model: null, visible: true, opacity: 0.58, wireframe: false,
    position: [0, 0, 5], rotation: [0, 0, 0], scale: 1, units: 'mm', up: 'z',
  };
}

export function createDefaultProject(): LastProject {
  return {
    schema: 'last-studio', version: 1, title: 'SHOOB F240 형상 검토',
    settings: {
      sampleKind: DEFAULT_SAMPLE_KIND, // Changed
      dimensions: [253, 105.31, 79.4], referenceCenter: null, gap: 28, imageOpacity: 0.58,
      section: { enabled: false, axis: 'x', percent: 66.7 }, // Changed
      lastOpacity: 1, grid: true, axes: true, bounds: false,
      wireframe: false, showLast: true, view: 'iso', orthographic: false,
      modelPosition: [0, 0, 0], modelRotation: [0, 0, 0], modelScale: 1,
      modelUnits: 'mm', modelUp: 'z',
    },
    planes: {
      side: { visible: true, flip: false, image: null },
      top: { visible: true, flip: false, image: null },
      front: { visible: true, flip: false, image: null },
      rear: { visible: false, flip: false, image: null },
    },
    model: null,
    last: createDefaultLastLayer(), // Changed
  };
}

export function projectFilename(title: string): string {
  return (title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 90) || 'last-studio') + '.laststudio.json';
}
