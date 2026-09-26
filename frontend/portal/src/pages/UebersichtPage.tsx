import { Recht } from '../components/Recht';
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { type Betriebsart, type Device, type Site } from '../api';
import { isFleetShell } from '../betriebsart';
import { anlageRoute, type Route } from '../nav';
import { AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawer';
import { PortfolioCockpit } from '../components/PortfolioCockpit';
import { StandortVorschlagHinweis } from '../components/StandortVorschlagHinweis';
import { AnlageSeite } from './AnlagenPage';
import { anlageLeertext } from '../anlegeNurMessen';
import { useAnlegeArt } from '../useAnlegeArt';

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
 * Die ADAPTIVE Übersichts-Landung der ENDKUNDEN-Schale: mit EINER Anlage IST
 * die Übersicht die Anlagen-Seite (ihre ganze Welt ist eine Anlage, keine
 * doppelten Hero-Blöcke); ab zwei Anlagen rendert sie das gemeinsame
 * {@link PortfolioCockpit} in seiner KOMFORTABLEN Dichte.
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
  // übergegangen; seit dem 25.09.2026 zeigt es für jede Betriebsart dieselben
  // vier Blöcke - die Betriebsart entscheidet hier nur, OB die Flotten-Ebene
  // gilt (`isFleetShell`).
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
      onReload={props.onReload}
      isAdmin={props.isAdmin}
      titel="Meine Anlagen"
      // UEMS AP-02 IP-10/O18: die Vorschlagskarte der Standorte, nur mit Recht und offenen Vorschlägen.
      hinweis={({ anwendungen, neuLaden }) => (
        <StandortVorschlagHinweis
          sites={props.sites}
          isAdmin={props.isAdmin ?? false}
          betriebsart={props.betriebsart ?? null}
          anwendungen={anwendungen}
          onBestaetigt={() => {
            neuLaden();
            props.onReload();
          }}
        />
      )}
    />
  );
}

/** Empty-state: onboarding entry for customers, neutral notice for admins. */
function UebersichtEmpty({ onReload, isAdmin = false }: UebersichtProps) {
  const [siteDrawer, setSiteDrawer] = useState(false);
  const anlegeArt = useAnlegeArt();
  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>{isAdmin ? 'Übersicht' : 'Willkommen bei VoltPilot'}</h1>
          <p>
            {isAdmin
              ? 'Dieser Mandant hat noch keine Anlage.'
              : anlageLeertext(
                  anlegeArt,
                  'Legen Sie Ihre Anlage an, um Ihr Gerät zu verbinden und Live-Daten, Fahrplan und Erlöse zu sehen.',
                  'Legen Sie Ihre Anlage an, um Ihr Gerät zu verbinden und ihre Messwerte zu sehen.',
                )}
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
              : anlageLeertext(
                  anlegeArt,
                  'Eine Anlage bündelt Ihr Gerät, Live-Daten, Marktpreise, Wetter und den Batterie-Fahrplan. Danach verbinden Sie Ihr Gerät in wenigen Schritten.',
                  'Eine Anlage bündelt Ihr Gerät und seine Messwerte. Danach verbinden Sie Ihr Gerät in wenigen Schritten.',
                )}
          </p>
          <Recht aktion="anlage.verwalten"><Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
            {isAdmin ? 'Anlage anlegen' : 'Erste Anlage anlegen'}
          </Button></Recht>
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
