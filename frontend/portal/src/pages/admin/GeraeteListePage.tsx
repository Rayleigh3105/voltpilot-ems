import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Input } from '../../../designsystem/components/forms/Input';
import { VpPicker } from '../../components/VpPicker';
import { ApiError } from '../../api';
import { adminApi, type AdminDeviceRow } from '../../admin/adminApi';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { Blende } from '../../components/Lazy';
import { AdminPageHead } from './AdminPageHead';
import { normalizeDeviceIdInput } from '../../anlageFlow';
import { fmtRelative } from '../../format';
import {
  filterGeraeteListe, geraeteListeLinien, geraeteListeZeilen, listeChipZahlen,
  LEERER_LISTE_FILTER, type GeraeteListeZeile, type ListeFilter,
} from '../../geraeteListe';
import { useFreshnessPoll } from '../../useFreshnessPoll';
import { LIST_POLL_MS } from '../../pollCadence';
import { BoxArtChip } from './BoxArtChip';
import { parseGeraeteListeFilter } from '../../nav';
import './BoxVersions.css';
import './GeraeteUpdates.css';

/**
 * Die GERÄTE-LISTE (§4.4, Scheibe S2): eine Zeile je Box in jedem
 * Lebensabschnitt. Sie ersetzt die Registrierungs-Seite und die Boxenliste
 * von „Plattform › Software" - eine Zeile führt in die Geräteakte, nie in
 * ein zweites Fenster.
 */
export function GeraeteListePage({ onOpen }: { onOpen: (ref: string) => void }) {
  const [state, setState] = useState<{
    fleet: AdminDeviceRow[] | null;
    zeilen: GeraeteListeZeile[];
  }>({ fleet: null, zeilen: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filter, setFilter] = useState<ListeFilter>(
    () => ({ ...LEERER_LISTE_FILTER, chip: (parseGeraeteListeFilter(window.location.hash) as ListeFilter['chip']) ?? null }),
  );
  const [jetzt, setJetzt] = useState(() => new Date());

  async function reload() {
    setError(null);
    const [edgeUpdates, devices, pending, werkstatt] = await Promise.allSettled([
      adminApi.edgeUpdates(), adminApi.listDevices(), adminApi.listPendingEnrollments(), adminApi.werkstattBoxen(),
    ]);
    if (edgeUpdates.status === 'rejected' && devices.status === 'rejected') {
      setLoadError('Das Geräte-Inventar ist gerade nicht abrufbar. Bitte erneut versuchen.');
      setLoading(false);
      return;
    }
    setLoadError(null);
    const now = new Date();
    setJetzt(now);
    setState({
      fleet: devices.status === 'fulfilled' ? devices.value : null,
      zeilen: geraeteListeZeilen({
        fleet: edgeUpdates.status === 'fulfilled' ? edgeUpdates.value.fleet : [],
        devices: devices.status === 'fulfilled' ? devices.value : [],
        pending: pending.status === 'fulfilled' ? pending.value : [],
        werkstattBoxen: werkstatt.status === 'fulfilled' ? werkstatt.value : [],
      }, now),
    });
    setLoading(false);
  }

  useEffect(() => {
    void reload();
  }, []);
  useFreshnessPoll(() => void reload(), LIST_POLL_MS, !loading && loadError == null);

  async function registrieren(externalRef: string, kind: string, note: string) {
    await adminApi.provisionDevice({ externalRef, kind, note: note.trim() || undefined });
    await reload();
  }

  const registerButton = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setAddOpen((v) => !v)}>
      Geräte-ID registrieren
    </Button>
  );

  return (
    <>
      <AdminPageHead
        icon="cpu"
        category="primary"
        title="Geräte"
        description="Jede Box in jedem Lebensabschnitt: gedruckt, meldet sich, in der Werkstatt, beim Kunden."
        actions={registerButton}
      />

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {addOpen && (
        <RegistrierZeile
          onAbbrechen={() => setAddOpen(false)}
          onRegistrieren={async (ref, kind, note) => {
            await registrieren(ref, kind, note);
            setAddOpen(false);
          }}
        />
      )}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void reload()} />
      ) : (
        <Blende laedt={loading} skelett={<Card style={{ padding: 0, overflow: 'hidden' }}><TableSkeleton rows={5} cols={6} /></Card>}>
          <GeraeteTabelle zeilen={state.zeilen} jetzt={jetzt} filter={filter} onFilter={setFilter} onOpen={onOpen} />
        </Blende>
      )}
    </>
  );
}

function GeraeteTabelle({ zeilen, jetzt, filter, onFilter, onOpen }: {
  zeilen: GeraeteListeZeile[];
  jetzt: Date;
  filter: ListeFilter;
  onFilter: (f: ListeFilter) => void;
  onOpen: (ref: string) => void;
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
        {chips.length > 0 && (
          <div className="vp-seg vp-row-gap" role="group" aria-label="Geräte filtern" style={{ flexWrap: 'wrap' }}>
            {chips.map((c) => (
              <button key={c.chip} type="button" aria-pressed={filter.chip === c.chip}
                className={filter.chip === c.chip ? 'an' : undefined}
                onClick={() => onFilter({ ...filter, chip: filter.chip === c.chip ? null : c.chip })}>
                {c.label} {c.n}
              </button>
            ))}
          </div>
        )}
        <div className="vp-seg" role="group" aria-label="Geräte nach Linie filtern" style={{ marginTop: 8 }}>
          {linien.map((l) => (
            <button key={l.wert} type="button" aria-pressed={filter.linie === l.wert}
              className={filter.linie === l.wert ? 'an' : undefined}
              onClick={() => onFilter({ ...filter, linie: l.wert })}>
              {l.label} {l.n}
            </button>
          ))}
        </div>
        <label className="vp-gu-such" style={{ marginTop: 8 }}>
          <Icon name="search" size={15} />
          <span className="vp-sr-only">Geräte durchsuchen</span>
          <input type="search" value={filter.suche} placeholder="Box, Kunde, Anlage, Referenz"
            onChange={(e) => onFilter({ ...filter, suche: e.target.value })} />
        </label>
      </div>
      {sichtbar.length === 0 ? (
        <EmptyState icon="list" category="primary" title="Keine Box passt zu diesem Filter"
          action={<Button variant="outline" onClick={() => onFilter(LEERER_LISTE_FILTER)}>Filter zurücksetzen</Button>} />
      ) : (
        <div className="vp-table-scroll">
          <table className="vp-table responsive" data-testid="geraete-liste">
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
              {sichtbar.map((z) => <GeraeteZeile key={z.lebensabschnitt === 'verbunden' ? z.zeile.ref : z.ref} z={z} jetzt={jetzt} onOpen={onOpen} />)}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const LEBENSABSCHNITT_LABEL: Record<GeraeteListeZeile['lebensabschnitt'], string> = {
  gedruckt: 'Gedruckt', wartet: 'Meldet sich', werkstatt: 'Werkstatt', verbunden: 'Beim Kunden',
};

function GeraeteZeile({ z, jetzt, onOpen }: { z: GeraeteListeZeile; jetzt: Date; onOpen: (ref: string) => void }) {
  const ref = z.lebensabschnitt === 'verbunden' ? z.zeile.ref : z.ref;
  const openRef = z.lebensabschnitt === 'verbunden' ? z.zeile.row.externalRef : z.ref;
  return (
    <tr className="vp-row-click" onClick={() => onOpen(openRef)} title="Geräteakte öffnen">
      <td data-label="Box">
        <span className="vp-cell-main">
          <button type="button" className="vp-linklike" onClick={(e) => { e.stopPropagation(); onOpen(openRef); }}>
            {z.lebensabschnitt === 'verbunden' ? z.zeile.name : z.name}
          </button>
          <span className="vp-cell-sub vp-mono">{ref}</span>
          {z.lebensabschnitt === 'verbunden' && <span className="vp-box-art"><BoxArtChip boxArt={z.zeile.row.boxArt} /></span>}
        </span>
      </td>
      <td data-label="Kunde und Anlage">
        {z.lebensabschnitt === 'verbunden' ? z.zeile.ort : <span className="vp-muted">{LEBENSABSCHNITT_LABEL[z.lebensabschnitt]}</span>}
      </td>
      <td data-label="Verbindung">
        {z.lebensabschnitt === 'verbunden' ? (
          <div className={`vp-gu-verb ${z.zeile.verbindung.zustand}`}>
            <b><i aria-hidden="true" />{z.zeile.verbindung.text}</b>
            {z.zeile.verbindung.gesehen && <small>{z.zeile.verbindung.gesehen}</small>}
          </div>
        ) : (
          <span className="vp-muted">{z.seit ? fmtRelative(z.seit, jetzt) : '–'}</span>
        )}
      </td>
      <td data-label="Software">
        {z.lebensabschnitt === 'verbunden' && z.zeile.urteil ? (
          <Badge variant={z.zeile.urteil.ton === 'ok' ? 'ok' : z.zeile.urteil.ton === 'warn' || z.zeile.urteil.ton === 'fehler' ? 'warn' : 'off'} dot>
            {z.zeile.urteil.text}
          </Badge>
        ) : <span className="vp-muted">–</span>}
      </td>
      <td data-label="Hinweis">
        {z.lebensabschnitt === 'verbunden'
          ? (z.zeile.satz ? z.zeile.satz.map((t) => (typeof t === 'string' ? t : t.mono)).join('') : null)
          : <Badge variant={z.suspect ? 'warn' : 'off'} dot>{z.hinweis}</Badge>}
      </td>
      <td className="vp-gu-pfeil-zelle">
        <button type="button" className="vp-gu-pfeil" aria-label={`Geräteakte öffnen für ${ref}`}
          onClick={(e) => { e.stopPropagation(); onOpen(openRef); }}>
          <Icon name="chevron-right" size={18} />
        </button>
      </td>
    </tr>
  );
}

/** „Geräte-ID registrieren" als Eingabezeile - kein Fenster (E1 = A). */
function RegistrierZeile({ onRegistrieren, onAbbrechen }: {
  onRegistrieren: (externalRef: string, kind: string, note: string) => Promise<void>;
  onAbbrechen: () => void;
}) {
  const [externalRef, setExternalRef] = useState('');
  const [kind, setKind] = useState('inverter');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = /^vp-/i.test(externalRef.trim());

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRegistrieren(externalRef.trim(), kind, note);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Geräte-ID. Sie muss mit VP- beginnen (Aufkleber-Format).'
          : 'Das Registrieren hat nicht geklappt. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="md" radius="lg" data-testid="geraete-registrier-zeile">
      <div className="vp-form-stack">
        <Input
          label="Geräte-ID *"
          placeholder="z. B. VP-1234-ABCD"
          value={externalRef}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setExternalRef(normalizeDeviceIdInput(e.target.value))}
        />
        <VpPicker
          id="geraete-liste-kind"
          label="Typ"
          options={[
            { value: 'inverter', label: 'Wechselrichter' },
            { value: 'battery', label: 'Batteriespeicher' },
            { value: 'meter', label: 'Zähler' },
          ]}
          value={kind}
          onChange={setKind}
        />
        <Input label="Notiz" placeholder="z. B. Charge 2026-07" value={note}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)} />
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div className="vp-row-gap" style={{ marginTop: 12 }}>
        <Button variant="primary" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? 'Registriere…' : 'Registrieren'}
        </Button>
        <Button variant="ghost" onClick={onAbbrechen}>Abbrechen</Button>
      </div>
    </Card>
  );
}
