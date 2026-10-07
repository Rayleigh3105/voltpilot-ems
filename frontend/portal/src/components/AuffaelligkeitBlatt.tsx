import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import * as A from '../abweichungen';
import { api, type Abweichung, type Auffaelligkeit } from '../api';
import { monatWort } from '../bezugsbasisVergleich';
import * as Z from '../energieziele';
import { useIsPhone } from '../useIsPhone';
import { STARTWERTE } from '../verbesserung';
import { VerantwortlichWahl } from './AuffaelligkeitZeile';
import { BottomSheet } from './BottomSheet';
import { VpDatePicker } from './VpDatePicker';
import '../pages/Abweichungen.css';

const TITEL = 'Auffälligkeit beantworten';
const ABBRECHEN = 'Abbrechen';
const UNTERSUCHEN = 'Untersuchen';
const ZUR_KENNTNIS = 'Zur Kenntnis nehmen';
const KEINE_ZAHL = 'Keine Antwort ändert eine Zahl. Messwerte, Kennzahl und Bezugsbasis bleiben, wie sie sind.';
const BEGRUENDUNG_BEISPIEL = 'Zum Beispiel: Kleinserien-Sonderauftrag mit vielen Werkzeugwechseln, im Produktionsplan dokumentiert.';

type Antwort = 'abweichung' | 'zur_kenntnis';

/**
 * „Auffälligkeit beantworten“ (Verbessern-Konzept v1 §6.7): was auffiel in Zahlen, zwei Antwort-Karten mit dem, was
 * jede bedeutet - „Untersuchen“ (daraus wird eine Abweichung mit Person und Frist; alle offenen Auffälligkeiten
 * derselben Kennzahl und Fassung gehen mit hinein) oder „Zur Kenntnis nehmen“ (mit Begründung). Die Frist steht per
 * Tippen auf der Vorgabe der Route (Eröffnungstag + 30). „Heute“ ist der Tag der Route (`abruf`), nie der des Browsers.
 * Am Telefon ein Blatt von unten, am Rechner der Dialog in der Mitte - dieselben Fragen. Beantwortet wird über die Route
 * an der Kennzahl; keine Antwort ändert eine Zahl (A5).
 */
export function AuffaelligkeitBlatt({
  vermerk,
  alle,
  abruf,
  onClose,
  onFertig,
}: {
  vermerk: Auffaelligkeit;
  /** Alle bekannten Vermerke - die offenen derselben Kennzahl und Fassung gehen bei „Untersuchen“ mit hinein. */
  alle: readonly Auffaelligkeit[];
  /** Der Tag der Route (Uhr der Kennzahlen). */
  abruf: string;
  onClose: () => void;
  onFertig: (x: { vermerk: Auffaelligkeit; abweichung: Abweichung | null }) => void;
}) {
  const basis = `ab-${useId().replace(/:/g, '')}`;
  const phone = useIsPhone();
  const [antwort, setAntwort] = useState<Antwort>('abweichung');
  const [verantwortlich, setVerantwortlich] = useState('');
  const vorgabe = A.plusTage(abruf, STARTWERTE.abweichung_frist_tage);
  const [anderer, setAnderer] = useState(false);
  const [frist, setFrist] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ verantwortlich?: string; begruendung?: string; frist?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zahlen = A.anlassZahlen(vermerk.anlass_inhalt);
  const auffiel = A.wasAuffielSatz(zahlen) ?? A.anlassSaetze(vermerk.anlass_inhalt).join(' ');
  const mit = A.offeneDerFassung(alle, vermerk).filter((v) => v.id !== vermerk.id);
  const knopf = antwort === 'abweichung' ? UNTERSUCHEN : ZUR_KENNTNIS;

  async function senden(ev?: FormEvent) {
    ev?.preventDefault();
    // Ein zweites Enter während der Anfrage schickt nichts doppelt.
    if (busy) return;
    const fehler =
      antwort === 'abweichung'
        ? {
            ...(!verantwortlich ? { verantwortlich: 'Bitte wählen Sie, wer das klärt.' } : {}),
            ...(anderer && !A.fristOk(frist) ? { frist: 'Bitte wählen Sie einen Tag.' } : {}),
            ...(anderer && frist && frist < abruf ? { frist: 'Die Frist liegt nie vor heute.' } : {}),
          }
        : { ...(!Z.begruendungOk(begruendung) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}) };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(`${basis}-${Object.keys(fehler)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onFertig(
        await api.auffaelligkeitAntworten(
          vermerk.kennzahl.id,
          vermerk.id,
          antwort === 'abweichung'
            ? { antwort: 'abweichung', verantwortlich, frist: anderer && frist ? frist : vorgabe }
            : { antwort: 'zur_kenntnis', begruendung: begruendung.trim() },
        ),
      );
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }

  const fuss = (
    <div className="vp-abw-blatt-fuss">
      <Button variant="ghost" onClick={onClose}>
        {ABBRECHEN}
      </Button>
      <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="auffaelligkeit-blatt-senden">
        {knopf}
      </Button>
    </div>
  );

  const inhalt = (
    <form id={`${basis}-form`} className="vp-abw-blatt" noValidate onSubmit={(x) => void senden(x)} data-testid="auffaelligkeit-blatt">
      <p className="vp-abw-blatt-sub">{`${A.kennzahlName(vermerk.kennzahl)} · ${monatWort(vermerk.periode)}`}</p>
      {auffiel && (
        <p className="vp-abw-bezug" data-testid="auffaelligkeit-blatt-auffiel">
          <span>{A.WAS_AUFFIEL}</span>
          <span>{auffiel}</span>
        </p>
      )}
      <fieldset className="vp-abw-feld">
        <legend>Was ist zu tun?</legend>
        <div className="vp-abw-wahl" role="radiogroup">
          <label data-testid="auffaelligkeit-wahl-untersuchen">
            <input type="radio" name={`${basis}-antwort`} checked={antwort === 'abweichung'} onChange={() => setAntwort('abweichung')} />
            <b>{UNTERSUCHEN}</b>
            <span>Daraus wird eine Abweichung mit verantwortlicher Person und Frist. Sie halten fest, was Sie herausfinden.</span>
          </label>
          <label data-testid="auffaelligkeit-wahl-kenntnis">
            <input type="radio" name={`${basis}-antwort`} checked={antwort === 'zur_kenntnis'} onChange={() => setAntwort('zur_kenntnis')} />
            <b>{ZUR_KENNTNIS}</b>
            <span>Der Grund ist bekannt und es ist nichts zu tun - mit kurzer Begründung.</span>
          </label>
        </div>
      </fieldset>
      {antwort === 'abweichung' ? (
        <>
          <VerantwortlichWahl
            id={`${basis}-verantwortlich`}
            label="Wer klärt das?"
            hint="Aus den aktiven Konten Ihres Kundenbereichs."
            wert={verantwortlich}
            setze={(v) => {
              setVerantwortlich(v);
              if (v) setZeigen((z) => ({ ...z, verantwortlich: undefined }));
            }}
            fehler={zeigen.verantwortlich ?? null}
          />
          <fieldset className="vp-abw-feld">
            <legend>Bis wann?</legend>
            <div className="vp-abw-schnell">
              <button type="button" className="vp-abw-chip" aria-pressed={!anderer} onClick={() => setAnderer(false)} data-testid="auffaelligkeit-frist-vorgabe">
                {`in ${STARTWERTE.abweichung_frist_tage} Tagen, ${Z.tag(vorgabe).slice(0, 6)}`}
              </button>
              <button type="button" className="vp-abw-chip" aria-pressed={anderer} onClick={() => setAnderer(true)} data-testid="auffaelligkeit-frist-anderer">
                Anderer Tag
              </button>
            </div>
            {anderer && (
              <VpDatePicker
                id={`${basis}-frist`}
                ariaLabel="Frist"
                value={frist}
                onChange={(t) => {
                  setFrist(t);
                  setZeigen((z) => ({ ...z, frist: undefined }));
                }}
                min={abruf}
                error={zeigen.frist ?? null}
              />
            )}
          </fieldset>
          {mit.length > 0 && (
            <p className="vp-abw-leise" data-testid="auffaelligkeit-blatt-mit">
              {A.mitgenommen([vermerk, ...mit].sort((a, b) => a.periode.localeCompare(b.periode)).map((v) => monatWort(v.periode)))}
            </p>
          )}
        </>
      ) : (
        <div className="vp-abw-feld">
          <label htmlFor={`${basis}-begruendung`}>Warum ist nichts zu tun?</label>
          <textarea
            id={`${basis}-begruendung`}
            rows={3}
            value={begruendung}
            placeholder={BEGRUENDUNG_BEISPIEL}
            onChange={(x) => {
              setBegruendung(x.target.value);
              if (Z.begruendungOk(x.target.value)) setZeigen((z) => ({ ...z, begruendung: undefined }));
            }}
            aria-invalid={!!zeigen.begruendung}
          />
          {zeigen.begruendung && <p className="vp-abw-fehler">{zeigen.begruendung}</p>}
        </div>
      )}
      <p className="vp-abw-leise">{KEINE_ZAHL}</p>
      {satz && (
        <p className="vp-alert vp-alert-err" role="alert">
          {satz}
        </p>
      )}
    </form>
  );

  return phone ? (
    <BottomSheet open title={TITEL} onClose={onClose} footer={fuss}>
      {inhalt}
    </BottomSheet>
  ) : (
    <Modal open onClose={onClose} title={TITEL} footer={fuss}>
      {inhalt}
    </Modal>
  );
}
