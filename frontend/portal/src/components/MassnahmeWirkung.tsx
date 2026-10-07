import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Massnahme, type MassnahmeBewertung, type MassnahmeErgebnis, type MassnahmeWirkung, type VorgangAnstoss } from '../api';
import * as Z from '../energieziele';
import { NBSP } from '../format';
import { UEMS_MASSNAHME, UEMS_MASSNAHME_ERGEBNISSE, UEMS_NORMGRENZE } from '../glossar';
import * as B from '../massnahmenBild';
import * as W from '../massnahmeWirkung';
import { Ablehnung } from './EnergiezielDialoge';
import { BringtMarke } from './MassnahmenRegister';
import { TextFeld, Wahl } from './MassnahmeDialoge';
import { Recht } from './Recht';
import { Skeleton } from './States';
import { fazit, nachherMonate, URTEIL_WORT, WirkungsGrafik } from './WirkungsGrafik';
import '../pages/Verbesserung.css';
import '../pages/Massnahmen.css';

export type WirkungLage = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; w: MassnahmeWirkung };

/** Die Wirkung der Maßnahme - ein Leser der Route (`…/wirkung`), erneut bei jeder Umsetzung und auf Wunsch. */
export function useWirkung(m: Pick<Massnahme, 'id' | 'umgesetzt_am' | 'zustand' | 'art'>): [WirkungLage | null, () => void] {
  const [lage, setLage] = useState<WirkungLage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const lesen = m.art === 'gemessen' && (m.zustand === 'umgesetzt' || m.zustand === 'bewertet');
  useEffect(() => {
    if (!lesen) return;
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.massnahmeWirkung(m.id).then(
      (w) => aktiv && setLage({ art: 'da', w }),
      () => aktiv && setLage({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [m.id, m.umgesetzt_am, lesen, versuch]);
  return [lesen ? lage : null, () => setVersuch((v) => v + 1)];
}

/** Beobachtet neben erwartet, nie summiert (V2/V4): Weniger als erwartet · Erwartet waren · Vorher. */
export function WirkungKacheln({ m, w }: { m: Massnahme; w: MassnahmeWirkung }) {
  const k = w.massnahme.wirkung_kurz;
  if (!k) return null;
  return (
    <div className="vp-mn-kacheln" data-testid="massnahme-kacheln">
      {B.kachelnBild(m, k).map((x) => (
        <div key={x.titel} className="vp-mn-k" data-testid={`massnahme-kachel-${x.titel}`}>
          <span className="vp-mn-k-titel">{x.titel}</span>
          <span className="vp-mn-k-wert">
            {x.wert}
            <small>{x.einheit}</small>
          </span>
          <p className="vp-mn-k-unter">{x.unter}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * „Je Monat nach der Umsetzung“ (§6.6): die Grafik der Route, darunter in Worten, wie viele Monate unter der
 * Erwartung lagen, und die Gründe der nicht bewertbaren; dieselben Werte als Liste dahinter (Regel 6.11). Laden und
 * noch kein Monat; einen Fehler sagt die Antwort oben mit „Erneut versuchen“ (`antwortBild`).
 */
export function WirkungKarte({ m, lage }: { m: Massnahme; lage: Exclude<WirkungLage, { art: 'fehler' }> }) {
  if (lage.art === 'laedt') {
    return (
      <section className="vp-mn-karte is-wirkung" aria-busy="true" data-testid="massnahme-wirkung">
        <div className="vp-wv-blockkopf">
          <h2>Je Monat nach der Umsetzung</h2>
        </div>
        <Skeleton height={190} />
      </section>
    );
  }
  const w = lage.w;
  const monate = nachherMonate(w);
  const f = fazit(monate);
  const ausschluesse = monate.filter((x) => !x.gezaehlt && x.grund !== null && x.satz).map((x) => x.satz!);
  const zeilen = monate.some((x) => x.vergleich.bereinigt.gemessen.wert !== null)
    ? monate
        .filter((x) => x.vergleich.bereinigt.gemessen.wert !== null || x.grund !== null)
        .map((x) => {
          const b = x.vergleich.bereinigt;
          return {
            periode: x.periode,
            gezaehlt: x.gezaehlt,
            monat: x.vergleich.beschriftung,
            gemessen: b.gemessen.wert === null ? '-' : `${B.ganz(b.gemessen.wert)}${NBSP}${b.gemessen.einheit}`,
            erwartet: b.erwartet === null ? '-' : `${B.ganz(b.erwartet)}${NBSP}${b.gemessen.einheit}`,
            prozent: x.gezaehlt && b.delta_prozent !== null ? `${B.prozentBetrag(b.delta_prozent)} ${B.richtungWort(b.delta_prozent)}` : null,
            wort: x.gezaehlt && b.delta_prozent !== null ? (URTEIL_WORT[b.urteil] ?? b.urteil) : x.grund !== null ? 'nicht bewertbar' : Z.offenGrund(x.vergleich),
            urteil:
              x.gezaehlt && b.delta_prozent !== null
                ? `${B.prozentBetrag(b.delta_prozent)} ${B.richtungWort(b.delta_prozent)}${b.urteil === 'im_rahmen' ? ` · ${URTEIL_WORT[b.urteil]}` : ' als erwartet'}`
                : x.grund !== null
                  ? 'nicht bewertbar'
                  : Z.offenGrund(x.vergleich),
            roh: W.rohText(x.kennzahl_roh) ?? '-',
          };
        })
    : [];
  return (
    <section className="vp-mn-karte is-wirkung" aria-labelledby="ma-je-monat" data-testid="massnahme-wirkung">
      <div className="vp-wv-blockkopf">
        <h2 id="ma-je-monat">Je Monat nach der Umsetzung</h2>
        {w.monate_text && <span className="vp-wv-abschnitt-m is-immer">{`${w.monate_text} Monaten`}</span>}
      </div>
      {w.monate_bewertbar ? (
        <WirkungsGrafik w={w} erwartetProzent={m.erwartete_wirkung_prozent} />
      ) : (
        <p className="vp-mn-text" data-testid="massnahme-wirkung-leer">
          {B.ohneMonatSatz(w)}
        </p>
      )}
      {(f || ausschluesse.length > 0) && (
        <p className="vp-mn-fazit" data-testid="massnahme-wirkung-fazit">
          {f && (
            <>
              <b>{f.kopf}</b>
              {f.rest}
            </>
          )}
          {ausschluesse.length > 0 && ` ${ausschluesse.join(' ')}`}
        </p>
      )}
      {w.satz && (
        <p className="vp-mn-leise" data-testid="massnahme-wirkung-satz">
          {w.satz}
        </p>
      )}
      {zeilen.length > 0 && (
        <details className="vp-mn-details vp-mn-werte" data-testid="massnahme-wirkung-monate">
          <summary>
            Werte je Monat
            <Icon name="chevron-down" size={14} />
          </summary>
          {/* Am Telefon Reihen (wie „Werte je Monat“ am Energieziel), ab 560 px eine Tabelle - dieselben Zeilen. */}
          <ul className="vp-mn-werte-liste">
            {zeilen.map((z) => (
              <li key={z.periode} className={z.gezaehlt ? undefined : 'is-aus'}>
                <b>{z.monat}</b>
                <span className="vp-mn-wl-prozent">{z.prozent ?? z.wort}</span>
                <span className="vp-mn-wl-werte">
                  {z.gemessen === '-' ? 'kein Wert' : z.erwartet === '-' ? z.gemessen : `${z.gemessen}, erwartet ${z.erwartet}`}
                </span>
                <span className="vp-mn-wl-wort">{z.prozent ? z.wort : ''}</span>
                {z.roh !== '-' && <span className="vp-mn-wl-roh">{`${W.ROH_SPALTE} ${z.roh}`}</span>}
              </li>
            ))}
          </ul>
          <div className="vp-mn-werte-rahmen">
            <table>
              <thead>
                <tr>
                  <th scope="col">Monat</th>
                  <th scope="col" className="is-zahl">
                    gemessen
                  </th>
                  <th scope="col" className="is-zahl">
                    erwartet
                  </th>
                  <th scope="col">Urteil</th>
                  <th scope="col" className="is-zahl">
                    {W.ROH_SPALTE}
                  </th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((z) => (
                  <tr key={z.periode} className={z.gezaehlt ? undefined : 'is-aus'} data-testid={`wirkung-${z.periode}`}>
                    <th scope="row">{z.monat}</th>
                    <td className="is-zahl">{z.gemessen}</td>
                    <td className="is-zahl">{z.erwartet}</td>
                    <td data-testid="urteil">{z.urteil}</td>
                    <td className="is-zahl" data-testid="roh">
                      {z.roh}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="vp-mn-leise">{W.ROH_HINWEIS}</p>
        </details>
      )}
    </section>
  );
}

/** „Alle Stände der Bewertung“ - erst beim Aufklappen gelesen; nach einem Fehler mit „Erneut versuchen“. */
function AlleStaende({ m }: { m: Massnahme }) {
  const [liste, setListe] = useState<MassnahmeBewertung[] | null | 'fehler'>(null);
  const [offen, setOffen] = useState(false);
  const [versuch, setVersuch] = useState(0);
  useEffect(() => {
    if (!offen || (liste !== null && liste !== 'fehler')) return;
    let aktiv = true;
    setListe(null);
    api.massnahmeBewertungen(m.id).then(
      (r) => aktiv && setListe(r.bewertungen),
      () => aktiv && setListe('fehler'),
    );
    return () => {
      aktiv = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offen, m.id, versuch]);
  return (
    <details className="vp-mn-details" data-testid="massnahme-staende" onToggle={(e) => setOffen((e.target as HTMLDetailsElement).open)}>
      <summary>
        {W.ALLE_STAENDE}
        <Icon name="chevron-down" size={14} />
      </summary>
      {liste === 'fehler' ? (
        <p className="vp-mn-leise" role="alert">
          {W.STAENDE_LADEFEHLER}{' '}
          <button type="button" className="vp-mn-sprung" onClick={() => setVersuch((v) => v + 1)} data-testid="massnahme-staende-erneut">
            {B.ERNEUT_VERSUCHEN}
          </button>
        </p>
      ) : liste === null ? (
        offen && <Skeleton height={60} />
      ) : (
        <ol className="vp-mn-verlauf">
          {[...liste].reverse().map((b) => (
            <li key={b.stand_nr}>
              <div className="vp-mn-verlauf-text">
                <b>{`Stand Nr. ${b.stand_nr} · ${UEMS_MASSNAHME_ERGEBNISSE[b.ergebnis]}${b.status !== 'bewertet' ? ` (${b.status})` : ''}`}</b>
                <span>{`${b.person.name} · ${Z.tag(b.am)} · ‚${b.begruendung}‘`}</span>
                <span>{W.standZeile(b)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

export type BewertungSchritt = 'bewerten' | 'freigeben' | 'ablehnen';

/**
 * „Kommt der Unterschied von der Maßnahme?“ (§6.6, WK6, E6 = A): das Urteil einer Person mit Zitat, Person, Datum und
 * dem damaligen Stand - „beobachtet“ ist das Wort des Systems, „belegt“ das einer Person. Ein offener Antrag wartet
 * auf eine zweite Person; „Neu prüfen“, wenn seit dem Stand mehr Monate bewertbar sind.
 */
export function UrteilKarte({
  m,
  w,
  sub,
  onDialog,
  darfAbschliessen = true,
}: {
  m: Massnahme;
  w: MassnahmeWirkung | null;
  sub: string | null;
  onDialog: (s: BewertungSchritt) => void;
  /** Ohne `verbesserung.abschliessen` sagt die Karte, wer abschließt, statt die Person dazu aufzufordern. */
  darfAbschliessen?: boolean;
}) {
  const b = m.bewertung;
  const antrag = m.bewertung_antrag;
  const kopie = b ? B.standKopie(b) : null;
  const jetzt = w?.monate_text ?? null;
  // „Neu prüfen“ nur, wenn heute mehr Monate bewertbar sind als im festgehaltenen Stand.
  const neuPruefen = b && kopie && jetzt && (w?.monate_bewertbar ?? 0) > kopie.anzahl && W.bewertbar(m);
  const ohneMessung = m.art !== 'gemessen';
  return (
    <section className="vp-mn-karte is-urteil" aria-labelledby="ma-urteil" data-testid="massnahme-bewertung">
      <div className="vp-wv-blockkopf">
        <h2 id="ma-urteil">{ohneMessung ? 'Was daraus geworden ist' : `Kommt der Unterschied von der ${UEMS_MASSNAHME}?`}</h2>
      </div>
      {b ? (
        <>
          <BringtMarke marke={B.ergebnisMarke(b)} />
          <blockquote className="vp-mn-zitat" data-testid="massnahme-stand">
            ‚{b.begruendung}‘
            <small>
              {`${b.person.name} · ${Z.tag(b.am)}${kopie ? ` · nach ${kopie.monate} Monaten (damals ${kopie.prozent})` : ''}`}
              {W.bestaetigtSatz(b) ? ` · ${W.bestaetigtSatz(b)}` : ''}
            </small>
          </blockquote>
          {neuPruefen && (
            <Recht aktion="verbesserung.abschliessen" standort={m.standort_id}>
              <button type="button" className="vp-mn-sprung" onClick={() => onDialog('bewerten')} data-testid="massnahme-neu-pruefen">
                {`${B.KNOPF_NEU_PRUEFEN} mit ${jetzt} Monaten`}
              </button>
            </Recht>
          )}
        </>
      ) : !antrag ? (
        <p className="vp-mn-text" data-testid="massnahme-beobachtet">
          {ohneMessung
            ? m.zustand === 'umgesetzt'
              ? darfAbschliessen
                ? 'Ohne Kennzahl misst VoltPilot nichts. Ob die Maßnahme hält, sagen Sie mit einem Satz - damit ist sie abgeschlossen.'
                : `Ohne Kennzahl misst VoltPilot nichts. Was daraus geworden ist, sagt ein Satz beim Abschließen - ${B.WER_ABSCHLIESST}.`
              : 'Nach der Umsetzung schließen Sie die Maßnahme mit einem Satz ab.'
            : W.bewertungOffenSatz()}
        </p>
      ) : null}
      {antrag && (
        <div className="vp-mn-hinweis" data-testid="massnahme-antrag">
          <Icon name="info" size={16} />
          <span>
            {`${antrag.person.name} hat „${UEMS_MASSNAHME_ERGEBNISSE[antrag.ergebnis]}“ beantragt (${Z.tag(antrag.am)}): ‚${antrag.begruendung}‘ Bestätigen oder ablehnen kann eine zweite Person.`}
          </span>
        </div>
      )}
      {antrag && !W.eigenerAntrag(m, sub) && (
        <Recht aktion="verbesserung.abschliessen" standort={m.standort_id}>
          <div className="vp-ez-aktionen">
            <Button size="sm" onClick={() => onDialog('freigeben')} data-testid="massnahme-freigeben">
              {W.KNOPF_FREIGEBEN}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDialog('ablehnen')} data-testid="massnahme-ablehnen">
              {W.KNOPF_ABLEHNEN}
            </Button>
          </div>
        </Recht>
      )}
      {antrag && W.eigenerAntrag(m, sub) && <p className="vp-mn-leise">{W.EIGENER_ANTRAG}</p>}
      {(b || antrag) && <AlleStaende key={`${b?.stand_nr ?? 0}-${antrag?.stand_nr ?? 0}`} m={m} />}
    </section>
  );
}

/** Die Antwort-Karten von „Wirkung prüfen“ (§6.9): was jedes Ergebnis bedeutet. */
const ERGEBNIS_KARTE: Record<MassnahmeErgebnis, { wort: string; satz: string }> = {
  belegt: { wort: 'Ja, belegt', satz: 'Sie können begründen, dass die Maßnahme den Unterschied macht.' },
  nicht_belegt: { wort: 'Nicht belegt', satz: 'Der Unterschied hat andere Gründe - oder es gibt keinen.' },
  nicht_messbar: { wort: 'Nicht messbar', satz: 'Die Zahl sagt hier nichts, zum Beispiel weil sich der Prozess geändert hat.' },
};

/**
 * „Wirkung prüfen“ (§6.9, WK6) bzw. ohne Messung „Abschließen“ (Entscheid 6: ein Satz, Ergebnis „nicht messbar“) -
 * ein Blatt. Oben die beobachtete Zahl der Route, darunter die Antwort-Karten und ein Satz Begründung; „Wird als Stand
 * Nr. n festgehalten“. Mit Vier-Augen folgt der Dialog der Route (409 `vieraugen_beantragen` → Antrag); eine ZWEITE
 * Person bestätigt oder lehnt ab. Aus einem Anstoß („neu bewerten“) geht die Antwort an `…/anstoesse/{aid}/antwort`.
 */
export function MassnahmeBewertenDialog({
  m,
  w,
  schritt,
  anstoss,
  onClose,
  onFertig,
}: {
  m: Massnahme;
  w?: MassnahmeWirkung | null;
  schritt: BewertungSchritt;
  anstoss?: VorgangAnstoss | null;
  onClose: () => void;
  onFertig: (m: Massnahme) => void;
}) {
  const basis = `mab-${useId().replace(/:/g, '')}`;
  const ohneMessung = m.art !== 'gemessen' || !m.messgrundlage;
  const optionen = W.ergebnisOptionen(m);
  const [ergebnis, setErgebnis] = useState<MassnahmeErgebnis | null>(ohneMessung ? 'nicht_messbar' : null);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ ergebnis?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titel =
    schritt === 'bewerten'
      ? ohneMessung
        ? B.KNOPF_ABSCHLIESSEN
        : anstoss
          ? W.ANTWORT_KNOPF.neu_bewertet
          : B.KNOPF_WIRKUNG
      : schritt === 'freigeben'
        ? W.KNOPF_FREIGEBEN
        : W.KNOPF_ABLEHNEN;
  const naechsteNr = Math.max(m.bewertung?.stand_nr ?? 0, m.bewertung_antrag?.stand_nr ?? 0) + 1;
  const k = w?.massnahme.wirkung_kurz ?? null;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(schritt === 'bewerten' && !ergebnis ? { ergebnis: 'Bitte wählen Sie eine Antwort.' } : {}),
      // Beim Bestätigen ist die Begründung wahlfrei (IP-12); steht eine da, gilt dieselbe Länge.
      ...(!Z.begruendungOk(begruendung) && !(schritt === 'freigeben' && !begruendung.trim())
        ? { begruendung: 'Ein Satz mit mindestens zehn Zeichen.' }
        : {}),
    };
    setZeigen(fehler);
    if (Object.keys(fehler).length) {
      document.getElementById(fehler.ergebnis ? `${basis}-ergebnis` : `${basis}-begruendung`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    const text = begruendung.trim();
    const body = schritt === 'bewerten' ? { ergebnis: ergebnis!, begruendung: text } : text ? { begruendung: text } : {};
    try {
      if (anstoss && schritt === 'bewerten') {
        onFertig(await api.massnahmeAnstossAntwort(m.id, anstoss.id, { antwort: 'neu_bewertet', ergebnis: ergebnis!, begruendung: text }));
      } else {
        onFertig(await api.massnahmeBewertung(m.id, schritt, body));
      }
    } catch (e) {
      // Wie am Energieziel folgt der Dialog der Route: mit Vier-Augen wird „bewerten“ ein Antrag.
      if (schritt === 'bewerten' && !anstoss && Z.ablehnungCode(e) === 'vieraugen_beantragen') {
        try {
          onFertig(await api.massnahmeBewertung(m.id, 'beantragen', body));
        } catch (e2) {
          setSatz(W.ablehnungSatz(e2));
        }
      } else {
        setSatz(W.ablehnungSatz(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      blatt
      onClose={onClose}
      title={titel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="massnahme-bewerten-senden">
            {schritt === 'bewerten' ? (ohneMessung ? B.KNOPF_ABSCHLIESSEN : 'Wirkung festhalten') : titel}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-mn-blatt vp-k-farben" noValidate onSubmit={(e) => void senden(e)} data-testid="massnahme-bewerten-dialog">
        <p className="vp-mn-unter">{m.titel}</p>
        {anstoss && <p className="vp-mn-leise">{W.anstossZeile(anstoss)}</p>}
        {schritt === 'bewerten' && !ohneMessung && k && (
          <div className="vp-mn-danach" data-testid="massnahme-bewerten-beobachtet">
            <span>Beobachtet</span>
            <span>
              <b>{`${B.prozentBetrag(k.delta_prozent)} ${B.richtungWort(k.delta_prozent)}`}</b>
              {` als erwartet · ${k.monate_text} Monaten`}
              {m.erwartete_wirkung_prozent ? ` · erwartet waren ${B.personProzent(m.erwartete_wirkung_prozent)}` : ''}
            </span>
          </div>
        )}
        {schritt === 'bewerten' && ohneMessung && (
          <p className="vp-mn-text">Ohne Kennzahl misst VoltPilot nichts. Ihr Satz schließt die Maßnahme ab; als Ergebnis steht „nicht messbar“.</p>
        )}
        {schritt === 'bewerten' && !ohneMessung && (
          <div id={`${basis}-ergebnis`} tabIndex={-1}>
            <Wahl
              name={`${basis}-wahl`}
              legende={`Kommt der Unterschied von der ${UEMS_MASSNAHME}?`}
              wert={ergebnis}
              setze={setErgebnis}
              optionen={optionen.map((o) => ({ wert: o.value, wort: ERGEBNIS_KARTE[o.value].wort, satz: ERGEBNIS_KARTE[o.value].satz }))}
              testid="massnahme-bewerten-wahl"
            />
            {zeigen.ergebnis && <p className="vp-mn-fehler">{zeigen.ergebnis}</p>}
          </div>
        )}
        {schritt !== 'bewerten' && m.bewertung_antrag && <p className="vp-mn-leise">{W.beantragtSatz(m.bewertung_antrag)}</p>}
        <TextFeld
          id={`${basis}-begruendung`}
          label={schritt === 'bewerten' ? (ohneMessung ? 'Was ist daraus geworden?' : 'Woran sehen Sie das?') : schritt === 'freigeben' ? 'Begründung (wahlfrei)' : 'Warum lehnen Sie ab?'}
          wert={begruendung}
          setze={setBegruendung}
          platzhalter={
            schritt === 'bewerten' && !ohneMessung
              ? 'Zum Beispiel: Laufzeit laut Steuerung 18 % niedriger, keine andere Änderung im Zeitraum.'
              : schritt === 'bewerten'
                ? 'Zum Beispiel: Die Zuständigkeit ist festgelegt und wird bei jeder Freigabe genannt.'
                : undefined
          }
          hilfe={
            schritt === 'bewerten'
              ? `Wird als Stand Nr. ${naechsteNr} festgehalten${m.bewertung ? `; Stand Nr. ${m.bewertung.stand_nr} vom ${Z.tag(m.bewertung.am)} bleibt lesbar` : ''}.`
              : 'Steht im Verlauf.'
          }
          fehler={zeigen.begruendung}
          testid="massnahme-bewerten-text"
        />
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
