import { useEffect, useState } from 'react';
import { api } from '../api';
import { anschlussText, tagText } from '../netzanschlussListe';
import type { KopfzeileNachweis } from '../uemsNetzanschluss';

/** Ein ausgewiesener Stichtag, keine Behauptung über die gesamte Bilanzperiode.
 * Die Bilanzroute trägt keinen Anschluss; Standort und Bindung kommen aus den bestehenden Tages-Leserouten. */
export function NetzanschlussBilanzKopf({ anlage, am }: { anlage: string; am: string }) {
  const [stand, setStand] = useState<{ anlage: string; am: string; text: string } | null>(null);
  useEffect(() => {
    let aktiv = true;
    const laden = async () => {
      try {
        const orte = await api.standorte(am);
        const ort = orte.standorte.find((s) => s.anlagen.some((a) => a.id === anlage));
        const bezug = ort?.anlagen.find((a) => a.id === anlage)?.netzanschluss;
        let text = 'Netzanschluss konnte nicht geladen werden.';
        if (bezug === null) text = anschlussText(null);
        if (bezug && ort) {
          // Eine umgezogene Anlage kann weiterhin am Anschluss des bisherigen Standorts hängen.
          // Fehlen dessen Details im sichtbaren Standort, bleibt der gelieferte Bezug sichtbar.
          text = `Netzanschluss ${bezug.kennzeichen} · Weitere Angaben nicht abrufbar.`;
          try {
            const liste = (await api.netzanschluesse(ort.id, am)).netzanschluesse;
            const n = liste.find((n) => n.id === bezug.id);
            if (n) {
              // AP-15 IP-31: das Urteil des Grenz-Nachweises im Monat des Stichtags. Fehlt es, bleibt die
              // Zeile, wie sie war — gezeigt, nicht geprüft.
              let nachweis: KopfzeileNachweis | null = null;
              try {
                nachweis = await api.netzanschlussGrenznachweis(ort.id, n.id, am.slice(0, 7));
              } catch {
                /* Ohne Nachweis bleibt die Kopfzeile ohne Urteil. */
              }
              text = anschlussText(n, nachweis);
            }
          } catch {
            /* Der bekannte Bezug bleibt auch bei einem Lesefehler erhalten. */
          }
        }
        if (aktiv) setStand({ anlage, am, text });
      } catch {
        if (aktiv) setStand({ anlage, am, text: 'Netzanschluss konnte nicht geladen werden.' });
      }
    };
    void laden();
    return () => {
      aktiv = false;
    };
  }, [anlage, am]);
  return (
    <p className="vp-eb-zone" data-testid="bilanz-netzanschluss">
      Stand am {tagText(am)} ·{' '}
      {stand?.anlage === anlage && stand.am === am ? stand.text : 'Netzanschluss wird geladen …'}
    </p>
  );
}
