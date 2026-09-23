import { useEffect, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Bericht, type Funktionen, type MessstellenRegister } from '../api';
import { darfAnsehen } from '../bewertung';
import { bewertungFristBaustein, type BewertungFristBild } from '../bewertungFrist';
import { bezugsbasisUebersichtBild, type BezugsbasisUebersicht, type BezugsbasisUebersichtBild } from '../bezugsbasisUebersicht';
import { misst } from '../ebenenNav';
import { UEMS_ENERGIEBILANZ, UEMS_GEBAEUDE, UEMS_KENNZAHLEN } from '../glossar';
import { heuteIn, listenKarte, ZUR_LISTE } from '../kennzahlKarte';
import { kennzahlRoute, pageRoute, standortBereichRoute, type Route } from '../nav';
import type { UebersichtEbene } from '../uebersicht';
import {
  BILANZ_PERIODEN,
  MESSSTELLEN_TITEL,
  NETZBEZUG,
  bausteineMitInhalt,
  blaettere,
  ende,
  energiebilanzBaustein,
  gebaeudeZeilen,
  kennzahlenDerEbene,
  laeuftNoch,
  letzterGebildeter,
  messstellenBaustein,
  zeitraumText,
  type AnlageBilanz,
  type BilanzPeriode,
  type GebaeudeEingang,
  type UebersichtBausteinId,
} from '../uebersichtBausteine';
import { useRollen } from '../rollen';
import { VORGABE_ZEITZONE } from '../uemsOrtsbaum';
import { BewertungBaustein } from './BewertungBaustein';
import { BezugsbasisUebersichtKarte } from './BezugsbasisUebersichtKarte';
import { ZeitSegment } from './HistorieWelt';
import { KennzahlKarte, useKennzahlenListe } from './KennzahlListe';
import './UebersichtBausteine.css';

/**
 * Die Übersichts-Bausteine je Ebene (UEMS AP-13 IP-7, E3 = A, Ü1–Ü5): „Messstellen“, „Energiebilanz“ (am Standort
 * mit den Gebäude-Zeilen) und „Kennzahlen“ unter der Anlagen-Tabelle der Unternehmens- und der Standort-Übersicht.
 * Jede Ableitung steht im reinen Modul `uebersichtBausteine.ts`; hier wird nur geladen und gerendert.
 */

type Gebaeude = { id: string; kurzzeichen: string; name: string };

export interface UebersichtDaten {
  ebene: UebersichtEbene;
  heute: string;
  periode: BilanzPeriode;
  am: string;
  waehle: (periode: BilanzPeriode, am: string) => void;
  register: MessstellenRegister | null;
  /** Die zuletzt geladenen Bilanzen je Anlage — `laedt`: sie gehören (noch) nicht zum gewählten Zeitraum. */
  anlagen: AnlageBilanz[] | null;
  laedt: boolean;
  gebaeude: GebaeudeEingang[];
  kennzahlen: ReturnType<typeof useKennzahlenListe>;
  /** AP-16 IP-24: die gültige Bewertung am Unternehmen — nur mit `energieeinsatz.ansehen` und einem Stand. */
  bewertung: BewertungFristBild | null;
  /** AP-17 IP-17: laufende Bezugsbasen am Unternehmen — `null` ohne laufende Basis (R10: keine neue Kachel). */
  bezugsbasen?: BezugsbasisUebersichtBild | null;
  /** Die Bausteine MIT Inhalt — nur sie bietet die Fläche an. */
  inhalt: UebersichtBausteinId[];
}

/**
 * Lädt, was die Bausteine brauchen — nur mit einer messenden Ebene (`null`/ohne Messfunktion fragt nichts Neues ab):
 * das Register, je Anlage ihre Bilanz im Zeitraum der Leiste, am Standort Ortsbaum und Register je Gebäude (heute für
 * die Datenlage, am letzten Tag des Zeitraums für „im Gebäude“), und die Kennzahlen.
 */
export function useUebersichtBausteine(
  ebene: UebersichtEbene | null,
  anlagen: readonly { id: string; name: string }[],
  funktionen: Funktionen | null,
): UebersichtDaten | null {
  // E2/Q2/O18: auch vorhandene Gebäude begründen keinen Messdaten-Baustein.
  const standorte = ebene?.art === 'standort' ? [ebene.standort] : ebene?.standorte ?? [];
  const lm = { standorte, funktionen, kennzahlen: null };
  const an = standorte.some((s) => s.zustand !== 'archiviert' && misst(lm, s.id));
  const standortId = an && ebene?.art === 'standort' ? ebene.standort.id : null;
  const zone = ebene?.art === 'standort' ? ebene.standort.zeitzone : VORGABE_ZEITZONE;
  const heute = heuteIn(zone, Date.now());
  const [wahl, setWahl] = useState<{ periode: BilanzPeriode; am: string }>(() => ({
    periode: 'monat',
    am: letzterGebildeter('monat', heute),
  }));

  const [register, setRegister] = useState<MessstellenRegister | null>(null);
  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    api.messstellenRegister().then(
      (r) => aktiv && setRegister(r),
      () => aktiv && setRegister(null),
    );
    return () => {
      aktiv = false;
    };
  }, [an]);

  const anlagenSchluessel = JSON.stringify(anlagen.map((a) => ({ id: a.id, name: a.name })));
  const bilanzSchluessel = `${anlagenSchluessel}|${wahl.periode}|${wahl.am}`;
  const [bilanzen, setBilanzen] = useState<{ schluessel: string; anlagen: AnlageBilanz[] } | null>(null);
  useEffect(() => {
    if (!an) return;
    let aktiv = true;
    const liste = JSON.parse(anlagenSchluessel) as { id: string; name: string }[];
    Promise.all(
      liste.map((a) =>
        api.anlageBilanz(a.id, wahl.periode, wahl.am).then(
          (bilanz): AnlageBilanz => ({ anlage: a, bilanz }),
          (): AnlageBilanz => ({ anlage: a, bilanz: null }),
        ),
      ),
    ).then((xs) => aktiv && setBilanzen({ schluessel: bilanzSchluessel, anlagen: xs }));
    return () => {
      aktiv = false;
    };
  }, [an, anlagenSchluessel, bilanzSchluessel, wahl.periode, wahl.am]);

  const [orte, setOrte] = useState<{ standortId: string; gebaeude: Gebaeude[] } | null>(null);
  useEffect(() => {
    if (!standortId) return;
    let aktiv = true;
    api.standortOrte(standortId).then(
      (o) => aktiv && setOrte({ standortId, gebaeude: o.gebaeude.map((g) => ({ id: g.id, kurzzeichen: g.kurzzeichen, name: g.name })) }),
      () => aktiv && setOrte({ standortId, gebaeude: [] }),
    );
    return () => {
      aktiv = false;
    };
  }, [standortId]);
  const gebaeudeListe = orte && orte.standortId === standortId ? orte.gebaeude : [];
  const orteSchluessel = JSON.stringify(gebaeudeListe);

  const [gebaeudeHeute, setGebaeudeHeute] = useState<{ schluessel: string; je: Record<string, MessstellenRegister | null> } | null>(null);
  useEffect(() => {
    const liste = JSON.parse(orteSchluessel) as Gebaeude[];
    if (liste.length === 0) return;
    let aktiv = true;
    Promise.all(
      liste.map((g) =>
        api.messstellenRegister({ ort: g.kurzzeichen }).then(
          (r): [string, MessstellenRegister | null] => [g.id, r],
          (): [string, MessstellenRegister | null] => [g.id, null],
        ),
      ),
    ).then((xs) => aktiv && setGebaeudeHeute({ schluessel: orteSchluessel, je: Object.fromEntries(xs) }));
    return () => {
      aktiv = false;
    };
  }, [orteSchluessel]);

  // „im Gebäude“ gilt am letzten Tag des Zeitraums (wie „Stand am …“) — nie nach heute.
  const stichtag = [ende(wahl.periode, wahl.am), heute].sort()[0];
  const zeitraumSchluessel = `${orteSchluessel}|${stichtag}`;
  const [gebaeudeImZeitraum, setGebaeudeImZeitraum] = useState<{ schluessel: string; je: Record<string, string[] | null> } | null>(null);
  useEffect(() => {
    const liste = JSON.parse(orteSchluessel) as Gebaeude[];
    if (liste.length === 0) return;
    let aktiv = true;
    Promise.all(
      liste.map((g) =>
        api.messstellenRegister({ ort: g.kurzzeichen, stichtag }).then(
          (r): [string, string[] | null] => [g.id, r.register.map((z) => z.kennzeichen)],
          (): [string, string[] | null] => [g.id, null],
        ),
      ),
    ).then((xs) => aktiv && setGebaeudeImZeitraum({ schluessel: zeitraumSchluessel, je: Object.fromEntries(xs) }));
    return () => {
      aktiv = false;
    };
  }, [orteSchluessel, stichtag, zeitraumSchluessel]);

  const kennzahlen = useKennzahlenListe(zone, standortId, 0, an);

  // AP-16 IP-24: „Bewertung“ nach der Berichte-Regel (misst) und nur, wer Energieeinsätze sehen darf (IP-6); nur am
  // Unternehmen. Frist und Zahlen leitet der Server beim Abruf ab — ohne Recht wird nichts abgefragt.
  const { selbst } = useRollen();
  const bewertungAn = an && ebene?.art === 'unternehmen' && darfAnsehen(selbst);
  const [berichte, setBerichte] = useState<Bericht[] | null>(null);
  useEffect(() => {
    if (!bewertungAn) {
      setBerichte(null);
      return;
    }
    let aktiv = true;
    api
      .berichte()
      .then((r) => aktiv && setBerichte(r.berichte))
      .catch(() => aktiv && setBerichte(null));
    return () => {
      aktiv = false;
    };
  }, [bewertungAn]);
  const bewertung = bewertungAn ? bewertungFristBaustein(berichte) : null;

  // AP-17 IP-17: „Bezugsbasen“ nur am Unternehmen; die Frist leitet der Server beim Abruf ab, die Sichtbarkeit folgt der
  // Kennzahl. Ohne laufende Basis bleibt die Kachel weg.
  const bezugsbasenAn = an && ebene?.art === 'unternehmen';
  const [bezugsbasisDaten, setBezugsbasisDaten] = useState<BezugsbasisUebersicht | null>(null);
  useEffect(() => {
    if (!bezugsbasenAn) {
      setBezugsbasisDaten(null);
      return;
    }
    let aktiv = true;
    api
      .bezugsbasisUebersicht()
      .then((r) => aktiv && setBezugsbasisDaten(r))
      .catch(() => aktiv && setBezugsbasisDaten(null));
    return () => {
      aktiv = false;
    };
  }, [bezugsbasenAn]);
  const bezugsbasen = bezugsbasenAn ? bezugsbasisUebersichtBild(bezugsbasisDaten) : null;

  if (!ebene || !an) return null;
  const gebaeude: GebaeudeEingang[] = gebaeudeListe.map((g) => ({
    ...g,
    heute: gebaeudeHeute?.schluessel === orteSchluessel ? (gebaeudeHeute.je[g.id] ?? null) : null,
    imZeitraum: gebaeudeImZeitraum?.schluessel === zeitraumSchluessel ? (gebaeudeImZeitraum.je[g.id] ?? null) : null,
  }));
  const laedt = bilanzen?.schluessel !== bilanzSchluessel;
  const anlagenBilanz = bilanzen?.anlagen ?? null;
  const inhalt = bausteineMitInhalt({
    messstellen: messstellenBaustein(ebene, register),
    energiebilanz: energiebilanzBaustein({ ebene, periode: wahl.periode, am: wahl.am, heute, anlagen: anlagenBilanz }),
    gebaeude: standortId
      ? gebaeudeZeilen({ standortId, periode: wahl.periode, am: wahl.am, heute, anlagen: laedt ? null : anlagenBilanz, gebaeude })
      : [],
    kennzahlen: kennzahlenDerEbene(ebene, kennzahlen.liste),
    bewertung,
  });
  return {
    ebene,
    heute,
    periode: wahl.periode,
    am: wahl.am,
    waehle: (periode, am) => setWahl({ periode, am }),
    register,
    anlagen: anlagenBilanz,
    laedt,
    gebaeude,
    kennzahlen,
    bewertung,
    bezugsbasen,
    inhalt,
  };
}

export function UebersichtBausteine({
  daten,
  zeigen,
  onNavigate,
}: {
  daten: UebersichtDaten;
  /** Die sichtbaren Bausteine des Layouts (`Anpassen` darf sie ausblenden). */
  zeigen: readonly string[];
  onNavigate: (route: Route) => void;
}) {
  const { ebene, periode, am, heute, laedt } = daten;
  const standortId = ebene.art === 'standort' ? ebene.standort.id : null;
  const messstellen = zeigen.includes('messstellen') ? messstellenBaustein(ebene, daten.register) : null;
  const zeigtEnergie = zeigen.includes('energiebilanz');
  const energie = zeigtEnergie ? energiebilanzBaustein({ ebene, periode, am, heute, anlagen: daten.anlagen }) : null;
  const gebaeude =
    zeigtEnergie && standortId
      ? gebaeudeZeilen({ standortId, periode, am, heute, anlagen: laedt ? null : daten.anlagen, gebaeude: daten.gebaeude })
      : [];
  const kennzahlen = zeigen.includes('kennzahlen') ? kennzahlenDerEbene(ebene, daten.kennzahlen.liste) : null;
  const bewertung = zeigen.includes('bewertung') ? daten.bewertung : null;
  // Die Bezugsbasen gehören zur Welt der Kennzahlen: wer „Kennzahlen“ ausblendet, blendet sie mit aus.
  const bezugsbasen = zeigen.includes('kennzahlen') ? (daten.bezugsbasen ?? null) : null;
  if (!messstellen && !energie && gebaeude.length === 0 && !kennzahlen && !bewertung && !bezugsbasen) return null;

  return (
    <div className="vp-ub" data-testid="uebersicht-bausteine">
      {messstellen && (
        <section className="vp-ub-baustein" aria-labelledby="vp-ub-messstellen" data-testid="baustein-messstellen">
          <h2 id="vp-ub-messstellen" className="vp-ub-titel">
            {MESSSTELLEN_TITEL}
          </h2>
          <ul className="vp-ub-zeilen">
            {messstellen.map((z) => (
              <li key={z.key}>
                <button type="button" className={`vp-ub-zeile is-${z.ton}`} onClick={() => onNavigate(z.ziel)} data-testid={`datenlage-${z.key}`}>
                  <span className="vp-ub-punkt" aria-hidden="true" />
                  <span className="vp-ub-text">
                    {z.name && <span className="vp-ub-name">{z.name}</span>}
                    <span className="vp-ub-satz">{z.text}</span>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(energie || gebaeude.length > 0) && (
        <section className="vp-ub-baustein" aria-labelledby="vp-ub-energiebilanz" data-testid="baustein-energiebilanz">
          <div className="vp-ub-kopf">
            <h2 id="vp-ub-energiebilanz" className="vp-ub-titel">
              {UEMS_ENERGIEBILANZ}
            </h2>
            <div className="vp-ub-zeitwahl" role="group" aria-label="Zeitraum">
              <ZeitSegment label="Zeitraum" optionen={BILANZ_PERIODEN} wert={periode} onWert={(p) => daten.waehle(p, letzterGebildeter(p, heute))} />
              <div className="vp-ub-datumzeile">
                <button type="button" className="vp-ub-schritt" aria-label="Vorheriger Zeitraum" onClick={() => daten.waehle(periode, blaettere(periode, am, -1))}>
                  <Icon name="chevron-left" size={18} />
                </button>
                <span className="vp-ub-zeitraum" aria-live="polite" data-testid="energiebilanz-zeitraum">
                  {zeitraumText(periode, am)}
                </span>
                <button
                  type="button"
                  className="vp-ub-schritt"
                  aria-label="Nächster Zeitraum"
                  disabled={laeuftNoch(periode, am, heute)}
                  onClick={() => daten.waehle(periode, blaettere(periode, am, 1))}
                >
                  <Icon name="chevron-right" size={18} />
                </button>
              </div>
            </div>
          </div>
          {laedt ? (
            <p className="vp-ub-hinweis">Wird geladen …</p>
          ) : energie?.hinweis ? (
            <p className="vp-ub-hinweis" data-testid="energiebilanz-hinweis">
              {energie.hinweis}
            </p>
          ) : (
            energie && (
              <>
                {energie.summe && (
                  <p className={`vp-ub-summe is-${energie.summe.ton}`} data-testid="energiebilanz-summe">
                    <strong>{NETZBEZUG}</strong> {energie.summe.text}
                  </p>
                )}
                {energie.gruppen.map((g) => (
                  <div key={g.key} className="vp-ub-gruppe" data-testid={`energiebilanz-gruppe-${g.key}`}>
                    {g.name && (
                      <p className={`vp-ub-gruppe-kopf is-${g.summe?.ton ?? 'off'}`}>
                        <span className="vp-ub-name">{g.name}</span>
                        {g.summe && <span className="vp-ub-satz">{g.summe.text}</span>}
                      </p>
                    )}
                    <ul className="vp-ub-zeilen">
                      {g.systeme.map((s) => (
                        <li key={s.key}>
                          <button type="button" className={`vp-ub-zeile is-${s.ton}`} onClick={() => onNavigate(s.ziel)} data-testid={`system-${s.key}`}>
                            <span className="vp-ub-punkt" aria-hidden="true" />
                            <span className="vp-ub-text">
                              <span className="vp-ub-name">{s.name}</span>
                              {s.zusatz && <span className="vp-ub-satz">{s.zusatz}</span>}
                            </span>
                            <span className="vp-ub-zahl">{s.zahl}</span>
                            <Icon name="chevron-right" size={16} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )
          )}
          {gebaeude.length > 0 && (
            <div className="vp-ub-gruppe" data-testid="gebaeude-zeilen">
              <h3 className="vp-ub-unter">{UEMS_GEBAEUDE}</h3>
              <ul className="vp-ub-zeilen">
                {gebaeude.map((g) => (
                  <li key={g.key}>
                    <button type="button" className={`vp-ub-zeile is-${g.ton}`} onClick={() => onNavigate(g.ziel)} data-testid={`gebaeude-${g.key}`}>
                      <span className="vp-ub-punkt" aria-hidden="true" />
                      <span className="vp-ub-text">
                        <span className="vp-ub-name">{g.name}</span>
                        {g.gemessen && <span className="vp-ub-satz">{g.gemessen}</span>}
                        {g.datenlage && <span className="vp-ub-satz">{g.datenlage}</span>}
                      </span>
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {kennzahlen && (
        <section className="vp-ub-baustein" aria-labelledby="vp-ub-kennzahlen" data-testid="baustein-kennzahlen">
          <div className="vp-ub-kopf">
            <h2 id="vp-ub-kennzahlen" className="vp-ub-titel">
              {UEMS_KENNZAHLEN}
            </h2>
            <button
              type="button"
              className="vp-ub-alle"
              onClick={() => onNavigate(standortId ? standortBereichRoute(standortId, 'kennzahlen') : pageRoute('portfolio-kennzahlen'))}
            >
              {ZUR_LISTE}
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
          <ul className="vp-kz-liste">
            {kennzahlen.map((k) => (
              <li key={k.id}>
                <KennzahlKarte
                  karte={listenKarte(k, daten.kennzahlen.werte[k.id] ?? { art: 'laedt' })}
                  onOeffnen={() => onNavigate(kennzahlRoute(k.id, standortId))}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {bewertung && <BewertungBaustein bild={bewertung} onOeffnen={() => onNavigate(pageRoute('portfolio-bewertung'))} />}

      {bezugsbasen && (
        <BezugsbasisUebersichtKarte
          bild={bezugsbasen}
          onOeffnen={() => onNavigate(pageRoute('portfolio-kennzahlen'))}
          onKennzahl={(id) => onNavigate(kennzahlRoute(id, null))}
        />
      )}
    </div>
  );
}
