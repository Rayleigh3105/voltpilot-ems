import { useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { api, ApiError, type MastrPreview, type Site, type SiteAsset } from '../api';
import {
  buildMastrApply,
  mastrLocationLabel,
  normalizeSeeNummer,
  pickStorageNumber,
  validateSeeNummer,
} from '../anlageFlow';
import { registerortWarnung } from '../anlageBestaetigen';
import { fmtNum } from '../format';
import { Recht } from './Recht';

/**
 * „Aus dem Register holen“ - die MaStR-Nummer als Hilfe in Schritt 3, nicht als eigener Schritt
 * (Anlage-Flow a1, R4). Der Kunde gibt die Nummer seiner PV-Anlage ein (der verknüpfte Speicher kommt mit),
 * sieht EINE Vorschau und übernimmt Leistung, Module, Ausrichtung und Speicher in einem Zug
 * (`mastr-apply`). Der Ort aus dem Register wird gegen die Adresse der Anlage geprüft: passt er nicht,
 * sagt der Satz, was nicht passt, und „Andere Nummer“ führt zurück.
 */
export function RegisterHolen({
  site,
  plz,
  ort,
  onUebernommen,
  onZurueck,
}: {
  site: Site;
  /** Postleitzahl und Ort der Anlage aus Schritt 1 - `null`, wenn unbekannt (dann fragt die Zeile nur). */
  plz: string | null;
  ort: string | null;
  onUebernommen: (assets: SiteAsset[]) => void;
  onZurueck: () => void;
}) {
  const [mode, setMode] = useState<'enter' | 'preview'>('enter');
  const [pvNummer, setPvNummer] = useState('');
  const [storageNummer, setStorageNummer] = useState('');
  const [storageAutoFilled, setStorageAutoFilled] = useState(false);
  const [previews, setPreviews] = useState<MastrPreview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [abgeschickt, setAbgeschickt] = useState(false);

  const pvHint = validateSeeNummer(pvNummer);
  const storageHint = validateSeeNummer(storageNummer);
  const leer = pvNummer.trim() === '' && storageNummer.trim() === '';

  const pvPreview = previews?.find((p) => p.kind === 'pv') ?? null;
  const storagePreview = previews?.find((p) => p.kind === 'storage') ?? null;

  async function lookup() {
    if (busy) return;
    setAbgeschickt(true);
    if (pvHint || storageHint || leer) {
      document.getElementById(pvHint || leer ? 'register-pv' : 'register-speicher')?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const found: MastrPreview[] = [];
      let pv: MastrPreview | null = null;
      const pvNorm = normalizeSeeNummer(pvNummer);
      if (pvNorm) {
        pv = await api.mastrLookup(site.id, pvNorm);
        found.push(pv);
      }
      // Den verknüpften Speicher übernehmen, wenn das Feld leer ist.
      const storage = pickStorageNumber(pv, storageNummer);
      if (storage) {
        found.push(await api.mastrLookup(site.id, storage.number));
        if (storage.autoFilled) {
          setStorageNummer(storage.number);
          setStorageAutoFilled(true);
        }
      }
      const kinds = found.map((p) => p.kind);
      if (new Set(kinds).size !== kinds.length) {
        setError(
          'Beide Nummern gehören zur gleichen Einheitenart. Bitte geben Sie die SEE-Nummer der PV-Anlage und - falls vorhanden - die des Speichers an.',
        );
        return;
      }
      setPreviews(found);
      setMode('preview');
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'Die Registerabfrage ist gerade nicht erreichbar. Bitte versuchen Sie es gleich noch einmal.',
      );
      document.getElementById('register-pv')?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!previews || busy) return;
    setBusy(true);
    setError(null);
    try {
      onUebernommen(await api.mastrApply(site.id, buildMastrApply(previews)));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Die Daten konnten nicht übernommen werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'preview' && previews) {
    return (
      <div className="vp-register-holen">
        <h4 className="vp-onb-block-title">Im Register gefunden</h4>
        <p className="vp-muted" style={{ marginTop: 0 }}>Bitte kurz prüfen - erst dann speichern wir die Werte.</p>
        {pvPreview && <MastrPreviewCard preview={pvPreview} plz={plz} ort={ort} />}
        {storagePreview && <MastrPreviewCard preview={storagePreview} linked={storageAutoFilled} plz={plz} ort={ort} />}
        <p className="vp-note">Datenquelle: Marktstammdatenregister der Bundesnetzagentur (dl-de/by-2-0).</p>
        {error && <div className="vp-alert vp-alert-err" role="alert">{error}</div>}
        <Recht aktion="anlage.verwalten">
          <Button variant="primary" fullWidth onClick={apply} disabled={busy} style={{ marginTop: 8 }}>
            {busy ? 'Wird übernommen…' : 'Übernehmen'}
          </Button>
        </Recht>
        <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
          <button
            type="button"
            className="vp-linklike"
            onClick={() => {
              setMode('enter');
              setError(null);
            }}
          >
            Andere Nummer
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="vp-register-holen">
      <h4 className="vp-onb-block-title">Aus dem Register holen</h4>
      <p className="vp-muted" style={{ marginTop: 0 }}>
        Mit der MaStR-Nummer Ihrer PV-Anlage holen wir Leistung, Modulzahl und Ausrichtung - den verknüpften
        Speicher erkennen wir mit.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
        <Input
          id="register-pv"
          label="MaStR-Nummer der PV-Anlage"
          placeholder="z. B. SEE966831669444"
          value={pvNummer}
          error={pvHint ?? (abgeschickt && leer ? 'Bitte geben Sie eine MaStR-Nummer ein.' : null)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setPvNummer(e.target.value);
            setError(null);
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') void lookup();
          }}
        />
        <Input
          id="register-speicher"
          label="MaStR-Nummer des Speichers (optional)"
          placeholder="z. B. SEE972142227037"
          value={storageNummer}
          error={storageHint}
          hint={storageAutoFilled ? 'Verknüpft - automatisch aus der PV-Anlage übernommen.' : 'Ist der Speicher verknüpft, finden wir ihn selbst.'}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setStorageNummer(e.target.value);
            setStorageAutoFilled(false);
            setError(null);
          }}
        />
      </div>
      {error && <div className="vp-alert vp-alert-err" role="alert">{error}</div>}
      <Button variant="primary" fullWidth onClick={lookup} disabled={busy} style={{ marginTop: 16 }}>
        <Icon name="search" size={17} style={{ marginRight: 8, verticalAlign: '-3px' }} />
        {busy ? 'Suche im Register…' : 'Im Register suchen'}
      </Button>
      <p className="vp-note" style={{ marginTop: 8, textAlign: 'center' }}>
        <button type="button" className="vp-linklike" onClick={onZurueck}>
          Ohne Register weiter
        </button>
      </p>
    </div>
  );
}

/** Die Bestätigungskarte eines Registereintrags (PV oder Speicher). */
function MastrPreviewCard({
  preview,
  linked,
  plz,
  ort,
}: {
  preview: MastrPreview;
  linked?: boolean;
  plz: string | null;
  ort: string | null;
}) {
  const isPv = preview.kind === 'pv';
  const location = mastrLocationLabel(preview);
  const warnung = registerortWarnung(preview, plz, ort);
  return (
    <div className={`vp-mastr-card ${isPv ? 'vp-mastr-pv' : 'vp-mastr-storage'}`}>
      <div className="vp-mastr-card-head">
        <span className="vp-mastr-card-title">
          <Icon name={isPv ? 'sun' : 'battery'} size={16} />
          {isPv ? 'PV-Anlage' : 'Batteriespeicher'}
        </span>
        {linked && (
          <Badge variant="tint" dot>
            verknüpft
          </Badge>
        )}
        <span className="vp-mono vp-note vp-mastr-nr">{preview.mastrNummer}</span>
      </div>
      <dl className="vp-kv-list">
        {isPv ? (
          <>
            <KvRow k="Leistung" v={preview.powerKw != null ? fmtNum(preview.powerKw, 'kWp', 2) : null} />
            <KvRow k="Module" v={preview.moduleCount != null ? String(preview.moduleCount) : null} />
            <KvRow k="Ausrichtung" v={[preview.azimuthLabel, preview.tiltLabel].filter(Boolean).join(' · ') || null} />
            <KvRow k="In Betrieb seit" v={preview.commissionedOn} />
          </>
        ) : (
          <>
            <KvRow k="Kapazität" v={preview.storageCapacityKwh != null ? fmtNum(preview.storageCapacityKwh, 'kWh', 1) : null} />
            <KvRow k="Entladeleistung" v={preview.powerKw != null ? fmtNum(preview.powerKw, 'kW', 2) : null} />
            <KvRow k="Ladeleistung" v={preview.chargePowerKw != null ? fmtNum(preview.chargePowerKw, 'kW', 2) : null} />
            <KvRow k="Technologie" v={preview.batteryTechnology} />
          </>
        )}
      </dl>
      {warnung ? (
        <div className="vp-alert vp-alert-warn" role="status" style={{ marginBottom: 0, marginTop: 10 }}>
          {warnung}
        </div>
      ) : (
        location && (
          <p className="vp-mastr-plaus">
            <Icon name="map-pin" size={14} />
            <span>{plz ? `${location} - passt zu Ihrer Adresse` : `${location} - stimmt das?`}</span>
          </p>
        )
      )}
      {preview.warnings.map((w) => (
        <div key={w} className="vp-alert vp-alert-info" style={{ marginBottom: 0, marginTop: 10 }}>
          {w}
        </div>
      ))}
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string | null }) {
  return (
    <div className="vp-kv-row">
      <dt>{k}</dt>
      <dd>{v ?? <span className="vp-muted">nicht im Register</span>}</dd>
    </div>
  );
}
