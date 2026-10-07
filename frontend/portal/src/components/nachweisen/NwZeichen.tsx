import type { ReactNode } from 'react';
import './Nachweisen.css';

/**
 * Die Zeichen eines Teils (Konzept n1, Runde 2, `.zei`): gefüllt Navy = festgehalten, Ring = offen (noch nichts
 * festgehalten), Ring mit Punkt = ein Entwurf wartet, Warnton = eine Frist ist abgelaufen. Kein Zeichen heißt „gut“ oder
 * „erfüllt“ (G4); „trifft zurzeit nicht zu“ zählt wie festgehalten - es IST festgehalten, mit Satz und Person.
 */
export type ZeichenArt = 'festgehalten' | 'offen' | 'entwurf' | 'ueber';

export const ZEICHEN_WORT: Record<ZeichenArt, string> = {
  festgehalten: 'festgehalten',
  offen: 'offen',
  entwurf: 'Entwurf wartet',
  ueber: 'überfällig',
};

/** Ein Zeichen; `stumm` in einer Reihe, deren Bedeutung schon daneben in Worten steht. */
export function NwZeichen({ art, stumm = false }: { art: ZeichenArt; stumm?: boolean }) {
  const klasse = `vp-nw-zei is-${art}`;
  return stumm ? (
    <span className={klasse} aria-hidden="true" />
  ) : (
    <span className={klasse} role="img" aria-label={ZEICHEN_WORT[art]} />
  );
}

/** Die Legende der Zeichen in einer Zeile (`.zlg`); nur die Arten, die auf der Seite vorkommen. */
export function NwZeichenLegende({ arten }: { arten: readonly ZeichenArt[] }) {
  return (
    <p className="vp-nw-zlg" data-testid="zeichen-legende">
      {arten.map((art) => (
        <span key={art}>
          <NwZeichen art={art} stumm />
          {ZEICHEN_WORT[art]}
        </span>
      ))}
    </p>
  );
}

/**
 * Der Zähler-Chip (`.zchip`): die Antwort einer Startseite als Zahl und kurzes Wort („4 Teile offen“, „6 Fristen
 * überfällig“) - gezählt wird nur, was offen, überfällig oder wartend ist, nie das Ganze (Entscheid 3, G4). Antippbar,
 * wenn er ein Blatt oder eine Stelle öffnet.
 */
export function ZaehlerChip({
  anzahl,
  wort,
  zeichen,
  ton = 'normal',
  onClick,
  blatt = false,
  testId,
}: {
  anzahl: number;
  wort: ReactNode;
  zeichen?: ZeichenArt;
  /** `warn` nur für Abgelaufenes; `still` für einen Zähler ohne Handlungsbedarf. */
  ton?: 'normal' | 'warn' | 'still';
  onClick?: () => void;
  /** Der Chip öffnet ein Blatt (sonst springt er zu einer Stelle der Seite). */
  blatt?: boolean;
  testId?: string;
}) {
  const klasse = `vp-nw-zchip${ton === 'normal' ? '' : ` is-${ton}`}`;
  const inhalt = (
    <>
      {zeichen && <NwZeichen art={zeichen} stumm />}
      <b>{anzahl}</b>
      {wort}
    </>
  );
  return onClick ? (
    <button type="button" className={klasse} onClick={onClick} aria-haspopup={blatt ? 'dialog' : undefined} data-testid={testId}>
      {inhalt}
    </button>
  ) : (
    <span className={klasse} data-testid={testId}>
      {inhalt}
    </span>
  );
}
