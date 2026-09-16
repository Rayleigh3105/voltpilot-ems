import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type DatenquelleBudgetBox,
  type DatenquelleBudgetFehler,
  type Device,
  type EdgeVersion,
  type UemsDatenquelle,
  type UemsDatenquelleBearbeiten,
  type UemsDatenquellePruefergebnis,
} from '../api';
import { budgetAblehnungAnzeige, PROTOKOLLE, type Protokoll } from '../uemsDatenquelle';
import { datenquelleBoxen, folgenSaetze, pruefungText } from '../datenquelle';
import { Recht } from './Recht';
import { VpPicker } from './VpPicker';
import './DatenquelleAnlegen.css';

type Formular = {
  name: string;
  protokoll: Protokoll;
  adresse: string;
  netz: string;
  kadenz: string;
  geraeteId: string;
  register: string;
};

const START: Formular = {
  name: '', protokoll: 'modbus_tcp', adresse: '', netz: '', kadenz: '60', geraeteId: '1', register: '0',
};

export function DatenquelleAnlegen({
  anlage,
  standortId,
  anlagenAmStandort,
  onClose,
  onEingerichtet,
}: {
  anlage: { id: string; name: string };
  standortId: string;
  anlagenAmStandort: readonly string[];
  onClose: () => void;
  onEingerichtet?: (quelle: UemsDatenquelle) => void;
}) {
  const basis = `vp-dqa-${useId().replace(/:/g, '')}`;
  const [formular, setFormular] = useState<Formular>(START);
  const [geraete, setGeraete] = useState<Device[] | null>(null);
  const [versionen, setVersionen] = useState<EdgeVersion[]>([]);
  const [boxId, setBoxId] = useState<string | null>(null);
  const [budgets, setBudgets] = useState<DatenquelleBudgetBox[]>([]);
  const [quelle, setQuelle] = useState<UemsDatenquelle | null>(null);
  const [pruefung, setPruefung] = useState<UemsDatenquellePruefergebnis | null>(null);
  const [budgetFehler, setBudgetFehler] = useState<DatenquelleBudgetFehler | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let aktiv = true;
    Promise.all([api.listDevices(), api.edgeVersions()]).then(
      ([g, v]) => {
        if (!aktiv) return;
        setGeraete(g.eintraege);
        setVersionen(v.eintraege);
      },
      (e: unknown) => {
        if (aktiv) setFehler(e instanceof Error ? e.message : 'Die Boxen konnten nicht geladen werden.');
      },
    );
    return () => { aktiv = false; };
  }, []);

  const boxen = useMemo(
    () => datenquelleBoxen(geraete ?? [], versionen, anlagenAmStandort, budgets),
    [geraete, versionen, anlagenAmStandort, budgets],
  );
  useEffect(() => {
    if (!boxId && boxen.length) {
      const [ersteBox] = boxen;
      const heim = geraete?.find((g) => g.kind === 'edge' && g.siteId === anlage.id && boxen.some((b) => b.id === g.id));
      setBoxId(heim?.id ?? boxen.find((b) => b.verbunden === 'Verbunden')?.id ?? ersteBox.id);
    }
  }, [boxen, boxId, geraete, anlage.id]);
  const box = boxen.find((b) => b.id === boxId) ?? null;

  const bearbeitung = (): UemsDatenquelleBearbeiten => ({
    name: formular.name.trim(),
    protokoll: formular.protokoll,
    adresse: formular.adresse.trim(),
    geraete_ids: [Number(formular.geraeteId)],
    netz: formular.netz.trim(),
    mehrere_leser: false,
    steuerquelle: false,
    kadenz_s: Number(formular.kadenz),
  });

  function validieren(): string | null {
    if (!formular.name.trim()) return 'Geben Sie einen Namen ein.';
    if (!formular.adresse.trim()) return 'Geben Sie die Adresse ein.';
    if (!formular.netz.trim()) return 'Geben Sie die Netzlage aus dem Netzplan ein.';
    if (!boxId) return 'Wählen Sie eine Box.';
    if (!Number.isInteger(Number(formular.kadenz)) || Number(formular.kadenz) <= 0) return 'Der Takt muss eine positive Zahl in Sekunden sein.';
    if (!Number.isInteger(Number(formular.geraeteId)) || Number(formular.geraeteId) < 0) return 'Die Geräte-ID muss eine nicht negative ganze Zahl sein.';
    if (!Number.isInteger(Number(formular.register)) || Number(formular.register) < 0) return 'Das Prüfregister muss eine nicht negative ganze Zahl sein.';
    return null;
  }

  async function entwurfAnlegen(e: FormEvent) {
    e.preventDefault();
    const grund = validieren();
    if (grund) { setFehler(grund); return; }
    setBusy(true); setFehler(null); setBudgetFehler(null);
    try {
      const neu = await api.datenquelleAnlegen(anlage.id, { ...bearbeitung(), device_id: boxId! });
      setQuelle(neu);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Datenquelle konnte nicht angelegt werden.');
    } finally { setBusy(false); }
  }

  async function pruefen() {
    if (!quelle || !boxId) return;
    const grund = validieren();
    if (grund) { setFehler(grund); return; }
    setBusy(true); setFehler(null); setBudgetFehler(null); setPruefung(null);
    try {
      const gespeichert = await api.datenquelleBearbeiten(anlage.id, quelle.id, bearbeitung());
      setQuelle(gespeichert);
      setPruefung(await api.datenquellePruefen(anlage.id, quelle.id, {
        device_id: boxId,
        unit_id: Number(formular.geraeteId),
        register: Number(formular.register),
      }));
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Prüfung konnte nicht ausgeführt werden.');
    } finally { setBusy(false); }
  }

  async function abschliessen() {
    if (!quelle || !boxId || pruefung?.ergebnis !== 'ok') return;
    setBusy(true); setFehler(null); setBudgetFehler(null);
    try {
      const antwort = await api.datenquelleZuweisen(anlage.id, quelle.id, { device_id: boxId });
      onEingerichtet?.(antwort.datenquelle);
      onClose();
    } catch (e) {
      const budget = e instanceof ApiError && e.status === 422
        ? e.body as DatenquelleBudgetFehler : null;
      if (budget?.code === 'budget_ueberschritten') {
        setBudgetFehler(budget);
        setBudgets(budget.rechnung.freie_kapazitaet);
      } else setFehler(e instanceof Error ? e.message : 'Die Datenquelle konnte nicht eingerichtet werden.');
    } finally { setBusy(false); }
  }

  const budgetAnzeige = budgetAblehnungAnzeige(budgetFehler);
  const fuss = (
    <>
      <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
      {!quelle ? (
        <Recht aktion="datenquelle.bearbeiten" standort={standortId}><Button type="submit" form={`${basis}-form`} disabled={busy}>
          {busy ? 'Wird angelegt …' : 'Entwurf anlegen'}
        </Button></Recht>
      ) : (
        <>
          <Recht aktion="datenquelle.bearbeiten" standort={standortId}><Button variant="outline" onClick={() => void pruefen()} disabled={busy || !boxId}>
            {busy ? 'Wird geprüft …' : `Von ${box?.name ?? 'Box'} prüfen`}
          </Button></Recht>
          <Recht aktion="datenquelle.zustaendigkeit" standort={standortId}><Button onClick={() => void abschliessen()} disabled={busy || pruefung?.ergebnis !== 'ok'}>
            Einrichtung abschließen
          </Button></Recht>
        </>
      )}
    </>
  );

  return (
    <Modal open onClose={onClose} title="Datenquelle anlegen" footer={fuss}>
      <form id={`${basis}-form`} className="vp-dqa" noValidate onSubmit={(e) => void entwurfAnlegen(e)}>
        <p className="vp-dqa-einleitung">Die Box liest die Quelle in ihrem Netz. VoltPilot prüft die Erreichbarkeit und das Lesebudget vor der Einrichtung.</p>
        <div className="vp-dqa-felder">
          <Input label="Name" value={formular.name} disabled={busy} onChange={(e) => setFormular((f) => ({ ...f, name: e.target.value }))} />
          <VpPicker label="Protokoll" value={formular.protokoll} disabled={busy || !!quelle}
            options={PROTOKOLLE.map((p) => ({ value: p.code, label: p.name }))}
            onChange={(protokoll) => setFormular((f) => ({ ...f, protokoll: protokoll as Protokoll, register: protokoll === 'sunspec_modbus' ? '40000' : f.register }))} />
          <Input label="Adresse" value={formular.adresse} disabled={busy || !!quelle} placeholder="192.168.20.10:502" onChange={(e) => setFormular((f) => ({ ...f, adresse: e.target.value }))} />
          <Input label="Netzlage" value={formular.netz} disabled={busy} placeholder="VLAN 20 „Produktion“" hint="Aus Ihrem Netzplan (Bogen D1/D2)." onChange={(e) => setFormular((f) => ({ ...f, netz: e.target.value }))} />
          <Input label="Takt in Sekunden" inputMode="numeric" value={formular.kadenz} disabled={busy} onChange={(e) => { setFormular((f) => ({ ...f, kadenz: e.target.value })); setPruefung(null); }} />
          <Input label="Geräte-ID" inputMode="numeric" value={formular.geraeteId} disabled={busy} onChange={(e) => { setFormular((f) => ({ ...f, geraeteId: e.target.value })); setPruefung(null); }} />
          <Input label="Prüfregister" inputMode="numeric" value={formular.register} disabled={busy} onChange={(e) => { setFormular((f) => ({ ...f, register: e.target.value })); setPruefung(null); }} />
        </div>

        <fieldset className="vp-dqa-boxen">
          <legend>Zuständige Box</legend>
          {geraete === null && !fehler && <p>Boxen werden geladen …</p>}
          {geraete !== null && boxen.length === 0 && <p>An diesem Standort ist noch keine VoltPilot-Box verbunden.</p>}
          {boxen.map((b) => (
            <label key={b.id} className="vp-dqa-box" data-gewaehlt={boxId === b.id ? 'ja' : 'nein'}>
              <input type="radio" name={`${basis}-box`} value={b.id} checked={boxId === b.id} disabled={busy}
                onChange={() => { setBoxId(b.id); setPruefung(null); setBudgetFehler(null); }} />
              <span><strong>{b.name}</strong><span>{b.verbunden} · {b.software}</span><span>{b.budget}</span></span>
            </label>
          ))}
        </fieldset>

        {quelle && <p className="vp-dqa-entwurf">{quelle.kennzeichen} ist als Entwurf angelegt. Prüfen Sie jetzt die Verbindung von der gewählten Box.</p>}
        {pruefung && <p className={`vp-dqa-pruefung ${pruefung.ergebnis === 'ok' ? 'ist-ok' : 'ist-fehler'}`} role="status">
          <strong>Prüfung von {pruefung.box.name ?? box?.name ?? 'der Box'}:</strong> {pruefungText(pruefung)}
        </p>}
        {budgetAnzeige && (
          <section className="vp-dqa-budget" aria-labelledby={`${basis}-budget`} role="alert">
            <h3 id={`${basis}-budget`}>{budgetAnzeige.titel}</h3>
            <p>{budgetAnzeige.quelle}</p><p>{budgetAnzeige.anfragen}</p><p>{budgetAnzeige.box}</p>
            <div className="vp-dqa-auswege">
              {budgetFehler?.rechnung.auswege.takt && budgetFehler.rechnung.auswege.takt_s && <Button variant="outline" onClick={() => {
                setFormular((f) => ({ ...f, kadenz: String(budgetFehler.rechnung.auswege.takt_s) })); setPruefung(null); setBudgetFehler(null);
              }}>{budgetFehler.rechnung.auswege.takt}</Button>}
              {budgetFehler?.rechnung.auswege.andere_box && budgetFehler.rechnung.auswege.boxen.length > 0 && <Button variant="outline" onClick={() => {
                const [alternative] = budgetFehler.rechnung.auswege.boxen;
                setBoxId(alternative.id); setPruefung(null); setBudgetFehler(null);
              }}>{budgetFehler.rechnung.auswege.andere_box}</Button>}
            </div>
          </section>
        )}
        {fehler && <p className="vp-dqa-fehler" role="alert">{fehler}</p>}

        <section className="vp-dqa-folgen" aria-labelledby={`${basis}-folgen`}>
          <h3 id={`${basis}-folgen`}>Was danach gilt</h3>
          <ul>{folgenSaetze(anlage.name, box?.name ?? null).map((satz) => <li key={satz}>{satz}</li>)}</ul>
        </section>
      </form>
    </Modal>
  );
}
