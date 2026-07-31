import { useEffect, useState } from 'react';
import { api, type TarifArt } from '../api';
import {
  aktuellerPreisSlot,
  bezugspreisLeerText,
  bezugspreisSatz,
  bezugspreisVorschau,
} from '../settingsSurface';

/**
 * Die LEBENDE Bezugspreis-Vorschau unter dem Stromtarif (E5, Report §7 P5):
 * „Ihr Bezugspreis gerade: 32,5 ct/kWh (Börsenpreis 12,4 + Netzentgelte/Abgaben
 * 20,1)". Ein falsch getippter Wert wird damit SOFORT sichtbar, statt erst in
 * der Dispositionsentscheidung des Optimierers.
 *
 * **Sie rechnet nichts.** Die Komposition ist serverseitig die eine Wahrheit
 * (`pricing.py import_prices` ⟷ `SlotEconomics.importPriceCtSql`) und reist je
 * Viertelstunde mit dem Fahrplan mit; hier wird der Slot gelesen, der gerade
 * läuft — dieselben Zahlen, die auch das Fahrplan-„Warum" nennt. Aus den
 * Formularfeldern zu addieren wäre eine zweite Preisrechnung, und genau die
 * darf es nicht geben.
 *
 * Fail-soft in beide Richtungen: ein fehlgeschlagener Abruf, ein Lauf ohne
 * Preisspalte oder ein Fahrplan, der die laufende Viertelstunde nicht abdeckt,
 * führen zur ehrlichen Zeile statt zu einer erfundenen Zahl.
 */
export function BezugspreisPreview({ siteId, tarifArt }: { siteId: string; tarifArt: TarifArt }) {
  const [satz, setSatz] = useState<string | null>(null);
  const [geladen, setGeladen] = useState(false);

  useEffect(() => {
    let alive = true;
    setSatz(null);
    setGeladen(false);
    api
      .schedule(siteId)
      .then((plan) => {
        if (!alive) return;
        const slot = aktuellerPreisSlot(plan.slots, plan.slotMinutes, new Date());
        setSatz(bezugspreisSatz(bezugspreisVorschau(slot)));
        setGeladen(true);
      })
      .catch(() => {
        if (alive) setGeladen(true);
      });
    return () => {
      alive = false;
    };
  }, [siteId, tarifArt]);

  // Solange nichts geladen ist, steht dort NICHTS — ein Platzhalter, der später
  // zur Zahl wird, liest sich wie ein Wert.
  if (!geladen) return null;

  if (!satz) {
    return <span className="vp-setting-preview muted">{bezugspreisLeerText(tarifArt)}</span>;
  }

  // Die Zahl trägt die Aussage, die Aufschlüsselung erklärt sie.
  const [kopf, ...rest] = satz.split(' (');
  const detail = rest.length > 0 ? `(${rest.join(' (')}` : null;
  const [vorn, betrag] = kopf.split(': ');
  return (
    <span className="vp-setting-preview">
      {vorn}: <b>{betrag}</b>
      {detail ? ` ${detail}` : null}
    </span>
  );
}
