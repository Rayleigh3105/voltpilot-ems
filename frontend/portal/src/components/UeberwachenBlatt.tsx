import { useId, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { UeberwachungsRegel } from '../meldungenApi';
import { WORT_ERHOLDAUER, WORT_RUECKKEHRSCHWELLE, WORT_UEBERWACHEN, SCHWERE_WORT } from '../meldungen';
import type { Schwere } from '../meldungenApi';
import { ueberwachungApi } from '../ueberwachungApi';
import { ueberwachungSatz, vorgabenFuerBedingung } from '../ueberwachungSatz';
import { katalogEintrag } from '../werteKatalog';
import { BottomSheet } from './BottomSheet';
import './UeberwachenBlatt.css';

/**
 * Das Blatt „Überwachen" (Alerting Scheibe 2, Konzept §6.8): „Vom Wert zur fertigen Regel: drei
 * Taps" - (1) Menü ⋯, (2) „Überwachen" (öffnet dieses Blatt), (3) „Überwachung starten". Der Satz
 * ist vorbelegt (Schwelle aus dem aktuellen Live-Wert, Dauer/Rückkehrschwelle aus §9) und jedes
 * Feld bleibt änderbar (§6.1 Leitsatz 9) - kein Pflichtfeld ohne Vorbelegung.
 *
 * Bewusst nur die Bedingung „über" (§6.4): die vier Cockpit-Werte, an denen diese Scheibe
 * „Überwachen" anbietet (Netz, PV, Speicher, Verbrauch), brauchen für den Normalfall „zu viel" kein
 * eigenes Bedingungs-Auswahlfeld - einfache Zahlenfelder reichen (Aufgabenbeschreibung Teil 4b).
 * Kein Probelauf (§6.8 Entwurf 1) in dieser Runde - ein bekannter, akzeptierter Rückstand.
 */
export function UeberwachenBlatt({
  offen,
  isPhone,
  onClose,
  wertart,
  siteId,
  aktuellerWert,
  einheit = 'kW',
  onUeberwacht,
}: {
  offen: boolean;
  isPhone: boolean;
  onClose: () => void;
  wertart: string;
  siteId: string;
  aktuellerWert: number | null;
  einheit?: string;
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
  const feldId = useId();

  if (!eintrag) return null;

  const gueltig = Number.isFinite(schwelle) && dauerMinuten > 0 && erholdauerMinuten > 0;
  const satz = ueberwachungSatz(eintrag, { art: 'ueber', schwelle, rueckkehr, dauer_s: dauerMinuten * 60 }, schwere, einheit);

  async function starten() {
    if (busy || !gueltig) return;
    setBusy(true);
    setFehler('');
    try {
      const regel = await ueberwachungApi.anlegen({
        wertart,
        bezug: { anlage: siteId },
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

  return isPhone ? (
    <BottomSheet open={offen} title={WORT_UEBERWACHEN} onClose={onClose}>
      {inhalt}
    </BottomSheet>
  ) : (
    <Modal open={offen} onClose={onClose} title={WORT_UEBERWACHEN}>
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
