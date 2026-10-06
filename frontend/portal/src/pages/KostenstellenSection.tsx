import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type Kostenstelle,
  type KostenstelleEnergiePeriode,
  type MessstelleRegisterZeile,
  type Prozess,
} from '../api';
import { BegriffAufklapper } from '../components/BegriffAufklapper';
import {
  ALLE_NICHT_ABRUFBAR,
  ALLE_ZUGEORDNET,
  ERNEUT,
  KOSTENSTELLEN_MEHR,
  KOSTENSTELLEN_SATZ,
  MENGEN_RECHT,
  MESSSTELLE_ZUORDNEN,
  NOCH_KEINE_MESSSTELLE,
  OHNE_KOSTENSTELLE,
  OHNE_WERT,
  OHNE_ZUGEKLAPPT,
  PROZESSE_MEHR,
  PROZESSE_NICHT_ABRUFBAR,
  PROZESSE_SATZ,
  REITER_WORT,
  ZEITWAHL,
  ZUORDNEN,
  ZUORDNEN_HASH,
  anteiligeQuellen,
  kostenstelleBeispiel,
  kostenstellenBild,
  kostenstellenImZeitraum,
  ohneKostenstelle,
  ohneMengenSatz,
  ohneUmbruchVorZahl,
  prozessBeispiel,
  prozessKennzeichen,
  prozesseBild,
  werteAnfrage,
  type EnergieAntwort,
  type KarteBild,
  type MessstellenWert,
  type OhneKostenstelleBild,
  type PostenBild,
  type ProzessReihe,
  type WerteAntwort,
  type ZuordnungAntwort,
} from '../kostenstellenUebersicht';
import { SPALTE } from '../messstellenListe';
import { blaettere, laeuftNoch, letzterGebildeter, zeitraumText } from '../uebersichtBausteine';
import { useRollen } from '../rollen';
import { VOR_EINHEIT } from '../uemsErgebnis';
import './MessstellenPage.css';
import './KostenstellenSection.css';

/**
 * Die Reiter „Kostenstellen“ und „Prozesse“ der Welt Messstellen am Unternehmen (UEMS AP-13 IP-9; Neubau nach dem
 * Messen-Konzept m1 §6.6/§6.7, Captain-Freigabe 05.10.2026). Die Ableitung ist `kostenstellenUebersicht.ts` - hier wird
 * nur geladen und gerendert, in derselben Familie wie die Liste der Messstellen (Kopf mit Satz, Aufklapper „Was ist …?“,
 * Karten je Kostenstelle, Reihen mit Punkt, Satz, Zahl und Chevron).
 *
 * Geladen wird je Kostenstelle EIN Aufruf der Kostenstellen-Sicht (gemerkt in `api.kostenstelleEnergie`), je Prozess die
 * Prozess-Messstellen-Route, einmal das Register (für „Ohne Kostenstelle“ und die Ablesezähler) und je Messstelle, deren
 * Wert eine Reihe zeigt, die Werte-Route mit EINEM Schritt über den Zeitraum.
 *
 * ⚠ Hier steht keine Summe über Kostenstellen oder Prozesse - und kein Satz darüber; das Warum steht im Aufklapper.
 * Verteilung und Prozesse ändern bleibt die Karte „Zuordnung“ der Messstellen-Seite: diese Fläche liest nur, jeder Posten
 * und jede Reihe springt dorthin.
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

/** Monat · Jahr und „‹ September 2026 ›“ in EINER Zeile (Konzept `.seg` + `.zeitnav`). */
function ZeitLeiste({ wahl, heute, onWahl }: ReiterProps) {
  return (
    <div className="vp-ks-zeitwahl" role="group" aria-label="Zeitraum">
      <div className="vp-seg vp-ks-seg" role="tablist" aria-label="Zeitraum">
        {ZEITWAHL.map((o) => (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={wahl.periode === o.id}
            className={wahl.periode === o.id ? 'active' : ''}
            onClick={() => onWahl(o.id, letzterGebildeter(o.id, heute))}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="vp-ks-blaettern">
        <button
          type="button"
          className="vp-ks-schritt"
          aria-label="Vorheriger Zeitraum"
          onClick={() => onWahl(wahl.periode, blaettere(wahl.periode, wahl.am, -1))}
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <span className="vp-ks-zeitraum" aria-live="polite" data-testid="organisation-zeitraum">
          {zeitraumText(wahl.periode, wahl.am)}
        </span>
        <button
          type="button"
          className="vp-ks-schritt"
          aria-label="Nächster Zeitraum"
          disabled={laeuftNoch(wahl.periode, blaettere(wahl.periode, wahl.am, 1), heute)}
          onClick={() => onWahl(wahl.periode, blaettere(wahl.periode, wahl.am, 1))}
        >
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
    </div>
  );
}

/** Der Kopf eines Reiters: Titel (= Reiter), der Satz darunter, „Was ist …?“ und die Zeitwahl. */
function ReiterKopf({
  titel,
  satz,
  aufklapper,
  ...zeit
}: ReiterProps & { titel: string; satz: string; aufklapper: ReactNode }) {
  return (
    <>
      <header className="vp-ms-kopf">
        <div className="vp-ms-kopf-text">
          <h1>{titel}</h1>
          <p className="vp-ms-meta">{satz}</p>
        </div>
      </header>
      <div className="vp-ks-lage">
        {aufklapper}
        <ZeitLeiste {...zeit} />
      </div>
    </>
  );
}

/** Ein leiser Verweis mit Chevron („Messstelle zuordnen ›“). */
function Verweis({ href, children, testid }: { href: string; children: ReactNode; testid?: string }) {
  return (
    <a className="vp-ks-verweis" href={href} data-testid={testid}>
      {children}
      <Icon name="chevron-right" size={14} />
    </a>
  );
}

/** Die Zahl rechts in einer Reihe: Wert und Zeitraum; unterwegs ein Skelett, ohne Wert der Strich - nie 0. */
function ReihenWert({ wert, wann }: { wert: MessstellenWert | null; wann: string }) {
  if (!wert || wert.zahl === null) {
    return (
      <span className="vp-ms-reihe-wert" aria-busy={wert ? 'true' : undefined}>
        {wert ? <span className="vp-skeleton vp-ks-wert-skelett" /> : <b className="is-leer">{OHNE_WERT}</b>}
      </span>
    );
  }
  const i = wert.zahl.lastIndexOf(VOR_EINHEIT);
  return (
    <span className="vp-ms-reihe-wert">
      {i < 0 ? (
        <b className={wert.zahl === OHNE_WERT ? 'is-leer' : undefined}>{wert.zahl}</b>
      ) : (
        <b>
          {wert.zahl.slice(0, i)}
          <small>{wert.zahl.slice(i + 1)}</small>
        </b>
      )}
      {wert.zahl !== OHNE_WERT && <span>{wann}</span>}
    </span>
  );
}

/** Der Kopf der Spalten ab 760 px. */
function Spalten({ erste, zweite, dritte, wert }: { erste: string; zweite: string; dritte: string; wert: string }) {
  return (
    <div className="vp-ms-spalten" aria-hidden="true">
      <span>{erste}</span>
      <span>{zweite}</span>
      <span>{dritte}</span>
      <span className="is-wert">{wert}</span>
      <span />
    </div>
  );
}

// ------------------------------------------------------------------------------------------- Kostenstellen

function Posten({ p }: { p: PostenBild }) {
  const zusatz = [p.herkunft, p.zustand, ...p.woerter].filter(Boolean).join(' · ');
  const inhalt = (
    <>
      <span className="vp-ks-po-name">
        {ohneUmbruchVorZahl(p.name)} <span className="vp-ms-kz">{p.kennzeichen}</span>
      </span>
      <span className={`vp-ks-po-zahl${p.zahl === OHNE_WERT ? ' is-leer' : ''}`}>{p.zahl}</span>
      <span className="vp-ks-po-herkunft">{zusatz}</span>
      {p.doppelt.length > 0 && (
        <span className="vp-ks-po-doppelt" data-testid="posten-doppelt">
          {p.doppelt.join(' · ')}
        </span>
      )}
    </>
  );
  return (
    <li>
      {p.sprung ? (
        <a className="vp-ks-po" href={p.sprung.hash} data-testid="posten">
          {inhalt}
        </a>
      ) : (
        <span className="vp-ks-po" data-testid="posten">
          {inhalt}
        </span>
      )}
    </li>
  );
}

function KostenstelleKarte({
  k,
  hervor,
  nurKopf,
  onErneut,
}: {
  k: KarteBild;
  hervor: boolean;
  nurKopf: boolean;
  onErneut: () => void;
}) {
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
        <h2 id={titelId} className="vp-ks-karte-name">
          {ohneUmbruchVorZahl(k.name)} <span className="vp-ms-kz">{k.kennzeichen}</span>
        </h2>
        {k.gueltig && (
          <p className="vp-ks-gueltig" data-testid="kostenstelle-gueltig">
            {k.gueltig}
          </p>
        )}
      </header>
      {nurKopf ? null : k.laedt ? (
        <div className="vp-ks-karte-skelett" aria-busy="true">
          <span className="vp-skeleton is-gross" />
          <span className="vp-skeleton is-zeile" />
        </div>
      ) : k.fehler ? (
        <div className="vp-ks-karte-fehler" role="alert">
          <p className="vp-ks-leise">{k.fehler}</p>
          <button type="button" className="vp-ms-link" onClick={onErneut}>
            {ERNEUT}
          </button>
        </div>
      ) : k.ohneZuordnung ? (
        <div className="vp-ks-ohne-zuordnung">
          <p className="vp-ks-leise">{NOCH_KEINE_MESSSTELLE}</p>
          <Verweis href={ZUORDNEN_HASH()}>{MESSSTELLE_ZUORDNEN}</Verweis>
        </div>
      ) : (
        <>
          {k.summe && (
            <div className="vp-ks-gross vp-k-farben" data-testid="kostenstelle-summe">
              <b className={k.summe.zahl === OHNE_WERT ? 'is-leer' : undefined}>{k.summe.zahl}</b>
              {k.summe.einheit && <span className="vp-ks-einheit">{k.summe.einheit}</span>}
              {k.summe.marke && <span className={`vp-k-marke is-${k.summe.marke.ton}`}>{k.summe.marke.text}</span>}
              {k.doppelt && <span className="vp-k-marke is-warn">{k.doppelt.marke}</span>}
              {k.summe.getrennt && <span className="vp-ks-leise">getrennt nach Größe</span>}
            </div>
          )}
          {k.doppelt && (
            <div className="vp-ks-doppelt" role="note" data-testid="doppelzaehlung">
              <span>{k.doppelt.saetze.join(' · ')}</span>
              {k.doppelt.pruefen.map((x) =>
                x.sprung ? (
                  <Verweis key={x.text} href={x.sprung.hash}>
                    {x.text}
                  </Verweis>
                ) : null,
              )}
            </div>
          )}
          <ul className="vp-ks-posten">
            {k.posten.map((p) => (
              <Posten key={p.id} p={p} />
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

/** „Ohne Kostenstelle · 7 Messstellen“: ruhig, grauer Punkt, die ersten drei Reihen, der Rest auf Tipp. */
function OhneKostenstelle({ ohne, wertSpalte }: { ohne: OhneKostenstelleBild; wertSpalte: string }) {
  const [alle, setAlle] = useState(false);
  const rest = ohne.reihen.length - OHNE_ZUGEKLAPPT;
  const sichtbar = alle || rest <= 0 ? ohne.reihen : ohne.reihen.slice(0, OHNE_ZUGEKLAPPT);
  const umschalten = (
    <button type="button" className="vp-ms-link vp-ks-alle" aria-expanded={alle} onClick={() => setAlle((x) => !x)}>
      {alle ? 'Weniger zeigen' : OHNE_KOSTENSTELLE.alle.replace('{n}', String(ohne.reihen.length))}
      {!alle && <Icon name="chevron-right" size={14} />}
    </button>
  );
  return (
    <section className="vp-ms-ort vp-ks-ohne" aria-labelledby="vp-ks-ohne-titel" data-testid="ohne-kostenstelle">
      <div className="vp-ms-ort-kopf">
        <h2 id="vp-ks-ohne-titel">{ohne.titel}</h2>
        <span className="vp-ms-ort-zahl">{ohne.anzahl}</span>
        <span className="vp-ks-ohne-kurz">{OHNE_KOSTENSTELLE.kurz}</span>
        {rest > 0 && <span className="vp-ks-nur-breit">{umschalten}</span>}
      </div>
      <p className="vp-ks-ohne-satz">{ohne.satz}</p>
      <Spalten erste={SPALTE.messstelle} zweite={SPALTE.zustand} dritte={SPALTE.woher} wert={wertSpalte} />
      <ul className="vp-ms-reihen">
        {sichtbar.map((r) => (
          <li key={r.id}>
            <a className="vp-ms-reihe is-still" href={r.sprung?.hash} data-testid="ohne-kostenstelle-reihe">
              <span className="vp-ms-reihe-name">
                <span className="vp-ms-punkt is-name" aria-hidden="true" />
                <span className="vp-ms-reihe-titel">
                  {ohneUmbruchVorZahl(r.name)} <span className="vp-ms-kz">{r.kennzeichen}</span>
                </span>
              </span>
              {r.ort && <span className="vp-ms-reihe-unter">{r.ort}</span>}
              <span className="vp-ms-reihe-satz">
                <span className="vp-ms-punkt is-satz" aria-hidden="true" />
                <span>{OHNE_KOSTENSTELLE.zustand}</span>
              </span>
              <span className="vp-ms-reihe-woher">{r.woher}</span>
              <ReihenWert wert={r.wert} wann={r.wann} />
              <span className="vp-ms-reihe-chev" aria-hidden="true">
                <Icon name="chevron-right" size={18} />
              </span>
            </a>
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <span className="vp-ks-nur-schmal">
          {alle ? (
            umschalten
          ) : (
            <button type="button" className="vp-ms-link vp-ks-alle" aria-expanded={false} onClick={() => setAlle(true)}>
              {OHNE_KOSTENSTELLE.weitere.replace('{n}', String(rest))}
              <Icon name="chevron-right" size={14} />
            </button>
          )}
        </span>
      )}
    </section>
  );
}

/** Das Register für „Ohne Kostenstelle“, die Ablesezähler und die Standorte der Prozesse - einmal je Reiter. */
function useRegister(): MessstelleRegisterZeile[] | null | 'fehler' {
  const [register, setRegister] = useState<MessstelleRegisterZeile[] | null | 'fehler'>(null);
  useEffect(() => {
    let aktiv = true;
    api.messstellenRegister({}).then(
      (r) => aktiv && setRegister(r.register),
      () => aktiv && setRegister('fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, []);
  return register;
}

/**
 * Die Werte-Route je Kennzeichen für den Zeitraum - jedes Kennzeichen einmal je Zeitraum; ein neuer Zeitraum fragt neu,
 * und eine Antwort für einen alten Zeitraum zeigt nichts mehr. Ein Kennzeichen, das erst später gebraucht wird (die
 * Antworten der Kostenstellen kommen nach und nach), wird dann gefragt.
 */
function useWerte(kennzeichen: readonly string[], periode: KostenstelleEnergiePeriode, am: string): ReadonlyMap<string, WerteAntwort> {
  const schluessel = `${periode}|${am}`;
  const [stand, setStand] = useState<{ schluessel: string; map: ReadonlyMap<string, WerteAntwort> }>({ schluessel, map: new Map() });
  const gefragt = useRef<{ schluessel: string; kennzeichen: Set<string> }>({ schluessel, kennzeichen: new Set() });
  const liste = kennzeichen.join('|');
  useEffect(() => {
    if (gefragt.current.schluessel !== schluessel) gefragt.current = { schluessel, kennzeichen: new Set() };
    const a = werteAnfrage(periode, am);
    for (const kz of liste ? liste.split('|') : []) {
      if (gefragt.current.kennzeichen.has(kz)) continue;
      gefragt.current.kennzeichen.add(kz);
      const setze = (w: WerteAntwort) => {
        if (gefragt.current.schluessel !== schluessel) return;
        setStand((alt) => ({ schluessel, map: new Map(alt.schluessel === schluessel ? alt.map : []).set(kz, w) }));
      };
      api.messstelleWerte(kz, a.raster, a.von, a.bis).then(setze, () => setze('fehler'));
    }
  }, [liste, schluessel, periode, am]);
  return stand.schluessel === schluessel ? stand.map : LEER;
}

const LEER: ReadonlyMap<string, WerteAntwort> = new Map();

/** „Bei Ihnen bekommt KS-100 Produktion Spritzguss 70 % von MS-20 Spritzguss und KS-200 Montage 30 %.“ */
function KostenstelleBeispiel({ antworten }: { antworten: ReadonlyMap<string, EnergieAntwort> }) {
  const b = kostenstelleBeispiel(antworten);
  if (!b) return null;
  const [erste, ...weitere] = b.teile;
  if (erste.anteil === null) {
    return (
      <>
        Bei Ihnen bekommt <b>{erste.kostenstelle}</b> den ganzen Verbrauch von {b.messstelle}.
      </>
    );
  }
  return (
    <>
      Bei Ihnen bekommt <b>{erste.kostenstelle}</b> {erste.anteil}{'\u00a0'}% von {b.messstelle}
      {weitere.map((t, i) => (
        <span key={t.kostenstelle}>
          {i === weitere.length - 1 ? ' und ' : ', '}
          <b>{t.kostenstelle}</b> {t.anteil ?? 100}{'\u00a0'}%
        </span>
      ))}
      .
    </>
  );
}

/** Der Reiter „Kostenstellen“ (Konzept §6.6): je Kostenstelle eine Karte, „Ohne Kostenstelle“, keine Gesamtsumme. */
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
  const registerAntwort = useRegister();
  const register = registerAntwort === 'fehler' ? null : registerAntwort;

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

  // Welche Werte die Fläche braucht: die Quellen anteiliger Posten („von 88.200 kWh“) und die Messstellen ohne Kostenstelle.
  const bedarf = useMemo(() => {
    if (nurKopf) return [];
    const ohne = ohneKostenstelle(im, antworten, register) ?? [];
    return [...new Set([...anteiligeQuellen(antworten), ...ohne.map((z) => z.kennzeichen)])];
  }, [nurKopf, im, antworten, register]);
  const werte = useWerte(bedarf, periode, am);

  const bild = kostenstellenBild({ katalog, antworten, register, werte, periode, am, ohneMengen });
  const geladen = bild.karten.some((k) => !k.laedt);

  // Ein Sprung auf eine Kostenstelle (IP-11: aus einer Herkunfts-Zeile) holt ihre Karte in den Blick, sobald sie steht.
  useEffect(() => {
    if (hervor && geladen) document.getElementById(`kostenstelle-${hervor}`)?.scrollIntoView({ block: 'start' });
  }, [hervor, geladen]);

  return (
    <section className="vp-ks" aria-labelledby="vp-ks-titel" data-testid="kostenstellen">
      <ReiterKopf
        {...zeit}
        titel={REITER_WORT.kostenstellen}
        satz={KOSTENSTELLEN_SATZ}
        aufklapper={<BegriffAufklapper begriff="kostenstelle" beispiel={nurKopf ? undefined : <KostenstelleBeispiel antworten={antworten} />} mehr={KOSTENSTELLEN_MEHR} />}
      />
      {bild.ohneMengen && (
        <p className="vp-ks-lagekarte" role="note" data-testid="kostenstellen-ohne-mengen">
          {bild.ohneMengen}
        </p>
      )}
      {bild.ablesung && (
        <div className="vp-ks-lagekarte" role="status" data-testid="kostenstellen-ablesung">
          <span className="vp-ks-lagekarte-icon" aria-hidden="true">
            <Icon name="info" size={18} />
          </span>
          <span className="vp-ks-lagekarte-text">
            <b>{bild.ablesung.titel}</b>
            <span>{bild.ablesung.satz}</span>
          </span>
        </div>
      )}
      {bild.alleFehler ? (
        <section className="vp-ms-karte is-fehler" role="alert">
          <h2>{ALLE_NICHT_ABRUFBAR}</h2>
          <p className="vp-ms-leise">Ihre Daten sind nicht betroffen.</p>
          <button type="button" className="vp-ms-link" onClick={() => setVersuch((v) => v + 1)}>
            {ERNEUT}
          </button>
        </section>
      ) : (
        <>
          {bild.leer && (
            <section className="vp-ms-karte" role="status">
              <p className="vp-ms-leer-satz">{bild.leer}</p>
            </section>
          )}
          {bild.karten.length > 0 && (
            <ul className="vp-ks-karten">
              {bild.karten.map((k) => (
                <li key={k.id}>
                  <KostenstelleKarte k={k} hervor={k.kennzeichen === hervor} nurKopf={nurKopf} onErneut={() => setVersuch((v) => v + 1)} />
                </li>
              ))}
            </ul>
          )}
          {bild.ohne && <OhneKostenstelle ohne={bild.ohne} wertSpalte={bild.wertSpalte} />}
          {bild.alleZugeordnet && (
            <p className="vp-ms-status is-ok" data-testid="alle-zugeordnet">
              <span className="vp-ms-status-punkt" aria-hidden="true" />
              {ALLE_ZUGEORDNET}
            </p>
          )}
        </>
      )}
      {bild.vorherBeendet && (
        <p className="vp-ks-fuss" data-testid="vorher-beendet">
          {bild.vorherBeendet}
        </p>
      )}
      {bild.fuss && <p className="vp-ks-fuss">{bild.fuss}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------- Prozesse

function ProzessZeile({ r }: { r: ProzessReihe }) {
  const ton = r.zuordnen ? 'still' : r.ton;
  const inhalt = (
    <>
      <span className="vp-ms-reihe-name">
        <span className="vp-ms-punkt is-name" aria-hidden="true" />
        <span className="vp-ms-reihe-titel">
          {ohneUmbruchVorZahl(r.name)} <span className="vp-ms-kz">{r.kennzeichen}</span>
        </span>
      </span>
      {r.unter && <span className="vp-ms-reihe-unter">{r.unter}</span>}
      <span className="vp-ms-reihe-satz">
        <span className="vp-ms-punkt is-satz" aria-hidden="true" />
        <span>{r.laedt ? <span className="vp-skeleton vp-ks-satz-skelett" /> : r.zustand}</span>
      </span>
      <span className="vp-ms-reihe-woher">
        {r.zuordnen ? (
          <span className="vp-ks-zuordnen">
            {MESSSTELLE_ZUORDNEN}
            <Icon name="chevron-right" size={14} />
          </span>
        ) : (
          r.quelle
        )}
        {r.auch && <small>{r.auch}</small>}
        {r.hinweise.map((h) => (
          <small key={h} className="vp-ks-pz-hinweis" role="note">
            {h}
          </small>
        ))}
      </span>
      {r.zuordnen ? (
        <span className="vp-ms-reihe-wert">
          <b className="is-leer">{OHNE_WERT}</b>
          <span className="vp-ks-zuordnen-kurz">{ZUORDNEN}</span>
        </span>
      ) : r.teile.length > 0 ? (
        <span className="vp-ms-reihe-wert" />
      ) : (
        <ReihenWert wert={r.laedt ? { zahl: null, zustand: null, ton: 'still', fehler: false } : r.wert} wann={r.wann} />
      )}
      <span className="vp-ms-reihe-chev" aria-hidden="true">
        {(r.sprung || r.zuordnen) && <Icon name="chevron-right" size={18} />}
      </span>
    </>
  );
  const klasse = `vp-ms-reihe is-${ton} vp-ks-pz${r.zuordnen ? ' is-zuordnen' : ''}${r.teile.length > 0 ? ' has-teile' : ''}`;
  const ziel = r.zuordnen ? ZUORDNEN_HASH() : r.sprung?.hash;
  return (
    <li data-testid="prozess-reihe" data-kennzeichen={r.kennzeichen}>
      {ziel ? (
        <a className={klasse} href={ziel}>
          {inhalt}
        </a>
      ) : (
        <div className={klasse}>{inhalt}</div>
      )}
      {r.teile.length > 0 && (
        <ul className="vp-ks-teile">
          {r.teile.map((t) => (
            <li key={t.id}>
              <a className={`vp-ms-reihe is-${t.wert.ton} vp-ks-teil`} href={t.sprung?.hash} data-testid="prozess-teil">
                <span className="vp-ms-reihe-name">
                  <span className="vp-ms-reihe-titel">
                    {ohneUmbruchVorZahl(t.name)} <span className="vp-ms-kz">{t.kennzeichen}</span>
                  </span>
                </span>
                <span className="vp-ms-reihe-satz">
                  <span className="vp-ms-punkt is-satz" aria-hidden="true" />
                  <span>{t.wert.zustand ?? ''}</span>
                </span>
                <span className="vp-ms-reihe-woher" />
                <ReihenWert wert={t.wert} wann={r.wann} />
                <span className="vp-ms-reihe-chev" aria-hidden="true">
                  <Icon name="chevron-right" size={18} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Der Reiter „Prozesse“ (Konzept §6.7): je Prozess die Messstellen, die ihn messen, mit Wert - keine Summe über Prozesse. */
export function ProzesseReiter({ katalog, ...zeit }: ReiterProps & { katalog: Prozess[] }) {
  const { periode, am } = zeit.wahl;
  const [zuordnungen, setZuordnungen] = useState<{ am: string; map: ReadonlyMap<string, ZuordnungAntwort> }>({ am: '', map: new Map() });
  const [versuch, setVersuch] = useState(0);
  const registerAntwort = useRegister();
  const register = registerAntwort === 'fehler' ? null : registerAntwort;

  // Die Zuordnung gilt am ersten Tag des Zeitraums (die Route kennt einen Tag, keinen Zeitraum).
  useEffect(() => {
    let aktiv = true;
    setZuordnungen({ am, map: new Map() });
    for (const p of katalog) {
      api.prozessMessstellen(p.id, am).then(
        (a) => aktiv && setZuordnungen((alt) => ({ am, map: new Map(alt.am === am ? alt.map : []).set(p.id, a) })),
        () => aktiv && setZuordnungen((alt) => ({ am, map: new Map(alt.am === am ? alt.map : []).set(p.id, 'fehler') })),
      );
    }
    return () => {
      aktiv = false;
    };
  }, [katalog, am, versuch]);

  const map = zuordnungen.am === am ? zuordnungen.map : new Map<string, ZuordnungAntwort>();
  const kennzeichen = useMemo(() => prozessKennzeichen(map), [map]);
  const werte = useWerte(kennzeichen, periode, am);
  const bild = prozesseBild({ katalog, zuordnungen: map, werte, register, periode, am });
  const alleFehler = bild.reihen.length > 0 && bild.reihen.every((r) => r.fehler);
  const beispiel = prozessBeispiel(bild);

  return (
    <section className="vp-ks" aria-labelledby="vp-pz-titel" data-testid="prozesse">
      <ReiterKopf
        {...zeit}
        titel={REITER_WORT.prozesse}
        satz={PROZESSE_SATZ}
        aufklapper={
          <BegriffAufklapper
            begriff="prozess"
            beispiel={
              beispiel.length > 0 ? (
                <>
                  Bei Ihnen zum Beispiel{' '}
                  {beispiel.map((n, i) => (
                    <span key={n}>
                      {i === 0 ? '' : i === beispiel.length - 1 ? ' und ' : ', '}
                      <b>{n}</b>
                    </span>
                  ))}
                  .
                </>
              ) : undefined
            }
            mehr={PROZESSE_MEHR}
          />
        }
      />
      {alleFehler ? (
        <section className="vp-ms-karte is-fehler" role="alert">
          <h2>{PROZESSE_NICHT_ABRUFBAR}</h2>
          <p className="vp-ms-leise">Ihre Daten sind nicht betroffen.</p>
          <button type="button" className="vp-ms-link" onClick={() => setVersuch((v) => v + 1)}>
            {ERNEUT}
          </button>
        </section>
      ) : bild.leer ? (
        <section className="vp-ms-karte" role="status">
          <p className="vp-ms-leer-satz">{bild.leer}</p>
        </section>
      ) : (
        <section className="vp-ms-ort vp-ks-prozesse" aria-labelledby="vp-pz-liste" data-testid="prozesse-liste">
          <div className="vp-ms-ort-kopf">
            <h2 id="vp-pz-liste">{bild.anzahl}</h2>
            {bild.standort && <span className="vp-ms-ort-zahl">{bild.standort}</span>}
          </div>
          <Spalten erste="Prozess" zweite={SPALTE.zustand} dritte="Gemessen von" wert={bild.wertSpalte} />
          <ul className="vp-ms-reihen">
            {bild.reihen.map((r) => (
              <ProzessZeile key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}
      {bild.vorherBeendet && <p className="vp-ks-fuss">{bild.vorherBeendet}</p>}
    </section>
  );
}
