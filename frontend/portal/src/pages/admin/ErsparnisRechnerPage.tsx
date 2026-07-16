/**
 * Plattform "Ersparnis-Rechner": prospect simulations for Vertrieb with
 * explicit inputs (address search instead of a site) - the operator
 * instrument for "was brächte VoltPilot dieser Anlage?". Stateless by
 * design (V1): nothing about the prospect is stored; the result lives in
 * the simulation service's job cache. Reuses the shared result view.
 */
import { useState } from 'react';
import { Card } from '../../../designsystem/components/core/Card';
import { Button } from '../../../designsystem/components/core/Button';
import { Icon } from '../../../designsystem/components/core/Icon';
import { Input } from '../../../designsystem/components/forms/Input';
import { adminApi } from '../../admin/adminApi';
import { LocationSearch, type GeoPlace } from '../../components/AnlageFlow';
import {
  SimulationRunView,
  useSimulationJob,
} from '../../components/SimulationView';
import type { SimulationRequestInput } from '../../simulation';
import { AdminPageHead } from './AdminPageHead';

export function ErsparnisRechnerPage() {
  const [place, setPlace] = useState<GeoPlace | null>(null);
  const [pvKwp, setPvKwp] = useState('10');
  const [annualKwh, setAnnualKwh] = useState('4500');
  const [capacityKwh, setCapacityKwh] = useState('10');
  const [tarifArt, setTarifArt] = useState('dynamisch');
  const [tarifParam, setTarifParam] = useState('17');
  const [plantKind, setPlantKind] = useState('eigenverbrauch');
  const [commissionedOn, setCommissionedOn] = useState('');
  const [netzladen, setNetzladen] = useState(false);
  const [speicherschonung, setSpeicherschonung] = useState('ausgewogen');
  const [formError, setFormError] = useState<string | null>(null);

  const job = useSimulationJob({
    start: (input) => adminApi.startProspectSimulation(input),
    poll: (id) => adminApi.prospectSimulationStatus(id),
  });

  const submit = () => {
    if (place == null) {
      setFormError('Bitte zuerst den Standort der Anlage suchen und auswählen.');
      return;
    }
    setFormError(null);
    const input: SimulationRequestInput = {
      plant: {
        pvKwp: num(pvKwp) ?? undefined,
        latitude: place.latitude,
        longitude: place.longitude,
      },
      consumption: { annualKwh: num(annualKwh) ?? undefined },
      tariff: {
        plantKind,
        tarifArt,
        tarifParamCtKwh: tarifArt === 'ohne' ? undefined : num(tarifParam) ?? undefined,
        commissionedOn: commissionedOn || undefined,
        netzladenErlaubt: netzladen,
      },
      battery: {
        capacityKwh: num(capacityKwh) ?? undefined,
        speicherschonung,
      },
    };
    void job.start(input);
  };

  return (
    <>
      <AdminPageHead
        icon="euro"
        category="primary"
        title="Ersparnis-Rechner"
        description="Simulation für Interessenten: ohne Speicher, mit Standard-Speicher und mit VoltPilot über das letzte volle Börsenjahr. Es wird nichts gespeichert."
      />
      <Card padding="lg" radius="lg" className="vp-sim-form-card">
        <div className="vp-form-stack">
          <LocationSearch selected={place} onSelect={setPlace} />
          <div className="vp-sim-form">
            <Input
              label="PV-Leistung (kWp)"
              inputMode="decimal"
              value={pvKwp}
              onChange={(e) => setPvKwp(e.target.value)}
            />
            <Input
              label="Jahresverbrauch (kWh)"
              inputMode="decimal"
              value={annualKwh}
              onChange={(e) => setAnnualKwh(e.target.value)}
            />
            <Input
              label="Speichergröße (kWh)"
              inputMode="decimal"
              value={capacityKwh}
              onChange={(e) => setCapacityKwh(e.target.value)}
            />
            <div>
              <label className="vp-select-label" htmlFor="sim-tarifart">
                Stromtarif
              </label>
              <select
                id="sim-tarifart"
                className="vp-select"
                value={tarifArt}
                onChange={(e) => setTarifArt(e.target.value)}
              >
                <option value="dynamisch">Dynamisch (Börsenpreis + Aufschlag)</option>
                <option value="fest">Fester Arbeitspreis</option>
                <option value="ohne">Spot ohne Aufschlag</option>
              </select>
            </div>
            {tarifArt !== 'ohne' && (
              <Input
                label={tarifArt === 'fest' ? 'Arbeitspreis (ct/kWh)' : 'Aufschlag (ct/kWh)'}
                inputMode="decimal"
                value={tarifParam}
                onChange={(e) => setTarifParam(e.target.value)}
              />
            )}
            <div>
              <label className="vp-select-label" htmlFor="sim-plantkind">
                Anlagentyp
              </label>
              <select
                id="sim-plantkind"
                className="vp-select"
                value={plantKind}
                onChange={(e) => setPlantKind(e.target.value)}
              >
                <option value="eigenverbrauch">Eigenverbrauch (EEG-Vergütung)</option>
                <option value="direktvermarktung">Direktvermarktung</option>
              </select>
            </div>
            <Input
              label="Inbetriebnahme (JJJJ-MM-TT)"
              value={commissionedOn}
              onChange={(e) => setCommissionedOn(e.target.value)}
              placeholder="optional"
              hint="Bestimmt die feste EEG-Vergütung."
            />
            <div>
              <label className="vp-select-label" htmlFor="sim-schonung">
                Umgang mit dem Speicher
              </label>
              <select
                id="sim-schonung"
                className="vp-select"
                value={speicherschonung}
                onChange={(e) => setSpeicherschonung(e.target.value)}
              >
                <option value="aggressiv">Aggressiv</option>
                <option value="ausgewogen">Ausgewogen</option>
                <option value="schonend">Schonend</option>
              </select>
            </div>
            <label className="vp-sim-check">
              <input
                type="checkbox"
                checked={netzladen}
                onChange={(e) => setNetzladen(e.target.checked)}
              />
              Netzladen erlaubt (keine EEG-Vergütung)
            </label>
          </div>
          {formError && <div className="vp-alert vp-alert-err">{formError}</div>}
          <div className="vp-sim-actions">
            <Button
              variant="primary"
              iconLeft={<Icon name="trending-up" size={18} />}
              disabled={job.busy}
              onClick={submit}
            >
              {job.busy ? 'Simulation läuft …' : 'Simulation starten'}
            </Button>
          </div>
        </div>
      </Card>
      <SimulationRunView status={job.status} error={job.error} />
    </>
  );
}

function num(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}
