import { Badge } from '../../designsystem/components/core/Badge';
import { netzladenBadge } from '../fleet';

/**
 * The grid-charging mode badge, one look everywhere a site shows its mode
 * (fleet site card, Standort detail drawer): green "Nur Solarladen (EEG)" for
 * the compliant default, cyan "Netzladen aktiv" where a Portal-Admin enabled
 * grid arbitrage. Wording/derivation is the pure `netzladenBadge` in fleet.ts;
 * the cyan colorway extends the design-system Badge the same way the plan's
 * mock does (the ok variant already matches the EEG green).
 */
export function NetzladenBadge({ erlaubt, small = false }: { erlaubt: boolean; small?: boolean }) {
  const badge = netzladenBadge(erlaubt);
  const style: React.CSSProperties = {
    ...(badge.kind === 'netzladen'
      ? { background: '#E0F7FA', color: '#00838F' }
      : {}),
    ...(small ? { padding: '0.2rem 0.55rem' } : {}),
    whiteSpace: 'nowrap',
  };
  return (
    <Badge variant="ok" style={style} title={
      badge.kind === 'netzladen'
        ? 'Der Speicher darf auch aus dem Stromnetz laden (Markt-Arbitrage).'
        : 'Der Speicher lädt nur aus eigenem Solarstrom - nie aus dem Netz (EEG-konform).'
    }>
      {badge.label}
    </Badge>
  );
}
