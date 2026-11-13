import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import {
  adminApi, type AdminDeviceRow, type AdminGeraeteListeEintrag, type PendingEnrollment,
} from '../../admin/adminApi';
import { ApiError } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RowMenu } from '../../components/RowMenu';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { Blende } from '../../components/Lazy';
import { AdminPageHead } from './AdminPageHead';
import { freshnessLabel, type EdgeUpdates } from '../../adminEdgeUpdates';
import {
  filterGeraeteListe, geraeteListeLinien, geraeteListeZeilen, listeChipZahlen, loeschKandidat,
  LEERER_LISTE_FILTER, seitText, type GeraeteListeZeile, type ListeFilter, type LoeschKandidat,
} from '../../geraeteListe';
import { PENDING_KONTEXT, pendingErreichbarText } from '../../onboardingFunnel';
import type { FlottenAnlage } from '../../adminKomponentenFlotte';
import type { WerkstattBox } from '../../werkstatt';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { LIST_POLL_MS } from '../../pollCadence';
import { BoxArtChip } from './BoxArtChip';
import { parseGeraeteListeFilter, parseGeraeteListeWerkzeug, type AnlageWerkzeug } from '../../nav';
import './BoxVersions.css';
import './GeraeteUpdates.css';

const WERKZEUG_LABEL: Record<AnlageWerkzeug, string> = { plan: 'Plan erklären (Optimizer)', flows: 'Flows' };

/**
 * Die GERÄTE-LISTE (§4.4, Scheiben S2/S3): eine Zeile je Box in jedem
 * Lebensabschnitt. Sie ersetzt die Registrierungs-Seite und die Boxenliste
 * von „Plattform › Software" - eine Zeile führt in die Geräteakte, nie in
 * ein zweites Fenster.
 *
 * Scheibe S3: `?werkzeug=plan|flows` (die Alt-Adressen `#/optimizer`/`#/flows`)
 * trägt ein Werkzeug mit - „Box wählen, dann Werkzeug"; ein Klick öffnet es
 * direkt in `…/anlage/plan` bzw. `…/anlage/flows` dieser Box. `?filter=fassung`
 * (die Alt-Adresse `#/komponenten-flotte`) markiert Boxen, deren Anlage eine
 * Komponenten-Fassung nicht angewandt hat (`/admin/component-fleet`).
 */
export function GeraeteListePage({ onOpen }: { onOpen: (ref: string, werkzeug?: AnlageWerkzeug | null) => void }) {
  const [edgeUpdates, setEdgeUpdates] = useState<EdgeUpdates | null>(null);
  const [devices, setDevices] = useState<AdminDeviceRow[] | null>(null);
  const [pending, setPending] = useState<PendingEnrollment[]>([]);
  const [werkstattBoxen, setWerkstattBoxen] = useState<WerkstattBox[]>([]);
  const [komponenten, setKomponenten] = useState<FlottenAnlage[]>([]);
  const [geraeteListeDaten, setGeraeteListeDaten] = useState<AdminGeraeteListeEintrag[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ListeFilter>(
    () => ({ ...LEERER_LISTE_FILTER, chip: (parseGeraeteListeFilter(window.location.hash) as ListeFilter['chip']) ?? null }),
  );
  const [werkzeug] = useState<AnlageWerkzeug | null>(() => parseGeraeteListeWerkzeug(window.location.hash));
  const [jetzt, setJetzt] = useState(() => new Date());
  // §5.2: Bezugszeit des letzten ERFOLGS, nie eine laufende Uhr über einem
  // stehenden Schnappschuss (`liveness.ts`).
  const [fetchedAt, setFetchedAt] = useState<number>(() => Date.now());
  const [tick, setTick] = useState<number>(() => Date.now());
  const [pollFehler, setPollFehler] = useState(false);
  const hatteDaten = useRef(false);
  const [loeschFrage, setLoeschFrage] = useState<LoeschKandidat | null>(null);
  const [loeschBusy, setLoeschBusy] = useState(false);
  const [loeschFehler, setLoeschFehler] = useState<string | null>(null);

  async function reload() {
    setError(null);
    const [eu, dv, pe, ws, ko, gl] = await Promise.allSettled([
      adminApi.edgeUpdates(), adminApi.listDevices(), adminApi.listPendingEnrollments(), adminApi.werkstattBoxen(),
      adminApi.componentFleet(), adminApi.geraeteListe(),
    ]);
    if (eu.status === 'fulfilled') setEdgeUpdates(eu.value);
    if (dv.status === 'fulfilled') setDevices(dv.value);
    if (pe.status === 'fulfilled') setPending(pe.value);
    if (ws.status === 'fulfilled') setWerkstattBoxen(ws.value);
    if (ko.status === 'fulfilled') setKomponenten(ko.value);
    if (gl.status === 'fulfilled') setGeraeteListeDaten(gl.value.geraete);
    const erfolg = eu.status === 'fulfilled' || dv.status === 'fulfilled';
    if (erfolg) {
      hatteDaten.current = true;
      setLoadError(null);
      setPollFehler(false);
      setFetchedAt(Date.now());
      setJetzt(new Date());
    } else if (hatteDaten.current) {
      // Ein fehlgeschlagener Abruf ist keine Datenlage (§5.2/`liveness.ts`):
      // die Liste bleibt mit ihrem alten Stand stehen, nur die Fehlerzeile
      // erscheint - nie eine leere Fehlerseite über einer schon gezeigten Liste.
      setPollFehler(true);
    } else {
      setLoadError('Das Geräte-Inventar ist gerade nicht abrufbar. Bitte erneut versuchen.');
    }
    setLoading(false);
  }

  useEffect(() => {
    void reload();
  }, []);
  useFreshnessPoll(() => void reload(), LIST_POLL_MS, !loading);
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  const zeilen = useMemo(() => {
    const fleet = edgeUpdates?.fleet ?? [];
    // Scheibe S3: Boxen, deren Anlage eine Fassung nicht angewandt hat - für den Chip „Fassung weicht ab".
    const abweichendeAnlagen = new Set(komponenten.filter((k) => k.syncStatus === 'pending').map((k) => k.siteId));
    const fassungRefs = new Set(fleet.filter((r) => abweichendeAnlagen.has(r.siteId)).map((r) => r.externalRef));
    return geraeteListeZeilen({
      fleet, devices: devices ?? [], pending, werkstattBoxen, geraeteListe: geraeteListeDaten,
    }, jetzt, fassungRefs);
  }, [edgeUpdates, devices, pending, werkstattBoxen, komponenten, geraeteListeDaten, jetzt]);

  async function wirklichLoeschen() {
    const k = loeschFrage;
    if (!k) return;
    setLoeschBusy(true);
    setLoeschFehler(null);
    try {
      if (k.art === 'gedruckt') await adminApi.deleteProvisionedDevice(k.ref);
      else if (k.art === 'wartet') await adminApi.deletePendingEnrollment(k.ref);
      else await adminApi.werkstattBoxLoeschen(k.ref);
      setLoeschFrage(null);
      await reload();
    } catch (e) {
      setLoeschFehler(e instanceof ApiError ? e.message : `${k.name} ließ sich nicht löschen.`);
    } finally {
      setLoeschBusy(false);
    }
  }

  return (
    <>
      <AdminPageHead
        icon="cpu"
        category="primary"
        title="Geräte"
        actions={
          <span className="vp-muted vp-text-sm" data-testid="geraete-liste-stand">
            {loading ? 'Wird geladen …' : pollFehler ? freshnessLabel(fetchedAt, tick, true) : `${freshnessLabel(fetchedAt, tick)} · alle 30 s`}
          </span>
        }
      />

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {werkzeug && (
        <div className="vp-alert vp-alert-info" data-testid="geraete-liste-werkzeug">
          Werkzeug „{WERKZEUG_LABEL[werkzeug]}" - wählen Sie unten die Box, deren Anlage es öffnen soll.
        </div>
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void reload()} />
      ) : (
        <Blende laedt={loading} skelett={<Card style={{ padding: 0, overflow: 'hidden' }}><TableSkeleton rows={5} cols={6} /></Card>}>
          <GeraeteTabelle zeilen={zeilen} jetzt={jetzt} filter={filter} onFilter={setFilter} werkstattBoxen={werkstattBoxen}
            onOpen={(ref) => (werkzeug ? onOpen(ref, werkzeug) : onOpen(ref))}
            onLoeschenAnfragen={(k) => { setLoeschFehler(null); setLoeschFrage(k); }} />
        </Blende>
      )}

      <ConfirmDialog
        open={loeschFrage != null}
        tone="danger"
        title={loeschFrage ? `${loeschFrage.name} löschen?` : ''}
        intro="Das lässt sich nicht rückgängig machen."
        consequences={loeschFrage?.loeschtMit ?? []}
        confirmLabel={loeschBusy ? 'Löscht …' : 'Box löschen'}
        busy={loeschBusy}
        onCancel={() => { if (!loeschBusy) { setLoeschFrage(null); setLoeschFehler(null); } }}
        onConfirm={() => void wirklichLoeschen()}
        extra={loeschFehler && <div className="vp-alert vp-alert-err">{loeschFehler}</div>}
      />
    </>
  );
}

function GeraeteTabelle({ zeilen, jetzt, filter, onFilter, onOpen, werkstattBoxen, onLoeschenAnfragen }: {
  zeilen: GeraeteListeZeile[];
  jetzt: Date;
  filter: ListeFilter;
  onFilter: (f: ListeFilter) => void;
  onOpen: (ref: string) => void;
  werkstattBoxen: readonly WerkstattBox[];
  onLoeschenAnfragen: (k: LoeschKandidat) => void;
}) {
  const chips = useMemo(() => listeChipZahlen(zeilen), [zeilen]);
  const linien = useMemo(() => geraeteListeLinien(zeilen), [zeilen]);
  const sichtbar = useMemo(() => filterGeraeteListe(zeilen, filter), [zeilen, filter]);

  if (zeilen.length === 0) {
    return (
      <Card padding="lg" radius="lg">
        <EmptyState
          icon="list"
          category="primary"
          title="Noch kein Gerät"
          description="Registrieren Sie die erste Aufkleber-ID (Format VP-XXXX-XXXX), damit Kunden ihr Gerät verbinden können."
        />
      </Card>
    );
  }

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div className="vp-admin-sec-head">
        <h2>Alle Geräte</h2>
        <p>{zeilen.length} {zeilen.length === 1 ? 'Box' : 'Boxen'} über jeden Lebensabschnitt.</p>
        <div className="vp-gu-filterzeile">
          {chips.length > 0 && (
            <div className="vp-gu-seg" role="group" aria-label="Geräte filtern">
              {chips.map((c) => (
                <button key={c.chip} type="button" aria-pressed={filter.chip === c.chip}
                  className={filter.chip === c.chip ? 'an' : undefined}
                  onClick={() => onFilter({ ...filter, chip: filter.chip === c.chip ? null : c.chip })}>
                  {c.label} {c.n}
                </button>
              ))}
            </div>
          )}
          <div className="vp-gu-seg" role="group" aria-label="Geräte nach Linie filtern">
            {linien.map((l) => (
              <button key={l.wert} type="button" aria-pressed={filter.linie === l.wert}
                className={filter.linie === l.wert ? 'an' : undefined}
                onClick={() => onFilter({ ...filter, linie: l.wert })}>
                {l.label} {l.n}
              </button>
            ))}
          </div>
          <label className="vp-gu-such">
            <Icon name="search" size={15} />
            <span className="vp-sr-only">Geräte durchsuchen</span>
            <input type="search" value={filter.suche} placeholder="Box, Kunde, Anlage, Referenz"
              onChange={(e) => onFilter({ ...filter, suche: e.target.value })} />
          </label>
        </div>
      </div>
      {sichtbar.length === 0 ? (
        <EmptyState icon="list" category="primary" title="Keine Box passt zu diesem Filter"
          action={<Button variant="outline" onClick={() => onFilter(LEERER_LISTE_FILTER)}>Filter zurücksetzen</Button>} />
      ) : (
        <div className="vp-table-scroll">
          <table className="vp-table responsive vp-zeilen vp-geraeteliste" data-testid="geraete-liste">
            <thead>
              <tr>
                <th>Box</th>
                <th>Kunde und Anlage</th>
                <th>Verbindung</th>
                <th>Software</th>
                <th>Hinweis</th>
                <th aria-label="Öffnen" />
              </tr>
            </thead>
            <tbody>
              {sichtbar.map((z) => (
                <GeraeteZeile key={z.lebensabschnitt === 'verbunden' ? z.zeile.ref : z.ref} z={z} jetzt={jetzt} onOpen={onOpen}
                  werkstattBoxen={werkstattBoxen} onLoeschenAnfragen={onLoeschenAnfragen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const LEBENSABSCHNITT_LABEL: Record<GeraeteListeZeile['lebensabschnitt'], string> = {
  gedruckt: 'Gedruckt', wartet: 'Meldet sich', werkstatt: 'Werkstatt', verbunden: 'Beim Kunden',
  ausgebaut: 'Ausgebaut',
};

function GeraeteZeile({ z, jetzt, onOpen, werkstattBoxen, onLoeschenAnfragen }: {
  z: GeraeteListeZeile;
  jetzt: Date;
  onOpen: (ref: string) => void;
  werkstattBoxen: readonly WerkstattBox[];
  onLoeschenAnfragen: (k: LoeschKandidat) => void;
}) {
  const ref = z.lebensabschnitt === 'verbunden' ? z.zeile.ref : z.ref;
  const openRef = z.lebensabschnitt === 'verbunden' ? z.zeile.row.externalRef : z.ref;
  const kandidat = loeschKandidat(z, werkstattBoxen);
  return (
    <tr className="vp-row-click" onClick={() => onOpen(openRef)} title="Geräteakte öffnen">
      <td data-label="Box" data-zeile="haupt">
        <span className="vp-cell-main">
          <button type="button" className="vp-linklike" onClick={(e) => { e.stopPropagation(); onOpen(openRef); }}>
            {z.lebensabschnitt === 'verbunden' ? z.zeile.name : z.name}
          </button>
          <span className="vp-cell-sub vp-mono">{ref}</span>
          {z.lebensabschnitt === 'verbunden' && <span className="vp-box-art"><BoxArtChip boxArt={z.zeile.row.boxArt} /></span>}
        </span>
      </td>
      <td data-label="Kunde und Anlage" data-zeile="neben">
        {z.lebensabschnitt === 'verbunden'
          ? z.zeile.ort
          : <span className="vp-muted">{z.lebensabschnitt === 'wartet' ? PENDING_KONTEXT : LEBENSABSCHNITT_LABEL[z.lebensabschnitt]}</span>}
      </td>
      <td data-label="Verbindung" data-zeile="neben">
        {z.lebensabschnitt === 'verbunden' ? (
          <div className={`vp-gu-verb ${z.zeile.verbindung.zustand}`}>
            <b><i aria-hidden="true" />{z.zeile.verbindung.text}</b>
            {z.zeile.verbindung.gesehen && <small>{z.zeile.verbindung.gesehen}</small>}
          </div>
        ) : z.lebensabschnitt === 'wartet' && z.erreichbar ? (
          <div className={`vp-gu-verb ${z.erreichbar.zustand}`} data-testid="geraete-wartet-erreichbar">
            <b><i aria-hidden="true" />{pendingErreichbarText(z.erreichbar)}</b>
            <small>{z.erreichbar.lastSeenText}</small>
          </div>
        ) : (
          <span className="vp-muted">{seitText(z, jetzt)}</span>
        )}
      </td>
      <td data-label="Software" data-zeile="neben">
        {z.lebensabschnitt === 'verbunden' && z.zeile.urteil ? (
          <Badge variant={z.zeile.urteil.ton === 'ok' ? 'ok' : z.zeile.urteil.ton === 'warn' || z.zeile.urteil.ton === 'fehler' ? 'warn' : 'off'} dot>
            {z.zeile.urteil.text}
          </Badge>
        ) : <span className="vp-muted vp-zeilen-nur-breit">–</span>}
      </td>
      <td data-label="Hinweis" data-zeile="neben">
        {z.lebensabschnitt === 'verbunden'
          ? (z.zeile.satz ? z.zeile.satz.map((t) => (typeof t === 'string' ? t : t.mono)).join('') : null)
          : <Badge variant={z.suspect ? 'warn' : 'off'} dot>{z.hinweis}</Badge>}
      </td>
      <td className="vp-gu-pfeil-zelle" data-zeile="aktion">
        <span className="vp-gu-zeile-aktionen" onClick={(e) => e.stopPropagation()}>
          {kandidat && (
            <RowMenu label={`Aktionen für ${ref}`} items={[
              { label: 'Box löschen', icon: 'trash', danger: true, onClick: () => onLoeschenAnfragen(kandidat) },
            ]} />
          )}
          <button type="button" className="vp-gu-pfeil" aria-label={`Geräteakte öffnen für ${ref}`}
            onClick={(e) => { e.stopPropagation(); onOpen(openRef); }}>
            <Icon name="chevron-right" size={18} />
          </button>
        </span>
      </td>
    </tr>
  );
}
