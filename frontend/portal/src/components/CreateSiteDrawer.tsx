import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { ApiError, type CreateSiteInput, type PlantKind, type Site, type TarifArt } from '../api';
import { VERAEUSSERUNGSFORM_FRAGE, VERAEUSSERUNGSFORM_LABEL } from '../glossar';
import { parsePremiumInput } from '../fleet';
import { LocationMap } from './LocationMap';
import { TariffFields } from './TariffFields';

/**
 * "Anlage anlegen" as a plain single-form drawer. Since the one-flow
 * "Anlage anlegen" (components/AnlageFlow.tsx) took over every customer
 * entry point, this remains ONLY for the admin Mandanten page, whose create
 * call goes through the cross-tenant admin API via `onCreate`
 * (POST /api/v1/admin/tenants/{id}/sites - tenant from the route).
 */
export function CreateSiteDrawer({
  open,
  onClose,
  onCreate,
  onCreated,
  contextNote,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateSiteInput) => Promise<Site>;
  onCreated: (site: Site) => void;
  /** Optional context line, e.g. which tenant the site is created for. */
  contextNote?: string;
}) {
  const [name, setName] = useState('');
  const [biddingZone, setBiddingZone] = useState('DE-LU');
  const [plantKind, setPlantKind] = useState<PlantKind>('eigenverbrauch');
  const [netzladen, setNetzladen] = useState(false);
  const [praemie, setPraemie] = useState('');
  const [tarifArt, setTarifArt] = useState<TarifArt>('ohne');
  const [tarifParam, setTarifParam] = useState('');
  const [lat, setLat] = useState<number | null>(null);
  const [lon, setLon] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setLat(null);
    setLon(null);
    setBiddingZone('DE-LU');
    setPlantKind('eigenverbrauch');
    setNetzladen(false);
    setPraemie('');
    setTarifArt('ohne');
    setTarifParam('');
    setError(null);
  }

  async function submit() {
    if (!name.trim()) return;
    const praemieValue = plantKind === 'direktvermarktung' ? parsePremiumInput(praemie) : null;
    if (praemieValue === undefined) {
      setError('Bitte geben Sie den anzulegenden Wert als Zahl in ct/kWh an, z. B. 8,11.');
      return;
    }
    const tarifParamValue = tarifArt === 'ohne' ? null : parsePremiumInput(tarifParam);
    if (tarifParamValue === undefined) {
      setError(
        tarifArt === 'dynamisch'
          ? 'Bitte geben Sie den Aufschlag als Zahl in ct/kWh an, z. B. 18.'
          : 'Bitte geben Sie Ihren Arbeitspreis als Zahl in ct/kWh an, z. B. 32,5.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const site = await onCreate({
        name: name.trim(),
        biddingZone,
        latitude: lat,
        longitude: lon,
        plantKind,
        anzulegenderWertCtKwh: praemieValue,
        tarifArt,
        tarifParamCtKwh: tarifParamValue,
        netzladenErlaubt: netzladen,
      });
      reset();
      onCreated(site);
      onClose();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie Name und Koordinaten.'
          : 'Die Anlage konnte nicht angelegt werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Anlage anlegen"
      icon={
        <IconTile category="home" size={40}>
          <Icon name="map-pin" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Wird angelegt…' : 'Anlage anlegen'}
          </Button>
        </>
      }
    >
      {contextNote && <p className="vp-note" style={{ marginTop: 0 }}>{contextNote}</p>}
      <div className="vp-form-stack">
        <Input
          label="Name *"
          placeholder="z. B. Werk Nord"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="site-zone" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Gebotszone
          </label>
          <select
            id="site-zone"
            className="vp-select"
            value={biddingZone}
            onChange={(e) => setBiddingZone(e.target.value)}
          >
            <option value="DE-LU">DE-LU (Deutschland/Luxemburg)</option>
            <option value="AT">AT (Österreich)</option>
            <option value="CH">CH (Schweiz)</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="site-plant-kind" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            {VERAEUSSERUNGSFORM_LABEL}
          </label>
          <select
            id="site-plant-kind"
            className="vp-select"
            value={plantKind}
            onChange={(e) => setPlantKind(e.target.value as PlantKind)}
          >
            <option value="eigenverbrauch">Eigenverbrauch (Haushalt/Gewerbe)</option>
            <option value="direktvermarktung">Direktvermarktung (Einspeisung am Markt)</option>
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            {VERAEUSSERUNGSFORM_FRAGE} Sie bestimmt auch, wie Ihr Vorteil erzählt wird:
            „gespart" beim Eigenverbrauch, „mehr verdient" bei der Direktvermarktung.
          </p>
        </div>
        {plantKind === 'direktvermarktung' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <Input
              label="Anzulegender Wert (ct/kWh)"
              placeholder="z. B. 8,11"
              inputMode="decimal"
              value={praemie}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPraemie(e.target.value)}
            />
            <p className="vp-note" style={{ margin: 0 }}>
              Steht in Ihrem EEG-Zuschlag bzw. Direktvermarktungsvertrag. Optional -
              wenn angegeben, rechnen wir Ihre Marktprämie (anzulegender Wert minus
              Monatsmarktwert Solar) in Ihren Mehrerlös ein; bei negativen
              Börsenpreisen entfällt sie.
            </p>
          </div>
        )}
        <TariffFields
          tarifArt={tarifArt}
          onTarifArt={setTarifArt}
          param={tarifParam}
          onParam={setTarifParam}
          idPrefix="create-site"
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="site-netzladen" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Netzladen des Speichers
          </label>
          <select
            id="site-netzladen"
            className="vp-select"
            value={netzladen ? 'erlaubt' : 'verboten'}
            onChange={(e) => setNetzladen(e.target.value === 'erlaubt')}
          >
            <option value="verboten">Verboten - EEG-Anlage (nur Solarladen)</option>
            <option value="erlaubt">Erlaubt - Speicher darf aus dem Netz laden</option>
          </select>
          <p className="vp-note" style={{ margin: 0 }}>
            EEG-geförderte Anlagen dürfen ihren Speicher nicht aus dem Netz laden
            (Ausschließlichkeitsprinzip). Nur aktivieren, wenn Ihre Anlage keine
            EEG-Vergütung bezieht.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label style={{ fontSize: '0.9rem', fontWeight: 600 }}>Standort auf der Karte</label>
          <LocationMap
            lat={lat}
            lon={lon}
            onChange={(la, lo) => {
              setLat(la);
              setLon(lo);
            }}
          />
          <p className="vp-note" style={{ margin: 0 }}>
            Setzen Sie den Pin auf Ihren Standort - nötig für die Wettervorhersage. Optional.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
    </Drawer>
  );
}
