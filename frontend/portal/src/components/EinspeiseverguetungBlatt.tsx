import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { api, type Einspeiseverguetung } from '../api';
import {
  angabeMoeglich,
  EIGENER_SATZ_BEISPIELE,
  giltJetzt,
  herleitungOption,
  parseVerguetungInput,
  ruhtErklaerung,
  STICHTAG_FEHLER,
  STICHTAG_FRAGE,
  STICHTAG_WAHL,
  VERGUETUNG_EINGABE_FEHLER,
  verguetungHinweise,
  verguetungInputText,
} from '../einspeiseverguetung';
import { Recht } from './Recht';
import './EinspeiseverguetungBlatt.css';
import './SettingEditors.css';
import './TariffFields.css';

const SPEICHER_FEHLER = 'Die Änderung wurde nicht gespeichert. Bitte versuchen Sie es erneut.';

type Weg = 'herleiten' | 'eigen';

/**
 * Das Blatt „Einspeisevergütung" (Einstellungen › Strom & Geld): oben, was
 * gerade gilt und woher es kommt; darunter die eine Wahl - aus dem EEG
 * herleiten oder einen eigenen Satz angeben. Zurücksetzen IST die Wahl
 * „herleiten": gespeichert wird dann `null`, und die Herleitung gilt wieder.
 *
 * Bei Direktvermarktung und solange Netzladen erlaubt ist, nimmt das Blatt
 * nichts an - es erklärt, warum hier der Börsenpreis gilt, statt einen festen
 * Satz vorzutäuschen. Alle Zahlen kommen vom Server ({@link Einspeiseverguetung}),
 * gerechnet wird hier nichts.
 *
 * Fehlt das Inbetriebnahmedatum, fragt das Blatt zu einem eigenen Satz, ob die
 * Anlage vor oder ab dem 25.02.2025 in Betrieb ging (Pflicht): davon hängt
 * § 51a EEG ab, also ob der Satz auch in Negativpreis-Viertelstunden zählt.
 */
export function EinspeiseverguetungBlatt({
  siteId,
  stand,
  onCancel,
  onSaved,
  onMastr,
}: {
  siteId: string;
  stand: Einspeiseverguetung;
  onCancel: () => void;
  /** Der neue Stand nach dem Speichern - und der vorige, für „Rückgängig". */
  onSaved: (neu: Einspeiseverguetung, vorher: Einspeiseverguetung) => void;
  /** Öffnet die Verknüpfung mit dem Marktstammdatenregister. */
  onMastr: () => void;
}) {
  const jetzt = giltJetzt(stand);
  const [weg, setWeg] = useState<Weg>(stand.angegebenCtKwh != null ? 'eigen' : 'herleiten');
  const [text, setText] = useState(verguetungInputText(stand.angegebenCtKwh));
  const [stichtag, setStichtag] = useState<boolean | null>(stand.inbetriebnahmeAbSolarspitzengesetz);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feld = useRef<HTMLInputElement>(null);
  const ersteWahl = useRef<HTMLInputElement>(null);
  // Wer „eigener Satz" WÄHLT, will tippen: das Feld bekommt den Fokus, sobald
  // es steht - aber nicht beim Öffnen, wenn der eigene Satz schon vorgewählt ist.
  const gewaehlt = useRef(false);
  useEffect(() => {
    if (weg === 'eigen' && gewaehlt.current) feld.current?.focus();
  }, [weg]);

  const kopf = (
    <div className="vp-verguetung-jetzt" data-testid="verguetung-jetzt">
      <span className="vp-verguetung-jetzt-h">Gilt jetzt</span>
      <p className="vp-einst-gross">{jetzt.wert}</p>
      <p className="vp-note">{jetzt.herkunft}</p>
    </div>
  );

  const ruht = ruhtErklaerung(stand);
  if (!angabeMoeglich(stand.zustand)) {
    return (
      <div className="vp-setting-editform">
        {kopf}
        {ruht && <p className="vp-note">{ruht}</p>}
        <div className="vp-setting-editactions">
          <Button variant="primary" size="sm" onClick={onCancel}>
            Verstanden
          </Button>
        </div>
      </div>
    );
  }

  const hinweise = verguetungHinweise(stand);
  const ohneDatum = stand.inbetriebnahme == null;

  async function speichern() {
    let satz: number | null = null;
    if (weg === 'eigen') {
      const v = parseVerguetungInput(text);
      if (v === undefined || v === null) {
        setFehler(VERGUETUNG_EINGABE_FEHLER);
        feld.current?.focus();
        return;
      }
      if (ohneDatum && stichtag == null) {
        setFehler(STICHTAG_FEHLER);
        ersteWahl.current?.focus();
        return;
      }
      satz = v;
    }
    // Die Antwort zu § 51a reist nur mit einem Satz und nur ohne Datum.
    const antwort = satz != null && ohneDatum ? stichtag : null;
    if (satz === stand.angegebenCtKwh && antwort === (ohneDatum ? stand.inbetriebnahmeAbSolarspitzengesetz : null)) {
      // Nichts geändert: nichts senden, das Blatt schließt nur.
      onCancel();
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const neu = await api.setEinspeiseverguetung(siteId, satz, antwort);
      onSaved(neu, stand);
    } catch {
      setFehler(SPEICHER_FEHLER);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-setting-editform">
      {kopf}
      <fieldset className="vp-pricemode">
        <legend className="vp-tarif-label">Womit soll gerechnet werden?</legend>
        <div className="vp-pricemode-cards">
          <label className={`vp-pricemode-card${weg === 'herleiten' ? ' selected' : ''}`}>
            <input
              type="radio"
              name="verguetung-weg"
              value="herleiten"
              checked={weg === 'herleiten'}
              onChange={() => {
                setWeg('herleiten');
                setFehler(null);
              }}
            />
            <span>
              <b>Aus dem EEG herleiten</b>
              <small>{herleitungOption(stand)}</small>
            </span>
          </label>
          <label className={`vp-pricemode-card${weg === 'eigen' ? ' selected' : ''}`}>
            <input
              type="radio"
              name="verguetung-weg"
              value="eigen"
              checked={weg === 'eigen'}
              onChange={() => {
                gewaehlt.current = true;
                setWeg('eigen');
              }}
            />
            <span>
              <b>Eigenen Satz angeben</b>
              <small>{EIGENER_SATZ_BEISPIELE}</small>
            </span>
          </label>
        </div>
      </fieldset>
      {ohneDatum && weg === 'herleiten' && (
        <Recht aktion="anlage.verwalten">
          <button type="button" className="vp-linklike vp-verguetung-mastr" onClick={onMastr}>
            Anlage verknüpfen ›
          </button>
        </Recht>
      )}
      {weg === 'eigen' && (
        <div className="vp-tarif-field">
          <Input
            ref={feld}
            id="verguetung-satz"
            label="Ihr Satz (ct/kWh)"
            placeholder="z. B. 8,2"
            inputMode="decimal"
            value={text}
            error={fehler === VERGUETUNG_EINGABE_FEHLER ? fehler : undefined}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setText(e.target.value);
              if (fehler === VERGUETUNG_EINGABE_FEHLER) setFehler(null);
            }}
          />
        </div>
      )}
      {weg === 'eigen' && ohneDatum && (
        <fieldset className="vp-pricemode" aria-describedby={fehler === STICHTAG_FEHLER ? 'verguetung-stichtag-fehler' : undefined}>
          <legend className="vp-tarif-label">{STICHTAG_FRAGE}</legend>
          <div className="vp-pricemode-cards">
            {(['vor', 'ab'] as const).map((k) => (
              <label key={k} className={`vp-pricemode-card${stichtag === (k === 'ab') ? ' selected' : ''}`}>
                <input
                  ref={k === 'vor' ? ersteWahl : undefined}
                  type="radio"
                  name="verguetung-stichtag"
                  value={k}
                  checked={stichtag === (k === 'ab')}
                  onChange={() => {
                    setStichtag(k === 'ab');
                    if (fehler === STICHTAG_FEHLER) setFehler(null);
                  }}
                />
                <span>
                  <b>{STICHTAG_WAHL[k].label}</b>
                  <small>{STICHTAG_WAHL[k].hint}</small>
                </span>
              </label>
            ))}
          </div>
          {fehler === STICHTAG_FEHLER && (
            <p id="verguetung-stichtag-fehler" className="vp-tarif-warn" role="alert">
              {fehler}
            </p>
          )}
        </fieldset>
      )}
      {hinweise.map((h) => (
        <p key={h} className="vp-note vp-verguetung-hinweis">
          {h}
        </p>
      ))}
      {fehler && fehler !== VERGUETUNG_EINGABE_FEHLER && fehler !== STICHTAG_FEHLER && (
        <div className="vp-alert vp-alert-err">{fehler}</div>
      )}
      <div className="vp-setting-editactions">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={() => void speichern()} disabled={busy}>
          {busy ? 'Wird gespeichert…' : 'Speichern'}
        </Button>
      </div>
    </div>
  );
}
