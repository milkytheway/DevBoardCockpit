import {
  ActivityIcon,
  BoardIcon,
  BoltIcon,
  CpuIcon,
  GaugeIcon,
  MemoryIcon,
  ThermometerIcon,
} from './Icons';
import type { CardLook } from './cards';

/**
 * The pictogram for a card family, shared by the card chrome and the sidebar.
 *
 * One mapping, one meaning: the icon in the catalogue is the icon on the card.
 */
export function CardGlyph({
  icon,
  size = 14,
}: {
  icon: CardLook['icon'];
  size?: number;
}): JSX.Element {
  switch (icon) {
    case 'cpu':
      return <CpuIcon size={size} />;
    case 'gpu':
      return <GaugeIcon size={size} />;
    case 'memory':
      return <MemoryIcon size={size} />;
    case 'thermal':
      return <ThermometerIcon size={size} />;
    case 'board':
      return <BoardIcon size={size} />;
    case 'bolt':
      return <BoltIcon size={size} />;
    default:
      return <ActivityIcon size={size} />;
  }
}
