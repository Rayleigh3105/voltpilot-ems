/**
 * Die Steuerung als Gerät (UEMS EZ-10, EW-3 A): an der Karte „Gerät“ einer Anlagensteuerung die
 * Erzeugungseinheiten - so wie die Energiekarten an einer WAGO-Steuerung - mit Art, Typname, Nennleistung und
 * Zustand, dazu Netzpunkt (berechnet bzw. „—“ ohne Messung, EW-16 C) und Datenstand; den Programmstand zeigt EZ-16
 * an derselben Karte. Die Werte liest die Route `…/anlagensteuerungen/{geraetId}/werte` (EZ-6); ohne sie stehen
 * die Stammdaten allein.
 */
import type { Erzeugungseinheit } from '../api';
import { datenstandZeile, einheitenZeilen, netzpunktZeile } from '../anlagensteuerung';
import type { Zeile } from '../geraetEinstellungen';
import { useAnlagensteuerungWerte } from '../useAnlagensteuerung';

export function AnlagensteuerungEinheiten({
  siteId,
  geraetId,
  einheiten,
  jetzt,
}: {
  siteId: string;
  geraetId: string;
  einheiten: readonly Erzeugungseinheit[];
  /** Die Uhr der Seite (Tests); ohne sie „jetzt“. */
  jetzt?: string;
}) {
  const werte = useAnlagensteuerungWerte(siteId, geraetId);
  const now = jetzt ? new Date(jetzt) : new Date();
  const anlage: Zeile[] = [netzpunktZeile(werte), datenstandZeile(werte, now)];
  return (
    <>
      <h4 className="vp-gh-unter">Erzeugungseinheiten</h4>
      <Zeilen zeilen={einheitenZeilen(einheiten, werte)} testId="geraet-einheiten" />
      <h4 className="vp-gh-unter">Anlage</h4>
      <Zeilen zeilen={anlage} testId="geraet-anlagensteuerung" />
    </>
  );
}

function Zeilen({ zeilen, testId }: { zeilen: Zeile[]; testId: string }) {
  return (
    <dl className="vp-geraet-kv" data-testid={testId}>
      {zeilen.map((z) => (
        <div key={`${z.label}|${z.wert}`}>
          <dt>{z.label}</dt>
          <dd>
            <span>{z.wert}</span>
            {z.detail && <small>{z.detail}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
