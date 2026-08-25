import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  ANLAGEN_BILD_BREITE,
  ANLAGEN_SPALTEN_X,
  ANLAGEN_ZONE,
  layoutAnlagenBild,
  type AnlagenBild as AnlagenBildModell,
  type AnlagenKnoten,
  type AnlagenSlot,
  type AnlagenZone,
} from '../anlagenBild';
import type { TypId } from '../anlegenFlow';
import './AnlagenBild.css';

export type AnlagenAddAuthority = 'portal' | 'box' | 'unknown';

export function AnlagenBild({
  bild,
  desktop,
  authority,
  selectedId,
  previewId,
  onSelect,
  onClosePreview,
  onAdd,
}: {
  bild: AnlagenBildModell;
  desktop: boolean;
  authority: AnlagenAddAuthority;
  selectedId: string | null;
  previewId: string | null;
  onSelect: (karteId: string) => void;
  onClosePreview: () => void;
  onAdd: (typ: TypId) => void;
}) {
  const [kommunikation, setKommunikation] = useState(false);
  const preview = bild.knoten.find((k) => k.karteId === previewId) ?? null;

  return (
    <section className="vp-ab" aria-label="Elektrisches Anlagenbild">
      <div className="vp-ab-toolbar">
        <p>
          Feste Leitungen zeigen die elektrische Zuordnung. Es werden keine Leistungsflüsse
          oder Richtungen dargestellt.
        </p>
        <button
          type="button"
          className="vp-ab-comm"
          aria-pressed={kommunikation}
          disabled={!bild.service}
          onClick={() => setKommunikation((offen) => !offen)}
        >
          <Icon name="link" size={16} />
          {kommunikation ? 'Verbindungen ausblenden' : 'Verbindungen anzeigen'}
        </button>
      </div>

      {desktop ? (
        <DesktopBild
          bild={bild}
          kommunikation={kommunikation}
          authority={authority}
          selectedId={selectedId}
          onSelect={onSelect}
          onAdd={onAdd}
        />
      ) : (
        <MobilerPfad
          bild={bild}
          kommunikation={kommunikation}
          authority={authority}
          selectedId={selectedId}
          onSelect={onSelect}
          onAdd={onAdd}
        />
      )}

      {preview && (
        <GeraeteVorschau
          knoten={preview}
          authority={authority}
          onClose={onClosePreview}
        />
      )}
    </section>
  );
}

function DesktopBild({
  bild,
  kommunikation,
  authority,
  selectedId,
  onSelect,
  onAdd,
}: {
  bild: AnlagenBildModell;
  kommunikation: boolean;
  authority: AnlagenAddAuthority;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (typ: TypId) => void;
}) {
  const layout = useMemo(() => layoutAnlagenBild(bild), [bild]);
  const knoten = new Map(bild.knoten.map((k) => [k.id, k]));
  const slots = new Map(bild.slots.map((s) => [s.id, s]));
  const mitteX = ANLAGEN_BILD_BREITE / 2;
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
          {kommunikation &&
            layout.items
              .filter((i) => i.art === 'knoten')
              .map((i) => (
                <line
                  key={`kommunikation-${i.id}`}
                  x1={mitteX}
                  y1={layout.serviceY + 27}
                  x2={i.x + i.w / 2}
                  y2={i.y + i.h / 2}
                  className="vp-ab-wire is-communication"
                />
              ))}
        </svg>

        {(['pv', 'storage', 'grid'] as AnlagenZone[]).map((zone) => {
          return (
            <div
              key={zone}
              className={`vp-ab-zone-label zone-${zone}`}
              style={{ left: ANLAGEN_SPALTEN_X[zone], top: 22 }}
            >
              <Icon name={ANLAGEN_ZONE[zone].icon} size={15} />
              {ANLAGEN_ZONE[zone].label}
            </div>
          );
        })}

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
          const style = { left: item.x, top: item.y, width: item.w, minHeight: item.h };
          if (item.art === 'slot') {
            const slot = slots.get(item.id);
            return slot ? (
              <Slot key={item.id} slot={slot} style={style} authority={authority} onAdd={onAdd} />
            ) : null;
          }
          const node = knoten.get(item.id);
          return node ? (
            <Knoten
              key={item.id}
              knoten={node}
              style={style}
              selected={node.karteId === selectedId}
              onSelect={onSelect}
            />
          ) : null;
        })}

        <div
          className={`vp-ab-service${kommunikation ? ' is-on' : ''}`}
          style={{ left: 26, top: layout.serviceY, width: layout.breite - 52 }}
        >
          <span className="vp-ab-service-icon"><Icon name="wifi" size={18} /></span>
          {bild.service ? (
            <span>
              <strong>Datenverbindung · {bild.service.titel}</strong>
              <small>{bild.service.zustand}</small>
            </span>
          ) : (
            <span>
              <strong>Datenverbindung nicht gemeldet</strong>
              <small>VoltPilot zeigt keine Kommunikationslinien ohne bekannte Box.</small>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

const MOBILE_ORDER: AnlagenZone[] = ['pv', 'storage', 'house', 'grid', 'consumer'];

function MobilerPfad({
  bild,
  kommunikation,
  authority,
  selectedId,
  onSelect,
  onAdd,
}: {
  bild: AnlagenBildModell;
  kommunikation: boolean;
  authority: AnlagenAddAuthority;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (typ: TypId) => void;
}) {
  return (
    <div className="vp-ab-mobile" data-testid="anlagenbild-mobil">
      {MOBILE_ORDER.map((zone) => {
        const knoten = bild.knoten.filter((k) => k.zone === zone);
        const slots = bild.slots.filter((s) => s.zone === zone);
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
                <Knoten
                  key={knoten.id}
                  knoten={knoten}
                  selected={knoten.karteId === selectedId}
                  onSelect={onSelect}
                  kommunikation={kommunikation}
                />
              ))}
              {slots.map((slot) => (
                <Slot key={slot.id} slot={slot} authority={authority} onAdd={onAdd} />
              ))}
            </div>
          </section>
        );
      })}
      {bild.service && (
        <div className={`vp-ab-mobile-service${kommunikation ? ' is-on' : ''}`}>
          <Icon name="wifi" size={17} />
          <span>
            <strong>Datenverbindung · {bild.service.titel}</strong>
            <small>{bild.service.zustand}</small>
          </span>
        </div>
      )}
    </div>
  );
}

function Knoten({
  knoten,
  selected,
  onSelect,
  style,
  kommunikation = false,
}: {
  knoten: AnlagenKnoten;
  selected: boolean;
  onSelect: (karteId: string) => void;
  style?: React.CSSProperties;
  kommunikation?: boolean;
}) {
  const live = knoten.werte[0] ?? null;
  return (
    <button
      type="button"
      className={`vp-ab-node zone-${knoten.zone} state-${knoten.zustand}${selected ? ' selected' : ''}`}
      style={style}
      aria-pressed={selected}
      data-anlagen-knoten={knoten.karteId}
      onClick={() => onSelect(knoten.karteId)}
    >
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
      {kommunikation && <span className="vp-ab-node-comm">Datenweg über VoltPilot-Box</span>}
    </button>
  );
}

function Slot({
  slot,
  authority,
  onAdd,
  style,
}: {
  slot: AnlagenSlot;
  authority: AnlagenAddAuthority;
  onAdd: (typ: TypId) => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`vp-ab-slot zone-${slot.zone}`}
      style={style}
      disabled={authority !== 'portal'}
      onClick={() => onAdd(slot.typ)}
      aria-describedby={authority !== 'portal' ? `${slot.id}-authority` : undefined}
    >
      <span className="vp-ab-slot-icon"><Icon name={slot.icon} size={17} /></span>
      <span>
        <strong>{slot.label}</strong>
        <small id={authority !== 'portal' ? `${slot.id}-authority` : undefined}>
          Optional
          {authority === 'box' && ' · an der Box verwaltet'}
          {authority === 'unknown' && ' · hier nicht freigegeben'}
        </small>
      </span>
    </button>
  );
}

function GeraeteVorschau({
  knoten,
  authority,
  onClose,
}: {
  knoten: AnlagenKnoten;
  authority: AnlagenAddAuthority;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const titleId = `vp-ab-preview-${knoten.karteId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  useEffect(() => {
    const vorher = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', key);
      vorher?.focus();
    };
  }, [knoten.karteId, onClose]);

  const trap = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const fokus = [...(panel.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (fokus.length === 0) return;
    const erstes = fokus[0];
    const letztes = fokus[fokus.length - 1];
    if (event.shiftKey && document.activeElement === erstes) {
      event.preventDefault();
      letztes.focus();
    } else if (!event.shiftKey && document.activeElement === letztes) {
      event.preventDefault();
      erstes.focus();
    }
  };

  return createPortal(
    <div className="vp-ab-preview-layer">
      <div className="vp-ab-preview-scrim" aria-hidden="true" onClick={onClose} />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="vp-ab-preview"
        onKeyDown={trap}
      >
        <div className="vp-ab-preview-grip" aria-hidden="true" />
        <header>
          <div>
            <span className="vp-ab-preview-kicker">{ANLAGEN_ZONE[knoten.zone].label}</span>
            <h2 id={titleId}>{knoten.titel}</h2>
            <p>{knoten.untertitel}</p>
          </div>
          <button type="button" className="vp-ab-preview-close" onClick={onClose} aria-label="Vorschau schließen">
            <Icon name="x" size={20} />
          </button>
        </header>

        <div className="vp-ab-preview-body">
          <p className={`vp-ab-preview-state state-${knoten.zustand}`}>
            <span aria-hidden="true" className="vp-ab-state-mark" />
            <strong>{knoten.zustandLabel}</strong>
            {knoten.zustandDetail && <span> · {knoten.zustandDetail}</span>}
          </p>
          <dl className="vp-ab-preview-facts">
            <div>
              <dt>Elektrischer Ort</dt>
              <dd>{ANLAGEN_ZONE[knoten.zone].label}</dd>
            </div>
            {knoten.verbindung && (
              <div>
                <dt>Verbindung</dt>
                <dd>{knoten.verbindung}</dd>
              </div>
            )}
          </dl>

          <section className="vp-ab-preview-values" aria-label="Letzte Werte">
            <h3>Letzte Werte</h3>
            {knoten.werte.length > 0 ? (
              <div className="vp-ab-preview-valuegrid">
                {knoten.werte.map((wert) => (
                  <div key={`${wert.label}:${wert.wert}`}>
                    <strong>{wert.wert}</strong>
                    <span>{wert.label}</span>
                    {wert.stand && <small>{wert.stand}</small>}
                  </div>
                ))}
              </div>
            ) : (
              <p>Keine aktuellen Werte gemeldet. Ein fehlender Wert wird nicht als 0 angezeigt.</p>
            )}
          </section>
        </div>

        <footer>
          {knoten.href ? (
            <a className="vp-btn vp-btn--primary vp-btn--md" href={knoten.href}>
              Gerät öffnen
            </a>
          ) : (
            <button type="button" className="vp-btn vp-btn--primary vp-btn--md" disabled>
              Gerät öffnen
            </button>
          )}
          <button
            type="button"
            className="vp-btn vp-btn--outline vp-btn--md"
            disabled
            aria-describedby={`${titleId}-edit-hint`}
          >
            Bearbeiten
          </button>
          <p id={`${titleId}-edit-hint`}>
            {authority === 'portal'
              ? 'Gerätebearbeitung folgt in einem eigenen, geprüften Schritt.'
              : authority === 'box'
                ? 'Dieses Gerät wird an Ihrer VoltPilot-Box verwaltet.'
                : 'Für diese Anlage ist keine Gerätebearbeitung freigegeben.'}
          </p>
        </footer>
      </aside>
    </div>,
    document.body,
  );
}
