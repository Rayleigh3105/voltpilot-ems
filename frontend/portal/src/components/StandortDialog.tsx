import { Recht } from './Recht';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Nutzung, type StandortAmStichtag, type Unternehmen } from '../api';
import {
  alsOrtFehler,
  anfrage,
  dialogFassung,
  dialogVorspann,
  DIALOG_SENDEN,
  DIALOG_TITEL,
  ersterFehler,
  feldAusServer,
  flaecheText,
  formularAus,
  LAENDER,
  leeresFormular,
  NUTZUNGEN,
  pruefen,
  sichtbareFehler,
  standortFlaecheAnfrage,
  ZEITZONEN,
  type FeldFehler,
  type FeldName,
  type Land,
  type StandortFormular,
} from '../standorte';
import { VpPicker } from './VpPicker';
import { VpDatePicker } from './VpDatePicker';
import './StandortDialog.css';

/**
 * Der Standort-Dialog (UEMS AP-02 IP-6, Mockup T2) in drei Fassungen: anlegen ·
 * bearbeiten · vervollständigen (ein automatisch angelegter Standort, dem die
 * Adresse fehlt, E10). Zentriertes `Modal`, keine nativen Auswahlfelder.
 *
 * Alles, was entschieden wird, steht in `standorte.ts`; hier wird nur gerendert.
 * Beim Senden wird zuerst vor Ort geprüft (dieselben Sätze wie der Server), der
 * erste fehlerhafte Eintrag bekommt den Fokus. Lehnt der Server trotzdem ab,
 * landet sein Satz am Feld aus `feld` — sonst über dem Fuß.
 *
 * Die Bezugsfläche wird als eigene zeitgültige Fassung gespeichert; Stammdaten und
 * Flächenhistorie bleiben dadurch getrennte Wahrheiten.
 */
/** „ST-2“ bricht nie am Bindestrich um (375 px: „ST-“ / „2“ stand auf zwei Zeilen). */
function mitGanzemKurzzeichen(satz: string, kurzzeichen: string | null) {
  const i = kurzzeichen ? satz.indexOf(kurzzeichen) : -1;
  if (!kurzzeichen || i < 0) return satz;
  return (
    <>
      {satz.slice(0, i)}
      <span className="vp-sd-kz">{kurzzeichen}</span>
      {satz.slice(i + kurzzeichen.length)}
    </>
  );
}

export function StandortDialog({
  open,
  standort,
  unternehmen,
  standorte,
  heute,
  onClose,
  onGespeichert,
  onOeffnen,
}: {
  open: boolean;
  /** `null`: anlegen. Ein Entwurf öffnet „vervollständigen“, sonst „bearbeiten“. */
  standort: StandortAmStichtag | null;
  unternehmen: Unternehmen | null;
  /** Die Standorte heute — für die Namensregel vor dem Senden. */
  standorte: StandortAmStichtag[];
  /** Der Tag heute in der Zeitzone des Unternehmens (ISO). */
  heute: string;
  onClose: () => void;
  onGespeichert: (s: StandortAmStichtag) => void;
  /** „oder öffnen Sie …“ — öffnet den Standort, der den Namen schon trägt. */
  onOeffnen?: (s: StandortAmStichtag) => void;
}) {
  const fassung = dialogFassung(standort);
  const basis = `vp-sd-${useId().replace(/:/g, '')}`;
  const feldId = (f: FeldName) => `${basis}-${f}`;

  const [form, setForm] = useState<StandortFormular>(() =>
    standort ? formularAus(standort, heute) : leeresFormular(unternehmen, heute),
  );
  const [versucht, setVersucht] = useState(false);
  const [serverFehler, setServerFehler] = useState<FeldFehler>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [kurzzeichen, setKurzzeichen] = useState<string | null>(null);

  useEffect(() => {
    if (!open || fassung !== 'anlegen') return;
    let aktiv = true;
    api
      .standortKurzzeichenVorschlag()
      .then((v) => aktiv && setKurzzeichen(v.kurzzeichen))
      .catch(() => aktiv && setKurzzeichen(null));
    return () => {
      aktiv = false;
    };
  }, [open, fassung]);

  const pruefung = useMemo(
    () => pruefen(form, fassung, standorte, heute, standort),
    [form, fassung, standorte, heute, standort],
  );
  const fehler: FeldFehler = versucht ? { ...pruefung.fehler, ...serverFehler } : serverFehler;
  const amFeld = sichtbareFehler(fehler);

  function setze<K extends keyof StandortFormular>(feld: K, wert: StandortFormular[K]) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServerFehler((s) => {
      if (!(feld in s)) return s;
      const rest = { ...s };
      delete rest[feld as FeldName];
      return rest;
    });
    setAllgemein(null);
  }

  function fokus(feld: FeldName | null) {
    if (!feld) return;
    // Nach dem Rendern der Fehlertexte, damit der Screenreader den Satz mitliest.
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    const erster = ersterFehler(pruefung.fehler);
    if (erster) {
      fokus(erster);
      return;
    }
    setBusy(true);
    try {
      const body = anfrage(form, fassung, standort);
      let s =
        fassung === 'anlegen'
          ? await api.standortAnlegen(body)
          : await api.standortBearbeiten(standort!.id, body);
      const flaeche = standortFlaecheAnfrage(form, standort);
      if (flaeche) s = await api.standortFlaeche(s.id, flaeche);
      onGespeichert(s);
    } catch (err) {
      const ort = err instanceof ApiError ? alsOrtFehler(err.body) : null;
      const feld = ort?.code === 'name_belegt' ? 'name' : feldAusServer(ort?.feld);
      if (ort && feld) {
        setServerFehler({ [feld]: ort.message });
        fokus(feld);
      } else {
        setAllgemein(err instanceof Error ? err.message : 'Der Standort konnte nicht gespeichert werden.');
      }
    } finally {
      setBusy(false);
    }
  }

  const belegtVon = fehler.name ? pruefung.belegtVon : null;
  const flaeche = standort ? flaecheText(standort) : null;
  const firmenZone = unternehmen?.zeitzone ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={DIALOG_TITEL[fassung]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Recht aktion="standort.verwalten" rueckwirkend={!!form.flaeche.trim() && form.gueltigAb < heute}><Button type="submit" form={`${basis}-form`} disabled={busy}>
            {DIALOG_SENDEN[fassung]}
          </Button></Recht>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-sd" noValidate onSubmit={(e) => void senden(e)}>
        <p className="vp-sd-vorspann">
          {mitGanzemKurzzeichen(dialogVorspann(fassung, standort, kurzzeichen), kurzzeichen)}
        </p>

        <Input
          id={feldId('name')}
          label="Name *"
          value={form.name}
          autoComplete="off"
          onChange={(e) => setze('name', e.target.value)}
          error={amFeld.name}
        />
        {belegtVon && onOeffnen && (
          <button type="button" className="vp-sd-verweis" onClick={() => onOeffnen(belegtVon)}>
            {belegtVon.name} öffnen
          </button>
        )}

        {fassung !== 'anlegen' && (
          <Input
            id={feldId('kurzzeichen')}
            label="Kurzzeichen *"
            value={form.kurzzeichen}
            autoComplete="off"
            onChange={(e) => setze('kurzzeichen', e.target.value)}
            error={amFeld.kurzzeichen}
          />
        )}

        <Input
          id={feldId('strasse')}
          label="Straße und Hausnummer *"
          value={form.strasse}
          autoComplete="street-address"
          onChange={(e) => setze('strasse', e.target.value)}
          error={amFeld.strasse}
        />
        <div className="vp-sd-reihe">
          <div className="vp-sd-plz">
            <Input
              id={feldId('plz')}
              label="PLZ"
              value={form.plz}
              inputMode="numeric"
              autoComplete="postal-code"
              onChange={(e) => setze('plz', e.target.value)}
              error={amFeld.plz}
            />
          </div>
          <div className="vp-sd-ort">
            <Input
              id={feldId('ort')}
              label="Ort *"
              value={form.ort}
              autoComplete="address-level2"
              onChange={(e) => setze('ort', e.target.value)}
              error={amFeld.ort}
            />
          </div>
        </div>
        <VpPicker
          id={feldId('land')}
          label="Land *"
          placeholder="Land wählen"
          options={LAENDER.map((l) => ({ value: l.code, label: l.wort }))}
          value={form.land || null}
          onChange={(v) => setze('land', v as Land)}
          error={amFeld.land}
        />
        <VpPicker
          id={feldId('zeitzone')}
          label="Zeitzone *"
          // T2 „Europe/Berlin (vom Unternehmen)“: der Zusatz steht UNTER dem Feld und
          // in der Liste — im Auslöser würde er bei 375 px abgeschnitten (gemessen).
          options={ZEITZONEN.map((z) => ({
            value: z,
            label: z,
            sub: z === firmenZone ? 'vom Unternehmen' : undefined,
          }))}
          value={form.zeitzone}
          hint={form.zeitzone === firmenZone ? 'vom Unternehmen' : undefined}
          onChange={(v) => setze('zeitzone', v)}
          error={amFeld.zeitzone}
        />
        <VpPicker
          id={feldId('nutzung')}
          label="Nutzung"
          placeholder="Nutzung wählen"
          options={NUTZUNGEN.map((n) => ({ value: n.code, label: n.wort }))}
          values={form.nutzung}
          onChangeMany={(v) => setze('nutzung', v as Nutzung[])}
          hint="Die erste Auswahl ist die Hauptnutzung."
          error={amFeld.nutzung}
        />
        <Input
          id={feldId('notiz')}
          label="Notiz"
          value={form.notiz}
          onChange={(e) => setze('notiz', e.target.value)}
          error={amFeld.notiz}
        />

        {flaeche && (
          <div className="vp-sd-flaeche">
            <span className="vp-sd-flaeche-label">Bezugsfläche</span>
            <span className="vp-sd-flaeche-wert">{flaeche}</span>
          </div>
        )}

        <div className="vp-sd-reihe">
          <div className="vp-sd-flaeche-eingabe">
            <Input
              id={feldId('flaeche')}
              label="Bezugsfläche (m²)"
              inputMode="numeric"
              value={form.flaeche}
              onChange={(e) => setze('flaeche', e.target.value)}
              error={amFeld.flaeche}
            />
          </div>
          <div className="vp-sd-flaeche-ab">
            <VpDatePicker
              id={feldId('gueltigAb')}
              label="Gültig ab"
              value={form.gueltigAb}
              onChange={(v) => setze('gueltigAb', v)}
              error={amFeld.gueltigAb}
            />
          </div>
        </div>

        {allgemein && (
          <div className="vp-alert vp-alert-err" role="alert">
            {allgemein}
          </div>
        )}
      </form>
    </Modal>
  );
}
