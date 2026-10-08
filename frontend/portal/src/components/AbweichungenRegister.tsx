import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import * as A from '../abweichungen';
import { api, type Abweichung, type Auffaelligkeit, type AuffaelligkeitenAlle } from '../api';
import { UEMS_ABWEICHUNGEN, UEMS_AUFFAELLIGKEIT, UEMS_VERANTWORTLICH } from '../glossar';
import { abweichungRoute, hashForRoute, kennzahlRoute } from '../nav';
import { AuffaelligkeitBlatt } from './AuffaelligkeitBlatt';
import { BegriffAufklapper } from './BegriffAufklapper';
import { FristDatum, Kennzeichentext } from './FristDatum';
import { GrenzHinweis, GrenzSatz } from './GrenzSatz';
import { useRollen } from '../rollen';
import { merkeAbruf } from '../routenUhr';
import './kacheln/Kacheln.css';
import './Wiedervorlage.css';
import '../pages/Abweichungen.css';

type Lage =
  | { art: 'laedt' }
  | { art: 'fehler' }
  | { art: 'da'; abweichungen: Abweichung[]; abruf: string; vermerke: AuffaelligkeitenAlle | 'fehler' };

const UNTERZEILE = 'Wo es anders lief als erwartet - und was Sie dazu wissen.';
const NICHTS_ZU_BEANTWORTEN = 'Nichts zu beantworten. Liegt ein Monat über der Bezugsbasis, vermerkt VoltPilot ihn und er steht hier.';
const NOCH_KEINE = `Noch keine Abweichung. Sie entsteht, wenn Sie eine ${UEMS_AUFFAELLIGKEIT} untersuchen - oder von Hand an einer Kennzahl unter Auswerten.`;
const LADEFEHLER = 'Die Abweichungen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
const LADEFEHLER_VERMERKE = 'Die offenen Auffälligkeiten ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.';
const ERNEUT = 'Erneut versuchen';
const SPALTEN = ['Datum', 'Was auffiel', 'Ergebnis', UEMS_VERANTWORTLICH, 'Nächster Schritt'] as const;

/**
 * Der Reiter „Abweichungen“ (Verbessern-Konzept v1 §6.7, PR3): zuerst, was auf eine Antwort wartet - die offenen
 * Auffälligkeiten über alle sichtbaren Kennzahlen (`GET /api/v1/auffaelligkeiten`, Entscheid 4), beantwortet im Blatt -,
 * dann, was in Arbeit ist, zuletzt, was daraus wurde (abgeschlossene Abweichungen und zur Kenntnis genommene
 * Auffälligkeiten). Am Telefon Karten und leise Reihen, ab 760 px Breite Reihen in fünf Spalten. Eröffnet wird aus einer
 * Auffälligkeit oder von Hand an der Kennzahl; „überfällig“ kommt aus `frist` der Route (E5 = A).
 */
export function AbweichungenRegister({
  onOeffnen,
  onKennzahl,
  grenze = true,
}: {
  onOeffnen: (id: string) => void;
  /** Öffnet die Kennzahl (eine zur Kenntnis genommene Auffälligkeit steht dort im Vergleich). */
  onKennzahl?: (kennzahlId: string) => void;
  /** `false`, wenn die umgebende Fläche den Grenz-Satz schon trägt. */
  grenze?: boolean;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [blatt, setBlatt] = useState<Auffaelligkeit | null>(null);
  const rollen = useRollen();

  useEffect(() => {
    let aktiv = true;
    setLage((l) => (l.art === 'da' ? l : { art: 'laedt' }));
    Promise.all([api.abweichungen(), api.alleAuffaelligkeiten().catch(() => 'fehler' as const)]).then(
      ([liste, vermerke]) => {
        // Eine Uhr (Befund 2): die Dialoge rechnen „heute“ mit dem Tag der Route.
        merkeAbruf(liste.abruf);
        if (aktiv) setLage({ art: 'da', abweichungen: liste.abweichungen, abruf: liste.abruf, vermerke });
      },
      () => aktiv && setLage({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const kopf = (
    <header className="vp-abw-kopf">
      <div className="vp-abw-kopf-text">
        <h1>{UEMS_ABWEICHUNGEN}</h1>
        <p className="vp-abw-meta">{UNTERZEILE}</p>
      </div>
    </header>
  );

  if (lage.art !== 'da') {
    return (
      <section className="vp-abw" data-testid="abweichungen-register" aria-busy={lage.art === 'laedt'}>
        {kopf}
        {lage.art === 'laedt' ? (
          <div className="vp-wv-skelett" aria-label="Wird geladen">
            <span className="vp-skeleton is-zeile" />
            <span className="vp-skeleton is-karte" />
            <span className="vp-skeleton is-karte" />
          </div>
        ) : (
          <div className="vp-abw-leer is-fehler" role="alert" data-testid="abweichungen-fehler">
            <span>{LADEFEHLER}</span>
            <button type="button" className="vp-abw-link" onClick={() => setVersuch((v) => v + 1)}>
              {ERNEUT}
            </button>
          </div>
        )}
        {grenze && <GrenzSatz className="vp-abw-leise" />}
      </section>
    );
  }

  const vermerke = lage.vermerke === 'fehler' ? null : lage.vermerke.vermerke;
  const abruf = lage.vermerke === 'fehler' ? lage.abruf : lage.vermerke.abruf;
  // Die Sätze passen zu den Rechten: „Ihre Antwort“ nur mit `verbesserung.verwalten` am Standort des Monats.
  const bild = A.reiterBild(lage.abweichungen, vermerke, abruf, (v) => rollen.darf('verbesserung.verwalten', v.standort_id));
  const leer = vermerke !== null && bild.zuBeantworten.length === 0 && bild.inArbeit.length === 0 && bild.abgeschlossen.length === 0;

  return (
    <section className="vp-abw" data-testid="abweichungen-register">
      {kopf}
      <div className="vp-abw-antwort">
        <p className="vp-abw-satz" data-testid="abweichungen-satz">
          {bild.satz}
        </p>
        {bild.wer && (
          <p className="vp-abw-formal" data-testid="abweichungen-wer">
            {bild.wer}
          </p>
        )}
        <p className="vp-abw-formal">
          <span data-testid="abweichungen-formal">{bild.formal}</span>
        </p>
      </div>
      {/* „Was ist eine Abweichung?“ wie jeder Begriff (Konzept Verbessern v1 §7; Review r1 S-3.2): Klartext, Beispiel und
          die Abgrenzung zur Auffälligkeit stehen in `begriffe.ts`, nicht ein zweites Mal hier. */}
      <BegriffAufklapper begriff="abweichung" />

      {leer ? (
        <p className="vp-abw-leer" data-testid="abweichungen-leer">
          {NOCH_KEINE}
        </p>
      ) : (
        <>
          <Abschnitt titel="Zu beantworten" n={vermerke === null ? null : bild.zuBeantworten.length} testid="abweichungen-zu-beantworten">
            {vermerke === null ? (
              <div className="vp-abw-leer is-fehler" role="alert">
                <span>{LADEFEHLER_VERMERKE}</span>
                <button type="button" className="vp-abw-link" onClick={() => setVersuch((v) => v + 1)}>
                  {ERNEUT}
                </button>
              </div>
            ) : bild.zuBeantworten.length === 0 ? (
              <p className="vp-abw-leer">{NICHTS_ZU_BEANTWORTEN}</p>
            ) : (
              <Eintraege>
                {bild.zuBeantworten.map((v) => (
                  <ZuBeantworten key={v.id} v={v} darfAntworten={rollen.darf('verbesserung.verwalten', v.standort_id)} onBeantworten={() => setBlatt(v)} />
                ))}
              </Eintraege>
            )}
          </Abschnitt>
          {bild.inArbeit.length > 0 && (
            <Abschnitt titel="In Arbeit" n={bild.inArbeit.length} testid="abweichungen-in-arbeit">
              <Eintraege>
                {bild.inArbeit.map((a) => (
                  <InArbeit key={a.id} a={a} onOeffnen={onOeffnen} darfAbschliessen={rollen.darf('verbesserung.abschliessen', a.standort_id)} />
                ))}
              </Eintraege>
            </Abschnitt>
          )}
          {bild.abgeschlossen.length > 0 && (
            <Abschnitt titel="Abgeschlossen" n={bild.abgeschlossen.length} m={A.NEUESTE_ZUERST} testid="abweichungen-abgeschlossen">
              <Eintraege reihen>
                {bild.abgeschlossen.map((e) => (
                  <Abgeschlossen key={e.key} e={e} onOeffnen={onOeffnen} onKennzahl={onKennzahl} />
                ))}
              </Eintraege>
            </Abschnitt>
          )}
        </>
      )}

      <GrenzHinweis />
      {grenze && <GrenzSatz className="vp-abw-leise" />}
      {blatt && (
        <AuffaelligkeitBlatt
          vermerk={blatt}
          alle={vermerke ?? []}
          abruf={abruf}
          onClose={() => setBlatt(null)}
          onFertig={(x) => {
            setBlatt(null);
            if (x.abweichung) location.hash = hashForRoute(abweichungRoute(x.abweichung.id));
            else setVersuch((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

/** Ein Abschnitt: am Telefon Überschrift über Karten, ab 760 px eine Karte mit Kopfzeile und Reihen. */
function Abschnitt({ titel, n, m, testid, children }: { titel: string; n: number | null; m?: string; testid: string; children: ReactNode }) {
  return (
    <section className="vp-abw-abschnitt" aria-label={titel} data-testid={testid}>
      <div className="vp-abw-abschnitt-kopf">
        <h2>
          {titel}
          {n !== null && <span className="vp-abw-zahl">{` · ${n}`}</span>}
        </h2>
        {n !== null && <span className="vp-abw-abschnitt-m">{m ? `${n} · ${m}` : n}</span>}
      </div>
      {n !== null && n > 0 && (
        <div className="vp-abw-kopfzeile" aria-hidden="true">
          {SPALTEN.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}

function Eintraege({ reihen = false, children }: { reihen?: boolean; children: ReactElement[] }) {
  return (
    <ul className={`vp-abw-eintraege${reihen ? ' is-reihen' : ''}`}>
      {children.map((c, i) => (
        <li key={c.key ?? i}>{c}</li>
      ))}
    </ul>
  );
}

/** Das Kennzeichen leise hinter dem Titel; das Leerzeichen davor ist die Umbruchstelle. */
function Kennzeichen({ text }: { text: string | null }) {
  return text ? (
    <>
      {' '}
      <span className="vp-abw-kz">{text}</span>
    </>
  ) : null;
}

/** Eine offene Auffälligkeit: vermerkt am …, was auffiel in Zahlen, noch niemand, „Beantworten“. */
function ZuBeantworten({ v, darfAntworten, onBeantworten }: { v: Auffaelligkeit; darfAntworten: boolean; onBeantworten: () => void }) {
  const t = A.tagBlock(v.vermerkt_am);
  const zahlen = A.zahlenZeile(A.anlassZahlen(v.anlass_inhalt));
  return (
    <div className="vp-abw-eintrag" data-testid={`auffaelligkeit-${v.periode}-${v.kennzahl.kennzeichen ?? v.kennzahl.id}`}>
      <FristDatum wort="vermerkt" tag={t.tag} jahr={t.jahr} satz={`vermerkt am ${t.tag}${t.jahr}`} ton="bald" />
      <span className="vp-abw-text">
        <span className="vp-abw-titel">
          {A.auffaelligkeitTitel(v)}
          <Kennzeichen text={v.kennzahl.kennzeichen} />
        </span>
        <span className="vp-abw-grund">{[A.kennzahlName(v.kennzahl), zahlen].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="vp-abw-ergebnis">
        <span className="vp-k-marke">wartet auf Antwort</span>
      </span>
      <span className="vp-abw-fuss">
        <span className="vp-abw-wer">
          <Icon name="users" size={14} />
          noch niemand
          <small>wird beim Antworten bestimmt</small>
        </span>
        {/* Ohne das Recht kein Knopf und kein Satz je Zeile - wer antwortet, sagt der Reiter einmal oben. */}
        {darfAntworten && (
          <button type="button" className="vp-abw-schritt" onClick={onBeantworten} data-testid="auffaelligkeit-beantworten">
            {A.KNOPF_BEANTWORTEN}
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Eine offene Abweichung: Frist als Datumsblock (überfällig im Warnton), wer klärt, „Abschließen“ auf der Seite - nur mit
 * `verbesserung.abschliessen`, sonst leise „Ansehen“ (wer abschließt, sagt die Seite).
 */
function InArbeit({ a, onOeffnen, darfAbschliessen }: { a: Abweichung; onOeffnen: (id: string) => void; darfAbschliessen: boolean }) {
  const f = A.fristBlock(a);
  const schritt = A.schrittInArbeit(darfAbschliessen);
  const ueber = A.ueberfaelligText(a);
  return (
    <div className="vp-abw-eintrag is-ziel" data-testid={`abweichung-zeile-${a.kennzeichen}`}>
      <FristDatum wort={f.wort} tag={f.tag} jahr={f.jahr} satz={f.satz} ton={f.ton} />
      <span className="vp-abw-text">
        <a
          className="vp-abw-titel vp-abw-ziel"
          href={hashForRoute(abweichungRoute(a.id))}
          onClick={(e) => {
            e.preventDefault();
            onOeffnen(a.id);
          }}
        >
          {A.kurzTitel(a.monate, a.anlass_inhalt)}
          <Kennzeichen text={a.kennzeichen} />
        </a>
        <span className="vp-abw-grund">{A.kennzahlName(a.kennzahl)}</span>
      </span>
      <span className="vp-abw-ergebnis">
        <span className={`vp-k-marke${ueber ? ' is-warn' : ''}`} data-testid="frist">
          {ueber ?? 'in Arbeit'}
        </span>
      </span>
      <span className="vp-abw-fuss">
        <span className="vp-abw-wer">
          <Icon name="users" size={14} />
          {a.verantwortlich.name}
          <small>{`${A.FRIST} ${f.tag}${f.jahr}`}</small>
        </span>
        <span className={`vp-abw-schritt${schritt.leise ? ' is-leise' : ''}`} aria-hidden="true">
          {schritt.wort}
        </span>
      </span>
    </div>
  );
}

/** Abgeschlossen: Datum des Ergebnisses (grün), was auffiel, was daraus wurde, wer - leise „Ansehen“. */
function Abgeschlossen({
  e,
  onOeffnen,
  onKennzahl,
}: {
  e: A.AbgeschlossenEintrag;
  onOeffnen: (id: string) => void;
  onKennzahl?: (kennzahlId: string) => void;
}) {
  const t = A.tagBlock(e.am);
  const ergebnis = A.ergebnisKurz(e);
  const kennzahl = e.art === 'abweichung' ? e.a.kennzahl : e.v.kennzahl;
  const titel = e.art === 'abweichung' ? A.kurzTitel(e.a.monate, e.a.anlass_inhalt) : A.kurzTitel([e.v.periode], e.v.anlass_inhalt);
  const kz = e.art === 'abweichung' ? e.a.kennzeichen : e.v.kennzahl.kennzeichen;
  const wer = e.art === 'abweichung' ? e.a.abschluss!.person : (e.v.beantwortet_von ?? '');
  const wann = e.art === 'abweichung' ? A.nachTagen(A.tageZwischen(e.a.eroeffnet_am, e.a.abschluss!.am)) : 'ohne Abweichung';
  const oeffnen = e.art === 'abweichung' ? () => onOeffnen(e.a.id) : onKennzahl ? () => onKennzahl(e.v.kennzahl.id) : null;
  const href = e.art === 'abweichung' ? hashForRoute(abweichungRoute(e.a.id)) : hashForRoute(kennzahlRoute(e.v.kennzahl.id));
  return (
    <div className={`vp-abw-eintrag is-reihe${oeffnen ? ' is-ziel' : ''}`} data-testid={e.art === 'abweichung' ? `abweichung-zeile-${e.a.kennzeichen}` : `kenntnis-${e.v.periode}`}>
      <FristDatum wort="" tag={t.tag} jahr={t.jahr} satz={`abgeschlossen am ${t.tag}${t.jahr}`} ton="erledigt" />
      <span className="vp-abw-text">
        {oeffnen ? (
          <a
            className="vp-abw-titel vp-abw-ziel"
            href={href}
            onClick={(ev) => {
              ev.preventDefault();
              oeffnen();
            }}
          >
            {titel}
            <Kennzeichen text={kz} />
          </a>
        ) : (
          <span className="vp-abw-titel">
            {titel}
            <Kennzeichen text={kz} />
          </span>
        )}
        <span className="vp-abw-grund">{A.kennzahlName(kennzahl)}</span>
        <span className="vp-abw-grund vp-abw-reihe-ergebnis" data-testid="ergebnis">
          <Kennzeichentext text={ergebnis} />
        </span>
      </span>
      <span className="vp-abw-ergebnis" title={ergebnis}>
        <span>
          <Kennzeichentext text={ergebnis} />
        </span>
      </span>
      <span className="vp-abw-fuss">
        <span className="vp-abw-wer">
          {wer}
          <small>{wann}</small>
        </span>
        {oeffnen && (
          <span className="vp-abw-schritt is-leise" aria-hidden="true">
            {A.KNOPF_ANSEHEN}
          </span>
        )}
      </span>
      {oeffnen && (
        <span className="vp-abw-chev" aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
      )}
    </div>
  );
}
