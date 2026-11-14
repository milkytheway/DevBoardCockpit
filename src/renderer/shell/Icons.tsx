import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export function GridIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function LayersIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M8 2 14 5.5 8 9 2 5.5 8 2Z" />
      <path d="m2 8.5 6 3.5 6-3.5" />
      <path d="m2 11.5 6 3.5 6-3.5" />
    </svg>
  );
}

export function TerminalIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="m5 6.5 2 2-2 2" />
      <path d="M9 10.5h3" />
    </svg>
  );
}

export function FolderIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  );
}

export function ListIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M6 4h8M6 8h8M6 12h8" />
      <circle cx="3" cy="4" r=".6" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r=".6" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GearIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1" />
    </svg>
  );
}

export function SearchIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <circle cx="7" cy="7" r="4" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

export function CloseIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function PlusIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function RefreshIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.8v2.9H10" />
    </svg>
  );
}

export function CpuIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
      <rect x="6.5" y="6.5" width="3" height="3" rx=".5" />
      <path d="M6 2v2.5M10 2v2.5M6 11.5V14M10 11.5V14M2 6h2.5M2 10h2.5M11.5 6H14M11.5 10H14" />
    </svg>
  );
}

export function BoltIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M8.5 2 4 9h3l-.5 5L11 7H8l.5-5Z" />
    </svg>
  );
}

export function AlertIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M8 2.5 14 13H2L8 2.5Z" />
      <path d="M8 6.5v3M8 11.2v.1" />
    </svg>
  );
}

export function ChevronIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function PaletteIcon(p: IconProps): JSX.Element {
  return (
    <svg {...base(p)}>
      <path d="M8 2a6 6 0 1 0 0 12 1.8 1.8 0 0 0 1.4-2.9 1.6 1.6 0 0 1 1.2-2.6H12A2.5 2.5 0 0 0 14.5 6 6 6 0 0 0 8 2Z" />
      <circle cx="5.2" cy="6" r=".7" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.7" r=".7" fill="currentColor" stroke="none" />
      <circle cx="10.7" cy="6.2" r=".7" fill="currentColor" stroke="none" />
    </svg>
  );
}
