import * as THREE from 'three';
import type { PlaneKey, Vec3 } from './project';

export interface ReferenceFrame {
  center: THREE.Vector3;
  size: THREE.Vector3;
  bounds: THREE.Box3;
}

// Changed: captured images retain their world-space center. Null preserves the
// original centered-XY / bottom-Z=0 reference frame used by legacy projects.
export function getReferenceFrame(dimensions: Vec3, referenceCenter: Vec3 | null): ReferenceFrame {
  const center = new THREE.Vector3(...(referenceCenter ?? [0, 0, dimensions[2] / 2]));
  const size = new THREE.Vector3(...dimensions);
  return { center, size, bounds: new THREE.Box3().setFromCenterAndSize(center, size) };
}

// Changed: these image-plane bases are the inverse mapping of the four capture
// cameras. Gap offsets the display plane only; image scale remains unchanged.
export function getReferencePlanePose(frame: ReferenceFrame, key: PlaneKey, gap: number): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const normal = new THREE.Vector3();
  let depth: number;
  if (key === 'side') {
    right.set(1, 0, 0); up.set(0, 0, 1); normal.set(0, -1, 0); depth = frame.size.y;
  } else if (key === 'top') {
    right.set(1, 0, 0); up.set(0, 1, 0); normal.set(0, 0, 1); depth = frame.size.z;
  } else {
    const direction = key === 'front' ? 1 : -1;
    right.set(0, direction, 0); up.set(0, 0, 1); normal.set(direction, 0, 0); depth = frame.size.x;
  }
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
  return { position: frame.center.clone().addScaledVector(normal, depth / 2 + gap), quaternion };
}

// Changed: fit the displayed frame at its own center, including separated planes.
export function getReferenceDisplayBounds(frame: ReferenceFrame, gap: number): THREE.Box3 {
  const bounds = frame.bounds.clone();
  bounds.min.x -= gap; bounds.max.x += gap;
  bounds.min.y -= gap; bounds.max.y += gap;
  bounds.max.z += gap;
  return bounds;
}
