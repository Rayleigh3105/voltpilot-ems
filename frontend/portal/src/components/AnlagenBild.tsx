import { Recht } from './Recht';
import { useMemo } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  ANLAGEN_SPALTEN_X,
  ANLAGEN_ZONE,
  layoutAnlagenBild,
  type AnlagenBild as AnlagenBildModell,
  type AnlagenKnoten,
  type AnlagenZone,
  type DatenService,
} from '../anlagenBild';
import type { AdoptableSource } from '../rollen';
import './AnlagenBild.css';

/**
 * Das elektrische Anlagenbild als NAVIGATIONS-Fläche (Captain-Auftrag
 * 27.08.2026): ein echtes Gerät IST ein Link auf seine Detailseite, die
 * Datenverbindungs-Karte der Box führt auf die Box-Seite. Es gibt keine
 * Detail-Seitenleiste, keine inline „hinzufügen"-Plätze und keinen
 * „Verbindungen anzeigen"-Schalter mehr.
 *
 * Auf zeiger-fähigen Geräten (Rechner) blendet ein Gerät die zusätzlichen
 * Angaben aus der früheren Seitenleiste als **zurückhaltende Hover-Fläche** ein
 * (dieselbe Fläche erscheint bei Tastaturfokus); sie fängt die Navigation nie
 * ab und bleibt im Bild. Auf Touch/Telefon gibt es KEINE Hover-Ersatzfläche —
 * ein Tipp öffnet direkt die Geräteseite, wo die vollständigen Angaben stehen.
 */
export function AnlagenBild({
  bild,
  desktop,
  onAssign,
}: {
  bild: AnlagenBildModell;
  desktop: boolean;
  /** Ein noch nicht übernommenes Gerät führt in einem Zug in die Zuordnung. */
  onAssign: (source: AdoptableSource) => void;
}) {
  return (
    <section className="vp-ab" aria-label="Elektrisches Anlagenbild">
      <p className="vp-ab-intro">
        Feste Leitungen zeigen die elektrische Zuordnung. Es werden keine Leistungsflüsse
        oder Richtungen dargestellt.
      </p>

      {desktop ? (
        <DesktopBild bild={bild} onAssign={onAssign} />
      ) : (
        <MobilerPfad bild={bild} onAssign={onAssign} />
      )}
    </section>
  );
}

function DesktopBild({
  bild,
  onAssign,
}: {
  bild: AnlagenBildModell;
  onAssign: (source: AdoptableSource) => void;
}) {
  const layout = useMemo(() => layoutAnlagenBild(bild), [bild]);
  const knoten = new Map(bild.knoten.map((k) => [k.id, k]));
  const consumerY = layout.items.find((i) => i.zone === 'consumer')?.y ?? layout.busY + 84;

  return (
    <div className="vp-ab-desktop-scroll">
      <div
        className="vp-ab-desktop"
        style={{ width: layout.breite, height: layout.hoehe }}
        data-testid="anlagenbild-desktop"
      >
        <svg
          viewBox={`0 0 ${layout.breite} ${layout.hoehe}`}
          className="vp-ab-wires"
          aria-hidden="true"
        >
          {layout.linien.map((linie) => (
            <line
              key={linie.id}
              x1={linie.x1}
              y1={linie.y1}
              x2={linie.x2}
              y2={linie.y2}
              className={`vp-ab-wire is-${linie.art}`}
            />
          ))}
        </svg>

        {(['pv', 'storage', 'grid'] as AnlagenZone[]).map((zone) => (
          <div
            key={zone}
            className={`vp-ab-zone-label zone-${zone}`}
            style={{ left: ANLAGEN_SPALTEN_X[zone], top: 22 }}
          >
            <Icon name={ANLAGEN_ZONE[zone].icon} size={15} />
            {ANLAGEN_ZONE[zone].label}
          </div>
        ))}

        <div
          className="vp-ab-zone-label zone-consumer"
          style={{
            left: ANLAGEN_SPALTEN_X.consumer,
            top: consumerY - 28,
          }}
        >
          <Icon name={ANLAGEN_ZONE.consumer.icon} size={15} />
          {ANLAGEN_ZONE.consumer.label}
        </div>

        <div
          className="vp-ab-househub"
          style={{ left: 534, top: layout.busY - 35 }}
          aria-label="Hausverteilung"
        >
          <Icon name="home" size={19} />
          <span>
            <strong>Hausverteilung</strong>
            <small>gemeinsamer elektrischer Bus</small>
          </span>
        </div>

        {layout.items.map((item) => {
          const node = knoten.get(item.id);
          if (!node) return null;
          return (
            <Knoten
              key={item.id}
              knoten={node}
              style={{ left: item.x, top: item.y, width: item.w, minHeight: item.h }}
              onAssign={onAssign}
            />
          );
        })}

        <ServiceKarte
          service={bild.service}
          style={{ left: 26, top: layout.serviceY, width: layout.breite - 52 }}
        />
      </div>
    </div>
  );
}

const MOBILE_ORDER: AnlagenZone[] = ['pv', 'storage', 'house', 'grid', 'consumer'];

function MobilerPfad({
  bild,
  onAssign,
}: {
  bild: AnlagenBildModell;
  onAssign: (source: AdoptableSource) => void;
}) {
  return (
    <div className="vp-ab-mobile" data-testid="anlagenbild-mobil">
      {MOBILE_ORDER.map((zone) => {
        const knoten = bild.knoten.filter((k) => k.zone === zone);
        return (
          <section key={zone} className={`vp-ab-mobile-zone zone-${zone}`} aria-label={ANLAGEN_ZONE[zone].label}>
            <h3>
              <Icon name={ANLAGEN_ZONE[zone].icon} size={16} />
              {ANLAGEN_ZONE[zone].label}
            </h3>
            <div className="vp-ab-mobile-items">
              {zone === 'house' && (
                <div className="vp-ab-mobile-hub">
                  <strong>Hausverteilung</strong>
                  <span>gemeinsamer elektrischer Pfad</span>
                </div>
              )}
              {knoten.map((knoten) => (
                <Knoten key={knoten.id} knoten={knoten} onAssign={onAssign} mobil />
              ))}
            </div>
          </section>
        );
      })}
      <ServiceKarte service={bild.service} mobil />
    </div>
  );
}

/**
 * Ein Gerät. Ein echtes Gerät (mit Detailseite) ist ein LINK — ein Klick oder
 * Enter/Space führt direkt dorthin, nie in eine Seitenleiste. Ein noch nicht
 * übernommenes Gerät („neu") trägt stattdessen die Übernahme-Aktion.
 *
 * Auf dem Rechner (nicht `mobil`) zeigt eine Hover-/Fokus-Fläche die
 * zusätzlichen Angaben; sie ist `pointer-events: none` und fängt die
 * Navigation deshalb nie ab.
 */
function Knoten({
  knoten,
  style,
  onAssign,
  mobil = false,
}: {
  knoten: AnlagenKnoten;
  style?: React.CSSProperties;
  onAssign: (source: AdoptableSource) => void;
  mobil?: boolean;
}) {
  const live = knoten.werte.find((wert) => wert.zone === knoten.zone) ?? null;
  const hoverOben = knoten.zone === 'house' || knoten.zone === 'consumer';
  const cls = `vp-ab-node zone-${knoten.zone} state-${knoten.zustand}${
    hoverOben ? ' is-hover-above' : ''
  }`;
  const hoverId = mobil
    ? undefined
    : `vp-ab-hover-${knoten.karteId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  // Das explizite Label ersetzt den sichtbaren Nachfahren-Text. Es MUSS daher
  // die wesentlichen sichtbaren Fakten selbst tragen — auch auf Touch, wo es
  // absichtlich keinen Tooltip/Info-Ersatz gibt.
  const rollenLabel = knoten.nebenrollen.map((rolle) =>
    rolle === 'storage' ? 'Speicher integriert' : ANLAGEN_ZONE[rolle].label,
  );
  const liveLabel = live
    ? `${knoten.zone === 'pv' ? 'PV-Produktion' : live.label}: ${live.wert}`
    : null;
  const ariaLabel = [
    knoten.titel,
    knoten.untertitel,
    liveLabel,
    ...rollenLabel,
    knoten.zustandLabel,
    knoten.zustandDetail,
  ].filter(Boolean).join(', ');

  const inhalt = (
    <>
      <span className="vp-ab-node-top">
        <span className="vp-ab-node-title">{knoten.titel}</span>
        {live && <span className="vp-ab-node-live">{live.wert}</span>}
      </span>
      <span className="vp-ab-node-type">{knoten.untertitel}</span>
      <span className="vp-ab-node-state">
        <span aria-hidden="true" className="vp-ab-state-mark" />
        <strong>{knoten.zustandLabel}</strong>
        {knoten.zustandDetail && <span> · {knoten.zustandDetail}</span>}
      </span>
      {/* Ein Hybrid zeigt seine Speicher-/Netz-Rolle sichtbar an seiner
          PV-Darstellung — das physische Gerät steht nie zweimal im Bild. */}
      {knoten.nebenrollen.length > 0 && (
        <span className="vp-ab-node-roles">
          {knoten.nebenrollen.map((rolle) => (
            <span key={rolle} className={`vp-ab-role zone-${rolle}`}>
              {rolle === 'storage' ? 'Speicher integriert' : ANLAGEN_ZONE[rolle].label}
            </span>
          ))}
        </span>
      )}
      {hoverId && <HoverFlaeche knoten={knoten} id={hoverId} />}
    </>
  );

  if (knoten.href) {
    return (
      <a
        className={cls}
        style={style}
        href={knoten.href}
        data-anlagen-knoten={knoten.karteId}
        aria-label={ariaLabel}
        aria-describedby={hoverId}
      >
        {inhalt}
      </a>
    );
  }
  if (knoten.quelle) {
    return (
      <Recht aktion="geraet.einrichten"><button
        type="button"
        className={cls}
        style={style}
        data-anlagen-knoten={knoten.karteId}
        aria-label={`${ariaLabel}, jetzt zuordnen`}
        aria-describedby={hoverId}
        onClick={() => onAssign(knoten.quelle as AdoptableSource)}
      >
        {inhalt}
      </button></Recht>
    );
  }
  // Weder Detailseite noch Übernahme (selten): eine ruhige, nicht-interaktive
  // Kachel statt eines Links ins Leere.
  return (
    <div className={cls} style={style} data-anlagen-knoten={knoten.karteId}>
      {inhalt}
    </div>
  );
}

/**
 * Die zurückhaltende Hover-/Fokus-Fläche mit den Angaben, die früher in der
 * Seitenleiste standen: elektrischer Ort, Verbindung, letzte Werte. Sie ist
 * per `aria-describedby` mit dem Gerät verknüpft, damit sie bei Tastaturfokus
 * angesagt wird.
 */
function HoverFlaeche({ knoten, id }: { knoten: AnlagenKnoten; id: string }) {
  return (
    <span className="vp-ab-hover" role="tooltip" id={id}>
      <span className="vp-ab-hover-head">
        <span className="vp-ab-hover-kicker">{ANLAGEN_ZONE[knoten.zone].label}</span>
        <span className={`vp-ab-hover-state state-${knoten.zustand}`}>
          <span aria-hidden="true" className="vp-ab-state-mark" />
          <strong>{knoten.zustandLabel}</strong>
          {knoten.zustandDetail && <span> · {knoten.zustandDetail}</span>}
        </span>
      </span>
      {knoten.verbindung && <span className="vp-ab-hover-conn">{knoten.verbindung}</span>}
      {knoten.werte.length > 0 ? (
        <span className="vp-ab-hover-values">
          {knoten.werte.map((wert) => (
            <span key={`${wert.label}:${wert.wert}`} className="vp-ab-hover-value">
              <strong>{wert.wert}</strong>
              <span>{wert.label}</span>
              {wert.stand && <small>{wert.stand}</small>}
            </span>
          ))}
        </span>
      ) : (
        <span className="vp-ab-hover-empty">
          Keine aktuellen Werte gemeldet. Ein fehlender Wert wird nicht als 0 angezeigt.
        </span>
      )}
    </span>
  );
}

/**
 * Die Datenverbindungs-Karte der Box — ein LINK auf die Box-Seite, wie eine
 * Geräte-Karte. Sie zeigt die lokale Netz-Adresse (NIE eine WAN-Adresse) und
 * den installierten Software-Stand; fehlende Angaben werden ehrlich benannt.
 */
function ServiceKarte({
  service,
  style,
  mobil = false,
}: {
  service: DatenService | null;
  style?: React.CSSProperties;
  mobil?: boolean;
}) {
  const cls = mobil ? 'vp-ab-mobile-service' : 'vp-ab-service';
  if (!service) {
    return (
      <div className={cls} style={style}>
        <span className="vp-ab-service-icon"><Icon name="wifi" size={18} /></span>
        <span className="vp-ab-service-body">
          <strong>Datenverbindung nicht gemeldet</strong>
          <small>VoltPilot zeigt keine Datenverbindung ohne bekannte Box.</small>
        </span>
      </div>
    );
  }

  const inhalt = (
    <>
      <span className="vp-ab-service-icon"><Icon name="wifi" size={18} /></span>
      <span className="vp-ab-service-body">
        <strong>Datenverbindung · {service.titel}</strong>
        <small>{service.zustand}</small>
        <span className="vp-ab-service-facts">
          <span className="vp-ab-service-fact">
            <span className="k">Im Netzwerk</span>
            <span className={`v${service.lan.mono ? ' vp-mono' : ''}`}>{service.lan.wert}</span>
          </span>
          <span className="vp-ab-service-fact">
            <span className="k">Software</span>
            <span className={`v${service.version.bekannt ? ' vp-mono' : ''}`}>{service.version.wert}</span>
          </span>
        </span>
      </span>
      {service.href && (
        <span className="vp-ab-service-go" aria-hidden="true">
          <Icon name="chevron-right" size={18} />
        </span>
      )}
    </>
  );

  if (service.href) {
    const label =
      `Datenverbindung zu VoltPilot: ${service.titel}, ${service.zustand}. ` +
      `Adresse im Netzwerk: ${service.lan.wert}. Software: ${service.version.wert}.`;
    return (
      <a className={cls} style={style} href={service.href} aria-label={label}>
        {inhalt}
      </a>
    );
  }
  return (
    <div className={cls} style={style}>
      {inhalt}
    </div>
  );
}
