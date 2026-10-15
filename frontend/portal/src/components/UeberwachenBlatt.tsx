import { useEffect, useId, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { UeberwachungsRegel } from '../meldungenApi';
import { WORT_ERHOLDAUER, WORT_RUECKKEHRSCHWELLE, WORT_UEBERWACHEN, SCHWERE_WORT } from '../meldungen';
import type { Schwere } from '../meldungenApi';
import { ueberwachungApi, type ProbelaufVorschau } from '../ueberwachungApi';
import { ueberwachungSatz, vorgabenFuerBedingung } from '../ueberwachungSatz';
import { katalogEintrag } from '../werteKatalog';
import { BottomSheet } from './BottomSheet';
import './UeberwachenBlatt.css';

/** Der Bezug einer Überwachung (§6.3): Anlage (die vier Cockpit-Live-Kreise) ODER Komponente+Kanal
 * (Aufbau-Zeilen, Geräteseite - Familie `geraet.messwert`), nie beide. */
export type UeberwachenBezug = { anlage: string } | { komponente: string; kanal: string };

/**
 * Das Blatt „Überwachen" (Alerting Scheibe 2, Konzept §6.8): „Vom Wert zur fertigen Regel: drei
 * Taps" - (1) Menü ⋯, (2) „Überwachen" (öffnet dieses Blatt), (3) „Überwachung starten". Der Satz
 * ist vorbelegt (Schwelle aus dem aktuellen Live-Wert, Dauer/Rückkehrschwelle aus §9) und jedes
 * Feld bleibt änderbar (§6.1 Leitsatz 9) - kein Pflichtfeld ohne Vorbelegung.
 *
 * Bewusst nur die Bedingung „über" (§6.4): weder die vier Cockpit-Werte noch ein Komponenten-Kanal
 * brauchen für den Normalfall „zu viel" ein eigenes Bedingungs-Auswahlfeld - einfache Zahlenfelder
 * reichen (Aufgabenbeschreibung Teil 4b).
 *
 * Seit der Nachbesserung 3/3 zeigt das Blatt die Probelauf-Vorschau (§6.8 Entwurf 1, „was diese
 * Regel in den letzten 30 Tagen gemeldet hätte"): ein einfacher Debounce (~400 ms), damit nicht
 * jeder Tastenanschlag einen Abruf auslöst; ein Fehlschlag zeigt nichts - die Vorschau ist eine
 * Hilfe, nie ein Blocker für „Überwachung starten".
 */
export function UeberwachenBlatt({
  offen,
  isPhone,
  onClose,
  wertart,
  bezug,
  aktuellerWert,
  einheit = 'kW',
  titelZusatz,
  onUeberwacht,
}: {
  offen: boolean;
  isPhone: boolean;
  onClose: () => void;
  wertart: string;
  bezug: UeberwachenBezug;
  aktuellerWert: number | null;
  einheit?: string;
  /** Zusatz zum Blatt-Titel - z. B. "Netz · Leistung" an einem Aufbau-/Geräte-Wert; ohne Zusatz nur „Überwachen" (Cockpit). */
  titelZusatz?: string;
  onUeberwacht: (regel: UeberwachungsRegel) => void;
}) {
  const eintrag = katalogEintrag(wertart);
  const vorschlag = vorschlagSchwelle(aktuellerWert);
  const [schwelle, setSchwelle] = useState(vorschlag);
  const vorgaben = vorgabenFuerBedingung('ueber', vorschlag);
  const [dauerMinuten, setDauerMinuten] = useState(vorgaben.dauer_s / 60);
  const [erholdauerMinuten, setErholdauerMinuten] = useState(vorgaben.erholen_s / 60);
  const [rueckkehr, setRueckkehr] = useState(vorgaben.rueckkehr ?? vorschlag);
  const [schwere, setSchwere] = useState<Schwere>('warnung');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState('');
  const [probelauf, setProbelauf] = useState<ProbelaufVorschau | null>(null);
  const feldId = useId();

  const gueltig = Number.isFinite(schwelle) && dauerMinuten > 0 && erholdauerMinuten > 0;
  const bezugKey = 'anlage' in bezug ? `anlage:${bezug.anlage}` : `komponente:${bezug.komponente}:${bezug.kanal}`;

  // Die Probelauf-Vorschau (§6.8 Entwurf 1) - gedämpft, damit nicht jede Änderung an Schwelle,
  // Dauer oder Rückkehrschwelle sofort einen eigenen Abruf auslöst.
  useEffect(() => {
    if (!offen || !gueltig) {
      setProbelauf(null);
      return undefined;
    }
    let aktiv = true;
    const zeitnehmer = window.setTimeout(() => {
      ueberwachungApi
        .probelauf({
          wertart,
          bezug,
          bedingung: {
            art: 'ueber',
            schwelle,
            rueckkehr,
            dauer_s: Math.round(dauerMinuten * 60),
            erholen_s: Math.round(erholdauerMinuten * 60),
          },
          schwere,
        })
        .then(
          (v) => { if (aktiv) setProbelauf(v); },
          () => { if (aktiv) setProbelauf(null); },
        );
    }, 400);
    return () => { aktiv = false; window.clearTimeout(zeitnehmer); };
    // `bezugKey` fasst den Bezug stabil zusammen - `bezug` selbst ist bei jedem Render ein neues Objekt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen, gueltig, wertart, bezugKey, schwelle, rueckkehr, dauerMinuten, erholdauerMinuten, schwere]);

  if (!eintrag) return null;

  const satz = ueberwachungSatz(eintrag, { art: 'ueber', schwelle, rueckkehr, dauer_s: dauerMinuten * 60 }, schwere, einheit);
  const probelaufText = probelauf == null
    ? null
    : probelauf.ausgeloest === 0
      ? `In den letzten ${probelauf.fensterTage} Tagen hätte das nicht ausgelöst.`
      : `In den letzten ${probelauf.fensterTage} Tagen hätte das ${probelauf.ausgeloest} Mal ausgelöst.`;

  async function starten() {
    if (busy || !gueltig) return;
    setBusy(true);
    setFehler('');
    try {
      const regel = await ueberwachungApi.anlegen({
        wertart,
        bezug,
        bedingung: {
          art: 'ueber',
          schwelle,
          rueckkehr,
          dauer_s: Math.round(dauerMinuten * 60),
          erholen_s: Math.round(erholdauerMinuten * 60),
        },
        schwere,
      });
      onUeberwacht(regel);
      onClose();
    } catch {
      setFehler('Die Überwachung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    } finally {
      setBusy(false);
    }
  }

  const inhalt = (
    <div className="vp-ueberwachen-blatt">
      <p className="vp-ueberwachen-satz" aria-live="polite">
        {satz}
      </p>
      {probelaufText && (
        <p className="vp-ueberwachen-probelauf" aria-live="polite">
          {probelaufText}
        </p>
      )}
      <div className="vp-ueberwachen-felder">
        <Input
          id={`${feldId}-schwelle`}
          label={`Schwelle (${einheit})`}
          type="number"
          step="0.1"
          value={schwelle}
          onChange={(e) => setSchwelle(Number(e.target.value))}
        />
        <Input
          id={`${feldId}-rueckkehr`}
          label={`${WORT_RUECKKEHRSCHWELLE} (${einheit})`}
          type="number"
          step="0.1"
          value={rueckkehr}
          onChange={(e) => setRueckkehr(Number(e.target.value))}
        />
        <Input
          id={`${feldId}-dauer`}
          label="Länger als (Minuten)"
          type="number"
          step="1"
          min="1"
          value={dauerMinuten}
          onChange={(e) => setDauerMinuten(Number(e.target.value))}
        />
        <Input
          id={`${feldId}-erholdauer`}
          label={`${WORT_ERHOLDAUER} (Minuten)`}
          type="number"
          step="1"
          min="1"
          value={erholdauerMinuten}
          onChange={(e) => setErholdauerMinuten(Number(e.target.value))}
        />
      </div>
      <div className="vp-ueberwachen-schwere" role="group" aria-label="Wie wichtig?">
        <span className="vp-ueberwachen-schwere-label">Wie wichtig?</span>
        <div className="vp-seg vp-seg-compact">
          {(['hinweis', 'warnung', 'dringend'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={schwere === s} className={schwere === s ? 'active' : ''} onClick={() => setSchwere(s)}>
              {SCHWERE_WORT[s]}
            </button>
          ))}
        </div>
      </div>
      {fehler && <p role="alert">{fehler}</p>}
      <Button variant="primary" fullWidth disabled={busy || !gueltig} onClick={starten}>
        Überwachung starten
      </Button>
    </div>
  );

  const titel = titelZusatz ? `${WORT_UEBERWACHEN}: ${titelZusatz}` : WORT_UEBERWACHEN;
  return isPhone ? (
    <BottomSheet open={offen} title={titel} onClose={onClose}>
      {inhalt}
    </BottomSheet>
  ) : (
    <Modal open={offen} onClose={onClose} title={titel}>
      {inhalt}
    </Modal>
  );
}

/**
 * Vorschlag aus dem Live-Wert (§6.1 Leitsatz 9): grob der aktuelle Wert mal 1,2, gerundet auf eine
 * Stufe, die zur Größenordnung passt. Ohne Live-Wert (oder 0) ein kleiner fester Startwert - besser
 * ein grober Vorschlag als ein leeres Pflichtfeld.
 */
export function vorschlagSchwelle(wert: number | null): number {
  if (wert == null || wert === 0) return 10;
  const basis = Math.abs(wert) * 1.2;
  const schritt = basis >= 100 ? 10 : basis >= 20 ? 5 : 1;
  return Math.max(schritt, Math.round(basis / schritt) * schritt);
}
