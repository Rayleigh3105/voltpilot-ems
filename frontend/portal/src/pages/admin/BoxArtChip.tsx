import { Badge } from '../../../designsystem/components/core/Badge';
import { boxArtLabel } from '../../adminEdgeUpdates';

/**
 * Die Bauart einer Box als Chip: „Docker-Box", „Edge Light" oder ehrlich
 * „Box-Art unbekannt". Abgeleitet wird sie in der API (`ota.BoxArt`); der Chip
 * übersetzt nur.
 */
export function BoxArtChip({ boxArt }: { boxArt: string | null | undefined }) {
  const b = boxArtLabel(boxArt);
  return (
    <Badge variant={b.art ? 'tint' : 'off'} title={b.detail}
      data-testid="box-art" data-box-art={b.art ?? 'unbekannt'}>
      {b.label}
    </Badge>
  );
}
