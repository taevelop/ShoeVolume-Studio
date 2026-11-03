import * as THREE from 'three';
import type { LastLayer, Vec3 } from './project';

export interface ModelLayerGroups {
  pose: THREE.Group;
  normalization: THREE.Group;
  sourceAxis: THREE.Group;
}

// Changed: shoe and Last use the same unit/axis normalization on independent
// groups. A supplied mesh is never deformed to match either reference frame.
export function applyModelLayerTransform(
  groups: ModelLayerGroups,
  transform: Pick<LastLayer, 'position' | 'rotation' | 'scale' | 'units' | 'up'>,
  sample: boolean,
): void {
  const { pose, normalization, sourceAxis } = groups;
  pose.position.set(0, 0, 0);
  pose.rotation.set(0, 0, 0);
  pose.scale.setScalar(1);
  normalization.position.set(0, 0, 0);
  sourceAxis.rotation.set(!sample && transform.up === 'y' ? Math.PI / 2 : 0, 0, 0);
  pose.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(sourceAxis);
  const center = box.getCenter(new THREE.Vector3());
  normalization.position.set(-center.x, -center.y, -box.min.z);
  const unit = sample ? 1 : { mm: 1, cm: 10, m: 1000, in: 25.4 }[transform.units];
  pose.scale.setScalar(unit * transform.scale);
  pose.rotation.set(...transform.rotation.map(THREE.MathUtils.degToRad) as Vec3);
  pose.position.fromArray(transform.position);
  pose.updateMatrixWorld(true);
}
