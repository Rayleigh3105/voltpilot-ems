import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type Kostenstelle,
  type KostenstelleEnergiePeriode,
  type MessstelleProzesse,
  type MessstelleRegisterZeile,
  type Prozess,
} from '../api';
import { ZeitSegment } from '../components/HistorieWelt';
import { UEMS_PROZESS_SUMME } from '../glossar';
import {
  ALLE_NICHT_ABRUFBAR,
  MENGEN_RECHT,
  PROZESSE_NICHT_ABRUFBAR,
  REITER_WORT,
  berechnete,
  kostenstellenBild,
  kostenstellenImZeitraum,
  ohneMengenSatz,
  prozessSummeAnfrage,
  prozessSummen,
  prozesseBild,
  type EnergieAntwort,
  type KarteBild,
  type NichtVerteiltBild,
  type PostenBild,
  type ProzessKarteBild,
  type WerteAntwort,
} from '../kostenstellenUebersicht';
import { BILANZ_PERIODEN, blaettere, laeuftNoch, letzterGebildeter, zeitraumText } from '../uebersichtBausteine';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import './KostenstellenSection.css';

/**
 * Die Reiter „Kostenstellen“ und „Prozesse“ der Welt Messstellen am Unternehmen (UEMS AP-13 IP-9 = AP-10 IP-15,
 * Listen-Teil; E8 = A, B6/B7). Die Ableitung ist `kostenstellenUebersicht.ts` — hier wird nur geladen und gerendert:
 * je Kostenstelle des Zeitraums EIN Aufruf der Kostenstellen-Sicht (gemerkt in `api.kostenstelleEnergie`), für die
 * Prozesse das Register, die Prozesse der berechneten Messstellen und deren Wert.
 *
 * ⚠ Hier steht keine Summe über Kostenstellen oder Prozesse — der Satz dazu steht dort, wo sonst ein Fuß stünde: vor
 * den Karten, damit er am Telefon vor der ersten Zahl gelesen wird. Verteilung ändern bleibt die Karte „Organisation“
 * der Messstellen-Seite (B7): diese Fläche liest nur, jeder Posten springt dorthin.
 */

export interface Zeitwahl {
  periode: KostenstelleEnergiePeriode;
  am: string;
}

interface ReiterProps {
  wahl: Zeitwahl;
  heute: string;
  onWahl: (periode: KostenstelleEnergiePeriode, am: string) => void;
}

function ZeitLeiste({ wahl, heute, onWahl }: ReiterProps) {
  return (
    <div className="vp-ks-zeitwahl" role="group" aria-label="Zeitraum">
      <ZeitSegment label="Zeitraum" optionen={BILANZ_PERIODEN} wert={wahl.periode} onWert={(p) => onWahl(p, letzterGebildeter(p, heute))} />
      <div className="vp-ks-datumzeile">
        <button type="button" className="vp-ks-schritt" aria-label="Vorheriger Zeitraum" onClick={() => onWahl(wahl.periode, blaettere(wahl.periode, wahl.am, -1))}>
          <Icon name="chevron-left" size={18} />
        </button>
        <span className="vp-ks-zeitraum" aria-live="polite" data-testid="organisation-zeitraum">
          {zeitraumText(wahl.periode, wahl.am)}
        </span>
        <button
          type="button"
          className="vp-ks-schritt"
          aria-label="Nächster Zeitraum"
          disabled={laeuftNoch(wahl.periode, wahl.am, heute)}
          onClick={() => onWahl(wahl.periode, blaettere(wahl.periode, wahl.am, 1))}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>
    </div>
  );
}

function Kopf({ titel, id, unter, ...zeit }: ReiterProps & { titel: string; id: string; unter: string | null }) {
  return (
    <div className="vp-ks-kopf">
      <div className="vp-ks-kopf-text">
        <h2 id={id} className="vp-ks-titel">
          {titel}
        </h2>
        {unter && <p className="vp-ks-zone">{unter}</p>}
      </div>
      <ZeitLeiste {...zeit} />
    </div>
  );
}

function Posten({ p }: { p: PostenBild }) {
  const zusatz = [p.zustand, p.spanne, ...p.woerter].filter(Boolean).join(' · ');
  const name = (
    <>
      <span className="vp-ks-posten-name">{p.name}</span>
      <span className="vp-ks-kz">{p.kennzeichen}</span>
    </>
  );
  return (
    <li className="vp-ks-posten-zeile">
      {p.sprung ? (
        <a className="vp-ks-posten-link" href={p.sprung.hash}>
          {name}
        </a>
      ) : (
        <span className="vp-ks-posten-link">{name}</span>
      )}
      <span className="vp-ks-posten-zahl">{p.zahl}</span>
      {zusatz && <span className="vp-ks-posten-woerter">{zusatz}</span>}
    </li>
  );
}

function NichtVerteilt({ nv }: { nv: NichtVerteiltBild }) {
  const isPhone = useIsPhone();
  return (
    <section className="vp-ks-nv" aria-labelledby="vp-ks-nv-titel" data-testid="nicht-verteilt">
      <h3 id="vp-ks-nv-titel" className="vp-ks-nv-titel">
        {nv.titel}
      </h3>
      {nv.leer ? (
        <p className="vp-ks-satz">{nv.leer}</p>
      ) : (
        // Am Telefon zugeklappt: die Karten stehen sonst erst nach sieben Zeilen, die keiner gehören.
        <details className="vp-ks-nv-liste" open={!isPhone}>
          <summary className="vp-ks-nv-unter">
            {nv.anzahl} · {nv.unter}
          </summary>
          <ul className="vp-ks-posten">
            {nv.posten.map((p) => (
              <Posten key={p.id} p={p} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function KostenstelleKarte({ k, hervor, nurKopf }: { k: KarteBild; hervor: boolean; nurKopf: boolean }) {
  const titelId = `vp-ks-karte-${k.kennzeichen}`;
  return (
    <article
      id={`kostenstelle-${k.kennzeichen}`}
      className={`vp-ks-karte${hervor ? ' is-hervor' : ''}`}
      aria-labelledby={titelId}
      data-testid="kostenstelle-karte"
      data-kennzeichen={k.kennzeichen}
    >
      <header className="vp-ks-karte-kopf">
        <h3 id={titelId} className="vp-ks-karte-titel">
          <span className="vp-ks-kz">{k.kennzeichen}</span> {k.name}
        </h3>
        {k.gueltig && (
          <p className="vp-ks-gueltig" data-testid="kostenstelle-gueltig">
            {k.gueltig}
          </p>
        )}
      </header>
      {nurKopf ? null : k.laedt ? (
        <p className="vp-ks-satz">Wird geladen …</p>
      ) : k.fehler ? (
        <p className="vp-ks-satz" role="alert">
          {k.fehler}
        </p>
      ) : (
        <dl className="vp-ks-bloecke">
          {k.bloecke.map((b) => (
            <div key={b.art} className={`vp-ks-block is-${b.art}`} data-testid={`block-${b.art}`}>
              <dt className="vp-ks-block-wort">{b.wort}</dt>
              <dd className="vp-ks-block-wert">
                <span className="vp-ks-zahl">{b.zahl}</span>
                {b.zustand && <span className="vp-ks-zustand">{b.zustand}</span>}
                {b.summen.length > 0 && <span className="vp-ks-summen">{b.summen.join(' · ')}</span>}
              </dd>
              {b.posten.length > 0 && (
                <dd className="vp-ks-block-posten">
                  <ul className="vp-ks-posten">
                    {b.posten.map((p) => (
                      <Posten key={p.id} p={p} />
                    ))}
                  </ul>
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}
      {k.saetze.map((s) => (
        <p key={s} className="vp-ks-satz">
          {s}
        </p>
      ))}
      {k.doppelt && (
        <p className="vp-ks-doppelt" role="note" data-testid="doppelzaehlung">
          <span className="vp-ks-punkt" aria-hidden="true" />
          <span>
            <strong>{k.doppelt.titel}:</strong> {k.doppelt.saetze.join(' · ')}
            {k.doppelt.hinweis && <span className="vp-ks-doppelt-hinweis"> {k.doppelt.hinweis}</span>}
          </span>
        </p>
      )}
    </article>
  );
}

/** Der Reiter „Kostenstellen“ (O9): „nicht verteilt“ einmal oben, je Kostenstelle eine Karte, keine Gesamtsumme. */
export function KostenstellenReiter({ katalog, hervor = null, ...zeit }: ReiterProps & { katalog: Kostenstelle[]; hervor?: string | null }) {
  const { periode, am } = zeit.wahl;
  const [antworten, setAntworten] = useState<ReadonlyMap<string, EnergieAntwort>>(() => new Map());
  const [versuch, setVersuch] = useState(0);
  const im = useMemo(() => kostenstellenImZeitraum(katalog, periode, am), [katalog, periode, am]);
  // Kostenstelle B: die Mengen sieht nur, wer `messwerte.ansehen` am Unternehmen hat (so prüft die api) — alle anderen
  // fragen `…/energie` gar nicht erst. Ohne Selbstauskunft entscheidet die Route wie bisher.
  const rollen = useRollen();
  const ohneMengen = rollen.selbst !== null && !rollen.darf(MENGEN_RECHT, null) ? ohneMengenSatz(rollen.selbst.kundenadministratoren) : null;
  const nurKopf = ohneMengen !== null;

  useEffect(() => {
    let aktiv = true;
    setAntworten(new Map());
    if (nurKopf) return;
    for (const k of im) {
      api.kostenstelleEnergie(k.id, periode, am).then(
        (a) => aktiv && setAntworten((m) => new Map(m).set(k.id, a)),
        () => aktiv && setAntworten((m) => new Map(m).set(k.id, 'fehler')),
      );
    }
    return () => {
      aktiv = false;
    };
  }, [im, periode, am, versuch, nurKopf]);

  const bild = kostenstellenBild(katalog, antworten, periode, am, ohneMengen);
  const geladen = bild.karten.some((k) => !k.laedt);

  // Ein Sprung auf eine Kostenstelle (IP-11: aus einer Herkunfts-Zeile) holt ihre Karte in den Blick, sobald sie steht.
  useEffect(() => {
    if (hervor && geladen) document.getElementById(`kostenstelle-${hervor}`)?.scrollIntoView({ block: 'start' });
  }, [hervor, geladen]);

  return (
    <section className="vp-ks" aria-labelledby="vp-ks-titel" data-testid="kostenstellen">
      <Kopf {...zeit} titel={REITER_WORT.kostenstellen} id="vp-ks-titel" unter={[bild.zone, bild.stand].filter(Boolean).join(' · ') || null} />
      {bild.keineSumme && (
        <p className="vp-ks-keine-summe" data-testid="kostenstellen-keine-summe">
          {bild.keineSumme}
        </p>
      )}
      {bild.ohneMengen && (
        <p className="vp-ks-keine-summe" role="note" data-testid="kostenstellen-ohne-mengen">
          {bild.ohneMengen}
        </p>
      )}
      {bild.alleFehler ? (
        <div className="vp-ks-karte" role="alert">
          <p className="vp-ks-satz">{ALLE_NICHT_ABRUFBAR}</p>
          <button type="button" className="vp-ks-knopf" onClick={() => setVersuch((v) => v + 1)}>
            Erneut versuchen
          </button>
        </div>
      ) : (
        bild.nichtVerteilt && <NichtVerteilt nv={bild.nichtVerteilt} />
      )}
      {bild.leer && <p className="vp-ks-satz">{bild.leer}</p>}
      {!bild.alleFehler && bild.karten.length > 0 && (
        <ul className="vp-ks-karten">
          {bild.karten.map((k) => (
            <li key={k.id}>
              <KostenstelleKarte k={k} hervor={k.kennzeichen === hervor} nurKopf={nurKopf} />
            </li>
          ))}
        </ul>
      )}
      {bild.vorherBeendet && (
        <p className="vp-ks-beendet" data-testid="vorher-beendet">
          {bild.vorherBeendet}
        </p>
      )}
    </section>
  );
}

function ProzessKarte({ p, laedt }: { p: ProzessKarteBild; laedt: boolean }) {
  const titelId = `vp-pz-karte-${p.kennzeichen}`;
  return (
    <article className="vp-ks-karte" aria-labelledby={titelId} data-testid="prozess-karte" data-kennzeichen={p.kennzeichen}>
      <header className="vp-ks-karte-kopf">
        <h3 id={titelId} className="vp-ks-karte-titel">
          <span className="vp-ks-kz">{p.kennzeichen}</span> {p.name}
        </h3>
        {(p.teilVon || p.gueltig) && <p className="vp-ks-gueltig">{[p.teilVon, p.gueltig].filter(Boolean).join(' · ')}</p>}
      </header>
      {laedt ? (
        <p className="vp-ks-satz">Wird geladen …</p>
      ) : p.ohneSumme ? (
        <p className="vp-ks-satz">{p.ohneSumme}</p>
      ) : (
        p.summen.length > 0 && (
          <dl className="vp-ks-bloecke">
            <div className="vp-ks-block is-summe" data-testid="prozess-summe">
              <dt className="vp-ks-block-wort">{UEMS_PROZESS_SUMME}</dt>
              <dd className="vp-ks-block-posten">
                <ul className="vp-ks-posten">
                  {p.summen.map((s) => (
                    <li key={s.id} className="vp-ks-posten-zeile">
                      {s.sprung ? (
                        <a className="vp-ks-posten-link" href={s.sprung.hash}>
                          <span className="vp-ks-posten-name">{s.name}</span>
                          <span className="vp-ks-kz">{s.kennzeichen}</span>
                        </a>
                      ) : (
                        <span className="vp-ks-posten-link">{s.name}</span>
                      )}
                      <span className="vp-ks-posten-zahl">{s.zahl ?? 'Wird geladen …'}</span>
                      {(s.zustand || s.hinweis) && <span className="vp-ks-posten-woerter">{[s.zustand, s.hinweis].filter(Boolean).join(' · ')}</span>}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          </dl>
        )
      )}
    </article>
  );
}

type Zuordnungen = { register: MessstelleRegisterZeile[]; prozesse: ReadonlyMap<string, MessstelleProzesse | 'fehler'> };

/** Der Reiter „Prozesse“: je Prozess seine Prozess-Summe (eine berechnete Messstelle) — keine Summe über Prozesse. */
export function ProzesseReiter({ katalog, ...zeit }: ReiterProps & { katalog: Prozess[] }) {
  const { periode, am } = zeit.wahl;
  const [zuordnungen, setZuordnungen] = useState<Zuordnungen | 'fehler' | null>(null);
  const [werte, setWerte] = useState<ReadonlyMap<string, WerteAntwort>>(() => new Map());

  useEffect(() => {
    let aktiv = true;
    api.messstellenRegister({}).then(
      async (r) => {
        const paare = await Promise.all(
          berechnete(r.register).map((z): Promise<readonly [string, MessstelleProzesse | 'fehler']> =>
            api.messstelleProzesse(z.id).then(
              (a) => [z.id, a] as const,
              () => [z.id, 'fehler'] as const,
            ),
          ),
        );
        if (aktiv) setZuordnungen({ register: r.register, prozesse: new Map(paare) });
      },
      () => aktiv && setZuordnungen('fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, []);

  const summen = useMemo(
    () => (zuordnungen && zuordnungen !== 'fehler' ? prozessSummen(zuordnungen.register, zuordnungen.prozesse, periode, am) : null),
    [zuordnungen, periode, am],
  );

  useEffect(() => {
    if (!summen) return;
    let aktiv = true;
    setWerte(new Map());
    const a = prozessSummeAnfrage(periode, am);
    const kennzeichen = [...new Set([...summen.values()].flat().map((z) => z.kennzeichen))];
    for (const kz of kennzeichen) {
      api.messstelleWerte(kz, a.raster, a.von, a.bis).then(
        (w) => aktiv && setWerte((m) => new Map(m).set(kz, w)),
        () => aktiv && setWerte((m) => new Map(m).set(kz, 'fehler')),
      );
    }
    return () => {
      aktiv = false;
    };
  }, [summen, periode, am]);

  const bild = prozesseBild(katalog, summen, werte, periode, am);
  return (
    <section className="vp-ks" aria-labelledby="vp-pz-titel" data-testid="prozesse">
      <Kopf {...zeit} titel={REITER_WORT.prozesse} id="vp-pz-titel" unter={null} />
      {bild.keineSumme && (
        <p className="vp-ks-keine-summe" data-testid="prozesse-keine-summe">
          {bild.keineSumme}
        </p>
      )}
      {zuordnungen === 'fehler' && (
        <p className="vp-ks-satz" role="alert">
          {PROZESSE_NICHT_ABRUFBAR}
        </p>
      )}
      {bild.leer && <p className="vp-ks-satz">{bild.leer}</p>}
      {bild.karten.length > 0 && (
        <ul className="vp-ks-karten">
          {bild.karten.map((p) => (
            <li key={p.id}>
              <ProzessKarte p={p} laedt={bild.laedt && zuordnungen !== 'fehler'} />
            </li>
          ))}
        </ul>
      )}
      {bild.vorherBeendet && <p className="vp-ks-beendet">{bild.vorherBeendet}</p>}
    </section>
  );
}
