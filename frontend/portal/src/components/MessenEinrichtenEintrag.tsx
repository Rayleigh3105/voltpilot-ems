import { type ReactNode, useState } from 'react';
import { api, type Betriebsart, type Overview, type Site, type StandortZuordnungVorschau } from '../api';
import { orteAus } from '../betriebsart';
import { MESSEN_EINRICHTEN, useMessenEinstieg } from '../messenEinstieg';
import { portfolioAnwendungen } from '../portfolioCockpit';
import type { RowMenuItem } from './RowMenu';
import { StandortVorschau } from './StandortVorschau';

/**
 * UEMS firstmate K2 (09.10.2026): der leise Einstieg im „···"-Menü der gewohnten Übersicht —
 * Ersatz für die frühere grosse Karte „Noch nicht zugeordnet · Nächster Schritt: Standorte
 * einrichten" (AP-02 IP-10/O18). Die Karte verschwindet aus der Kunden-Übersicht; viele Kunden
 * wollen mit Standorten/Messen nichts zu tun haben und sollen unterwegs sein wie heute. Dieser
 * Eintrag trägt dasselbe Recht (`standort.verwalten`, von `RowMenu` selbst gefiltert — ohne das
 * Recht erscheint nichts Neues), denselben Knopftext wie jeder andere Einstieg in den EINEN
 * Messen-Assistenten ({@link MESSEN_EINRICHTEN}) und führt in den bestehenden Ablauf: ohne
 * Standorte zu „Standorte einrichten" (derselbe Dialog wie bisher, Voraussetzung für den
 * Assistenten), mit Standorten direkt in den Assistenten des Standorts (bei mehreren ohne
 * Vorwahl — der Assistent fragt dort). Kein Banner, kein Nachfragen, kein roter Punkt: alle
 * Daten (Standorte, Vorschlag, Anwendungen für „Was sich ändert") laden erst beim Klick — der
 * Aufrufer (`UebersichtPage`/`PortfolioPage`) reicht nur, was er ohnehin schon als Prop hat.
 *
 * `PortfolioCockpit` selbst bleibt dabei blind für die Betriebsart (Entscheid 25.09.2026,
 * `migration.test.ts` bewacht das) — dieser Hook läuft im Aufrufer und reicht nur das fertige
 * `{ aktion, modal }`-Paar als Prop hinein.
 */
export function useMessenEinrichtenEintrag(i: {
  sites: Site[];
  isAdmin: boolean;
  betriebsart: Betriebsart | null;
  onBestaetigt: () => void;
}): { aktion: RowMenuItem; modal: ReactNode } {
  const messen = useMessenEinstieg();
  const [vorschlag, setVorschlag] = useState<StandortZuordnungVorschau | null>(null);
  const [anwendungen, setAnwendungen] = useState<readonly string[]>([]);
  const [offen, setOffen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function oeffnen() {
    if (busy) return;
    setBusy(true);
    try {
      const orte = orteAus(await api.standorte(), null);
      if (orte.standorte.length === 0) {
        const [v, overview] = await Promise.all([
          api.standortZuordnungVorschlag(),
          api.overview().catch((): Overview | null => null),
        ]);
        if (v.anlagenZahl > 0) {
          const configById = new Map(i.sites.map((s) => [s.id, s]));
          setAnwendungen(overview ? portfolioAnwendungen(overview, configById) : []);
          setVorschlag(v);
          setOffen(true);
        }
      } else {
        messen?.oeffnen({ standortId: orte.standorte.length === 1 ? orte.standorte[0].id : null });
      }
    } catch {
      // Fail-soft: ein leiser Einstieg bleibt leise, auch wenn der Abruf scheitert.
    } finally {
      setBusy(false);
    }
  }

  return {
    aktion: {
      label: MESSEN_EINRICHTEN,
      recht: 'standort.verwalten',
      icon: 'settings',
      onClick: () => void oeffnen(),
    },
    modal: (
      <StandortVorschau
        open={offen}
        vorschau={vorschlag}
        aktuelleEbene="heute"
        isAdmin={i.isAdmin}
        betriebsart={i.betriebsart}
        anlagen={i.sites}
        anwendungen={anwendungen}
        onClose={() => setOffen(false)}
        onBestaetigt={() => {
          setOffen(false);
          setVorschlag(null);
          i.onBestaetigt();
        }}
      />
    ),
  };
}
