import * as THREE from 'three';
import { SAMPLE_SHAPE_LIMITS, type SampleShape } from './project';
import type { SampleKind } from './shoe-sample-catalog';
import { createShoeSample } from './shoe-samples';

/** Compact C2-continuous bump, with maximum 1 at the named length station. */
function bump(t: number, center: number, radius: number): number {
  const distance = Math.abs((t - center) / radius);
  return distance >= 1 ? 0 : Math.pow(1 - distance * distance, 3);
}

// Changed: a short flat station region keeps the named cross-section's width
// delta meaningful after triangle interpolation, with C2 falloff outside it.
function widthBump(t: number, center: number, radius: number): number {
  return 1 - THREE.MathUtils.smootherstep(Math.abs(t - center), 0.04, radius);
}

function isSole(name: string): boolean {
  return name === 'rubber-outsole' || name === 'layered-midsole' || name === 'visible-insole-footbed' || name.startsWith('outsole-tread-');
}

// Changed: every edit starts from the authored sample, never the previous edit.
// Width/height deltas are bounded local changes, not anatomical measurements.
export function createShapedShoeSample(kind: SampleKind, shape: SampleShape): THREE.Group {
  for (const key of Object.keys(SAMPLE_SHAPE_LIMITS) as (keyof SampleShape)[]) {
    const [min, max] = SAMPLE_SHAPE_LIMITS[key];
    if (!Number.isFinite(shape[key]) || shape[key] < min || shape[key] > max) throw new Error('샘플 형상 값이 지원 범위를 벗어났습니다.');
  }
  const source = createShoeSample(kind);
  if (shape.length === 253 && shape.ballWidthDelta === 0 && shape.heelWidthDelta === 0 && shape.toeHeightDelta === 0 && shape.instepHeightDelta === 0) return source;

  source.updateMatrixWorld(true);
  const originalBounds = new THREE.Box3().setFromObject(source, true);
  const originalSize = originalBounds.getSize(new THREE.Vector3());
  const originalCenter = originalBounds.getCenter(new THREE.Vector3());
  const footbed = source.getObjectByName('visible-insole-footbed');
  const footbedTop = footbed ? new THREE.Box3().setFromObject(footbed, true).max.z : originalBounds.min.z;
  const lengthScale = shape.length / originalSize.x;
  const result = new THREE.Group();
  result.name = source.name;
  const originals = new Set<THREE.BufferGeometry>();
  const created = new Set<THREE.BufferGeometry>();
  const paints = new Set<THREE.Material>();
  source.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    originals.add(child.geometry);
    const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => paints.add(material));
  });
  try {
    source.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      // Bake the authored parent transforms into a fresh mm-space geometry;
      // groups/materials/names and triangle indices remain intact.
      const geometry = child.geometry.clone().applyMatrix4(child.matrixWorld);
      created.add(geometry);
      const positions = geometry.getAttribute('position');
      const keepSoleZ = isSole(child.name);
      for (let index = 0; index < positions.count; index++) {
        const x = positions.getX(index), y = positions.getY(index), z = positions.getZ(index);
        const t = (x - originalBounds.min.x) / originalSize.x;
        // Heel and ball supports do not overlap. Outside the 16 mm center band,
        // each side moves by delta/2; the C2 taper fixes y=0 without a seam.
        // At the narrowest permitted width, d(y')/dy >= 1 - 8*1.875/16 = .0625.
        const widthDelta = shape.ballWidthDelta * widthBump(t, 2 / 3, 0.20) + shape.heelWidthDelta * widthBump(t, 0.15, 0.14);
        const widthShift = Math.sign(y) * widthDelta / 2 * THREE.MathUtils.smootherstep(Math.abs(y), 0, 16);
        const heightDelta = shape.toeHeightDelta * bump(t, 0.90, 0.16) + shape.instepHeightDelta * bump(t, 0.45, 0.20);
        // At maximum negative delta, d(z')/dz >= 1 - 8*1.5/20 = .4.
        // The floor/sole stay fixed while all upper pieces share this same map.
        const heightWeight = keepSoleZ ? 0 : THREE.MathUtils.smoothstep(z, footbedTop, footbedTop + 20);
        positions.setXYZ(index, (x - originalCenter.x) * lengthScale, y + widthShift, z + heightDelta * heightWeight);
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, child.material);
      mesh.name = child.name;
      mesh.userData = { ...child.userData };
      mesh.visible = child.visible;
      mesh.castShadow = child.castShadow;
      mesh.receiveShadow = child.receiveShadow;
      mesh.renderOrder = child.renderOrder;
      mesh.frustumCulled = child.frustumCulled;
      result.add(mesh);
    });
    // Correct only Float32 quantization of the baked X coordinates. This keeps
    // the requested overall length exact and centered, including decimal values.
    const bounds = new THREE.Box3().setFromObject(result, true);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    result.scale.x = shape.length / size.x;
    result.position.x = -center.x * result.scale.x;
    result.userData = { ...source.userData, sampleShape: { ...shape }, nominalDimensions: [shape.length, size.y, size.z] };
    result.updateMatrixWorld(true);
    return result;
  } catch (error) {
    created.forEach((geometry) => geometry.dispose());
    paints.forEach((material) => material.dispose());
    throw error;
  } finally {
    originals.forEach((geometry) => geometry.dispose());
    source.clear();
  }
}
