/**
 * Der VERGLEICH an der Messstelle (UEMS AP-13 IP-5, E6 = A) — die Render-Hälfte und ihr Abruf. Jede Zahl, jedes Wort
 * und jeder Grund kommen aus der reinen `src/uemsVergleich.ts` (dort aus dem Zwilling `uemsBericht`, AP-12 IP-3); hier
 * wird nur gefragt und gezeichnet.
 *
 * Zwei Formen, nie beide zugleich im Bild (VG1):
 *  - **Umschalter `aus · Vorperiode · Vorjahr`** (Adresse `v=`): dieselbe Messstelle in ihrer eigenen Vergangenheit,
 *    blass hinter der eigenen Reihe, mit der Δ-Zeile unter der Karte.
 *  - **„Weitere Messstelle"** (`VpPicker`): bis drei passende Reihen nebeneinander; der Picker zeigt AUCH die nicht
 *    passenden und sagt bei jeder, warum sie nicht passt (O12). Zwischen zwei Messstellen steht nie eine Differenz
 *    (VG4) — der Umschalter setzt dann die Δ-Zeile JEDER Reihe gegen ihre EIGENE Vorperiode.
 *
 * Der Abruf läuft durch {@link readWerteCache} (stale-while-revalidate): hin- und herschalten zeigt sofort, was schon
 * da war, und erneuert im Hintergrund. Eine gescheiterte Anfrage nimmt der Karte oben nichts — sie sagt es und bietet
 * „Erneut versuchen".
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type MessstelleGroesse, type MessstelleRegisterZeile, type MessstelleWerte } from '../api';
import { UEMS_VERGLEICH, UEMS_VERGLEICH_KEIN_DELTA, UEMS_VERGLEICH_NICHT_ABRUFBAR, UEMS_VERGLEICH_NUR_EINE_REIHE, UEMS_VERGLEICH_WEITERE } from '../glossar';
import { type Zeitraum } from '../uemsOberflaechen';
import {
  VERGLEICH_AUS,
  VOLL_SATZ,
  WOCHE_OHNE_DELTA,
  delta,
  entfernenName,
  laufendSatz,
  periodeTitel,
  reihenName,
  reihenOptionen,
  vergleichsPeriode,
  wahlOptionen,
  weitereMoeglich,
  hatZahl,
  type Bestehen,
  type Delta,
  type ReihenWahl,
  type VergleichWahl,
} from '../uemsVergleich';
import { karte, type MessstellenKarte } from '../uemsWerteKarte';
import { zeitraumAnfragen, type VerlaufAnfragen } from '../uemsVerlauf';
import { readWerteCache, werteCacheKey, writeWerteCache } from '../uemsWerteCache';
import { ErrorState, Skeleton } from './States';
import { ZeitSegment } from './HistorieWelt';
import type { VerlaufReihe } from './MessstellenVerlauf';
import { VpPicker } from './VpPicker';
import { WerteKarte } from './WerteKarte';
import './WerteVergleich.css';

/** Eine Anfrage, die der Vergleich braucht — mit ihrem Cache-Schlüssel. */
interface Bedarf {
  key: string;
  kennzeichen: string;
  raster: VerlaufAnfragen['verlauf']['raster'];
  von: string;
  bis: string;
}

const bedarfFuer = (kennzeichen: string, a: { raster: Bedarf['raster']; von: string; bis: string }): Bedarf => ({
  key: werteCacheKey(kennzeichen, a.raster, a.von, a.bis),
  kennzeichen,
  raster: a.raster,
  von: a.von,
  bis: a.bis,
});

/** Was eine Reihe im Bild zeigt: ihr Name, ihre Karte und ihre Δ-Zeile gegen die EIGENE Vorperiode. */
export interface VergleichsReihe {
  id: string;
  name: string;
  karte: MessstellenKarte | null;
  delta: Delta | null;
  /** Die Antwort im Raster des Zeitraums — die Reihe des Bildes. */
  verlauf: MessstelleWerte | null;
}

export interface VergleichStand {
  /** Die Vergleichsperiode derselben Messstelle für das Bild — `null` bei „aus" oder solange sie lädt. */
  ueberlagerung: VerlaufReihe | null;
  /** Die weiteren Messstellen als Reihen des Bildes (nur die schon geladenen). */
  reihenImBild: VerlaufReihe[];
  /** Die Δ-Zeile der eigenen Reihe (unter ihrer Karte, O11). */
  eigenDelta: Delta | null;
  /** Die weiteren Reihen mit Karte und Δ-Zeile (O12). */
  weitere: VergleichsReihe[];
  /** VG3 — „November 2026 läuft …"; `null` an einer abgeschlossenen Periode. */
  laufend: string | null;
  /** Der Titel der Vergleichsperiode („Oktober 2026") — `null` bei „aus". */
  vergleichsTitel: string | null;
  fehler: boolean;
  erneut: () => void;
}

/**
 * Was der Vergleich braucht und lädt. Der Wirt hält `wahl` (sie steht in der Adresse) und `reihen` (die gewählten
 * weiteren Messstellen); alles andere entsteht hier.
 */
export function useVergleich(e: {
  kennzeichen: string | null;
  zeitraum: Zeitraum;
  wert: string;
  heute: string;
  wahl: VergleichWahl;
  reihen: readonly ReihenWahl[];
  /** Die eigene Karte der gezeigten Periode (WerteSektion hat sie schon). */
  eigenKarte: MessstelleWerte | null;
  /** Das Bestehen der eigenen Messstelle aus dem Register (Q5). */
  bestehen: Bestehen;
  register: readonly MessstelleRegisterZeile[];
}): VergleichStand {
  const [antworten, setAntworten] = useState<Readonly<Record<string, MessstelleWerte>>>({});
  const [fehler, setFehler] = useState(false);
  const [neu, setNeu] = useState(0);

  const vp = vergleichsPeriode(e.zeitraum, e.wert, e.wahl);
  const vergleichsAnfragen = vp ? zeitraumAnfragen(e.zeitraum, vp) : null;

  const bedarf = useMemo(() => {
    const out: Bedarf[] = [];
    if (!e.kennzeichen) return out;
    // Die eigene Vergleichsperiode: das Bild nur ohne weitere Reihen (VG1), die Karte immer (sie trägt das Δ).
    if (vergleichsAnfragen) {
      if (vergleichsAnfragen.karte) out.push(bedarfFuer(e.kennzeichen, vergleichsAnfragen.karte));
      if (e.reihen.length === 0) out.push(bedarfFuer(e.kennzeichen, vergleichsAnfragen.verlauf));
    }
    for (const r of e.reihen) {
      const a = zeitraumAnfragen(e.zeitraum, e.wert);
      out.push(bedarfFuer(r.kennzeichen, a.verlauf));
      if (a.karte) out.push(bedarfFuer(r.kennzeichen, a.karte));
      if (vergleichsAnfragen?.karte) out.push(bedarfFuer(r.kennzeichen, vergleichsAnfragen.karte));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.kennzeichen, e.zeitraum, e.wert, vp, e.reihen.map((r) => r.kennzeichen).join('|')]);

  const schluessel = bedarf.map((b) => b.key).join('|');

  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    for (const b of bedarf) {
      const treffer = readWerteCache(b.key);
      // stale-while-revalidate: was da ist, steht sofort; erneuert wird trotzdem.
      if (treffer) setAntworten((a) => (a[b.key] === treffer.value ? a : { ...a, [b.key]: treffer.value }));
      if (treffer && !treffer.stale) continue;
      api.messstelleWerte(b.kennzeichen, b.raster, b.von, b.bis).then(
        (w) => {
          if (!w) return;
          writeWerteCache(b.key, w);
          if (aktiv) setAntworten((a) => ({ ...a, [b.key]: w }));
        },
        () => aktiv && setFehler(true),
      );
    }
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schluessel, neu]);

  const hol = (b: Bedarf | null): MessstelleWerte | null => (b ? (antworten[b.key] ?? null) : null);
  const kz = e.kennzeichen;
  const eigenVergleichKarte = kz && vergleichsAnfragen?.karte ? hol(bedarfFuer(kz, vergleichsAnfragen.karte)) : null;
  const eigenVergleichVerlauf =
    kz && vergleichsAnfragen && e.reihen.length === 0 ? hol(bedarfFuer(kz, vergleichsAnfragen.verlauf)) : null;

  const eigenDelta = vp
    ? delta({ zeitraum: e.zeitraum, aktuell: e.eigenKarte, vergleich: eigenVergleichKarte, periode: vp, bestehen: e.bestehen })
    : null;

  const weitere: VergleichsReihe[] = e.reihen.map((r) => {
    const a = zeitraumAnfragen(e.zeitraum, e.wert);
    const jetzt = a.karte ? hol(bedarfFuer(r.kennzeichen, a.karte)) : null;
    const gegen = vergleichsAnfragen?.karte ? hol(bedarfFuer(r.kennzeichen, vergleichsAnfragen.karte)) : null;
    return {
      id: r.id,
      name: reihenName(r),
      karte: jetzt ? karte(jetzt) : null,
      // VG4: nie gegen die eigene Messstelle — jede Reihe vergleicht sich mit IHRER Vorperiode.
      delta: vp ? delta({ zeitraum: e.zeitraum, aktuell: jetzt, vergleich: gegen, periode: vp }) : null,
      verlauf: hol(bedarfFuer(r.kennzeichen, a.verlauf)),
    };
  });

  return {
    ueberlagerung: vp && eigenVergleichVerlauf ? { name: periodeTitel(e.zeitraum, vp), antwort: eigenVergleichVerlauf } : null,
    reihenImBild: weitere.filter((r): r is VergleichsReihe & { verlauf: MessstelleWerte } => r.verlauf !== null).map((r) => ({ name: r.name, antwort: r.verlauf })),
    eigenDelta,
    weitere,
    laufend: e.wahl === VERGLEICH_AUS ? null : laufendSatz(e.zeitraum, e.wert, e.heute),
    vergleichsTitel: vp ? periodeTitel(e.zeitraum, vp) : null,
    fehler,
    erneut: () => setNeu((n) => n + 1),
  };
}

/** Die Δ-Zeile unter einer Karte: die Zahl mit Prozent und Vergleichsperiode — oder der Grund, warum es sie nicht gibt. */
export function DeltaZeile({ delta: d, testId = 'vergleich-delta' }: { delta: Delta | null; testId?: string }) {
  if (!d || (d.satz === null && d.ohne === null)) return null;
  return (
    <p className={`vp-vg-delta${d.ohne ? ' is-ohne' : ''}`} data-testid={testId} data-grund={d.grund ?? undefined}>
      {d.satz ?? d.ohne}
    </p>
  );
}

/**
 * Die Leiste des Vergleichs: der Umschalter, der Picker „Weitere Messstelle" und die Sätze, die die Fläche schuldet
 * (laufende Periode, kein Δ zwischen Messstellen, die Woche ohne Zahl).
 */
export function VergleichLeiste({
  zeitraum,
  wahl,
  onWahl,
  basis,
  eigenKennzeichen,
  register,
  reihen,
  onReihen,
  laufend,
  fehler,
  onErneut,
}: {
  zeitraum: Zeitraum;
  wahl: VergleichWahl;
  onWahl: (w: VergleichWahl) => void;
  /** Die Hauptgröße der eigenen Messstelle — ohne sie kann keine Reihe „passend" heißen. */
  basis: MessstelleGroesse | null;
  /** Die eigene Messstelle steht nicht im Picker: sie liegt schon im Bild. */
  eigenKennzeichen: string | null;
  register: readonly MessstelleRegisterZeile[];
  reihen: readonly ReihenWahl[];
  onReihen: (r: ReihenWahl[]) => void;
  laufend: string | null;
  fehler: boolean;
  onErneut: () => void;
}) {
  const schon = [...reihen.map((r) => r.kennzeichen), ...(eigenKennzeichen ? [eigenKennzeichen] : [])];
  const optionen = basis ? reihenOptionen(basis, register, schon) : [];
  const darfMehr = weitereMoeglich(reihen.length + 1);
  const picker = optionen.map((o) => ({
    value: o.id,
    label: reihenName(o),
    disabled: !o.passend,
    disabledHint: o.grund,
  }));

  return (
    <section className="vp-vg" aria-label={UEMS_VERGLEICH} data-testid="vergleich">
      <h3 className="vp-vg-titel">{UEMS_VERGLEICH}</h3>
      <div className="vp-vg-leiste">
        <ZeitSegment label={UEMS_VERGLEICH} optionen={wahlOptionen(zeitraum)} wert={wahl} onWert={onWahl} />
        {basis && register.length > 0 && (
          <div className="vp-vg-picker">
            <VpPicker
              ariaLabel={UEMS_VERGLEICH_WEITERE}
              placeholder={UEMS_VERGLEICH_WEITERE}
              options={picker}
              value={null}
              disabled={!darfMehr}
              hint={darfMehr ? undefined : VOLL_SATZ}
              onChange={(id) => {
                const o = optionen.find((x) => x.id === id);
                if (o && o.passend && darfMehr) onReihen([...reihen, { id: o.id, kennzeichen: o.kennzeichen, name: o.name }]);
              }}
            />
          </div>
        )}
      </div>
      {reihen.length > 0 && (
        <ul className="vp-vg-chips" aria-label={UEMS_VERGLEICH_WEITERE}>
          {reihen.map((r) => (
            <li key={r.id} data-testid="vergleich-reihe">
              <span>{reihenName(r)}</span>
              <button type="button" aria-label={entfernenName(r)} onClick={() => onReihen(reihen.filter((x) => x.id !== r.id))}>
                <Icon name="x" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {laufend && (
        <p className="vp-vg-satz" role="status" data-testid="vergleich-laufend">
          {laufend}
        </p>
      )}
      {!hatZahl(zeitraum) && wahl !== VERGLEICH_AUS && (
        <p className="vp-vg-satz" data-testid="vergleich-woche">
          {WOCHE_OHNE_DELTA}
        </p>
      )}
      {reihen.length > 0 && (
        <p className="vp-vg-satz" data-testid="vergleich-kein-delta">
          {UEMS_VERGLEICH_KEIN_DELTA}
        </p>
      )}
      {reihen.length > 0 && wahl !== VERGLEICH_AUS && (
        <p className="vp-vg-satz" data-testid="vergleich-nur-eine-reihe">
          {UEMS_VERGLEICH_NUR_EINE_REIHE}
        </p>
      )}
      {fehler && (
        <div data-testid="vergleich-fehler">
          <ErrorState message={UEMS_VERGLEICH_NICHT_ABRUFBAR} onRetry={onErneut} />
        </div>
      )}
    </section>
  );
}

/** Die Karten der weiteren Reihen (O12): jede mit ihrem Namen, ihrer Zahl und ihrer eigenen Δ-Zeile — nie eine Differenz. */
export function ReihenKarten({ reihen }: { reihen: readonly VergleichsReihe[] }) {
  if (reihen.length === 0) return null;
  return (
    <div className="vp-vg-karten" data-testid="vergleich-karten">
      {reihen.map((r, i) => (
        <div key={r.id} className="vp-vg-karte" data-testid="vergleich-reihe-karte" data-reihe={i + 1}>
          <p className="vp-vg-karte-name">
            <span className={`vp-vg-farbe is-r${i + 1}`} aria-hidden="true" />
            {r.name}
          </p>
          {r.karte ? (
            <WerteKarte karte={r.karte} grund={r.karte.grund} />
          ) : (
            <div aria-busy="true">
              <Skeleton height={112} />
            </div>
          )}
          <DeltaZeile delta={r.delta} testId="vergleich-reihe-delta" />
        </div>
      ))}
    </div>
  );
}
