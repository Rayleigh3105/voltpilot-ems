import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';
import type { MenueEintrag } from '../ortArchiv';
import './OrtMenue.css';

const ICON: Record<MenueEintrag['art'], IconName> = {
  archivieren: 'history',
  archivieren_gesperrt: 'alert-triangle',
  wiederherstellen: 'refresh-cw',
  wiederherstellen_gesperrt: 'info',
  loeschen: 'trash',
  loeschen_gesperrt: 'info',
  verschieben: 'map-pin',
  verschieben_gesperrt: 'info',
};

/**
 * Das Menü je Knoten im Ortsbaum (UEMS AP-02 IP-15): Standort · Gebäude · Bereich, auch am
 * archivierten Knoten. Die Einträge kommen fertig aus `menueEintraege` (`ortArchiv.ts`).
 *
 * Bewusst KEIN `role="menu"`: das Menü trägt neben Knöpfen auch Hinweise ohne Handlung („Löschen
 * geht nicht: … hat Historie“) — ein Menü darf nur Menüpunkte enthalten. Es ist eine
 * Aufklapp-Gruppe: der Knopf sagt `aria-expanded`, der Fokus springt auf den ersten Knopf der
 * Gruppe, Escape schließt und gibt ihn zurück. Platziert wie `RowMenu` (fest am Knopf, in
 * `document.body`, an den Rand geklemmt), damit keine Karte das Menü abschneidet.
 */
export function OrtMenue({
  name,
  eintraege,
  onWahl,
}: {
  name: string;
  eintraege: MenueEintrag[];
  /** Der Auslöser kommt mit, damit der Fokus nach dem Dialog dorthin zurückkehrt. */
  onWahl: (eintrag: MenueEintrag, ausloeser: HTMLElement) => void;
}) {
  const [offen, setOffen] = useState(false);
  const [lage, setLage] = useState<{ top: number; left: number } | null>(null);
  const knopf = useRef<HTMLButtonElement>(null);
  const gruppe = useRef<HTMLDivElement>(null);
  const id = `vp-om-${useId().replace(/:/g, '')}`;

  const platziere = useCallback(() => {
    const k = knopf.current;
    const g = gruppe.current;
    if (!k || !g) return;
    const r = k.getBoundingClientRect();
    const rand = 12;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(rand, Math.min(r.right - g.offsetWidth, vw - g.offsetWidth - rand));
    let top = r.bottom + 4;
    if (top + g.offsetHeight > vh - rand && r.top - 4 - g.offsetHeight > rand) top = r.top - 4 - g.offsetHeight;
    setLage({ top: Math.max(rand, Math.min(top, vh - g.offsetHeight - rand)), left });
  }, []);

  function schliessen(fokusZurueck: boolean) {
    setOffen(false);
    setLage(null);
    if (fokusZurueck) knopf.current?.focus();
  }

  useLayoutEffect(() => {
    if (offen) platziere();
  }, [offen, platziere]);

  useEffect(() => {
    if (!offen) return;
    const erster = gruppe.current?.querySelector('button');
    erster?.focus();
    const neu = () => platziere();
    const taste = (e: KeyboardEvent) => {
      if (e.key === 'Escape') schliessen(true);
    };
    window.addEventListener('scroll', neu, true);
    window.addEventListener('resize', neu);
    window.addEventListener('keydown', taste);
    return () => {
      window.removeEventListener('scroll', neu, true);
      window.removeEventListener('resize', neu);
      window.removeEventListener('keydown', taste);
    };
  }, [offen, platziere]);

  if (eintraege.length === 0) return null;

  return (
    <>
      <button
        ref={knopf}
        type="button"
        className="vp-ob-bearbeiten vp-om-knopf"
        aria-label={`Aktionen: ${name}`}
        aria-expanded={offen}
        aria-controls={offen ? id : undefined}
        onClick={() => (offen ? schliessen(false) : setOffen(true))}
      >
        <Icon name="more-horizontal" size={18} />
      </button>
      {offen &&
        createPortal(
          <>
            <div className="vp-rowmenu-scrim" onClick={() => schliessen(false)} />
            <div
              ref={gruppe}
              id={id}
              role="group"
              aria-label={`Aktionen: ${name}`}
              className="vp-rowmenu-pop vp-om-pop"
              style={lage ? { top: lage.top, left: lage.left, visibility: 'visible' } : { top: 0, left: 0, visibility: 'hidden' }}
            >
              {eintraege.map((e) =>
                e.knopf ? (
                  <button
                    key={e.art}
                    type="button"
                    className={e.art === 'loeschen' ? 'danger' : e.art === 'archivieren_gesperrt' ? 'vp-om-gesperrt' : undefined}
                    onClick={() => {
                      const von = knopf.current;
                      schliessen(false);
                      if (von) onWahl(e, von);
                    }}
                  >
                    <Icon name={ICON[e.art]} size={16} />
                    <span className="vp-om-text">
                      <span>{e.text}</span>
                      {e.art === 'archivieren_gesperrt' && <span className="vp-om-grund">{e.grund}</span>}
                    </span>
                  </button>
                ) : (
                  <p key={e.art} className="vp-om-hinweis" data-testid={`hinweis-${e.art}`}>
                    <Icon name={ICON[e.art]} size={16} />
                    <span>{e.text}</span>
                  </p>
                ),
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
