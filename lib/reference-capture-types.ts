import type { PlaneKey, Vec3 } from './project';

// Changed: one capture contract is shared by the viewer, preview UI, and ZIP export.
export type CaptureBackground = 'white' | 'transparent';

export interface ReferenceCaptureOptions {
  background: CaptureBackground;
  maxSize: 1024 | 2048;
}

export interface ReferenceCaptureImage {
  view: PlaneKey;
  blob: Blob;
  width: number;
  height: number;
  /** Full orthographic image frame, including the visible padding. */
  frameWidthMm: number;
  frameHeightMm: number;
  /** World-axis bounds of the model after its current unit, scale, and pose. */
  modelDimensions: Vec3;
}

export type ReferenceCaptureFunction = (options: ReferenceCaptureOptions) => Promise<ReferenceCaptureImage[]>;
