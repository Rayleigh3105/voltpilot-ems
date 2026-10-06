import { useEffect, useState } from 'react';
import { api } from '../api';
import { FUSS_ZONE, FUSS_ZONE_STANDORT } from '../anlageEnergiebilanz';
import { dez } from '../dez';
import { anschlussText } from '../netzanschlussListe';
import { kopfzeile, type KopfzeileNachweis } from '../uemsNetzanschluss';

/**
 * Der Fuß der Energiebilanz (Konzept Auswerten a1 §6.9): „Netzanschluss NA-1 · vereinbart 550 kW · Zeiten: Europe/Berlin
 * (Werk Ahrenberg)“. Die Zeitzone steht einmal, am Fuß (Messen m1, Entscheid 6); MaLo, Netzbetreiber, Anschlussleistung
 * und ein Grenz-Nachweis ohne Urteil („nicht belegt“) gehören auf die Seite des Netzanschlusses. Nur ein Grenz-Nachweis
 * mit „überschritten“ steht hier - er verlangt eine Handlung. Bei Umzug kann der Anschluss am alten Standort bleiben:
 * sein bekanntes Kennzeichen bleibt sichtbar, auch wenn die Details nicht lesbar sind.
 *
 * Die Bilanzroute trägt keinen Anschluss; Standort und Bindung kommen aus den bestehenden Tages-Leserouten, am ersten Tag
 * des gezeigten Zeitraums. Was fehlt oder nicht lädt, steht nicht da - die Zeitzone steht immer.
 */
export function EnergiebilanzFuss({ anlage, am, zone }: { anlage: string; am: string; zone: string }) {
  const [stand, setStand] = useState<{ schluessel: string; standort: string | null; anschluss: string | null } | null>(null);
  const schluessel = `${anlage}|${am}`;
  useEffect(() => {
    let aktiv = true;
    const laden = async () => {
      let standort: string | null = null;
      let anschluss: string | null = null;
      try {
        const orte = await api.standorte(am);
        const ort = orte.standorte.find((s) => s.anlagen.some((a) => a.id === anlage)) ?? null;
        standort = ort?.name ?? null;
        const bezug = ort?.anlagen.find((a) => a.id === anlage)?.netzanschluss;
        // `null` heißt „nicht angelegt“; eine fehlende Angabe ist unbekannt und sagt nichts.
        if (bezug === null) anschluss = anschlussText(null);
        if (ort && bezug) {
          anschluss = `Netzanschluss ${bezug.kennzeichen}`;
          const n = (await api.netzanschluesse(ort.id, am)).netzanschluesse.find((x) => x.id === bezug.id);
          if (n) {
            let nachweis: KopfzeileNachweis | null = null;
            try {
              // AP-15 IP-31: nur das Urteil „überschritten“ steht am Fuß - eingehalten und nicht belegt sagen hier nichts.
              const g = await api.netzanschlussGrenznachweis(ort.id, n.id, am.slice(0, 7));
              nachweis = g.urteil === 'ueberschritten' ? g : null;
            } catch {
              /* Ohne Nachweis bleibt der Fuß ohne Urteil. */
            }
            const vereinbart = n.vereinbart_kw === null ? null : dez(String(n.vereinbart_kw));
            const leistung = kopfzeile(n.kennzeichen, vereinbart, null, null, nachweis).text;
            anschluss = [`Netzanschluss ${n.kennzeichen}`, leistung].filter(Boolean).join(' · ');
          }
        }
      } catch {
        /* Der bekannte Teil bleibt; ohne Antwort steht nur die Zeitzone. */
      }
      if (aktiv) setStand({ schluessel, standort, anschluss });
    };
    void laden();
    return () => {
      aktiv = false;
    };
  }, [anlage, am, schluessel]);
  const geladen = stand?.schluessel === schluessel ? stand : null;
  const zeiten = geladen?.standort
    ? FUSS_ZONE_STANDORT.replace('{zone}', zone).replace('{standort}', geladen.standort)
    : FUSS_ZONE.replace('{zone}', zone);
  return (
    <p className="vp-bil-fuss" data-testid="energiebilanz-fuss">
      {[geladen?.anschluss, zeiten].filter(Boolean).join(' · ')}
    </p>
  );
}
