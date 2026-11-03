'use client';

import { ArrowUpRight, Check, Download } from 'lucide-react';
import { SHOE_SAMPLES, type SampleKind } from '@/lib/shoe-sample-catalog';

export function ShoeSampleGlyph({ kind, color }: { kind: SampleKind; color: string }) {
  return <svg className="shoe-sample-glyph" viewBox="0 0 140 82" aria-hidden="true">
    <ellipse cx="72" cy="69" rx="59" ry="4" fill="#253629" opacity=".06" />
    {kind === 'loafer' && <>
      <path d="M13 57 17 30Q25 23 32 38L52 44Q71 48 91 45L121 52Q131 54 132 62L17 65Z" fill={color} />
      <path d="M29 38Q38 39 49 44L65 47 50 51 32 46Z" fill="#543929" />
      <path d="M64 43 80 44 75 54 60 53Z" fill="#a97858" stroke="#66442e" strokeWidth="1.2" />
      <path d="M16 59Q52 64 91 59L131 59 131 65Q79 73 15 66Z" fill="#443c33" />
      <path d="M84 48Q109 47 124 55" fill="none" stroke="#d7aa7b" strokeWidth="1" />
    </>}
    {kind === 'sneaker' && <>
      <path d="M12 55 18 26 35 30 46 23 67 37 86 46 115 49Q131 51 131 60L14 64Z" fill={color} stroke="#aaa99c" strokeWidth="1" />
      <path d="M23 32 34 34 42 29 51 36 38 43 19 45Z" fill="#627965" />
      <path d="M44 36 65 42 88 50 69 55 47 48Z" fill="#899b84" />
      <path d="M51 32 62 30M59 38 70 36M68 44 80 42M76 49 88 46" stroke="#fffdf5" strokeWidth="2.8" strokeLinecap="round" />
      <path d="M13 56Q64 64 131 56L132 65Q70 75 12 66Z" fill="#f2eee2" stroke="#bbb9a9" strokeWidth="1" />
      <path d="M13 65Q70 72 131 64" fill="none" stroke="#71806a" strokeWidth="3" />
    </>}
    {kind === 'mary-jane' && <>
      <path d="M13 58 18 33 29 36 43 51Q65 58 84 49L104 46Q128 46 132 61L16 65Z" fill={color} />
      <path d="M36 43 42 29Q46 26 50 32L57 52 47 53Z" fill={color} />
      <rect x="40" y="35" width="10" height="7" rx="2" fill="none" stroke="#ddc18b" strokeWidth="2" />
      <path d="M15 60Q68 67 131 59L132 65Q74 72 14 66Z" fill="#493c3a" />
      <path d="M17 65H43V72H16Z" fill="#3e3432" />
      <path d="M89 49Q116 46 127 57" fill="none" stroke="#bc8c91" strokeWidth="1" />
    </>}
    {kind === 'sandal' && <>
      <path d="M13 60Q62 51 127 58L132 64Q78 74 12 67Z" fill="#997b59" />
      <path d="M13 59Q74 50 129 58L132 62Q76 68 13 63Z" fill="#d3ba91" />
      <path d="M43 60 46 39Q52 30 60 38L73 58 62 60 54 43 53 60Z" fill={color} />
      <path d="M83 58 86 40Q93 35 99 41L112 58 101 60 93 46 94 59Z" fill={color} />
      <path d="M16 60 20 38 28 39 26 61Z" fill={color} />
      <path d="M21 42Q37 30 50 40" fill="none" stroke={color} strokeWidth="6" />
      <rect x="44" y="38" width="9" height="6" rx="1" fill="none" stroke="#e5d3a6" strokeWidth="2" />
    </>}
    {kind === 'ankle-boot' && <>
      <path d="M18 60 22 13Q42 5 61 12L58 39Q61 47 86 49L113 52Q129 53 132 62L16 66Z" fill={color} />
      <path d="M27 17Q43 13 55 17L52 37 32 39Z" fill="#353d32" opacity=".8" />
      <path d="M24 14Q41 6 59 13" fill="none" stroke="#a6ae95" strokeWidth="2" />
      <path d="M62 43Q80 52 113 54" fill="none" stroke="#a6ae95" strokeWidth="1" />
      <path d="M16 60Q73 66 131 59L132 66Q66 74 15 67Z" fill="#343a30" />
      <path d="M18 66H48V73H17Z" fill="#293027" />
      <path d="M24 13 23 7 30 6 31 12" fill="none" stroke={color} strokeWidth="4" />
    </>}
  </svg>;
}

export function ShoeSampleQuickbar({ selected, disabled, onSelect, onDetails }: {
  selected: SampleKind | null; disabled: boolean; onSelect: (kind: SampleKind) => void; onDetails: () => void;
}) {
  return <section className="sample-quickbar" aria-label="신발 샘플 선택">
    <div className="sample-quickbar-heading"><span className="eyebrow">SHOE COLLECTION <b>05</b></span><button onClick={onDetails}>모델 정보 · 다운로드<ArrowUpRight size={13} /></button></div>
    <div className="sample-quick-options">{SHOE_SAMPLES.map(sample => <button key={sample.id}
      className={`sample-quick-option ${selected === sample.id ? 'active' : ''}`} aria-label={`${sample.name} 샘플 적용`} aria-pressed={selected === sample.id}
      disabled={disabled} onClick={() => onSelect(sample.id)} title={sample.description}>
      <ShoeSampleGlyph kind={sample.id} color={sample.color} /><span>{sample.name}</span>{selected === sample.id && <Check size={11} />}
    </button>)}</div>
  </section>;
}

export function ShoeSampleGallery({ selected, disabled, onSelect }: {
  selected: SampleKind | null; disabled: boolean; onSelect: (kind: SampleKind) => void;
}) {
  return <>
    <p className="dialog-description">실제 입구·갑피·밑창 구조가 서로 다른 3D 개념 모델 5종입니다. 샘플을 적용하면 모델이 교체되고 참조 이미지면은 접힙니다. 화면의 ‘참조 이미지’ 버튼으로 다시 펼칠 수 있습니다.</p>
    <div className="sample-gallery">{SHOE_SAMPLES.map((sample, index) => <article key={sample.id} className={`sample-gallery-card ${selected === sample.id ? 'selected' : ''}`}>
      <button className="sample-gallery-select" onClick={() => onSelect(sample.id)} disabled={disabled} aria-label={`${sample.name} 모델 선택`} aria-pressed={selected === sample.id}>
        <span className="sample-card-number">0{index + 1}</span>{selected === sample.id && <span className="sample-card-selected"><Check size={12} />적용 중</span>}
        <div className="sample-card-art"><ShoeSampleGlyph kind={sample.id} color={sample.color} /></div>
        <strong>{sample.name}<small>{sample.englishName}</small></strong><p>{sample.description}</p>
        <span className="sample-card-size">{sample.dimensions.join(' × ')} mm</span>
        <span className="sample-card-action">이 모델 적용<ArrowUpRight size={14} /></span>
      </button>
      <div className="sample-card-downloads"><a href={`/samples/${sample.id}.glb`} download={`${sample.id}.glb`} aria-label={`${sample.name} GLB 다운로드`}><Download size={13} />GLB</a><a href={`/samples/${sample.id}.stl`} download={`${sample.id}.stl`} aria-label={`${sample.name} STL 다운로드`}><Download size={13} />STL</a></div>
    </article>)}</div>
    <div className="dimension-notes"><h3>샘플의 크기와 파일</h3><p>길이 253 mm·최대 폭 105.31 mm를 공통 기준으로 만들었습니다. 높이는 종류별 개념 치수이며, 제공하신 신발이나 라스트를 복원한 결과가 아닙니다. 제조·착화·구조 검증을 거친 모델은 아닙니다.</p>
      <p>GLB는 색상을 포함한 미터·Y축 위쪽 형식, STL은 mm·Z축 위쪽 형식입니다. 다운로드 파일은 정렬·배율을 변경하기 전의 원본 샘플입니다. 밑창·갑피·끈 등 여러 파트가 포함되므로 제작 전에 CAD에서 접합과 두께를 검토하세요.</p></div>
  </>;
}
