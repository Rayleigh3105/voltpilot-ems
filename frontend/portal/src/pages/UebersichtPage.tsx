import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { type Betriebsart, type Device, type Site } from '../api';
import { currentUser } from '../auth';
import { isFleetShell } from '../betriebsart';
import { anlageRoute, type Route } from '../nav';
import { AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawer';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import { AnlageSeite } from './AnlagenPage';

interface UebersichtProps {
  sites: Site[];
  devices: Device[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /** U0 shell frame (effective, from /tenant-context); null = unknown. */
  betriebsart?: Betriebsart | null;
}

/**
 * The ADAPTIVE Übersicht landing of the ENDKUNDE (cockpit) shell: with one
 * Anlage the Übersicht IS the Anlagen-Seite (their whole world is one Anlage,
 * no duplicated hero blocks); with 2-3 Anlagen they get the calm CARD overview
 * (money hero, fleet status sentence, per-Anlage cards; a card tap opens that
 * Anlage's page #/anlage/{id}) - by design never a portfolio table (design
 * vp-ems-ui-overhaul §2.3).
 *
 * ⚠ Seit dem Anwendungs-Programm Stufe 4 (E5) landet KEIN Mandant mit
 * Flotten-Ebene mehr hier - weder ein Betreiber noch ein Endkunde ab zwei
 * Anlagen: `betriebsart.ts showPortfolioNav` hängt an der Flotten-Ebene, und
 * `redirectToPortfolio` legt die Landung auf `#/portfolio`. Übrig bleiben der
 * Einzel-Anlagen-Kunde (dessen Übersicht die Anlagen-Seite IST, unverändert)
 * und der leere Zustand.
 */
export function UebersichtPage(props: UebersichtProps) {
  if (props.sites.length === 0) {
    return <UebersichtEmpty {...props} />;
  }
  if (!isFleetShell(props.betriebsart ?? null, props.sites.length)) {
    const site = props.sites[0];
    return (
      <AnlageSeite
        sites={props.sites}
        devices={props.devices}
        route={anlageRoute(site.id)}
        onNavigate={props.onNavigate}
        onReload={props.onReload}
        isAdmin={props.isAdmin}
        site={site}
        onOpenSub={(sub) => props.onNavigate(anlageRoute(site.id, sub))}
        onBackToList={null}
      />
    );
  }
  // Anwendungs-Programm Stufe 4 (E5): die Flotten-Ebene ist EINE Fläche. Die
  // frühere `FleetUebersicht` ist ersatzlos in das {@link PortfolioCockpit}
  // übergegangen - dessen Karten-Dichte IST ihr Bild (Geld-Held + Status
  // nebeneinander, darunter eine Karte je Anlage), nur komponiert aus den
  // Anwendungen der Anlagen statt aus einer festen Kachel-Zeile.
  //
  // ⚠ Ein KUNDE landet hier seit Stufe 4 gar nicht mehr: `showPortfolioNav`
  // hängt an der Flotten-Ebene, also leitet `redirectToPortfolio` ihn auf
  // `#/portfolio`. Der Zweig bleibt trotzdem, damit jeder andere Weg auf
  // `#/uebersicht` (ein Admin-Deep-Link, ein Zustand vor dem Laden) dieselbe
  // Fläche zeigt - zwei Flotten-Bilder auf zwei Adressen waren genau der
  // Zustand, den E5 beendet.
  return (
    <PortfolioCockpit
      sites={props.sites}
      onNavigate={props.onNavigate}
      onReload={props.onReload}
      isAdmin={props.isAdmin}
      betriebsart={props.betriebsart ?? null}
      kopf={{ titel: `Guten Tag, ${greetingName()}`, satz: 'Alle Ihre Anlagen auf einen Blick.' }}
    />
  );
}

/** Der Vorname für die Begrüßung - sonst der ganze angezeigte Name. */
function greetingName(): string {
  const user = currentUser();
  return (user.name || '').split(/\s+/)[0] || user.name;
}

/** Empty-state: onboarding entry for customers, neutral notice for admins. */
function UebersichtEmpty({ onReload, isAdmin = false }: UebersichtProps) {
  const [siteDrawer, setSiteDrawer] = useState(false);
  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>{isAdmin ? 'Übersicht' : 'Willkommen bei VoltPilot'}</h1>
          <p>
            {isAdmin
              ? 'Dieser Mandant hat noch keine Anlage.'
              : 'Legen Sie Ihre Anlage an, um Ihr Gerät zu verbinden und Live-Daten, Fahrplan und Erlöse zu sehen.'}
          </p>
        </div>
      </div>
      <Card padding="lg" radius="lg">
        <div className="vp-empty">
          <IconTile category="solar" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
            <Icon name="sun" size={24} />
          </IconTile>
          <h3>{isAdmin ? 'Dieser Mandant hat noch keine Anlage' : 'Noch keine Anlage'}</h3>
          <p>
            {isAdmin
              ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheinen hier ihre Live-Daten, Marktpreise, Wetter und der Batterie-Fahrplan. Sie können im Namen des Mandanten eine Anlage anlegen.'
              : 'Eine Anlage bündelt Ihr Gerät, Live-Daten, Marktpreise, Wetter und den Batterie-Fahrplan. Danach verbinden Sie Ihr Gerät in wenigen Schritten.'}
          </p>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
            {isAdmin ? 'Anlage anlegen' : 'Erste Anlage anlegen'}
          </Button>
        </div>
      </Card>
      <AnlageAnlegenDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </>
  );
}

/**
 * Fleet mode: one tenant-wide overview request (30 s background poll like the
 * single-site widgets) renders the hero + status sentence + Anlagen cards. No
 * Ø-Preis KPI here (captain decision - meaningless across bidding zones);
 * price detail lives on each Anlage and on the Marktpreise page.
 */
