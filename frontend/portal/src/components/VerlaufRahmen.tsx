/**
 * Die gemeinsamen BAUSTEINE der Verlauf-Reiter Energie · Erlöse · Messwerte
 * (Konzept „Verlauf-Rework", Paket P1).
 *
 * - {@link VerlaufStatus}: EINE Statuszeile je Seite statt eines
 *   Herkunfts-Abzeichens an jeder Karte (Leitlinie „Herkunft einmal").
 * - {@link Kennzahlen}/{@link Kennzahl}: die Zahlen des Zeitraums in einer
 *   Zeile, jede mit Einheit; Erklärungen hängen als ⓘ am Begriff.
 * - {@link VrKarte}, {@link VrUmschalter}, {@link VrLegende}: ruhige Karten mit
 *   Titel links und Bedienung rechts; die Legende ist zugleich Schalter.
 *
 * Reine Render-Bausteine: Zahlen, Wörter und Zustände kommen fertig aus den
 * Ableitungen der Seiten.
 */
import type { CSSProperties, ReactNode } from 'react';
import { InfoTip } from './InfoTip';
import './VerlaufRahmen.css';

/** Eine Erklärung auf Abruf: Titel und ein bis zwei Sätze. */
export interface Erklaerung {
  titel: string;
  text: ReactNode;
}

export function Erklaert({ info }: { info: Erklaerung | null | undefined }) {
  if (!info) return null;
  return (
    <InfoTip title={info.titel} label={`Erklärung: ${info.titel}`}>
      {info.text}
    </InfoTip>
  );
}

/**
 * Die Statuszeile: woraus die Zahlen der Seite entstehen, wie vollständig
 * der Zeitraum ist und womit verglichen wird. Sie steht genau einmal, direkt
 * unter der Zeitleiste.
 */
export function VerlaufStatus({
  art,
  laeuft,
  aufloesung,
  abdeckung,
  vergleich,
  alt,
  info,
}: {
  /** `gemessen` (Energie, Messwerte) oder `bewertet` (Erlöse). */
  art: 'gemessen' | 'bewertet';
  /** Ein laufender Zeitraum, z. B. „Stand 12:00"; sonst null. */
  laeuft?: string | null;
  /** Die Auflösung der Werte, z. B. „15-Minuten-Werte". */
  aufloesung?: string | null;
  /** Die Datenlage, z. B. „94 von 96 Viertelstunden". */
  abdeckung?: string | null;
  /** Der Vergleichszeitraum, z. B. „Vergleich: Juli" – null ohne Vergleich. */
  vergleich?: string | null;
  /** Die Zahlen gehören noch zum vorherigen Zeitraum (lädt). */
  alt?: boolean;
  info?: Erklaerung | null;
}) {
  const teile: ReactNode[] = [];
  if (laeuft) {
    teile.push(
      <span key="l">
        <b>Läuft</b> · {laeuft}
      </span>,
    );
  }
  teile.push(
    <span key="a">
      <b>{art === 'gemessen' ? 'Gemessen' : 'Bewertet'}</b>
      {art === 'bewertet' ? ' mit Ihrem Stromtarif' : aufloesung ? ` · ${aufloesung}` : ''}
    </span>,
  );
  if (abdeckung) teile.push(<span key="d">{abdeckung}</span>);
  if (vergleich) teile.push(<span key="v">{vergleich}</span>);

  return (
    <p className="vp-vr-status" data-art={art}>
      <span
        className={`vp-vr-status-dot${alt ? ' alt' : laeuft ? ' laeuft' : ''}`}
        aria-hidden="true"
      />
      {teile.map((t, i) => (
        <span key={i} className="vp-vr-status-teil">
          {i > 0 && (
            <span className="vp-vr-status-sep" aria-hidden="true">
              ·{' '}
            </span>
          )}
          {t}
        </span>
      ))}
      <Erklaert info={info} />
    </p>
  );
}

/**
 * Die Kennzahlenzeile. Ohne `gleich` ist die erste Kachel die Hauptzahl
 * (breiter); `gleich` = alle Kacheln gleich breit.
 */
export function Kennzahlen({
  label,
  gleich,
  anzahl,
  children,
}: {
  label: string;
  gleich?: boolean;
  /** Zahl der Kacheln NEBEN der Hauptzahl (bzw. aller bei `gleich`) — für das Raster. */
  anzahl?: number;
  children: ReactNode;
}) {
  return (
    <div
      className={`vp-vr-kpis${gleich ? ' gleich' : ''}`}
      role="group"
      aria-label={label}
      style={anzahl ? ({ '--vp-vr-kpi-n': anzahl } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

export function Kennzahl({
  label,
  wert,
  unter,
  farbe,
  linie,
  haupt,
  ton,
  info,
}: {
  label: string;
  /** Der formatierte Wert samt Einheit; „—", wenn es keinen gibt. */
  wert: ReactNode;
  unter?: ReactNode;
  /** Die Rollenfarbe der Reihe, zu der die Zahl gehört (Kennung, nie Textfarbe). */
  farbe?: string | null;
  /** Kennung als Linie statt Fläche (Zahlen, die im Diagramm Linie oder Punkt sind). */
  linie?: boolean;
  /** Die EINE große Zahl der Seite. */
  haupt?: boolean;
  /** `minus` = Kosten/negativ, `leer` = kein Wert. */
  ton?: 'minus' | 'leer' | null;
  info?: Erklaerung | null;
}) {
  return (
    <div className={`vp-vr-kpi${haupt ? ' haupt' : ''}`}>
      <div className="vp-vr-kpi-l">
        {farbe && (
          <span
            className={`vp-vr-key${linie ? ' linie' : ''}`}
            style={{ background: farbe }}
            aria-hidden="true"
          />
        )}
        <span>{label}</span>
        <Erklaert info={info} />
      </div>
      <div className={`vp-vr-kpi-v${ton ? ` ${ton}` : ''}`}>{wert}</div>
      {unter != null && unter !== '' && <div className="vp-vr-kpi-s">{unter}</div>}
    </div>
  );
}

/** Eine Karte des Verlaufs: Titel (h2) links, Bedienung rechts, Inhalt darunter. */
export function VrKarte({
  titel,
  sub,
  info,
  aktionen,
  label,
  className,
  children,
}: {
  titel: ReactNode;
  sub?: ReactNode;
  info?: Erklaerung | null;
  aktionen?: ReactNode;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`vp-vr-card${className ? ` ${className}` : ''}`}
      aria-label={label ?? (typeof titel === 'string' ? titel : undefined)}
    >
      <div className="vp-vr-card-head">
        <h2 className="vp-vr-card-title">
          {titel}
          {sub != null && <small>{sub}</small>}
          <Erklaert info={info} />
        </h2>
        {aktionen && <div className="vp-vr-card-actions">{aktionen}</div>}
      </div>
      {children}
    </section>
  );
}

/** Ein kleiner Umschalter (Säulen/Kumuliert, Diagramm/Tabelle). */
export function VrUmschalter<T extends string>({
  label,
  optionen,
  wert,
  onWert,
}: {
  label: string;
  optionen: readonly { id: T; label: string }[];
  wert: T;
  onWert: (w: T) => void;
}) {
  return (
    <div className="vp-vr-seg" role="group" aria-label={label}>
      {optionen.map((o) => (
        <button
          key={o.id}
          type="button"
          className={wert === o.id ? 'is-on' : undefined}
          aria-pressed={wert === o.id}
          onClick={() => onWert(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface LegendenEintrag {
  id: string;
  label: string;
  farbe: string;
  form: 'flaeche' | 'linie' | 'punkt';
  /** Mit `onToggle` ist der Eintrag ein Schalter; `aktiv` = sichtbar. */
  aktiv?: boolean;
  /** Ein Zuschalt-Eintrag („+ Börsenpreis") ist aus nicht durchgestrichen. */
  zuschalten?: boolean;
  onToggle?: () => void;
}

/** Die Legende — mit `onToggle` zugleich die Bedienung der Reihen. */
export function VrLegende({ eintraege, label }: { eintraege: readonly LegendenEintrag[]; label: string }) {
  return (
    <ul className="vp-vr-legend" aria-label={label}>
      {eintraege.map((e) => {
        const key = (
          <span
            className={`vp-vr-key${e.form === 'linie' ? ' linie' : e.form === 'punkt' ? ' punkt' : ''}`}
            style={{ background: e.farbe }}
            aria-hidden="true"
          />
        );
        return (
          <li key={e.id}>
            {e.onToggle ? (
              <button
                type="button"
                className={e.aktiv === false ? (e.zuschalten ? 'is-plus' : 'is-off') : undefined}
                aria-pressed={e.aktiv !== false}
                onClick={e.onToggle}
              >
                {key}
                {e.label}
              </button>
            ) : (
              <>
                {key}
                {e.label}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Eine Zelle der Tabellenansicht: fertiger Text plus Ton. */
export interface TabellenZelle {
  text: string;
  ton?: 'minus' | null;
}

/** Eine Zeile: Kopf (Zeitraum) und entweder Zellen oder ein Grund, warum keine. */
export interface TabellenZeile {
  id: string;
  kopf: string;
  zellen: readonly TabellenZelle[] | null;
  /** „keine Messwerte" — steht über alle Spalten, wenn `zellen` fehlt. */
  leer?: string;
}

/**
 * Die TABELLENANSICHT eines Diagramms — derselbe Inhalt als Zahlen (Leitlinie
 * „ein Diagramm hat einen Tabellen-Zwilling"). Kopf und erste Spalte bleiben
 * beim Scrollen stehen; am Telefon scrollt die Tabelle in ihrem Rahmen, nie
 * die Seite.
 */
export function VrTabelle({
  titel,
  spalten,
  zeilen,
  summe,
  fuss,
  onZeile,
  zeileTitel,
  hauptSpalte,
}: {
  /** Der Name der Tabelle für Screenreader (`caption`). */
  titel: string;
  /** Die Spaltenköpfe; die erste ist die Zeitspalte. */
  spalten: readonly string[];
  zeilen: readonly TabellenZeile[];
  summe?: TabellenZeile | null;
  fuss?: ReactNode;
  /** Mit Handler wird der Zeitraum einer Zeile zum Knopf, der ihn öffnet. */
  onZeile?: (id: string) => void;
  /** Der Titel dieses Knopfs („Tag öffnen"). */
  zeileTitel?: string;
  /**
   * Die Wert-Spalte (Index ohne die Zeitspalte), die am Telefon neben dem
   * Zeitraum steht — dort wird jede Zeile ein kleiner Block: Zeitraum und
   * Hauptwert oben, die übrigen Werte mit ihrem Namen darunter. Ohne Angabe
   * stehen alle Werte darunter.
   */
  hauptSpalte?: number;
}) {
  const breite = spalten.length - 1;
  const zeile = (z: TabellenZeile, klickbar = false) => (
    <tr key={z.id}>
      <th scope="row">
        {klickbar && onZeile ? (
          <button type="button" title={zeileTitel} onClick={() => onZeile(z.id)}>
            {z.kopf}
          </button>
        ) : (
          z.kopf
        )}
      </th>
      {z.zellen ? (
        z.zellen.map((c, i) => (
          <td
            key={i}
            data-label={spalten[i + 1]}
            className={[c.ton, i === hauptSpalte ? 'haupt' : null].filter(Boolean).join(' ') || undefined}
          >
            {c.text}
          </td>
        ))
      ) : (
        <td className="leer" colSpan={breite}>
          {z.leer ?? '—'}
        </td>
      )}
    </tr>
  );
  return (
    <>
      <div className="vp-vr-tablewrap" tabIndex={0} role="region" aria-label={titel}>
        <table className={`vp-vr-table stapelbar${hauptSpalte == null ? '' : ' mit-haupt'}`}>
          <caption>{titel}</caption>
          <thead>
            <tr>
              {spalten.map((s) => (
                <th key={s} scope="col">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{zeilen.map((z) => zeile(z, true))}</tbody>
          {summe && <tfoot>{zeile(summe)}</tfoot>}
        </table>
      </div>
      {fuss && <div className="vp-vr-tablefoot">{fuss}</div>}
    </>
  );
}
