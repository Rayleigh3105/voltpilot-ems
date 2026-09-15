import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type Ort } from '../api';
import type { BerichteFolgen } from '../berichteFolgen';
import {
  FLAECHE_AENDERN_TITEL,
  FLAECHE_GESPEICHERT_TITEL,
  FLAECHE_VORSPANN,
  flaecheAnfrage,
  flaecheFeldAusServer,
  flaecheKopf,
  flaechePruefen,
  folgenNachher,
  folgenVorher,
  heuteSatz,
  KNOPF_FERTIG,
  KNOPF_FLAECHE_SPEICHERN,
  leeresFlaecheFormular,
  verlauf,
  VERLAUF_TITEL,
  type FlaecheFehler,
  type FlaecheFeld,
  type FlaecheFormular,
  type Folgen,
} from '../flaecheAendern';
import { alsOrtFehler } from '../standorte';
import type { Tag } from '../uemsOrtsbaum';
import { useBerichteFolgen } from '../useBerichteFolgen';
import { VpDatePicker } from './VpDatePicker';
import './StandortDialog.css';
import './OrtDialog.css';
import './FlaecheDialog.css';

/**
 * „Fläche ändern“ mit „gültig ab“ und dem Flächen-Verlauf (UEMS AP-02 IP-8,
 * Mockup T7). Geöffnet aus „Gebäude/Bereich bearbeiten“, sobald der Knoten eine
 * Fläche hat; geschrieben über `PUT /api/v1/orte/{id}/flaeche` (IP-5).
 *
 * Zwei Zustände in derselben Schale:
 * 1. Eingabe — die heute gültige Fläche, „Neue Fläche“, „Gültig ab“ (heute
 *    vorbelegt) und darunter, sobald beides da ist, was das Datum bedeutet.
 * 2. Gespeichert — der Verlauf aus der ANTWORT des Servers (alle Intervalle, die
 *    neue mit ihrem Abzeichen) und die Folgen mit dem Ende, das der Server ihr gab.
 *
 * Alles, was entschieden wird, steht in `flaecheAendern.ts`.
 * ⚠ Es gibt keinen Lese-Weg für den Verlauf VOR dem Speichern — der Dialog zeigt
 * darum vorher nur die heute gültige Fläche, nie einen geratenen Verlauf.
 */
export function FlaecheDialog({
  open,
  ortId,
  name,
  kurzzeichen,
  flaecheHeute,
  heute,
  zeitzone,
  onClose,
  onGespeichert,
}: {
  open: boolean;
  ortId: string;
  name: string;
  kurzzeichen: string | null;
  /** Die Fläche, die heute gilt (aus dem Ortsbaum) — `null`, nie 0. */
  flaecheHeute: number | null;
  /** Heute in der Zeitzone des Standorts (der Stichtag der Ortsbaum-Antwort). */
  heute: Tag;
  zeitzone: string;
  /** Abbrechen, bevor etwas gespeichert ist. */
  onClose: () => void;
  /** Nach dem Speichern: „Fertig“ (oder Schließen) mit der Antwort des Servers. */
  onGespeichert: (ort: Ort) => void;
}) {
  const basis = `vp-fd-${useId().replace(/:/g, '')}`;
  const feldId = (f: FlaecheFeld) => `${basis}-${f}`;
  const [form, setForm] = useState<FlaecheFormular>(() => leeresFlaecheFormular(heute));
  const [versucht, setVersucht] = useState(false);
  const [serverFehler, setServerFehler] = useState<FlaecheFehler>({});
  const [allgemein, setAllgemein] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ergebnis, setErgebnis] = useState<{ ort: Ort; giltAb: Tag } | null>(null);
  const verlaufKopf = useRef<HTMLHeadingElement>(null);

  const pruefung = useMemo(() => flaechePruefen(form), [form]);
  const fehler: FlaecheFehler = versucht ? { ...pruefung, ...serverFehler } : serverFehler;
  const vorher = useMemo(() => folgenVorher(form, heute, zeitzone), [form, heute, zeitzone]);
  // AP-12 IP-9: welche freigegebenen Berichte die Fläche ab „gültig ab“ träfe — nur, solange die Karte „vorher“ steht.
  const berichte = useBerichteFolgen(ortId, vorher ? form.gueltigAb : null, 'flaeche_rueckwirkend', 'aendern');

  function setze<K extends FlaecheFeld>(feld: K, wert: string) {
    setForm((f) => ({ ...f, [feld]: wert }));
    setServerFehler((s) => {
      if (!(feld in s)) return s;
      const rest = { ...s };
      delete rest[feld];
      return rest;
    });
    setAllgemein(null);
  }

  function fokus(feld: FlaecheFeld) {
    requestAnimationFrame(() => document.getElementById(feldId(feld))?.focus());
  }

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setVersucht(true);
    setAllgemein(null);
    const anfrage = flaecheAnfrage(form);
    if (!anfrage) {
      fokus(pruefung.flaeche ? 'flaeche' : 'gueltigAb');
      return;
    }
    setBusy(true);
    try {
      const ort = await api.ortFlaeche(ortId, anfrage);
      setErgebnis({ ort, giltAb: anfrage.gueltigAb! });
      requestAnimationFrame(() => verlaufKopf.current?.focus());
    } catch (err) {
      const ortFehler = err instanceof ApiError ? alsOrtFehler(err.body) : null;
      const feld = ortFehler ? flaecheFeldAusServer(ortFehler) : null;
      if (ortFehler && feld) {
        setServerFehler({ [feld]: ortFehler.message });
        fokus(feld);
      } else {
        setAllgemein(
          ortFehler?.message ?? (err instanceof Error ? err.message : 'Die Fläche konnte nicht gespeichert werden.'),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const fertig = () => ergebnis && onGespeichert(ergebnis.ort);
  const nachher = ergebnis ? folgenNachher(ergebnis.ort, ergebnis.giltAb, heute, zeitzone) : null;

  return (
    <Modal
      open={open}
      onClose={ergebnis ? fertig : onClose}
      title={ergebnis ? FLAECHE_GESPEICHERT_TITEL : FLAECHE_AENDERN_TITEL}
      footer={
        ergebnis ? (
          <Button onClick={fertig}>{KNOPF_FERTIG}</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" form={`${basis}-form`} disabled={busy}>
              {KNOPF_FLAECHE_SPEICHERN}
            </Button>
          </>
        )
      }
    >
      <form id={`${basis}-form`} className="vp-sd" noValidate onSubmit={(e) => void senden(e)}>
        <div className="vp-fd-kopf">
          <p className="vp-fd-name">{flaecheKopf(name, kurzzeichen)}</p>
          <p className="vp-sd-vorspann">{FLAECHE_VORSPANN}</p>
        </div>

        {ergebnis ? (
          <>
            <section className="vp-fd-verlauf" aria-labelledby={`${basis}-verlauf`}>
              <h4 id={`${basis}-verlauf`} ref={verlaufKopf} tabIndex={-1}>
                {VERLAUF_TITEL}
              </h4>
              <ul>
                {verlauf(ergebnis.ort, ergebnis.giltAb).map((z) => (
                  <li key={z.schluessel} className={z.neu ? 'vp-fd-zeile vp-fd-zeile-neu' : 'vp-fd-zeile'}>
                    <span className={`vp-fd-punkt vp-fd-punkt-${z.zustand}`} aria-hidden="true" />
                    <span className="vp-fd-text">
                      <span className="vp-fd-m2">{z.flaeche}</span>
                      <span className="vp-fd-zeitraum">{z.zeitraum}</span>
                    </span>
                    {z.kennzeichen && <span className="vp-fd-chip">{z.kennzeichen}</span>}
                  </li>
                ))}
              </ul>
            </section>
            {nachher && <FolgenKarte folgen={nachher} />}
          </>
        ) : (
          <>
            <div className="vp-sd-flaeche">
              <span className="vp-sd-flaeche-wert">{heuteSatz(flaecheHeute)}</span>
            </div>
            <div className="vp-sd-reihe">
              <div className="vp-od-flaeche">
                <Input
                  id={feldId('flaeche')}
                  label="Neue Fläche (m²) *"
                  value={form.flaeche}
                  inputMode="numeric"
                  autoComplete="off"
                  onChange={(e) => setze('flaeche', e.target.value)}
                  error={fehler.flaeche}
                />
              </div>
              <div className="vp-od-ab">
                <VpDatePicker
                  id={feldId('gueltigAb')}
                  label="Gültig ab *"
                  value={form.gueltigAb}
                  onChange={(v) => setze('gueltigAb', v)}
                  error={fehler.gueltigAb}
                />
              </div>
            </div>
            {vorher && <FolgenKarte folgen={vorher} berichte={berichte} />}
            {allgemein && (
              <div className="vp-alert vp-alert-err" role="alert">
                {allgemein}
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

function FolgenKarte({ folgen, berichte = null }: { folgen: Folgen; berichte?: BerichteFolgen | null }) {
  return (
    <section className="vp-fd-folgen" aria-live="polite" data-testid="flaeche-folgen">
      <h4>{folgen.titel}</h4>
      {folgen.saetze.map((s) => (
        <p key={s}>{s}</p>
      ))}
      {berichte && (
        <p data-testid="berichte-folgen">
          <strong>{berichte.titel}:</strong> {berichte.text}
        </p>
      )}
    </section>
  );
}
