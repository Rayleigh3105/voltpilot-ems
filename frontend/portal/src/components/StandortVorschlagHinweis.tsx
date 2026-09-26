import { useEffect, useState } from 'react';
import { api, type Betriebsart, type Site, type StandortZuordnungVorschau } from '../api';
import { useRollen } from '../rollen';
import { NochNichtZugeordnetKarte, StandortVorschau } from './StandortVorschau';

/**
 * UEMS AP-02 IP-10/O18 — die Vorschlagskarte „Noch nicht zugeordnet“ auf der
 * FLOTTE (`PortfolioCockpit` ohne Ebene).
 *
 * Vor der Bestätigung gibt es noch keine UEMS-Ebene: der Mehr-Anlagen-Bestand
 * landet in der Flotten-Übersicht. Genau dort muss die Vorschlagskarte
 * erreichbar sein. Bis zum Nachzug von main (d1d67b97e) stand diese Logik im
 * Flotten-Zweig des Portfolio-Cockpits; seit die Flotte die vier Blöcke der
 * Kunden-Übersicht zeigt, reicht der Wirt sie als Hinweis hinein.
 *
 * Nur ein berechtigter Kunde (`standort.verwalten`) lädt und sieht die Fläche;
 * ein reiner Betriebskunde bleibt zeichengleich und fragt nichts ab.
 */
export function StandortVorschlagHinweis({
  sites,
  isAdmin,
  betriebsart,
  anwendungen,
  onBestaetigt,
}: {
  sites: Site[];
  isAdmin: boolean;
  /** U0-Rahmen (effektiv); er entscheidet mit, ob sich die Startseite ändert. */
  betriebsart: Betriebsart | null;
  /** Die Anwendungen der Flotte (`portfolioAnwendungen`), für „Was sich ändert“. */
  anwendungen: readonly string[];
  /** Nach dem Bestätigen: Fläche und Schale neu laden. */
  onBestaetigt: () => void;
}) {
  const rollen = useRollen();
  const darf = rollen.darf('standort.verwalten', null);
  const [standortVorschlag, setStandortVorschlag] = useState<StandortZuordnungVorschau | null>(null);
  const [offen, setOffen] = useState(false);
  const [runde, setRunde] = useState(0);

  useEffect(() => {
    if (!darf) {
      setStandortVorschlag(null);
      return;
    }
    let aktiv = true;
    api.standortZuordnungVorschlag().then(
      (v) => aktiv && setStandortVorschlag(v.anlagenZahl > 0 ? v : null),
      () => aktiv && setStandortVorschlag(null),
    );
    return () => {
      aktiv = false;
    };
  }, [darf, runde]);

  return (
    <>
      {standortVorschlag && <NochNichtZugeordnetKarte vorschau={standortVorschlag} onOeffnen={() => setOffen(true)} />}
      <StandortVorschau
        open={offen}
        vorschau={standortVorschlag}
        aktuelleEbene="heute"
        isAdmin={isAdmin}
        betriebsart={betriebsart}
        anlagen={sites}
        anwendungen={anwendungen}
        onClose={() => setOffen(false)}
        onBestaetigt={() => {
          setOffen(false);
          setStandortVorschlag(null);
          setRunde((r) => r + 1);
          onBestaetigt();
        }}
      />
    </>
  );
}
