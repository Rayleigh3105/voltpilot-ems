import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  deviceLiveStatus,
  type DatenquelleBudgetFehler,
  type Device,
  type UemsDatenquelle,
  type UemsDatenquellePruefergebnis,
} from '../api';
import { geplanterWechsel, wechselFolgen } from '../boxDialoge';
import { budgetAblehnungAnzeige } from '../uemsDatenquelle';
import { ortszeit, lesen, type ZeitpunktEingabe } from '../picker/zeitpunkt';
import { useRollen } from '../rollen';
import { zeitText } from '../uemsEreignis';
import { VORGABE_ZEITZONE } from '../uemsZustand';
import { VpPicker } from './VpPicker';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import { pruefungText } from '../datenquelle';
import './DatenquelleAnlegen.css';

type Schritt = 'wahl' | 'folgen' | 'erledigt' | 'ruecknahme';

export function DatenquelleWechselDialog({ quelle, devices, onClose, onChanged }: {
  quelle: UemsDatenquelle;
  devices: readonly Device[];
  onClose: () => void;
  onChanged: (quelle: UemsDatenquelle) => void;
}) {
  const rollen = useRollen();
  const [zone, setZone] = useState(VORGABE_ZEITZONE);
  const [anlagen, setAnlagen] = useState<Set<string>>(() => new Set([quelle.anlage]));
  const [boxId, setBoxId] = useState<string | null>(null);
  const [art, setArt] = useState<'jetzt' | 'geplant'>('jetzt');
  const [zeit, setZeit] = useState<ZeitpunktEingabe>(() => ortszeit(Date.now() + 60_000, VORGABE_ZEITZONE));
  const [unit, setUnit] = useState(String(quelle.geraete_ids[0] ?? 1));
  const [register, setRegister] = useState(quelle.protokoll === 'sunspec_modbus' ? '40000' : '0');
  const [pruefung, setPruefung] = useState<UemsDatenquellePruefergebnis | null>(null);
  const [budget, setBudget] = useState<DatenquelleBudgetFehler | null>(null);
  const [schritt, setSchritt] = useState<Schritt>('wahl');
  const [abschluss, setAbschluss] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    void api.standorte().then((liste) => {
      if (!aktiv) return;
      const standort = liste.standorte.find((s) => s.anlagen.some((a) => a.id === quelle.anlage));
      if (standort) {
        setZone(standort.zeitzone);
        setAnlagen(new Set(standort.anlagen.map((a) => a.id)));
        setZeit(ortszeit(Date.now() + 60_000, standort.zeitzone));
      }
    }).catch(() => {});
    return () => { aktiv = false; };
  }, [quelle.anlage]);

  const boxen = useMemo(() => devices
    .filter((d) => anlagen.has(d.siteId) && d.id !== quelle.zustaendige_box?.id && d.status !== 'ausgebaut' && d.status !== 'retired')
    .sort((a, b) => (a.name || a.externalRef).localeCompare(b.name || b.externalRef, 'de')),
  [devices, anlagen, quelle.zustaendige_box?.id]);
  const box = boxen.find((b) => b.id === boxId) ?? null;
  const zeitpunkt = art === 'jetzt' ? undefined : lesen(zeit, zone).wert ?? undefined;
  const plan = geplanterWechsel(quelle);
  const darf = rollen.darf('datenquelle.zustaendigkeit');

  useEffect(() => {
    if (!boxId && boxen[0]) setBoxId(boxen[0].id);
  }, [boxId, boxen]);

  const reset = () => { setPruefung(null); setBudget(null); setFehler(null); setSchritt('wahl'); };

  async function pruefen() {
    if (!box || !Number.isInteger(Number(unit)) || !Number.isInteger(Number(register))) {
      setFehler('Bitte geben Sie Geräte-ID und Prüfregister als ganze Zahlen an.'); return;
    }
    setBusy(true); setFehler(null); setPruefung(null);
    try {
      setPruefung(await api.datenquellePruefen(quelle.anlage, quelle.id, {
        device_id: box.id, unit_id: Number(unit), register: Number(register),
      }));
    } catch (e) { setFehler(e instanceof Error ? e.message : 'Die Prüfung konnte nicht ausgeführt werden.'); }
    finally { setBusy(false); }
  }

  async function speichern() {
    if (!box || !darf || pruefung?.ergebnis !== 'ok') return;
    setBusy(true); setFehler(null); setBudget(null);
    try {
      const antwort = await api.datenquelleZuweisen(quelle.anlage, quelle.id, {
        device_id: box.id, effective_from: zeitpunkt,
      });
      onChanged(antwort.datenquelle);
      setAbschluss(art === 'geplant' ? 'Der Wechsel ist geplant.' : 'Der Wechsel ist eingetragen.');
      setSchritt('erledigt');
    } catch (e) {
      const b = e instanceof ApiError && e.status === 422 ? e.body as DatenquelleBudgetFehler : null;
      if (b?.code === 'budget_ueberschritten') { setBudget(b); setSchritt('wahl'); }
      else setFehler(e instanceof Error ? e.message : 'Der Wechsel konnte nicht eingetragen werden.');
    } finally { setBusy(false); }
  }

  async function zuruecknehmen() {
    if (!plan?.id || !darf) return;
    setBusy(true); setFehler(null);
    try {
      const neu = await api.datenquelleZuweisungZuruecknehmen(quelle.anlage, quelle.id, plan.id);
      onChanged(neu); setAbschluss('Der geplante Wechsel wurde zurückgenommen.'); setSchritt('erledigt');
    } catch (e) {
      const body = e instanceof ApiError ? e.body as { satz?: string } | undefined : undefined;
      setFehler(body?.satz || (e instanceof Error ? e.message : 'Die Rücknahme ist fehlgeschlagen.'));
    } finally { setBusy(false); }
  }

  const budgetText = budgetAblehnungAnzeige(budget);
  const folgen = box ? wechselFolgen(quelle, box,
    art === 'jetzt' ? 'Ab jetzt' : `Ab ${zeitpunkt ? zeitText(zeitpunkt, zone) : 'dem gewählten Zeitpunkt'}`) : [];
  const footer = schritt === 'erledigt' ? <Button onClick={onClose}>Schließen</Button>
    : schritt === 'folgen' ? <><Button variant="ghost" disabled={busy} onClick={() => setSchritt('wahl')}>Zurück</Button>
      <Button disabled={busy || !darf} onClick={() => void speichern()}>{busy ? 'Wird eingetragen …' : 'Wechsel bestätigen'}</Button></>
    : schritt === 'ruecknahme' ? <><Button variant="ghost" disabled={busy} onClick={() => setSchritt('wahl')}>Zurück</Button>
      <Button disabled={busy || !darf} onClick={() => void zuruecknehmen()}>{busy ? 'Wird zurückgenommen …' : 'Rücknahme bestätigen'}</Button></>
    : <><Button variant="ghost" onClick={onClose}>Abbrechen</Button>
      <Button variant="outline" disabled={busy || !box} onClick={() => void pruefen()}>{busy ? 'Wird geprüft …' : `Von ${box?.name || box?.externalRef || 'Box'} prüfen`}</Button>
      <Button disabled={pruefung?.ergebnis !== 'ok' || !zeitpunkt && art === 'geplant' || !darf} onClick={() => setSchritt('folgen')}>Folgen prüfen</Button></>;

  return <Modal open title={schritt === 'erledigt' ? 'Zuständigkeit aktualisiert' : 'Zuständige Box wechseln'} onClose={onClose} footer={footer}>
    <div className="vp-dqa">
      {schritt === 'erledigt' ? <div className="vp-alert vp-alert-ok" role="status">
        {abschluss}
      </div> : schritt === 'folgen' ? <section className="vp-dqa-folgen" aria-label="Folgen des Wechsels">
        <h3>Was danach gilt</h3><ul>{folgen.map((s) => <li key={s}>{s}</li>)}</ul>
        <p>Messwerte, Zuordnungen und bisherige Verläufe bleiben unverändert.</p>
      </section> : schritt === 'ruecknahme' && plan ? <section className="vp-dqa-folgen" aria-label="Folgen der Rücknahme">
        <h3>Geplanten Wechsel zurücknehmen?</h3>
        <p>{plan.box.name ?? 'Die gewählte Box'} übernimmt am {zeitText(plan.effective_from, zone)} nicht.</p>
        <p>{quelle.zustaendige_box?.name ?? 'Die bisherige Box'} bleibt zuständig. Der Eintrag bleibt im Protokoll als „zurückgenommen“ erhalten.</p>
      </section> : <>
        {plan?.id && <section className="vp-dqa-folgen" aria-label="Geplanter Wechsel">
          <h3>Geplanter Wechsel</h3><p>Ab {zeitText(plan.effective_from, zone)} liest {plan.box.name ?? 'die neue Box'}.</p>
          <Button variant="outline" onClick={() => setSchritt('ruecknahme')}>Geplanten Wechsel zurücknehmen</Button>
        </section>}
        <VpPicker label="Neue zuständige Box" value={boxId} options={boxen.map((b) => ({
          value: b.id,
          label: b.name || b.externalRef,
          description: `${deviceLiveStatus(b) === 'online' ? 'Verbunden' : 'Meldet sich nicht'} · Lesebudget wird beim Bestätigen geprüft`,
        }))} onChange={(id) => { setBoxId(id); reset(); }} />
        {boxen.length === 0 && <p className="vp-alert vp-alert-info">An diesem Standort ist keine weitere Box verfügbar.</p>}
        <fieldset className="vp-dqa-boxen"><legend>Zeitpunkt</legend>
          <label className="vp-dqa-box"><input type="radio" checked={art === 'jetzt'} onChange={() => { setArt('jetzt'); reset(); }} />Jetzt</label>
          <label className="vp-dqa-box"><input type="radio" checked={art === 'geplant'} onChange={() => { setArt('geplant'); reset(); }} />Geplant</label>
        </fieldset>
        {art === 'geplant' && <VpZeitpunktPicker value={zeit} zone={zone} onChange={(v) => { setZeit(v); reset(); }} disabled={busy} />}
        <div className="vp-dqa-felder"><Input label="Geräte-ID" value={unit} inputMode="numeric" onChange={(e) => { setUnit(e.target.value); reset(); }} />
          <Input label="Prüfregister" value={register} inputMode="numeric" onChange={(e) => { setRegister(e.target.value); reset(); }} /></div>
        {pruefung && <p className={`vp-dqa-pruefung ${pruefung.ergebnis === 'ok' ? 'ist-ok' : 'ist-fehler'}`} role="status">
          <strong>Prüfung von {pruefung.box.name ?? 'der Box'}:</strong> {pruefungText(pruefung)}</p>}
        <section className="vp-dqa-folgen" aria-label="Lesebudget"><h3>Lesebudget</h3>
          {budgetText ? <><p>{budgetText.quelle}</p><p>{budgetText.anfragen}</p><p>{budgetText.box}</p>
            <ul>{budgetText.auswege.map((s) => <li key={s}>{s}</li>)}</ul></> : <p>Das Lesebudget der neuen Box wird vor dem Eintragen geprüft. Bei einer Überschreitung bleibt die bisherige Zuständigkeit unverändert.</p>}
        </section>
      </>}
      {!darf && <p role="note">{rollen.grund}</p>}
      {fehler && <p className="vp-dqa-fehler" role="alert">{fehler}</p>}
    </div>
  </Modal>;
}
