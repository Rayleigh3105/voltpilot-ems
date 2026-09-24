import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import * as A from '../abweichungen';
import { api, ApiError, type Abweichung, type AbweichungEintrag } from '../api';
import { monatWort, vergleichBild, type BezugsbasisVergleich } from '../bezugsbasisVergleich';
import { AbschliessenDialog, FristDialog, UrsacheAussageDialog, VerantwortlicherDialog } from '../components/AbweichungDialoge';
import { MonateTafel } from '../components/BezugsbasisVergleich';
import { Recht } from '../components/Recht';
import { ErrorState, Skeleton } from '../components/States';
import * as Z from '../energieziele';
import { UEMS_AUFFAELLIGKEIT, UEMS_BEZUGSBASIS, UEMS_MASSNAHME, UEMS_NORMGRENZE, UEMS_VERANTWORTLICH, UEMS_VERBESSERUNG_SAETZE } from '../glossar';
import '../components/BezugsbasisVergleich.css';
import './Verbesserung.css';

type Lage = { art: 'laedt' } | { art: 'fehlt' } | { art: 'fehler' } | { art: 'da'; a: Abweichung };
type Vergleich = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; v: BezugsbasisVergleich };

/** Ein Kommentar im Verlauf (A4): 1–2 000 Zeichen, nur offen; nichts wird geändert oder gelöscht. */
function Kommentar({ a, onNeu }: { a: Abweichung; onNeu: (a: Abweichung) => void }) {
  const id = `ak-${useId().replace(/:/g, '')}`;
  const [text, setText] = useState('');
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const t = text.trim();
    if (!t || t.length > A.KOMMENTAR_MAX) {
      setSatz(A.ABLEHNUNG.text_ungueltig);
      document.getElementById(id)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onNeu(await api.abweichungEintrag(a.id, { art: 'kommentar', text: t }));
      setText('');
    } catch (x) {
      setSatz(A.ablehnungSatz(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vp-ez-form" noValidate onSubmit={(x) => void senden(x)} data-testid="abweichung-kommentar">
      <div className="vp-ez-feld">
        <label className="vp-ez-label" htmlFor={id}>
          {A.KNOPF_KOMMENTAR}
        </label>
        <textarea id={id} rows={2} value={text} onChange={(x) => setText(x.target.value)} aria-invalid={!!satz} />
        {satz && <p className="vp-ez-fehler">{satz}</p>}
      </div>
      <div className="vp-ez-aktionen">
        <Button type="submit" size="sm" variant="outline" disabled={busy} data-testid="abweichung-kommentar-senden">
          {A.KNOPF_KOMMENTAR}
        </Button>
      </div>
    </form>
  );
}

/** Eine Zeile des Verlaufs — eine Ursache-Aussage immer mit „Aussage von …“ (U1), daneben wer sie eingetragen hat. */
function VerlaufZeile({ e }: { e: AbweichungEintrag }) {
  const aussage = e.aussage;
  return (
    <li data-testid={`verlauf-${e.art}`}>
      <p>
        <strong>{A.VERLAUF_WORT[e.art]}</strong> · {e.person} · {Z.tag(e.am)}
      </p>
      {aussage && (
        <>
          <p className="vp-aw-aussage" data-testid="ursache-aussage-satz">
            {aussage.satz ?? UEMS_VERBESSERUNG_SAETZE.ursacheAussage(aussage.name, Z.tag(aussage.am), aussage.beleg_kennung, aussage.wortlaut)}
          </p>
          <p className="vp-aw-vorbehalt" data-testid="ursache-aussage-kennzeichen">
            {aussage.kennzeichen}
          </p>
        </>
      )}
      {e.kommentar && <p>{e.kommentar}</p>}
      {e.begruendung && <p className="vp-ez-leise">‚{e.begruendung}‘</p>}
    </li>
  );
}

/**
 * Die Abweichungs-Seite (AP-18 IP-18, §5.3, A3–A6, U1–U3): der Kopf-Satz mit Frist und Verantwortlich („überfällig
 * seit n Tagen“ aus der Route), der Anlass als Kopie mit Vorbehalten und Prüfsumme (aufklappbar), die Vergleichszeilen
 * aus dem Leser daneben, der Verlauf mit Kommentaren und Ursache-Aussagen („Aussage von …“) und der Abschluss — bei
 * „Maßnahme“ mit dem Sprung in den Dialog „Maßnahme anlegen“. Das Portal rechnet nichts; nichts an der Kennzahl ändert
 * sich (A5).
 */
export function AbweichungSeite({
  id,
  onListe,
  onKennzahl,
  onMassnahme,
}: {
  id: string;
  onListe: () => void;
  onKennzahl?: (kennzahlId: string) => void;
  onMassnahme?: (massnahmeId: string) => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [vergleich, setVergleich] = useState<Vergleich>({ art: 'laedt' });
  const [dialog, setDialog] = useState<null | 'aussage' | 'frist' | 'verantwortlich' | 'abschliessen'>(null);

  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.abweichung(id).then(
      (a) => aktiv && setLage({ art: 'da', a }),
      (e) => aktiv && setLage({ art: e instanceof ApiError && e.status === 404 ? 'fehlt' : 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [id, versuch]);

  const kz = lage.art === 'da' ? lage.a.kennzahl.id : null;
  const monate = lage.art === 'da' ? [...lage.a.monate].sort() : [];
  const bb = lage.art === 'da' ? lage.a.bezugsbasis.kennzeichen : null;
  const von = monate[0];
  const bis = monate[monate.length - 1];
  useEffect(() => {
    if (!kz || !von) return;
    let aktiv = true;
    setVergleich({ art: 'laedt' });
    api.bezugsbasisVergleich(kz, { von, bis, ...(bb ? { basis: bb } : {}) }).then(
      (v) => aktiv && setVergleich({ art: 'da', v }),
      () => aktiv && setVergleich({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [kz, von, bis, bb]);

  const zurueck = (
    <button type="button" className="vp-ez-zurueck" onClick={onListe}>
      <Icon name="chevron-left" size={18} />
      {A.ZUR_LISTE}
    </button>
  );

  if (lage.art === 'laedt') {
    return (
      <div className="vp-ez" data-testid="abweichung-seite" aria-busy="true">
        {zurueck}
        <Skeleton height={260} />
      </div>
    );
  }
  if (lage.art !== 'da') {
    return (
      <div className="vp-ez" data-testid="abweichung-seite">
        {zurueck}
        {lage.art === 'fehlt' ? (
          <p className="vp-ez-satz">{A.NICHT_GEFUNDEN}</p>
        ) : (
          <ErrorState message={A.LADEFEHLER_SEITE} onRetry={() => setVersuch((v) => v + 1)} />
        )}
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    );
  }

  const { a } = lage;
  const ueberfaellig = A.ueberfaelligText(a);
  const saetze = A.anlassSaetze(a.anlass_inhalt);
  const neu = (x: Abweichung) => {
    setDialog(null);
    setLage({ art: 'da', a: x });
  };
  const bild = vergleich.art === 'da' ? vergleichBild(vergleich.v) : null;
  const kennzahl = A.kennzahlText(a.kennzahl);

  return (
    <div className="vp-ez" data-testid="abweichung-seite">
      {zurueck}
      <header className="vp-ez-kopf">
        <div className="vp-ez-kopf-zeile">
          <h1>{`${A.SPALTEN.kennzeichen} ${a.kennzeichen}`}</h1>
          <Badge variant="tint">{A.ZUSTAND_WORT[a.zustand]}</Badge>
        </div>
        <p className="vp-ez-satz" data-testid="abweichung-kopf">
          {A.kopfZeile(a, Z.tag)}
        </p>
        <p className="vp-ez-herkunft" data-testid="abweichung-herkunft">
          <span>{A.HERKUNFT_WORT[a.herkunft.art]}</span>
          {onKennzahl ? (
            <button type="button" className="vp-ez-sprung" onClick={() => onKennzahl(a.kennzahl.id)} data-testid="abweichung-sprung-kennzahl">
              {kennzahl}
            </button>
          ) : (
            <span>{kennzahl}</span>
          )}
          <span>{`${UEMS_BEZUGSBASIS} ${a.bezugsbasis.kennzeichen ?? ''}, Fassung ${a.fassung}`}</span>
          <span data-testid="abweichung-verantwortlich">{`${UEMS_VERANTWORTLICH} ${a.verantwortlich.name}`}</span>
          <span data-testid="abweichung-frist-tag">{`${A.FRIST} ${Z.tag(a.frist.termin)}`}</span>
        </p>
        {a.herkunft.wortlaut && (
          <p className="vp-ez-leise" data-testid="abweichung-wortlaut">
            ‚{a.herkunft.wortlaut}‘
          </p>
        )}
        {ueberfaellig && (
          <p className="vp-ez-frist" data-testid="abweichung-ueberfaellig">
            {ueberfaellig}
          </p>
        )}
        {A.offen(a) && (
          <div className="vp-ez-aktionen">
            <Recht aktion="verbesserung.verwalten" standort={a.standort_id}>
              <Button size="sm" variant="outline" onClick={() => setDialog('frist')} data-testid="abweichung-frist-knopf">
                {A.KNOPF_FRIST}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDialog('verantwortlich')} data-testid="abweichung-verantwortlich-knopf">
                {A.KNOPF_VERANTWORTLICH}
              </Button>
            </Recht>
          </div>
        )}
      </header>

      <div className="vp-aw-spalten">
        <section className="vp-ez-karte" aria-labelledby="aw-anlass" data-testid="abweichung-anlass">
          <h2 id="aw-anlass">{A.ANLASS}</h2>
          {saetze.map((s) => (
            <p key={s} className="vp-ez-satz" data-testid="anlass-satz">
              {s}
            </p>
          ))}
          {a.vorbehalte.length > 0 && (
            <p className="vp-ez-herkunft" data-testid="abweichung-vorbehalte">
              <span>{`${A.VORBEHALTE}:`}</span>
              {a.vorbehalte.map((x) => (
                <span key={x} className="vp-aw-vorbehalt">
                  {x}
                </span>
              ))}
            </p>
          )}
          {a.vermerke && a.vermerke.length > 0 && (
            <ul className="vp-aw-liste" data-testid="abweichung-vermerke">
              {a.vermerke.map((v) => (
                <li key={v.id}>{`${UEMS_AUFFAELLIGKEIT} ${monatWort(v.periode)} — vermerkt am ${Z.tag(v.vermerkt_am)}`}</li>
              ))}
            </ul>
          )}
          <details className="vp-ez-kopie" data-testid="abweichung-anlass-kopie">
            <summary>{A.ANLASS_KOPIE}</summary>
            <pre>{a.anlass}</pre>
          </details>
          <p className="vp-ez-pruefsumme" data-testid="abweichung-pruefsumme">
            {`${A.PRUEFSUMME} ${a.anlass_pruefsumme}`}
          </p>
        </section>

        <section className="vp-ez-karte vp-aw-vergleich" aria-labelledby="aw-vergleich" data-testid="abweichung-vergleich">
          <h2 id="aw-vergleich">{A.VERGLEICH_JETZT}</h2>
          {vergleich.art === 'laedt' ? (
            <Skeleton height={120} />
          ) : bild && bild.art === 'vergleich' ? (
            <>
              <p className="vp-ez-leise">{bild.basisZeile}</p>
              <MonateTafel monate={bild.monate} />
            </>
          ) : (
            <p className="vp-ez-leise">{bild?.art === 'leer' ? bild.satz : A.VERGLEICH_FEHLT}</p>
          )}
        </section>
      </div>

      <section className="vp-ez-karte" aria-labelledby="aw-verlauf" data-testid="abweichung-verlauf">
        <h2 id="aw-verlauf">{A.VERLAUF}</h2>
        {a.verlauf && a.verlauf.length > 0 && (
          <ol className="vp-ez-verlauf">
            {a.verlauf.map((e) => (
              <VerlaufZeile key={e.nr} e={e} />
            ))}
          </ol>
        )}
        {A.offen(a) && (
          <Recht aktion="verbesserung.verwalten" standort={a.standort_id}>
            <p className="vp-ez-leise">{A.AUSSAGE_HINWEIS}</p>
            <div className="vp-ez-aktionen">
              <Button size="sm" variant="outline" onClick={() => setDialog('aussage')} data-testid="abweichung-aussage-knopf">
                {A.KNOPF_AUSSAGE}
              </Button>
            </div>
            <Kommentar a={a} onNeu={(x) => setLage({ art: 'da', a: x })} />
          </Recht>
        )}
      </section>

      <section className="vp-ez-karte" aria-labelledby="aw-abschluss" data-testid="abweichung-abschluss">
        <h2 id="aw-abschluss">{A.ABSCHLUSS}</h2>
        {a.abschluss ? (
          <>
            <p className="vp-ez-satz" data-testid="abschluss-satz">
              {a.abschluss.satz ??
                `Abgeschlossen am ${Z.tag(a.abschluss.am)} von ${a.abschluss.person}: ${A.ERGEBNIS_WORT[a.abschluss.ergebnis]} — ‚${a.abschluss.begruendung}‘`}
            </p>
            {a.abschluss.massnahme &&
              (onMassnahme ? (
                <button type="button" className="vp-ez-sprung" onClick={() => onMassnahme(a.abschluss!.massnahme!.id)} data-testid="abschluss-sprung-massnahme">
                  {`${UEMS_MASSNAHME} ${a.abschluss.massnahme.kennzeichen ?? ''} öffnen`}
                </button>
              ) : (
                <span>{`${UEMS_MASSNAHME} ${a.abschluss.massnahme.kennzeichen ?? ''}`}</span>
              ))}
          </>
        ) : (
          <div className="vp-ez-aktionen">
            <Recht aktion="verbesserung.abschliessen" standort={a.standort_id}>
              <Button size="sm" onClick={() => setDialog('abschliessen')} data-testid="abweichung-abschliessen-knopf">
                {A.KNOPF_ABSCHLIESSEN}
              </Button>
            </Recht>
          </div>
        )}
      </section>

      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>

      {dialog === 'aussage' && <UrsacheAussageDialog abweichung={a} onClose={() => setDialog(null)} onFertig={neu} />}
      {dialog === 'frist' && <FristDialog abweichung={a} onClose={() => setDialog(null)} onFertig={neu} />}
      {dialog === 'verantwortlich' && <VerantwortlicherDialog abweichung={a} onClose={() => setDialog(null)} onFertig={neu} />}
      {dialog === 'abschliessen' && <AbschliessenDialog abweichung={a} onClose={() => setDialog(null)} onFertig={neu} />}
    </div>
  );
}
