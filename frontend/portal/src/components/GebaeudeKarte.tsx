import { Recht } from './Recht';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type MessstellenRegister, type StandortAnlage } from '../api';
import {
  ENERGIE_TITEL,
  KENNZAHLEN_TITEL,
  KNOPF_KENNZAHL_ANLEGEN,
  KNOPF_MESSSTELLE_ANLEGEN,
  darfKennzahlAnlegen,
  energieBlock,
  kennzahlVorschlag,
  kennzahlenDesGebaeudes,
  messstellenBlock,
  offenSatz,
} from '../gebaeudeKarte';
import { UEMS_MESSSTELLE } from '../glossar';
import { heuteIn, listenKarte } from '../kennzahlKarte';
import { kennzahlRoute, type Route } from '../nav';
import type { Knoten } from '../ortsbaum';
import {
  BILANZ_PERIODEN,
  MESSSTELLEN_TITEL,
  blaettere,
  ende,
  laeuftNoch,
  letzterGebildeter,
  zeitraumText,
  type AnlageBilanz,
  type BilanzPeriode,
} from '../uebersichtBausteine';
import type { Sprung } from '../uemsOberflaechen';
import { useBerichtRechte } from '../useBerichtRechte';
import { ZeitSegment } from './HistorieWelt';
import { KennzahlAnlegenDialog } from './KennzahlAnlegenDialog';
import { KennzahlKarte, useKennzahlenListe } from './KennzahlListe';
import { MessstelleDialog } from './MessstelleDialog';
import './GebaeudeKarte.css';

/**
 * Die Karte eines Gebäudes im Ortsbaum von „Standort › Gebäude“ (UEMS AP-13 IP-10 = AP-10 IP-17 Portal-Teil;
 * E4 = A, Ü6, B4) — die Hülle `Ortsbaum.gebaeudeKarte` aus IP-2 bekommt hier ihre drei Blöcke.
 *
 * Geladen wird EINMAL für die ganze Seite ({@link useGebaeudeKarten}): die Bilanz je Anlage des Standorts im
 * gewählten Zeitraum, je Gebäude das Register mit Filter Ort (heute für die Datenlage, am letzten Tag des Zeitraums
 * für „im Gebäude“) und die Kennzahlen des Standorts. Jede Ableitung steht im reinen Modul `gebaeudeKarte.ts`.
 *
 * ⚠ Keine Gebäude-Summe: `uemsBilanz.gebaeude` liefert `gebaeudeverbrauch: null`, und die Karte zeigt sie nie.
 * ⚠ Mit „Stand am …“ gibt es keinen Schreibweg (AP-02 IP-13) — dann fehlen „Kennzahl anlegen“ und
 *   „Messstelle anlegen“, nicht nur ihre Wirkung.
 * ⚠ „Kennzahl anlegen“ nur mit `kennzahl.standort_definieren` an DIESEM Standort (AP-11 E10, G3).
 */

export interface GebaeudeDaten {
  periode: BilanzPeriode;
  am: string;
  heute: string;
  waehle: (periode: BilanzPeriode, am: string) => void;
  anlagen: AnlageBilanz[] | null;
  /** Je Gebäude-ID: das Register von heute (Datenlage) und die Messstellen am letzten Tag des Zeitraums. */
  jeGebaeude: Record<string, { heute: MessstellenRegister | null; imZeitraum: Map<string, string> | null }>;
  kennzahlen: ReturnType<typeof useKennzahlenListe>;
  rechte: ReturnType<typeof useBerichtRechte>;
  /** Der Ortsbaum ist neu zu lesen (eine Messstelle wurde angelegt). */
  neuLaden: () => void;
  lauf: number;
}

/** Das Register eines Orts — der Fehlerfall bleibt `null`, damit keine Zahl aus einer fehlenden Antwort entsteht. */
const registerFuer = (ort: string, stichtag?: string) =>
  api.messstellenRegister(stichtag ? { ort, stichtag } : { ort }).then(
    (r): MessstellenRegister | null => r,
    (): MessstellenRegister | null => null,
  );

export function useGebaeudeKarten(
  standort: { id: string; zeitzone: string },
  gebaeude: readonly { id: string; kurzzeichen: string | null }[],
  anlagen: readonly StandortAnlage[],
): GebaeudeDaten {
  const heute = heuteIn(standort.zeitzone, Date.now());
  const [wahl, setWahl] = useState<{ periode: BilanzPeriode; am: string }>(() => ({ periode: 'monat', am: letzterGebildeter('monat', heute) }));
  const [lauf, setLauf] = useState(0);

  const anlagenSchluessel = JSON.stringify(anlagen.map((a) => ({ id: a.id, name: a.name })));
  const bilanzSchluessel = `${anlagenSchluessel}|${wahl.periode}|${wahl.am}`;
  const [bilanzen, setBilanzen] = useState<{ schluessel: string; anlagen: AnlageBilanz[] } | null>(null);
  useEffect(() => {
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
  }, [anlagenSchluessel, bilanzSchluessel, wahl.periode, wahl.am]);

  // „im Gebäude“ gilt am letzten Tag des Zeitraums (wie „Stand am …“) — nie nach heute.
  const stichtag = [ende(wahl.periode, wahl.am), heute].sort()[0];
  const orteSchluessel = JSON.stringify(gebaeude.map((g) => ({ id: g.id, kurzzeichen: g.kurzzeichen })));
  const schluessel = `${orteSchluessel}|${stichtag}|${lauf}`;
  const [je, setJe] = useState<{ schluessel: string; daten: GebaeudeDaten['jeGebaeude'] } | null>(null);
  useEffect(() => {
    const liste = (JSON.parse(orteSchluessel) as { id: string; kurzzeichen: string | null }[]).filter((g) => g.kurzzeichen);
    if (liste.length === 0) {
      setJe({ schluessel, daten: {} });
      return;
    }
    let aktiv = true;
    Promise.all(
      liste.map(async (g) => {
        const [jetzt, imZeitraum] = await Promise.all([registerFuer(g.kurzzeichen!), registerFuer(g.kurzzeichen!, stichtag)]);
        return [g.id, { heute: jetzt, imZeitraum: imZeitraum ? new Map(imZeitraum.register.map((z) => [z.kennzeichen, z.name ?? z.kennzeichen])) : null }] as const;
      }),
    ).then((xs) => aktiv && setJe({ schluessel, daten: Object.fromEntries(xs) }));
    return () => {
      aktiv = false;
    };
  }, [orteSchluessel, stichtag, schluessel]);

  const kennzahlen = useKennzahlenListe(standort.zeitzone, standort.id, lauf);
  const rechte = useBerichtRechte();

  return {
    periode: wahl.periode,
    am: wahl.am,
    heute,
    waehle: (periode, am) => setWahl({ periode, am }),
    anlagen: bilanzen?.schluessel === bilanzSchluessel ? bilanzen.anlagen : null,
    jeGebaeude: je?.schluessel === schluessel ? je.daten : {},
    kennzahlen,
    rechte,
    neuLaden: () => setLauf((n) => n + 1),
    lauf,
  };
}

/** Die Zeit-Leiste der Seite: EIN Zeitraum für alle Karten (wie die Bausteine der Übersicht, Ü3). */
export function GebaeudeZeitLeiste({ daten }: { daten: GebaeudeDaten }) {
  const { periode, am, heute } = daten;
  return (
    <div className="vp-gk-zeitwahl" role="group" aria-label="Zeitraum" data-testid="gebaeude-zeitleiste">
      <ZeitSegment label="Zeitraum" optionen={BILANZ_PERIODEN} wert={periode} onWert={(p) => daten.waehle(p, letzterGebildeter(p, heute))} />
      <div className="vp-gk-datumzeile">
        <button type="button" className="vp-gk-schritt" aria-label="Vorheriger Zeitraum" onClick={() => daten.waehle(periode, blaettere(periode, am, -1))}>
          <Icon name="chevron-left" size={18} />
        </button>
        <span className="vp-gk-zeitraum" aria-live="polite" data-testid="gebaeude-zeitraum">
          {zeitraumText(periode, am)}
        </span>
        <button
          type="button"
          className="vp-gk-schritt"
          aria-label="Nächster Zeitraum"
          disabled={laeuftNoch(periode, am, heute)}
          onClick={() => daten.waehle(periode, blaettere(periode, am, 1))}
        >
          <Icon name="chevron-right" size={18} />
        </button>
      </div>
    </div>
  );
}

export function GebaeudeKarte({
  knoten,
  standort,
  stichtag,
  daten,
  onNavigate,
  springe,
}: {
  knoten: Knoten;
  standort: { id: string; name: string };
  /** „Stand am …“: mit Stichtag gibt es keinen Schreibweg (AP-02 IP-13). */
  stichtag: string | null;
  daten: GebaeudeDaten;
  onNavigate: (route: Route) => void;
  springe: (sprung: Sprung) => void;
}) {
  const [kennzahlAnlegen, setKennzahlAnlegen] = useState(false);
  const [messstelleAnlegen, setMessstelleAnlegen] = useState(false);
  const ausloeser = useRef<HTMLElement | null>(null);
  const je = daten.jeGebaeude[knoten.schluessel] ?? { heute: null, imZeitraum: null };

  const energie = useMemo(
    () =>
      energieBlock({
        gebaeudeName: knoten.name,
        periode: daten.periode,
        am: daten.am,
        heute: daten.heute,
        anlagen: daten.anlagen,
        imZeitraum: je.imZeitraum,
      }),
    [knoten.name, daten.periode, daten.am, daten.heute, daten.anlagen, je.imZeitraum],
  );
  const messstellen = messstellenBlock({
    standortId: standort.id,
    gebaeudeKurzzeichen: knoten.kurzzeichen,
    register: je.heute,
    mitStichtag: stichtag !== null,
  });
  const bereichIds = knoten.kinder.flatMap((k) => (k.id ? [k.id] : []));
  const kennzahlen = knoten.id ? kennzahlenDesGebaeudes(daten.kennzahlen.liste, knoten.id, bereichIds) : null;
  const vorschlag = knoten.id ? kennzahlVorschlag({ id: knoten.id, name: knoten.name }, energie) : null;
  const darfAnlegen = !stichtag && darfKennzahlAnlegen(daten.rechte, standort.id);

  const merke = (e: { currentTarget: HTMLElement }) => {
    ausloeser.current = e.currentTarget;
  };
  const zurueck = () => ausloeser.current?.focus();

  return (
    <div className="vp-gk" data-testid={`gebaeude-karte-${knoten.kurzzeichen ?? knoten.schluessel}`}>
      <section className="vp-gk-block" aria-label={`${ENERGIE_TITEL} · ${knoten.name}`}>
        <h4 className="vp-gk-titel">{ENERGIE_TITEL}</h4>
        {energie.hinweis ? (
          <p className="vp-gk-hinweis" data-testid="gebaeude-energie-hinweis">
            {energie.hinweis}
          </p>
        ) : energie.systeme.length === 0 ? (
          <p className="vp-gk-hinweis" aria-busy="true">
            Wird geladen …
          </p>
        ) : (
          energie.systeme.map((s) => (
            <div key={s.key} className="vp-gk-system" data-testid={`gebaeude-system-${s.key}`}>
              <p className={`vp-gk-satz is-${s.ton}`}>
                <span className="vp-gk-punkt" aria-hidden="true" />
                {s.gemessen}
              </p>
              {s.posten.length > 0 && (
                <ul className="vp-gk-posten">
                  {s.posten.map((p) => (
                    <li key={p.messstelle}>
                      <span className="vp-gk-posten-name">{p.name}</span>
                      <span className="vp-gk-posten-zahl">{p.menge ?? '—'}</span>
                    </li>
                  ))}
                </ul>
              )}
              {s.ausserhalb && <p className="vp-gk-neben">{s.ausserhalb}</p>}
              {s.rest && (
                <button type="button" className="vp-gk-rest" onClick={() => onNavigate(s.ziel)} data-testid={`gebaeude-rest-${s.key}`}>
                  <span>{s.rest}</span>
                  <Icon name="chevron-right" size={16} />
                </button>
              )}
            </div>
          ))
        )}
        {energie.offen.length > 0 && (
          <p className="vp-gk-hinweis" data-testid="gebaeude-energie-offen">
            {offenSatz(energie.offen)}
          </p>
        )}
      </section>

      <section className="vp-gk-block" aria-label={`${MESSSTELLEN_TITEL} · ${knoten.name}`}>
        <h4 className="vp-gk-titel">{MESSSTELLEN_TITEL}</h4>
        {messstellen.text ? (
          <button type="button" className={`vp-gk-zeile is-${messstellen.ton}`} onClick={() => springe(messstellen.ziel)} data-testid="gebaeude-datenlage">
            <span className="vp-gk-punkt" aria-hidden="true" />
            <span className="vp-gk-satz-text">{messstellen.text}</span>
            <Icon name="chevron-right" size={16} />
          </button>
        ) : (
          <>
            <p className="vp-gk-hinweis">{`Noch keine ${UEMS_MESSSTELLE} in diesem Gebäude.`}</p>
            {messstellen.anlegen && (
              <Recht aktion="messstelle.bearbeiten"><Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  merke(e);
                  setMessstelleAnlegen(true);
                }}
              >
                {KNOPF_MESSSTELLE_ANLEGEN}
              </Button></Recht>
            )}
          </>
        )}
      </section>

      <section className="vp-gk-block" aria-label={`${KENNZAHLEN_TITEL} · ${knoten.name}`}>
        <h4 className="vp-gk-titel">{KENNZAHLEN_TITEL}</h4>
        {kennzahlen ? (
          <ul className="vp-kz-liste">
            {kennzahlen.map((k) => (
              <li key={k.id}>
                <KennzahlKarte
                  karte={listenKarte(k, daten.kennzahlen.werte[k.id] ?? { art: 'laedt' })}
                  onOeffnen={() => onNavigate(kennzahlRoute(k.id, standort.id))}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="vp-gk-hinweis">{`Für dieses Gebäude gibt es noch keine ${KENNZAHLEN_TITEL.toLowerCase()}.`}</p>
        )}
        {darfAnlegen && (
          <Recht aktion="kennzahl.standort_definieren"><Button
            variant="outline"
            size="sm"
            onClick={(e) => {
              merke(e);
              setKennzahlAnlegen(true);
            }}
          >
            {KNOPF_KENNZAHL_ANLEGEN}
          </Button></Recht>
        )}
      </section>

      {kennzahlAnlegen && (
        <KennzahlAnlegenDialog
          open
          vorschlag={vorschlag}
          onClose={() => {
            setKennzahlAnlegen(false);
            zurueck();
          }}
          onAngelegt={() => daten.neuLaden()}
          onZurKennzahl={(id) => {
            setKennzahlAnlegen(false);
            onNavigate(kennzahlRoute(id, standort.id));
          }}
        />
      )}
      {messstelleAnlegen && (
        <MessstelleDialog
          open
          standortId={standort.id}
          onClose={() => {
            setMessstelleAnlegen(false);
            zurueck();
          }}
          onGespeichert={() => daten.neuLaden()}
        />
      )}
    </div>
  );
}
