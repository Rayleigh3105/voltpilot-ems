import type { ReactNode } from 'react';
import type { Tenant } from '../../admin/adminApi';
import { GeraeteAktePage } from './GeraeteAktePage';
import { GeraeteListePage } from './GeraeteListePage';
import { geraeteAkteRoute, type AnlageWerkzeug, type GeraeteAkteReiter, type Route } from '../../nav';

/**
 * Der Raum „Geräte" (§4.2, Scheiben S2/S3): ohne Box-Referenz die GERÄTE-LISTE
 * (jede Box in jedem Lebensabschnitt), mit Referenz die GERÄTEAKTE - ein Ort
 * je Box statt der früheren Registrierungs-Seite und einem zweiten Fenster.
 * Der Dateiname/Exportname bleibt (Lesezeichen, `pageChunks.ts`).
 */
export function GeraeteRegistryPage({
  geraeteAkte,
  onNavigate,
  onJumpToTenant,
  tenants,
}: {
  geraeteAkte?: { ref: string; reiter: GeraeteAkteReiter | null; werkzeug?: AnlageWerkzeug | null } | null;
  onNavigate?: (target: Route) => void;
  /** Reiter „Anlage" (S3): „Wie der Kunde es sieht"-Werkzeuge (Prognose, Gemeinsame Steuerung). */
  onJumpToTenant?: (tenantId: string, target: Route) => void;
  tenants?: Tenant[];
  tabs?: ReactNode;
} = {}) {
  if (geraeteAkte) {
    return (
      <GeraeteAktePage boxRef={geraeteAkte.ref} reiter={geraeteAkte.reiter} werkzeug={geraeteAkte.werkzeug ?? null}
        onNavigate={onNavigate} onJumpToTenant={onJumpToTenant} tenants={tenants ?? []} />
    );
  }
  return (
    <GeraeteListePage
      onOpen={(ref, werkzeug) => onNavigate?.(geraeteAkteRoute(ref, werkzeug ? 'anlage' : null, werkzeug ?? null))}
    />
  );
}
