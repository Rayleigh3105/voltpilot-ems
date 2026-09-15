import { useEffect, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, ApiError, type BerichtDetail, type BerichtEntwurf } from '../api';
import { KEINE_RECHTE, revisionBanner, seitenHebel, VERGLEICHEN, VERWERFEN } from '../berichtDialoge';
import {
  abschnitte,
  abzugAus,
  ausgabeKnoepfe,
  berichtTitel,
  darfNachLesen,
  HEUTIGEN_WERT,
  HEUTIGER_WERT_LAEDT,
  heuteAnfrage,
  heutigerWert,
  LADEFEHLER_SEITE,
  LADEFEHLER_STAND,
  NACHWEIS,
  nrAus,
  NICHT_GEFUNDEN,
  PRUEFSUMME_GEPRUEFT,
  seitenKopf,
  STAND_WAHL,
  standId,
  standWahl,
  verlaufDerStaende,
  vorlageName,
  VERLAUF_TITEL,
  ZUR_LISTE,
  type Abschnitt,
  type Ansicht,
  type AusgabeKnopf,
  type HeutigerWert,
  type QuellenZahl,
} from '../berichtSeite';
import { AnstossVerwerfenDialog } from '../components/AnstossVerwerfenDialog';
import { BerichtFreigebenDialog } from '../components/BerichtFreigebenDialog';
import { BerichtVergleichDialog } from '../components/BerichtVergleichDialog';
import { ZeitSegment } from '../components/HistorieWelt';
import { ErrorState, Skeleton } from '../components/States';
import { WerteKarte } from '../components/WerteKarte';
import { TRENNER } from '../uemsErgebnis';
import { useBerichtRechte } from '../useBerichtRechte';

/**
 * Die Berichtsseite (UEMS AP-12 IP-13, §5.1–§5.6): Reiter „Nr. 1 · Nr. 2 · Entwurf“ (vorgewählt der gültige Stand),
 * der Kopf mit Datenstand, Stand, Freigabe und geprüfter Prüfsumme (D5, A6), die Abschnitte in der Reihenfolge der
 * Vorlage — jede Zahl klappt ihren Nachweis auf (die Form der `WerteKarte` plus Herkunft, A3) —, Qualität,
 * Quellenverzeichnis und der Verlauf der Stände.
 *
 * Sie LIEST nur: `GET /api/v1/berichte/{kennung}`, `…/staende/{nr}` bzw. `…/entwurf`, dazu für die Hinweise
 * „heute: …“ (A5) das Messstellen-Register und die Kennzahlen, und erst auf „heutigen Wert zeigen“ `…/messstellen/
 * {kennzeichen}/werte` (§5.6).
 *
 * AP-12 IP-14 schreibt über drei Dialoge (`berichtDialoge.ts`): am Entwurf „Als Berichtsstand freigeben“ (§5.2 — aus,
 * wenn F1 schon jetzt nein sagt, und der Satz steht darunter) und „Mit Berichtsstand Nr. n vergleichen“ (EW2); über der
 * Seite das Banner „Revision nötig“ mit „Entwurf vergleichen“ und „Anstoß verwerfen“ (§5.3). Schreibende Hebel nur mit
 * Recht aus der Selbstauskunft (`useBerichtRechte`); nach einer Freigabe zeigt die Seite den neuen Stand.
 *
 * ⚠ PDF und CSV: `ausgabeKnoepfe` leitet ab, wer an welchem Stand welche Ausgabe hat — sichtbar wird ein Knopf erst,
 *   wenn seine Route steht. IP-10 (CSV) und IP-11 (PDF) setzen `AUSGABE_EINGEHAENGT` in `berichtSeite.ts` und reichen
 *   hier `onAbruf` herein; bis dahin gibt es keinen Knopf ohne Ziel.
 */
export function BerichtSeite({
  kennung,
  onListe,
  zurListe = ZUR_LISTE,
  onAbruf,
  jetzt = () => Date.now(),
}: {
  kennung: string;
  onListe: () => void;
  /** Das Wort des Rückwegs — am Standort „Berichte dieses Standorts“ (AP-13 IP-2), sonst „Alle Berichte“. */
  zurListe?: string;
  /** Der Abruf einer Datei (IP-10/IP-11) — ohne ihn kein Knopf. */
  onAbruf?: (knopf: AusgabeKnopf) => void;
  jetzt?: () => number;
}) {
  const [detail, setDetail] = useState<BerichtDetail | null>(null);
  const [detailFehler, setDetailFehler] = useState<'fehlt' | 'fehler' | null>(null);
  const [wahl, setWahl] = useState<string | null>(null);
  const [ansicht, setAnsicht] = useState<{ id: string; ansicht: Ansicht } | null>(null);
  const [ansichtFehler, setAnsichtFehler] = useState<{ id: string; satz: string } | null>(null);
  const [namen, setNamen] = useState<ReadonlyMap<string, string>>(new Map());
  const [versuch, setVersuch] = useState(0);
  // AP-12 IP-14: was die Person darf, und welcher Dialog offen ist.
  const rechte = useBerichtRechte();
  const [dialog, setDialog] = useState<
    | { art: 'freigeben'; entwurf: BerichtEntwurf }
    | { art: 'vergleich'; gegen: number }
    | { art: 'verwerfen'; anstoss: { id: string; text: string }; nr: number }
    | null
  >(null);

  useEffect(() => {
    let aktiv = true;
    setDetailFehler(null);
    api.bericht(kennung).then(
      (d) => {
        if (!aktiv) return;
        setDetail(d);
        setWahl((alt) => alt ?? standWahl(d).vorgabe);
      },
      (e) => aktiv && setDetailFehler(e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler'),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, versuch]);

  // A5: die heutigen Namen — ein Hinweis; fehlt eine der beiden Quellen, fehlt nur der Hinweis.
  useEffect(() => {
    let aktiv = true;
    Promise.allSettled([api.messstellenRegister(), api.kennzahlen()]).then(([register, kennzahlen]) => {
      if (!aktiv) return;
      const m = new Map<string, string>();
      if (register.status === 'fulfilled') for (const r of register.value.register) if (r.name) m.set(r.kennzeichen, r.name);
      if (kennzahlen.status === 'fulfilled') for (const k of kennzahlen.value.kennzahlen) m.set(k.kennzeichen, k.name);
      setNamen(m);
    });
    return () => {
      aktiv = false;
    };
  }, []);

  useEffect(() => {
    if (wahl === null) return;
    let aktiv = true;
    setAnsichtFehler(null);
    const nr = nrAus(wahl);
    const laden: Promise<Ansicht> =
      nr === null
        ? api.berichtEntwurf(kennung).then((entwurf) => ({ art: 'entwurf', entwurf }))
        : api.berichtStand(kennung, nr).then((stand) => ({ art: 'stand', stand }));
    laden.then(
      (a) => aktiv && setAnsicht({ id: wahl, ansicht: a }),
      // 500 `abzug_beschaedigt` und 404 `stand_gibt_es_nicht` sprechen ihren Satz; alles andere ist ein Ladefehler.
      (e) => aktiv && setAnsichtFehler({ id: wahl, satz: e instanceof ApiError && (e.status === 500 || e.status === 404) && e.body ? e.message : LADEFEHLER_STAND }),
    );
    return () => {
      aktiv = false;
    };
  }, [kennung, wahl, versuch]);

  const zurueck = (
    <button type="button" className="vp-br-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {zurListe}
    </button>
  );

  if (detailFehler === 'fehlt') {
    return (
      <div className="vp-br" data-testid="bericht-seite">
        {zurueck}
        <p className="vp-br-leer">{NICHT_GEFUNDEN}</p>
      </div>
    );
  }
  if (detailFehler) {
    return (
      <div className="vp-br" data-testid="bericht-seite">
        {zurueck}
        <ErrorState message={LADEFEHLER_SEITE} onRetry={() => setVersuch((v) => v + 1)} />
      </div>
    );
  }
  if (!detail || wahl === null) {
    return (
      <div className="vp-br" data-testid="bericht-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={220} />
      </div>
    );
  }

  const b = detail.bericht;
  const wahlen = standWahl(detail);
  const aktuell = ansicht !== null && ansicht.id === wahl ? ansicht.ansicht : null;
  const kopf = aktuell ? seitenKopf(detail, aktuell, jetzt()) : null;
  const inhalt = aktuell
    ? abschnitte(abzugAus(aktuell.art === 'stand' ? aktuell.stand.abzug : aktuell.entwurf.abzug), (k) => namen.get(k) ?? null)
    : null;
  const knoepfe = onAbruf ? ausgabeKnoepfe(b, aktuell, darfNachLesen(b)) : [];
  const verlauf = verlaufDerStaende(detail);
  // Solange die Selbstauskunft fehlt, keine schreibenden Hebel; ist sie nicht zu haben (`null`), entscheidet die Route.
  const rechteJetzt = rechte === undefined ? KEINE_RECHTE : rechte;
  const banner = revisionBanner(detail);
  const hebel = seitenHebel(detail, aktuell?.art === 'entwurf' ? aktuell.entwurf : null, rechteJetzt, jetzt());
  const vergleichen = hebel.vergleichen;
  const nachFreigabe = (nr: number) => {
    setDialog(null);
    setWahl(standId(nr));
    setVersuch((v) => v + 1);
  };
  const heuteLaden =
    aktuell?.art === 'stand'
      ? async (kennzeichen: string): Promise<HeutigerWert> => {
          const q = heuteAnfrage(b);
          const stand = { nr: aktuell.stand.nr, freigegeben_am: aktuell.stand.freigegeben_am };
          try {
            return heutigerWert({ antwort: await api.messstelleWerte(kennzeichen, q.raster, q.von, q.bis) }, b, stand);
          } catch (fehler) {
            return heutigerWert({ fehler }, b, stand);
          }
        }
      : null;

  return (
    <div className="vp-br" data-testid="bericht-seite">
      {zurueck}
      <header className="vp-br-kopf">
        <p className="vp-br-kennung">{b.kennung}</p>
        <h1>{berichtTitel(b)}</h1>
        <p>{kopf?.vorlage ?? vorlageName(b.vorlage)}</p>
      </header>
      {banner && (
        <section className="vp-br-revision" role="status" data-testid="bericht-revision">
          <p className="vp-br-revision-titel">
            <Icon name="alert-triangle" size={18} />
            <span>{banner.titel}</span>
          </p>
          <ul className="vp-br-revision-anstoesse">
            {banner.anstoesse.map((a) => (
              <li key={a.id}>
                <span>{a.text}</span>
                {hebel.verwerfen && banner.anstoesse.length > 1 && (
                  <Button variant="outline" size="sm" onClick={() => setDialog({ art: 'verwerfen', anstoss: a, nr: banner.nr })}>
                    {VERWERFEN}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="vp-br-revision-satz">{banner.satz}</p>
          <div className="vp-br-aktionen">
            <Button size="sm" variant="outline" onClick={() => setDialog({ art: 'vergleich', gegen: banner.nr })}>
              {VERGLEICHEN}
            </Button>
            {hebel.verwerfen && banner.anstoesse.length === 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDialog({ art: 'verwerfen', anstoss: banner.anstoesse[0], nr: banner.nr })}
              >
                {VERWERFEN}
              </Button>
            )}
          </div>
        </section>
      )}
      {wahlen.optionen.length > 1 && (
        <div className="vp-br-wahl">
          <ZeitSegment label={STAND_WAHL} optionen={wahlen.optionen} wert={wahl} onWert={setWahl} />
        </div>
      )}
      {ansichtFehler?.id === wahl ? (
        <ErrorState message={ansichtFehler.satz} onRetry={() => setVersuch((v) => v + 1)} />
      ) : !kopf || !inhalt ? (
        <div aria-busy="true">
          <Skeleton height={320} />
        </div>
      ) : (
        <>
          <section className="vp-br-stand" aria-label={kopf.zeile} data-testid="bericht-kopf">
            <p className="vp-br-zeile-kopf">{kopf.zeile}</p>
            {kopf.abzeichen.length > 0 && (
              <p className="vp-br-abzeichen">
                {kopf.abzeichen.map((a) => (
                  <Badge key={a.text} variant={a.ton}>
                    {a.text}
                  </Badge>
                ))}
              </p>
            )}
            {kopf.pruefsumme && (
              <p className="vp-br-pruefsumme" data-testid="bericht-pruefsumme">
                <span>{PRUEFSUMME_GEPRUEFT}</span>
                <code>{kopf.pruefsumme}</code>
              </p>
            )}
            {kopf.teilansicht && <p className="vp-br-teilansicht">{kopf.teilansicht}</p>}
            {(hebel.freigeben || vergleichen) && (
              <div className="vp-br-aktionen" data-testid="bericht-hebel">
                {hebel.freigeben && (
                  <Button
                    size="sm"
                    disabled={!hebel.freigeben.vorschau.erlaubt}
                    onClick={() => aktuell?.art === 'entwurf' && setDialog({ art: 'freigeben', entwurf: aktuell.entwurf })}
                  >
                    {hebel.freigeben.knopf}
                  </Button>
                )}
                {vergleichen && (
                  <Button size="sm" variant="outline" onClick={() => setDialog({ art: 'vergleich', gegen: vergleichen.gegen })}>
                    {vergleichen.knopf}
                  </Button>
                )}
                {hebel.freigeben && !hebel.freigeben.vorschau.erlaubt && hebel.freigeben.vorschau.satz && (
                  <p className="vp-br-warum" data-testid="bericht-freigeben-warum">
                    {hebel.freigeben.vorschau.satz}
                  </p>
                )}
              </div>
            )}
            {knoepfe.length > 0 && onAbruf && (
              <div className="vp-br-knoepfe">
                {knoepfe.map((k) => (
                  <button key={k.handlung} type="button" className="vp-br-knopf" onClick={() => onAbruf(k)}>
                    {k.text}
                  </button>
                ))}
              </div>
            )}
          </section>
          {inhalt.abschnitte.map((a) => (
            <AbschnittBlock key={`${wahl}-${a.schluessel}`} abschnitt={a} heuteLaden={a.art === 'messstellen' ? heuteLaden : null} />
          ))}
        </>
      )}
      {verlauf.length > 0 && (
        <section className="vp-br-block" aria-label={VERLAUF_TITEL} data-testid="bericht-verlauf">
          <h2>{VERLAUF_TITEL}</h2>
          <ol className="vp-br-verlauf">
            {verlauf.map((v) => (
              <li key={v.nr}>
                <span className="vp-br-verlauf-kopf">
                  <span className="vp-br-verlauf-titel">{v.titel}</span>
                  {v.ersetzt ? <Badge variant="off">{v.ersetzt}</Badge> : v.anlass && <span className="vp-br-anlass">{v.anlass}</span>}
                </span>
                <span className="vp-br-verlauf-zeile">{v.zeile}</span>
                {v.ersetzt && v.anlass && <span className="vp-br-anlass">{v.anlass}</span>}
                {v.anstoesse.map((s) => (
                  <span key={s} className="vp-br-anstoss">
                    {s}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </section>
      )}
      {dialog?.art === 'freigeben' && (
        <BerichtFreigebenDialog
          open
          onClose={() => setDialog(null)}
          detail={detail}
          entwurf={dialog.entwurf}
          jetzt={jetzt}
          onFreigegeben={(stand) => nachFreigabe(stand.nr)}
          onEntwurf={() => setVersuch((v) => v + 1)}
        />
      )}
      {dialog?.art === 'vergleich' && (
        <BerichtVergleichDialog
          open
          onClose={() => setDialog(null)}
          detail={detail}
          gegen={dialog.gegen}
          rechte={rechteJetzt}
          jetzt={jetzt}
          onFreigeben={(entwurf) => setDialog({ art: 'freigeben', entwurf })}
        />
      )}
      {dialog?.art === 'verwerfen' && (
        <AnstossVerwerfenDialog
          open
          onClose={() => setDialog(null)}
          kennung={b.kennung}
          anstoss={dialog.anstoss}
          nr={dialog.nr}
          onVerworfen={() => {
            setDialog(null);
            setVersuch((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}

function AbschnittBlock({
  abschnitt: a,
  heuteLaden,
}: {
  abschnitt: Abschnitt;
  heuteLaden: ((kennzeichen: string) => Promise<HeutigerWert>) | null;
}) {
  return (
    <section className="vp-br-block" aria-label={a.titel} data-testid={`bericht-abschnitt-${a.schluessel}`}>
      <h2>{a.titel}</h2>
      {/* Variante B (empfohlen): der Kopf-Abschnitt klappt zu wie das Quellenverzeichnis — Datenstand, Stand,
          Freigabe und Prüfsumme stehen schon im Seitenkopf; Regelwerk und Darstellung bleiben einen Tipp entfernt. */}
      {a.art === 'kopf' && (
        <details className="vp-br-quellen" data-testid="bericht-angaben">
          <summary>{a.anzahl}</summary>
          <Angaben zeilen={a.zeilen} />
        </details>
      )}
      {a.art === 'qualitaet' && <Angaben zeilen={a.zeilen} />}
      {a.art === 'qualitaet' && a.korrekturen.length > 0 && (
        <ul className="vp-br-liste-text">
          {a.korrekturen.map((k) => (
            <li key={k}>{k}</li>
          ))}
        </ul>
      )}
      {a.art === 'zusammenfassung' && (
        <>
          <ul className="vp-br-kacheln">
            {a.kacheln.map((k) => (
              <li key={k.name}>
                <span className="vp-br-kachel-name">{k.name}</span>
                <span className="vp-br-kachel-zahl">{k.wert}</span>
              </li>
            ))}
          </ul>
          {a.zaehlung && <p className="vp-br-unter">{a.zaehlung}</p>}
        </>
      )}
      {a.art === 'messstellen' && a.vergleiche.length > 0 && (
        <ul className="vp-br-vergleiche">
          {a.vergleiche.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      )}
      {a.art === 'kennzahlen' && a.leer && <p className="vp-br-leer">{a.leer}</p>}
      {(a.art === 'messstellen' || a.art === 'kennzahlen') && (
        <ul className="vp-br-zahlen">
          {a.zeilen.map((z) => (
            <li key={z.schluessel}>
              <ZahlZeile zahl={z} heuteLaden={heuteLaden} />
            </li>
          ))}
        </ul>
      )}
      {a.art === 'quellen' && (
        <details className="vp-br-quellen" data-testid="bericht-quellen">
          <summary>{a.anzahl}</summary>
          <ul>
            {a.zeilen.map((q) => (
              <li key={q.kennzeichen}>
                <span className="vp-br-kz">{q.kennzeichen}</span>
                <span className="vp-br-quelle-text">
                  {[q.name, q.stand].filter((t): t is string => t !== null).join(TRENNER)}
                  {q.heute && <span className="vp-br-heute">{q.heute}</span>}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Angaben({ zeilen }: { zeilen: Array<{ name: string; wert: string }> }) {
  return (
    <dl className="vp-br-dl">
      {zeilen.map((z) => (
        <div key={z.name}>
          <dt>{z.name}</dt>
          <dd>{z.wert}</dd>
        </div>
      ))}
    </dl>
  );
}

function ZahlZeile({ zahl: z, heuteLaden }: { zahl: QuellenZahl; heuteLaden: ((kennzeichen: string) => Promise<HeutigerWert>) | null }) {
  const [heute, setHeute] = useState<HeutigerWert | 'laedt' | null>(null);
  const zeigen = () => {
    if (!heuteLaden || !z.messstelle) return;
    setHeute('laedt');
    void heuteLaden(z.messstelle).then(setHeute);
  };
  return (
    <details className="vp-br-zeile" data-testid="bericht-zahl" data-quelle={z.schluessel}>
      <summary>
        <span className="vp-br-zeile-name">
          <span className="vp-br-kz">{z.kennzeichen}</span> {z.name}
          {z.heute && (
            <span className="vp-br-heute" data-testid="bericht-heute">
              {z.heute}
            </span>
          )}
        </span>
        <span className="vp-br-zeile-zahl">{z.zahl}</span>
        <span className="vp-br-zeile-info">
          <Badge variant={z.zustandTon}>{z.zustand}</Badge>
          <span>{z.version}</span>
          {z.kennzeichenSaetze.map((s) => (
            <span key={s} className="vp-br-kennzeichen">
              {s}
            </span>
          ))}
        </span>
      </summary>
      <div className="vp-br-nachweis" aria-label={`${NACHWEIS} ${z.kennzeichen}`} data-testid="bericht-nachweis">
        <WerteKarte karte={z.nachweis.karte} />
        <ul className="vp-br-herkunft">
          {z.nachweis.herkunft.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
        {heuteLaden && z.messstelle && heute === null && (
          <button type="button" className="vp-br-hebel" onClick={zeigen}>
            {HEUTIGEN_WERT}
          </button>
        )}
        {heute === 'laedt' && <p className="vp-br-unter">{HEUTIGER_WERT_LAEDT}</p>}
        {heute !== null && heute !== 'laedt' && (
          <p className={`vp-br-heutiger is-${heute.art}`} data-testid="bericht-heutiger-wert">
            {heute.text}
          </p>
        )}
      </div>
    </details>
  );
}
