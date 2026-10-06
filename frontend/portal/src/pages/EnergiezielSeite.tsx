import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type Auffaelligkeit, type Energieziel, type EnergiezielStand, type Massnahme, type VorgangAnstoss } from '../api';
import { EnergiezielBeendenDialog, EnergiezielBewertenDialog } from '../components/EnergiezielDialoge';
import { GrenzHinweis } from '../components/GrenzSatz';
import { MassnahmeAnlegenDialog } from '../components/MassnahmeDialoge';
import { MonatsGrafik } from '../components/MonatsGrafik';
import { Recht } from '../components/Recht';
import { RowMenu, type RowMenuItem } from '../components/RowMenu';
import { StandSkala } from '../components/StandSkala';
import { VerbesserungAnstoesse } from '../components/VerbesserungAnstoesse';
import * as B from '../energiezielBild';
import * as Z from '../energieziele';
import { useRollen } from '../rollen';
import { merkeAbruf } from '../routenUhr';
import '../components/kacheln/Kacheln.css';
import './Energieziele.css';

type Daten = {
  ez: Energieziel;
  stand: EnergiezielStand | null;
  massnahmen: B.MassnahmenAmZiel | null;
  vermerke: Auffaelligkeit[];
  nachfolger: Energieziel | null;
};
type Lage = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | ({ art: 'da' } & Daten);
type Dialog = null | 'bewerten' | 'freigeben' | 'ablehnen' | 'beenden' | 'planen';

const VERWALTEN = 'verbesserung.verwalten';
const ABSCHLIESSEN = 'verbesserung.abschliessen';

/**
 * Die Seite eines Energieziels (Konzept Verbessern §6.4, PR 1): „Sind wir auf Kurs, und was wird dafür getan?“ - oben
 * die Antwort mit Bedingung, der Stand auf der Skala mit den kWh-Kacheln und „Was noch nötig ist“, die Maßnahmen am
 * Energieziel (und was schon im Stand enthalten ist), die Monate als Grafik mit dem Energieziel als gestrichelte Linie
 * und als Liste, die Bewertung, „Über dieses Energieziel“. Ein bewertetes Energieziel zeigt oben den festgehaltenen
 * Stand (Entscheid 11), den Live-Stand nur, wenn er abweicht. Gerechnet wird nichts: Lage, Lücke und der nötige Schnitt
 * kommen von der Route (Operation `kurs`).
 */
export function EnergiezielSeite({
  id,
  onListe,
  onKennzahl,
  onMassnahme,
  onOeffnen,
}: {
  id: string;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  /** Nach „Maßnahme planen“ und aus der Liste der Maßnahmen: die Seite der Maßnahme. */
  onMassnahme?: (massnahmeId: string) => void;
  /** „Daraus folgte“: ein anderes Energieziel öffnen. */
  onOeffnen?: (energiezielId: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [anstoss, setAnstoss] = useState<VorgangAnstoss | null>(null);
  const [beobachtet, setBeobachtet] = useState<Record<string, string>>({});
  const [verlaufOffen, setVerlaufOffen] = useState(false);
  const rollen = useRollen();
  const sub = rollen.selbst?.kennung ?? null;

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    Promise.all([
      api.energieziel(id),
      api.energiezielStand(id).catch(() => null),
      api.massnahmenZumEnergieziel(id).catch(() => null),
    ])
      .then(async ([ez, stand, liste]) => {
        merkeAbruf(stand?.abruf);
        const [vermerke, nachfolger] = await Promise.all([
          ez.zustand === 'offen'
            ? api.auffaelligkeiten(ez.kennzahl.id).then(
                (l) => l.vermerke.filter((v) => v.zustand === 'offen' && v.periode >= ez.zielperiode.slice(0, 7) && v.periode <= ez.zielperiode.slice(8)),
                () => [] as Auffaelligkeit[],
              )
            : Promise.resolve([] as Auffaelligkeit[]),
          ez.zustand !== 'offen'
            ? api.energieziele({ kennzahl: ez.kennzahl.id }).then(
                (l) => l.energieziele.filter((x) => x.zielperiode.slice(0, 7) > ez.zielperiode.slice(8)).sort((a, b) => a.zielperiode.localeCompare(b.zielperiode))[0] ?? null,
                () => null,
              )
            : Promise.resolve(null),
        ]);
        if (aktiv) setLage({ art: 'da', ez, stand, massnahmen: liste ? B.massnahmenAmZiel(liste) : null, vermerke, nachfolger });
      })
      .catch((e) => aktiv && setLage({ art: e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  // Was eine umgesetzte Maßnahme an derselben Kennzahl beobachtet - die Wirkung der Route, je Maßnahme einmal.
  useEffect(() => {
    if (lage.art !== 'da' || !lage.massnahmen) return;
    let aktiv = true;
    const umgesetzt = [...lage.massnahmen.fuer, ...lage.massnahmen.imStand].filter((m) => m.messgrundlage && m.umgesetzt_am);
    for (const m of umgesetzt) {
      api.massnahmeWirkung(m.id).then(
        (w) => {
          const summe = w.summe;
          if (!aktiv || !summe || summe.delta_prozent === null) return;
          const text = summe.richtung === 'gleich' ? 'wie erwartet' : `${B.prozent(summe.delta_prozent)} ${summe.richtung}`;
          setBeobachtet((b) => ({ ...b, [m.id]: text }));
        },
        () => undefined,
      );
    }
    return () => {
      aktiv = false;
    };
  }, [lage]);

  const zurueck = (
    <button type="button" className="vp-ezl-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={16} />
      {B.ZUR_LISTE}
    </button>
  );

  if (lage.art === 'laedt') {
    return (
      <div className="vp-ezl vp-k-farben" data-testid="energieziel-seite" aria-busy="true">
        {zurueck}
        <div className="vp-ezl-skelett">
          <span className="vp-skeleton is-zeile" />
          <span className="vp-skeleton is-satz" />
          <span className="vp-skeleton is-karte" />
        </div>
      </div>
    );
  }
  if (lage.art !== 'da') {
    return (
      <div className="vp-ezl vp-k-farben" data-testid="energieziel-seite">
        {zurueck}
        {lage.art === 'fehlt' ? (
          <p className="vp-ezl-leer">{B.NICHT_GEFUNDEN}</p>
        ) : (
          <section className="vp-ezl-karte is-fehler" role="alert">
            <p className="vp-ezl-leer">{B.LADEFEHLER_SEITE}</p>
            <button type="button" className="vp-ezl-link" onClick={() => setVersuch((v) => v + 1)}>
              {B.ERNEUT}
            </button>
          </section>
        )}
        <GrenzHinweis />
      </div>
    );
  }

  const { ez, stand } = lage;
  const offen = ez.zustand === 'offen';
  const bewertung = Z.bewertungLage(ez, sub);
  const fest = bewertung.art === 'bewertet' ? B.festAntwort(ez) : null;
  const antwort: B.Antwort | null = fest
    ? fest
    : ez.zustand === 'beendet'
      ? { lage: 'noch_keine_aussage', satz: ez.beendet_zum ? Z.beendetSatz(ez.beendet_zum, ez.beendet_grund) : 'Vorzeitig beendet.', formal: B.zielperiodeText(ez.zielperiode) }
      : stand
        ? B.seitenAntwort(stand, ez)
        : null;
  const frist = Z.fristText(ez);
  const faellig = offen && bewertung.art === 'keine' && ez.frist.faellig === 'bewertung_faellig';
  const bewertbar = offen && bewertung.art === 'keine' && (faellig || (stand !== null && stand.monate_endgueltig === stand.monate_soll));
  const punkte = stand ? B.monatsPunkte(stand) : [];
  const hatMonatswert = punkte.some((p) => p.art === 'gezaehlt');
  // Vor dem ersten Monat der Zielperiode gibt es nichts zu zeigen - die Antwort sagt, wann sie beginnt.
  const begonnen = punkte.some((p) => p.art !== 'kommt');
  const neu = (x: Energieziel) => {
    setDialog(null);
    setAnstoss(null);
    setLage({ ...lage, ez: x });
    setVersuch((v) => v + 1);
  };
  const menue: RowMenuItem[] = [
    ...(onKennzahl ? [{ label: 'Zur Kennzahl', icon: 'trending-up' as const, onClick: () => onKennzahl(ez.kennzahl.id) }] : []),
    ...(offen && bewertung.art === 'keine'
      ? [{ label: 'Vorzeitig beenden', icon: 'x' as const, recht: VERWALTEN, standort: ez.standort_id, danger: true, onClick: () => setDialog('beenden') }]
      : []),
  ];

  // ------------------------------------------------------------------ Bausteine
  const hinweisWenige = offen && stand ? B.wenigeMonateHinweis(stand) : null;
  const vermerk = lage.vermerke[0];
  const kopf = (
    <header className="vp-ezl-kopf">
      <div className="vp-ezl-kopf-text">
        <h1>
          {B.energiezielName(ez)} <span className="kz">{ez.kennzeichen}</span>
        </h1>
        <p className="vp-ezl-meta">
          {ez.kennzahl.name} · verantwortlich {ez.verantwortlich.name}
        </p>
      </div>
      {menue.length > 0 && (
        <span className="vp-ezl-menue" data-testid="energieziel-menue">
          <RowMenu label="Weitere Aktionen" buttonClassName="vp-ezl-menue-knopf" items={menue} />
        </span>
      )}
    </header>
  );

  const standKarte = fest ? (
    <FestKarte ez={ez} />
  ) : offen && stand ? (
    <section className="vp-ezl-karte" aria-labelledby="ez-stand" data-testid="energieziel-stand">
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-stand">Stand gegen das Energieziel</h2>
        <span className="m">{stand.monate_bewertbar === 0 ? 'noch kein Monat' : `${stand.monate_text} Monaten`}</span>
      </div>
      <StandSkala
        bild={B.skalaBild({ delta: stand.summe.delta_prozent, urteil: stand.summe.urteil, zielwert: ez.zielwert_prozent, punktWort: 'bisher' })}
        label={antwort?.satz ?? B.energiezielName(ez)}
      />
      <Kacheln kacheln={B.standKacheln(stand)} />
      {B.noetigSatz(stand.kurs) && (
        <p className="vp-ezl-noetig" data-testid="energieziel-noetig">
          <b>Was noch nötig ist:</b> {B.noetigSatz(stand.kurs)} {B.NAEHERUNG}
        </p>
      )}
    </section>
  ) : offen ? (
    <section className="vp-ezl-karte is-fehler" role="alert">
      <p className="vp-ezl-leer">{B.STAND_LADEFEHLER}</p>
      <button type="button" className="vp-ezl-link" onClick={() => setVersuch((v) => v + 1)}>
        {B.ERNEUT}
      </button>
    </section>
  ) : null;

  const heute = fest ? B.heuteGelesen(ez.bewertung?.stand, stand) : null;
  const vermerkHinweis = vermerk && (
    <Hinweis testId="energieziel-auffaelligkeit">
      <b>Auffälligkeit zu {B.monatLang(vermerk.periode)} · offen.</b> VoltPilot hat den Monat vermerkt, weil er über der
      Bezugsbasis liegt. Ob das eine Abweichung ist, sagt eine Person.{' '}
      {onKennzahl && (
        <button type="button" className="vp-ezl-link is-im-satz" onClick={() => onKennzahl(ez.kennzahl.id)}>
          Beantworten
        </button>
      )}
    </Hinweis>
  );

  const grafik = stand && begonnen && (offen || hatMonatswert) && (
    <section className="vp-ezl-karte" aria-labelledby="ez-monate" data-testid="energieziel-grafik">
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-monate">Je Monat gegen das Energieziel</h2>
        <span className="m">{stand.monate_text} Monaten</span>
      </div>
      <MonatsGrafik
        punkte={punkte}
        zielwert={ez.zielwert_prozent}
        band={stand.summe.band_prozent ?? stand.monate.find((m) => m.vergleich.bereinigt.band_prozent)?.vergleich.bereinigt.band_prozent ?? null}
        linieWort={`Energieziel: ${B.zielText(ez.zielwert_prozent)}`}
        label={`${B.energiezielName(ez)}, Abweichung vom Erwarteten je Monat`}
      />
      <p className="vp-ezl-fazit">
        <b>Gezählt wird über {stand.monate_soll === 1 ? 'den einen Monat' : `alle ${B.zahlwort(stand.monate_soll)} Monate`} zusammen:</b>{' '}
        Summe gemessen durch Summe erwartet. Ein einzelner Monat darf darüber liegen, wenn andere darunter liegen.
      </p>
    </section>
  );

  const werte = stand && begonnen && (offen || hatMonatswert) && <WerteJeMonat punkte={punkte} onMonat={onKennzahl ? () => onKennzahl(ez.kennzahl.id) : undefined} />;

  const darfPlanen = offen && rollen.darf(VERWALTEN, ez.standort_id);
  // Am Rechner (§6.4): die Ankündigung der Bewertung steht als Zeile in „Über dieses Energieziel“, die Karte erst, wenn
  // es etwas zu tun oder zu lesen gibt. Bewertete stehen mit ihrem Stand oben, die Bewertung daneben.
  const bewertungBreit = !(offen && bewertung.art === 'keine' && !bewertbar && !bewertung.abgelehnt);
  const monate = !!grafik;
  const flaechen = (
    offen
      ? [monate ? 'grafik rechts' : 'rechts rechts', ...(monate ? ['werte werte'] : []), 'massnahmen ueber', ...(bewertungBreit ? ['bewertung bewertung'] : [])]
      : [bewertungBreit ? 'rechts bewertung' : 'rechts rechts', ...(monate ? ['grafik grafik', 'werte werte'] : []), 'massnahmen ueber']
  )
    .map((z) => `'${z}'`)
    .join(' ');
  const massnahmenKarte = (
    <section className="vp-ezl-karte" aria-labelledby="ez-massnahmen" data-testid="energieziel-massnahmen">
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-massnahmen">{offen ? 'Was dafür getan wird' : 'Was dafür getan wurde'}</h2>
        <span className="m">{lage.massnahmen && lage.massnahmen.fuer.length > 0 ? `${lage.massnahmen.fuer.length} ${lage.massnahmen.fuer.length === 1 ? 'Maßnahme' : 'Maßnahmen'}` : 'Maßnahmen'}</span>
      </div>
      {lage.massnahmen === null ? (
        <p className="vp-ezl-leer">Die Maßnahmen laden gerade nicht. Ihre Daten sind nicht betroffen.</p>
      ) : (
        <>
          {lage.massnahmen.fuer.length === 0 ? (
            <p className="vp-ezl-leer">{offen ? 'Für dieses Energieziel ist noch keine Maßnahme geplant.' : 'Für dieses Energieziel war keine Maßnahme angelegt.'}</p>
          ) : (
            <div className="vp-ezl-liste">
              {lage.massnahmen.fuer.map((m) => (
                <MassnahmeReihe key={m.id} m={m} beobachtet={beobachtet[m.id] ?? null} onMassnahme={onMassnahme} />
              ))}
            </div>
          )}
          {darfPlanen &&
            (lage.massnahmen.fuer.length === 0 ? (
              <Button iconLeft={<Icon name="plus" size={16} />} className="vp-ezl-voll" onClick={() => setDialog('planen')} data-testid="energieziel-planen">
                {B.KNOPF_PLANEN}
              </Button>
            ) : (
              <button type="button" className="vp-ezl-link" onClick={() => setDialog('planen')} data-testid="energieziel-planen">
                Weitere Maßnahme planen
              </button>
            ))}
          {lage.massnahmen.imStand.length > 0 && (
            <>
              <p className="vp-ezl-label">Schon umgesetzt, im Stand enthalten</p>
              <div className="vp-ezl-liste">
                {lage.massnahmen.imStand.map((m) => (
                  <MassnahmeReihe key={m.id} m={m} beobachtet={beobachtet[m.id] ?? null} onMassnahme={onMassnahme} />
                ))}
              </div>
            </>
          )}
        </>
      )}
      {lage.nachfolger && onOeffnen && (
        <p className="vp-ezl-text">
          Daraus folgte:{' '}
          <button type="button" className="vp-ezl-link is-im-satz" onClick={() => onOeffnen(lage.nachfolger!.id)}>
            {B.energiezielName(lage.nachfolger)}
          </button>
        </p>
      )}
    </section>
  );

  const bewertungKarte = (
    <section
      className="vp-ezl-karte"
      aria-labelledby="ez-bewertung"
      data-testid="energieziel-bewertung"
      data-entscheid="energieziel_bewertung"
    >
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-bewertung">Bewertung</h2>
        {ez.ergebnis && <span className="vp-k-marke">{B.ERGEBNIS_WORT[ez.ergebnis]}</span>}
      </div>
      {bewertung.art === 'bewertet' ? (
        <>
          {bewertung.bewertung ? (
            <blockquote className="vp-ezl-zitat">
              <p>‚{bewertung.bewertung.begruendung}‘</p>
              <footer data-testid="energieziel-bewertet">
                {B.bewertetFuss(bewertung.bewertung, ez.bewertung?.stand)}
              </footer>
            </blockquote>
          ) : (
            <p className="vp-ezl-leise" data-testid="energieziel-bewertet">
              {`${Z.ZUSTAND_WORT.bewertet}: ${ez.ergebnis ? Z.ERGEBNIS_WORT[ez.ergebnis] : '-'}`}
            </p>
          )}
          {bewertung.bewertung?.entscheidung && (
            <p className="vp-ezl-leise" data-testid="energieziel-bestaetigt">
              {Z.bestaetigtSatz(bewertung.bewertung.entscheidung.name, bewertung.bewertung.entschieden_am)}
            </p>
          )}
          {bewertung.bewertung && Z.weichtAb(bewertung.bewertung.vorschlag, bewertung.bewertung.ergebnis) && (
            <p className="vp-ezl-leise" data-testid="energieziel-abweichung">
              {Z.ABWEICHUNG_VOM_VORSCHLAG}
            </p>
          )}
          {bewertung.bewertung?.pruefsumme && (
            <details className="vp-ezl-details">
              <summary>Kopie und Prüfsumme</summary>
              <p className="vp-ezl-pruefsumme">Prüfsumme {bewertung.bewertung.pruefsumme}</p>
              <p className="vp-ezl-pruefsumme">{bewertung.bewertung.kopie}</p>
            </details>
          )}
        </>
      ) : bewertung.art === 'beantragt' ? (
        <>
          <p className="vp-ezl-text" data-testid="energieziel-beantragt">
            {Z.beantragtSatz(bewertung.bewertung.person.name, bewertung.bewertung.am, bewertung.bewertung.ergebnis)}
          </p>
          <blockquote className="vp-ezl-zitat">
            <p>‚{bewertung.bewertung.begruendung}‘</p>
          </blockquote>
          {bewertung.eigener ? (
            <p className="vp-ezl-leise">{Z.EIGENER_ANTRAG}</p>
          ) : (
            <Recht aktion={ABSCHLIESSEN} standort={ez.standort_id}>
              <div className="vp-ezl-aktionen">
                <Button size="sm" onClick={() => setDialog('freigeben')} data-testid="energieziel-freigeben">
                  {Z.KNOPF_FREIGEBEN}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDialog('ablehnen')} data-testid="energieziel-ablehnen">
                  {Z.KNOPF_ABLEHNEN}
                </Button>
              </div>
            </Recht>
          )}
        </>
      ) : ez.zustand === 'beendet' ? (
        <p className="vp-ezl-text" data-testid="energieziel-beendet">
          {ez.beendet_zum ? Z.beendetSatz(ez.beendet_zum, ez.beendet_grund) : Z.ZUSTAND_WORT.beendet}
        </p>
      ) : (
        <>
          <p className="vp-ezl-text">{bewertbar ? B.bewertungFaelligSatz(stand, ez) : B.bewertungAnkuendigung(ez.zielperiode)}</p>
          {frist && (
            <p className="vp-ezl-frist" data-testid="energieziel-frist">
              {frist}
            </p>
          )}
          {bewertung.abgelehnt && (
            <p className="vp-ezl-leise" data-testid="energieziel-abgelehnt">
              {Z.abgelehntSatz(bewertung.abgelehnt.entscheidung?.name ?? null)}
              {bewertung.abgelehnt.entscheidungs_begruendung && ` ‚${bewertung.abgelehnt.entscheidungs_begruendung}‘`}
            </p>
          )}
          {bewertbar && (
            <Recht aktion={ABSCHLIESSEN} standort={ez.standort_id}>
              <div className="vp-ezl-aktionen">
                <Button size="sm" onClick={() => setDialog('bewerten')} data-testid="energieziel-bewerten">
                  Bewerten
                </Button>
              </div>
            </Recht>
          )}
        </>
      )}
    </section>
  );

  const ueber = (
    <section className="vp-ezl-karte" aria-labelledby="ez-ueber" data-testid="energieziel-ueber">
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-ueber">Über dieses Energieziel</h2>
      </div>
      <div className="vp-ezl-zuo">
        <Zeile l="Vorgenommen" w={ez.wortlaut} n={B.zielperiodeText(ez.zielperiode)} />
        <Zeile l="Warum" w={ez.begruendung} />
        <Zeile
          l="Gemessen an"
          w={ez.kennzahl.name}
          n={`Bezugsbasis ${ez.bezugsbasis.kennzeichen}, Fassung ${ez.bezugsbasis.fassung}`}
          a={onKennzahl ? { text: 'Ansehen', tun: () => onKennzahl(ez.kennzahl.id) } : undefined}
        />
        <Zeile
          l="Gesetzt"
          w={`am ${B.tag(ez.angelegt_am)}${ez.verlauf?.[0] ? ` von ${ez.verlauf[0].person}` : ''}`}
          a={ez.verlauf && ez.verlauf.length > 0 ? { text: verlaufOffen ? 'Verlauf schließen' : 'Verlauf', tun: () => setVerlaufOffen((v) => !v) } : undefined}
        />
        {!bewertungBreit && (
          <Zeile
            l="Bewertung"
            w={`nach ${B.monatLang(ez.zielperiode.slice(8))}`}
            n="Vorschlag von VoltPilot, Entscheidung einer Person"
            klasse="vp-ezl-nur-breit"
          />
        )}
      </div>
      {verlaufOffen && ez.verlauf && (
        <ol className="vp-ezl-verlauf" data-testid="energieziel-verlauf">
          {ez.verlauf.map((e, i) => (
            <li key={`${e.am}-${i}`}>
              <b>{Z.VERLAUF_WORT[e.art]}</b> · {e.person} · {B.tag(e.am)}
              {e.begruendung && <span>‚{e.begruendung}‘</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  return (
    <div className="vp-ezl vp-k-farben" data-testid="energieziel-seite">
      {zurueck}
      {kopf}
      {antwort && (
        <div className="vp-ezl-antwort" data-testid="energieziel-antwort">
          <p className="vp-ezl-satz">{antwort.satz}</p>
          <p className="vp-ezl-formal">{antwort.formal}</p>
          {fest && ez.ergebnis && (
            <div className="vp-ezl-marken">
              <span className="vp-k-marke">{B.ERGEBNIS_WORT[ez.ergebnis]}</span>
              <span className="vp-k-marke is-ok">
                <Icon name="check" size={12} />
                festgehalten
              </span>
            </div>
          )}
        </div>
      )}
      {faellig && (
        <Hinweis testId="energieziel-faellig" warn>
          {B.bewertungFaelligSatz(stand, ez)}
        </Hinweis>
      )}

      <div className="vp-ezl-seitenraster" style={{ gridTemplateAreas: flaechen }}>
        <div className="vp-ezl-r-grafik">{grafik}</div>
        <div className="vp-ezl-r-rechts">
          {hinweisWenige && <Hinweis testId="energieziel-wenige">{hinweisWenige}</Hinweis>}
          {standKarte}
          {heute && <Hinweis testId="energieziel-heute">{heute}</Hinweis>}
          {vermerkHinweis}
        </div>
        <div className="vp-ezl-r-werte">{werte}</div>
        <div className="vp-ezl-r-massnahmen">{massnahmenKarte}</div>
        <div className="vp-ezl-r-ueber">{ueber}</div>
        <div className={`vp-ezl-r-bewertung${bewertungBreit ? '' : ' vp-ezl-nur-schmal'}${offen ? '' : ' is-oben'}`}>{bewertungKarte}</div>
      </div>

      {/* IP-20 (§5.6, Z5): die Anstöße mit Antwort-Knöpfen - „beibehalten“ mit Begründung, „neu bewerten“ (IP-17-NAHT). */}
      <VerbesserungAnstoesse
        vorgang="energieziel"
        anstoesse={ez.anstoesse}
        standort={ez.standort_id}
        onAntwort={async (a, antwort2, begruendung) =>
          neu(await api.energiezielAnstossAntwort(ez.id, a.id, { antwort: antwort2, ...(begruendung ? { begruendung } : {}) }))
        }
        onNeuBewerten={(a) => {
          setAnstoss(a);
          setDialog('bewerten');
        }}
      />

      <GrenzHinweis />

      {(dialog === 'bewerten' || dialog === 'freigeben' || dialog === 'ablehnen') && (
        <EnergiezielBewertenDialog
          ez={ez}
          stand={stand}
          schritt={dialog}
          anstoss={anstoss}
          onClose={() => {
            setDialog(null);
            setAnstoss(null);
          }}
          onFertig={neu}
        />
      )}
      {dialog === 'beenden' && <EnergiezielBeendenDialog ez={ez} onClose={() => setDialog(null)} onBeendet={neu} />}
      {dialog === 'planen' && (
        <MassnahmeAnlegenDialog
          vorbelegung={{ herkunft: 'energieziel', energieziel: ez.id, kennzahl: ez.kennzahl.id }}
          onClose={() => setDialog(null)}
          onAngelegt={(m: Massnahme) => {
            setDialog(null);
            if (onMassnahme) onMassnahme(m.id);
            else setVersuch((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

function Hinweis({ children, testId, warn = false }: { children: ReactNode; testId: string; warn?: boolean }) {
  return (
    <div className={`vp-ezl-hinweis${warn ? ' is-warn' : ''}`} data-testid={testId}>
      <span className="vp-ezl-hinweis-i">
        <Icon name={warn ? 'alert-triangle' : 'info'} size={16} />
      </span>
      <span className="vp-ezl-hinweis-t">{children}</span>
    </div>
  );
}

function Kacheln({ kacheln }: { kacheln: B.Kachel[] | null }) {
  if (!kacheln) return null;
  return (
    <div className="vp-ezl-kacheln">
      {kacheln.map((k) => (
        <div key={k.name} className="vp-k">
          <div className="vp-k-kopf">
            <span className="vp-k-name">{k.name}</span>
          </div>
          <div>
            <span className="vp-k-gross">{k.wert}</span>
            {k.einheit && <span className="vp-k-einheit">{k.einheit}</span>}
          </div>
          <p className="vp-k-sub">
            {k.subFett && <b>{k.subFett}</b>}
            {k.sub}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Bewertet (Entscheid 11): der festgehaltene Stand oben - dieselben Zahlen, die die Prüfsumme deckt. */
function FestKarte({ ez }: { ez: Energieziel }) {
  const s = ez.bewertung?.stand;
  const teile = B.festKacheln(ez);
  if (!s) return null;
  return (
    <section className="vp-ezl-karte" aria-labelledby="ez-fest" data-testid="energieziel-fest">
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-fest">Festgehaltener Stand</h2>
        {s.abruf && <span className="m">{B.tag(s.abruf)}</span>}
      </div>
      <StandSkala
        bild={B.skalaBild({ delta: s.delta_prozent, urteil: s.urteil, zielwert: ez.zielwert_prozent })}
        label={`${B.energiezielName(ez)}, festgehalten auf einer Skala`}
      />
      {teile && <Kacheln kacheln={teile.kacheln} />}
      {teile?.fuss && <p className="vp-ezl-fussnote">{teile.fuss}</p>}
    </section>
  );
}

function WerteJeMonat({ punkte, onMonat }: { punkte: B.MonatsPunkt[]; onMonat?: () => void }) {
  const { zeilen, spaeter } = B.monatsZeilen(punkte);
  const chronologisch = [...zeilen].reverse();
  return (
    <section className="vp-ezl-karte" aria-labelledby="ez-werte" data-testid="energieziel-werte">
      <div className="vp-ezl-blockkopf">
        <h2 id="ez-werte">Werte je Monat</h2>
        <span className="m vp-ezl-nur-schmal">neueste zuerst</span>
      </div>
      <div className="vp-ezl-mliste vp-ezl-nur-schmal">
        {zeilen.map((z) => {
          const inhalt = (
            <>
              <span className="mo">{z.titel}</span>
              <span className="mw">{z.text}</span>
              <span className="md">
                {z.zahl && <b>{z.zahl}</b>}
                {z.marke && <span className={`vp-k-marke is-${z.ton}`}>{z.marke}</span>}
              </span>
            </>
          );
          return onMonat ? (
            <button key={z.periode} type="button" className="vp-ezl-mrow" onClick={onMonat} data-testid={`monat-${z.periode}`}>
              {inhalt}
              <span className="chev">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>
          ) : (
            <div key={z.periode} className="vp-ezl-mrow" data-testid={`monat-${z.periode}`}>
              {inhalt}
            </div>
          );
        })}
        {spaeter && <p className="vp-ezl-leise">{spaeter}</p>}
      </div>
      <div className="vp-ezl-tafel-rahmen vp-ezl-nur-breit">
        <table className="vp-ezl-tafel">
          <thead>
            <tr>
              <th scope="col">Monat</th>
              <th scope="col" className="z">Gemessen</th>
              <th scope="col" className="z">Erwartet</th>
              <th scope="col" className="z">Höchstens laut Energieziel</th>
              <th scope="col" className="z">Abweichung</th>
              <th scope="col">Urteil</th>
            </tr>
          </thead>
          <tbody>
            {chronologisch.map((z) => {
              const p = punkte.find((x) => x.periode === z.periode);
              return z.zahl && p ? (
                <tr key={z.periode}>
                  <th scope="row">{z.titel}</th>
                  <td className="z">{p.gemessen}</td>
                  <td className="z">{p.erwartet}</td>
                  <td className="z">{p.hoechstens}</td>
                  <td className="z">{z.zahl}</td>
                  <td>{z.marke && <span className={`vp-k-marke is-${z.ton}`}>{z.marke}</span>}</td>
                </tr>
              ) : (
                <tr key={z.periode} className="is-ohne">
                  <th scope="row">{z.titel}</th>
                  <td colSpan={4}>{z.text}</td>
                  <td>{z.marke && <span className={`vp-k-marke is-${z.ton}`}>{z.marke}</span>}</td>
                </tr>
              );
            })}
            {spaeter && (
              <tr className="is-ohne">
                <td colSpan={6}>{spaeter}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MassnahmeReihe({ m, beobachtet, onMassnahme }: { m: Massnahme; beobachtet: string | null; onMassnahme?: (id: string) => void }) {
  const inhalt = (
    <span className="lead">
      <span className="nm">{m.titel}</span>
      <span className={`st${m.frist.faellig === 'ueberfaellig' ? ' is-warn' : ''}`}>{B.massnahmeUnterzeile(m, beobachtet)}</span>
    </span>
  );
  return onMassnahme ? (
    <button type="button" className="vp-ezl-reihe" onClick={() => onMassnahme(m.id)} data-testid={`massnahme-${m.kennzeichen}`}>
      {inhalt}
      <Icon name="chevron-right" size={16} />
    </button>
  ) : (
    <div className="vp-ezl-reihe" data-testid={`massnahme-${m.kennzeichen}`}>
      {inhalt}
    </div>
  );
}

function Zeile({ l, w, n, a, klasse }: { l: string; w: string; n?: string; a?: { text: string; tun: () => void }; klasse?: string }) {
  return (
    <div className={`vp-ezl-zr${klasse ? ` ${klasse}` : ''}`}>
      <span className="l">{l}</span>
      <span className="w">{w}</span>
      {n && <span className="n">{n}</span>}
      {a && (
        <button type="button" className="a" onClick={a.tun}>
          {a.text}
        </button>
      )}
    </div>
  );
}
