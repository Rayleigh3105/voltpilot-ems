import type { ReactNode } from 'react';
import { GeraeteAktePage } from './GeraeteAktePage';
import { GeraeteListePage } from './GeraeteListePage';
import { geraeteAkteRoute, type GeraeteAkteReiter, type Route } from '../../nav';

/**
 * Der Raum „Geräte" (§4.2, Scheibe S2): ohne Box-Referenz die GERÄTE-LISTE
 * (jede Box in jedem Lebensabschnitt), mit Referenz die GERÄTEAKTE - ein Ort
 * je Box statt der früheren Registrierungs-Seite und einem zweiten Fenster.
 * Der Dateiname/Exportname bleibt (Lesezeichen, `pageChunks.ts`).
 */
export function GeraeteRegistryPage({
  geraeteAkte,
  onNavigate,
}: {
  geraeteAkte?: { ref: string; reiter: GeraeteAkteReiter | null } | null;
  onNavigate?: (target: Route) => void;
  tabs?: ReactNode;
} = {}) {
  if (geraeteAkte) {
    return <GeraeteAktePage boxRef={geraeteAkte.ref} reiter={geraeteAkte.reiter} onNavigate={onNavigate} />;
  }
  return <GeraeteListePage onOpen={(ref) => onNavigate?.(geraeteAkteRoute(ref))} />;
}
