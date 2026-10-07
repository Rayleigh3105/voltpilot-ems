import type { MouseEvent, ReactNode } from 'react';
import { FristDatum } from '../FristDatum';
import { NwSymbol } from './NwSymbol';
import { datumsblock, kuerzelAus, type DatumTon } from './nwBild';
import './NwZeilen.css';

/**
 * Die Zeilen-Bausteine von Nachweisen (Konzept n1 Runde 2, §0.3 Regel 2 „Ein Fakt je Zeile“, §12): jede Karte und jede
 * Zeile trägt einen Titel und höchstens einen Fakt; ein Datum steht als Datumsblock, eine Person als Kürzel; wo etwas zu
 * tun ist, steht das Verb in derselben Zeile. Die ganze Zeile ist das Tippziel (mindestens 52 px hoch).
 */

/** Wohin eine Zeile führt: ein Klick, eine Adresse - oder nichts (dann ist sie nur Text). */
type Ziel = { onClick?: () => void; href?: string };

function ZielHuelle({ ziel, className, label, testId, children }: { ziel: Ziel; className: string; label?: string; testId?: string; children: ReactNode }) {
  if (ziel.href) {
    const klick = ziel.onClick
      ? (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          ziel.onClick?.();
        }
      : undefined;
    return (
      <a className={className} href={ziel.href} onClick={klick} aria-label={label} data-testid={testId}>
        {children}
      </a>
    );
  }
  if (ziel.onClick) {
    return (
      <button type="button" className={className} onClick={ziel.onClick} aria-label={label} data-testid={testId}>
        {children}
      </button>
    );
  }
  return (
    <div className={className} data-testid={testId}>
      {children}
    </div>
  );
}

const Pfeil = () => (
  <span className="vp-nw-chev" aria-hidden="true">
    <NwSymbol name="chevron-right" size={16} />
  </span>
);

/** Eine Karte mit Kopf (`.card` + `.blockkopf`): Titel, leise eine Zahl, rechts höchstens ein Weg. */
export function NwKarte({
  titel,
  zahl,
  rechts,
  children,
  className,
  testId,
}: {
  titel: ReactNode;
  zahl?: string | number | null;
  rechts?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`vp-nw-karte${className ? ` ${className}` : ''}`} data-testid={testId}>
      <div className="vp-nw-kk">
        <h2>{titel}</h2>
        {zahl !== undefined && zahl !== null && <span className="vp-nw-kk-zahl">{zahl}</span>}
        {rechts}
      </div>
      {children}
    </section>
  );
}

/** Kleine Überschrift über Zeilen außerhalb einer Karte (`.subhead`): „AUDITS“, „FREIGEGEBEN“. */
export function Unterkopf({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <h2 className="vp-nw-unterkopf" data-testid={testId}>
      {children}
    </h2>
  );
}

/** Eine Liste von Zeilen (`.anl`): Trennlinie zwischen den Zeilen, keine über der ersten. */
export function NwZeilen({ children, label, testId }: { children: ReactNode; label?: string; testId?: string }) {
  return (
    <div className="vp-nw-zeilen" role={label ? 'group' : undefined} aria-label={label} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * Eine Zeile ohne Datumsblock (`.row`): vorn ein Zeichen, eine Nummer oder ein Kürzel, dann der Titel (darunter
 * höchstens ein leiser Fakt), rechts ein Zustand oder Wert, am Ende ein Verb oder der Pfeil.
 */
export function NwZeile({
  vorn,
  titel,
  unter,
  rechts,
  verb,
  warn = false,
  leise = false,
  kurz = false,
  pfeil,
  label,
  testId,
  ...ziel
}: Ziel & {
  vorn?: ReactNode;
  titel: ReactNode;
  /** Ein langer Titel (ein Wortlaut) wird auf zwei Zeilen gekürzt; der volle steht im Blatt. */
  kurz?: boolean;
  unter?: ReactNode;
  rechts?: ReactNode;
  /** Das Verb des Zustands („Festhalten“, „Planen“) statt des Pfeils. */
  verb?: string;
  warn?: boolean;
  leise?: boolean;
  /** Ohne Angabe: Pfeil, wenn die Zeile irgendwohin führt und kein Verb trägt. */
  pfeil?: boolean;
  label?: string;
  testId?: string;
}) {
  const mitPfeil = pfeil ?? (!verb && !!(ziel.onClick || ziel.href));
  return (
    <ZielHuelle ziel={ziel} className={`vp-nw-zl${warn ? ' is-warn' : ''}${leise ? ' is-leise' : ''}`} label={label} testId={testId}>
      {vorn}
      <span className="vp-nw-zl-text">
        <span className={`vp-nw-zl-titel${kurz ? ' is-kurz' : ''}`}>{titel}</span>
        {unter && <span className="vp-nw-zl-unter">{unter}</span>}
      </span>
      {rechts}
      {verb && <span className="vp-nw-verb">{verb}</span>}
      {mitPfeil && <Pfeil />}
    </ZielHuelle>
  );
}

/** Ein Fakt rechts in der Zeile (`.rm`): leise, ein bis drei Wörter. */
export function Fakt({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <span className={`vp-nw-fakt${warn ? ' is-warn' : ''}`}>{children}</span>;
}

/** Zustand rechts in der Zeile (`.zst`): Zeichen und Wort („✓ 20.03.“, „◷ läuft“). */
export function ZeilenZustand({ zeichen, children, ton }: { zeichen?: ReactNode; children: ReactNode; ton?: 'warn' | 'leise' }) {
  return (
    <span className={`vp-nw-zst${ton ? ` is-${ton}` : ''}`}>
      {zeichen}
      {children}
    </span>
  );
}

/** Die Nummer eines Beschlusses vorn in der Zeile (`.nr.b`). */
export function Nummer({ nr }: { nr: number | string }) {
  return (
    <span className="vp-nw-nr" aria-hidden="true">
      {nr}
    </span>
  );
}

/** Eine Liste von Zeilen mit Datumsblock (`.fzl`). */
export function NwFristZeilen({ children, label, testId }: { children: ReactNode; label?: string; testId?: string }) {
  return (
    <div className="vp-nw-fzl" role={label ? 'group' : undefined} aria-label={label} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * Eine Zeile mit Datumsblock (`.fz`): der Tag als Block („bis 22.01.2030“), Titel (auf zwei Zeilen gekürzt, wo der
 * Wortlaut eines Kunden der Titel ist), darunter höchstens ein Fakt; rechts Kürzel, ein Wort oder das Verb.
 * `symbol` ersetzt den Datumsblock durch ein Zeichen im selben Feld (abgeschlossene Feststellung).
 */
export function NwFristZeile({
  datum,
  symbol,
  titel,
  unter,
  rechts,
  verb,
  kurz = false,
  pfeil,
  label,
  testId,
  ...ziel
}: Ziel & {
  datum?: { wort: string; tag: string | null | undefined; ton?: DatumTon } | null;
  symbol?: ReactNode;
  titel: ReactNode;
  unter?: ReactNode;
  rechts?: ReactNode;
  verb?: string;
  /** Den Titel auf zwei Zeilen kürzen (Wortlaut eines Kunden). */
  kurz?: boolean;
  pfeil?: boolean;
  label?: string;
  testId?: string;
}) {
  const block = datum ? datumsblock(datum.wort, datum.tag) : null;
  const mitPfeil = pfeil ?? (!verb && !!(ziel.onClick || ziel.href));
  return (
    <ZielHuelle ziel={ziel} className="vp-nw-fz" label={label} testId={testId}>
      {block ? (
        <FristDatum {...block} ton={datum?.ton ?? 'bald'} />
      ) : symbol ? (
        <span className="vp-fd vp-nw-fd-symbol" aria-hidden="true">
          {symbol}
        </span>
      ) : null}
      <span className="vp-nw-fz-text">
        <span className={`vp-nw-fz-titel${kurz ? ' is-kurz' : ''}`}>{titel}</span>
        {unter && <span className="vp-nw-fz-unter">{unter}</span>}
      </span>
      {rechts}
      {verb && <span className="vp-nw-verb">{verb}</span>}
      {mitPfeil && <Pfeil />}
    </ZielHuelle>
  );
}

/** Eine Person mit Kürzel und Namen (für Vorleser und am Rechner als Titel beim Darüberfahren). */
export type KuerzelPerson = { name: string; kuerzel?: string | null };

/**
 * Personen als Kürzel statt Namen in jeder Zeile (`.avs`): „IK“, „IK MD PH“. Vorleser hören die Namen; am Rechner
 * zeigt das Darüberfahren sie. Eine Person ohne Namen bekommt kein erfundenes Kürzel.
 */
export function Kuerzel({ personen, testId }: { personen: KuerzelPerson[]; testId?: string }) {
  const mit = personen.filter((p) => p.name || p.kuerzel);
  if (!mit.length) return null;
  const namen = mit.map((p) => p.name).join(', ');
  return (
    <span className="vp-nw-avs" role="img" aria-label={namen} title={namen} data-testid={testId}>
      {mit.map((p, i) => (
        <span key={`${p.name}-${i}`} className="vp-nw-avs-pi" aria-hidden="true">
          {p.kuerzel || kuerzelAus(p.name)}
        </span>
      ))}
    </span>
  );
}
