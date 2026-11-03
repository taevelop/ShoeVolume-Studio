export const SAMPLE_KINDS = ['loafer', 'sneaker', 'mary-jane', 'sandal', 'ankle-boot'] as const;

export type SampleKind = typeof SAMPLE_KINDS[number];
export type ShoeSampleKind = SampleKind;
export const DEFAULT_SAMPLE_KIND: SampleKind = 'loafer';

export interface SampleDefinition {
  id: SampleKind;
  name: string;
  englishName: string;
  description: string;
  color: string;
  /** Nominal concept dimensions in mm; not measurements of a real product. */
  dimensions: [number, number, number];
}

export const SHOE_SAMPLES: readonly SampleDefinition[] = [
  {
    id: 'loafer', name: '로퍼', englishName: 'Loafer',
    description: '낮은 입구와 둥근 앞코의 슬립온',
    color: '#8c5e45', dimensions: [253, 105.31, 79.4],
  },
  {
    id: 'sneaker', name: '스니커즈', englishName: 'Sneaker',
    description: '신발끈과 두툼한 밑창의 캐주얼 슈즈',
    color: '#d9d6cc', dimensions: [253, 105.31, 95],
  },
  {
    id: 'mary-jane', name: '메리제인', englishName: 'Mary Jane',
    description: '발등 스트랩과 낮은 굽이 있는 슈즈',
    color: '#754b50', dimensions: [253, 105.31, 79.4],
  },
  {
    id: 'sandal', name: '샌들', englishName: 'Sandal',
    description: '앞코가 열려 있는 스트랩 샌들',
    color: '#ae8357', dimensions: [253, 105.31, 55],
  },
  {
    id: 'ankle-boot', name: '앵클부츠', englishName: 'Ankle Boot',
    description: '발목을 감싸는 높은 입구의 부츠',
    color: '#59614f', dimensions: [253, 105.31, 145],
  },
];
