import { useId } from 'react';

/** The V's five blocks, in a paint of the caller's. */
function VBlocks({ fill, point }: { fill: string; point: string }) {
  return <>{[[0, 0], [4, 0], [1, 1], [3, 1], [2, 2]].map(([c, r]) => <rect key={`${c}${r}`} x={c! * 20} y={r! * 26} width="17" height="23" rx="4.6" fill={r === 2 ? point : fill} />)}</>;
}

/** A present in chrome with the V's green ribbon, its lid up and a coin coming out. */
export function Gift({ vip = false }: { vip?: boolean }) {
  const id = useId();
  const g = (k: string) => `url(#${id}${k})`;
  return (
    <svg className="rf-gift" viewBox="0 -26 220 236" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fafaf8" /><stop offset="1" stopColor="#8d8d8a" /></linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a4a4a1" /><stop offset="1" stopColor="#3a3a39" /></linearGradient>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#c4c4c0" /></linearGradient>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5cf0c0" /><stop offset="1" stopColor="#00875f" /></linearGradient>
        <radialGradient id={`${id}i`}><stop offset="0" stopColor="#5cf0c0" stopOpacity="0.95" /><stop offset="0.6" stopColor="#00b481" stopOpacity="0.5" /><stop offset="1" stopColor="#00b481" stopOpacity="0" /></radialGradient>
        <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">{(vip ? ['#fff1c4', '#f6d27a', '#b9832a'] : ['#5cf0c0', '#2fd09c', '#00875f']).map((c, i) => <stop key={c} offset={i / 2} stopColor={c} />)}</linearGradient>
      </defs>
      <ellipse cx="110" cy="198" rx="74" ry="9" fill="#000" opacity="0.45" />
      <path d="M44 104 110 130v66L52 170q-6-3-6-9z" fill={g('l')} />
      <path d="M176 104 110 130v66l58-26q6-3 6-9z" fill={g('r')} />
      <path d="M44 104 110 80l66 24-66 26z" fill="#0b1d17" />
      <ellipse cx="110" cy="104" rx="60" ry="22" fill={g('i')} />
      <path d="M68 113.500 86 120.500v65L68 177z" fill={g('g')} /><path d="M152 113.500 134 120.500v65L152 177z" fill={g('g')} opacity="0.75" />
      <g transform="translate(0 6)"><g className="rf-gift__coin"><g transform="rotate(14 112 80)"><ellipse cx="117" cy="80" rx="29" ry="32" fill={vip ? '#6d4a12' : '#04513a'} /><ellipse cx="110" cy="80" rx="29" ry="32" fill={g('c')} /><ellipse cx="110" cy="80" rx="24" ry="27" fill={vip ? '#d9a441' : '#00a074'} stroke={vip ? '#fff1c4' : '#8ff5d3'} strokeOpacity="0.7" /><g transform="translate(93 67) scale(0.345)"><VBlocks fill={vip ? '#3a2604' : '#fff'} point={vip ? '#fff6d8' : '#04281d'} /></g></g></g></g>
      <g transform="translate(0 -20)"><g className="rf-gift__lid">
        <path d="M36 66 118 34l70 32-74 30z" fill={g('t')} /><path d="M36 66v18l78 30V96z" fill={g('l')} /><path d="M188 66v18l-74 30V96z" fill={g('r')} />
        <path d="M70 52.700 89 45.300 160 78l-18 7z" fill={g('g')} /><path d="M151 50 134 42 62 75l19 8z" fill={g('g')} opacity="0.85" />
        <path d="M112 60C92 22 58 26 64 46c4 13 30 14 48 14z" fill={g('g')} /><path d="M112 60c14-40 52-40 50-18-2 14-32 18-50 18z" fill={g('g')} /><path d="M112 60C98 38 78 34 76 44c0 9 22 14 36 16zM112 60c10-22 34-28 38-18 1 10-24 16-38 18z" fill="#064d38" />
        <ellipse cx="112" cy="60" rx="9" ry="7" fill="#5cf0c0" />
      </g></g>
      {[[26, 60, 1], [196, 34, 1.2], [40, 140, 0.8], [204, 128, 0.7]].map(([x, y, s]) => <path key={x} className="rf-gift__sp" transform={`translate(${x} ${y}) scale(${s})`} d="M0-9 2.300-2.300 9 0 2.300 2.300 0 9-2.300 2.300-9 0-2.300-2.300z" fill="#f4f4f2" />)}
    </svg>
  );
}

