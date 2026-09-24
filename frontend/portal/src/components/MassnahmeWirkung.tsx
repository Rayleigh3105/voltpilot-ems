import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Massnahme, type MassnahmeBewertung, type MassnahmeErgebnis, type MassnahmeWirkung, type VorgangAnstoss } from '../api';
import * as Z from '../energieziele';
import { UEMS_MASSNAHME, UEMS_NORMGRENZE } from '../glossar';
import * as W from '../massnahmeWirkung';
import * as M from '../massnahmen';
import { Ablehnung, Begruendung } from './EnergiezielDialoge';
import { Recht } from './Recht';
import { ErrorState, Skeleton } from './States';
import { VpPicker } from './VpPicker';
import '../pages/Verbesserung.css';

type Lage = { art: 'laedt' } | { art: 'fehler' } | { art: 'da'; w: MassnahmeWirkung };

/**
 * Abschnitt „Wirkung“ (AP-18 IP-20, §5.5, WK1–WK5): der Satz des Lesers, darunter die Nachher-Monate mit Urteil und
 * Band (Umsetzungsmonat und nicht bewertbare Monate mit dem Satz des Lesers), die Summenzeile Σ ÷ Σ mit „x von 12“,
 * „vorläufig“ aus dem Feld der Route, daneben Ausgangslage und erwartete Wirkung, und die rohe Kennzahl ohne Wort.
 * Ohne Messgrundlage nur der Satz (M4). Das Portal rechnet nichts.
 */
function WirkungKarte({ m, w }: { m: Massnahme; w: MassnahmeWirkung }) {
  const zeilen = W.wirkungZeilen(w);
  const summe = W.wirkungSumme(w);
  const vorlaeufig = W.vorlaeufigText(w);
  const mg = m.messgrundlage;
  return (
    <section className="vp-ez-karte" aria-labelledby="ma-wirkung" data-testid="massnahme-wirkung">
      <div className="vp-ez-kopf-zeile">
        <h2 id="ma-wirkung">{W.WIRKUNG}</h2>
        {vorlaeufig && (
          <Badge variant="tint" data-testid="massnahme-wirkung-vorlaeufig">
            {vorlaeufig}
          </Badge>
        )}
      </div>
      {w.satz && (
        <p className="vp-ez-satz" data-testid="massnahme-wirkung-satz">
          {w.satz}
        </p>
      )}
      {w.grund === null && (
        <>
          <div className="vp-ma-daneben" data-testid="massnahme-wirkung-daneben">
            <p className="vp-ez-label">{W.ZUM_VERGLEICH}</p>
            <p className="vp-ez-leise">{mg?.satz ?? M.erwarteteWirkungText(m)}</p>
          </div>
          <div className="vp-ma-tafel-rahmen">
            <table className="vp-ez-tafel" data-testid="massnahme-wirkung-monate">
              <thead>
                <tr>
                  <th scope="col">{Z.MONAT_SPALTEN.monat}</th>
                  <th scope="col" className="vp-ez-zahl">
                    {Z.MONAT_SPALTEN.gemessen}
                  </th>
                  <th scope="col" className="vp-ez-zahl">
                    {Z.MONAT_SPALTEN.erwartet}
                  </th>
                  <th scope="col" className="vp-ez-zahl">
                    {Z.MONAT_SPALTEN.delta}
                  </th>
                  <th scope="col">{Z.MONAT_SPALTEN.urteil}</th>
                  <th scope="col" className="vp-ez-zahl">
                    {W.ROH_SPALTE}
                  </th>
                </tr>
              </thead>
              <tbody>
                {zeilen.map((z) =>
                  z.art === 'gezaehlt' ? (
                    <tr key={z.periode} data-testid={`wirkung-${z.periode}`}>
                      <th scope="row">{z.beschriftung}</th>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.gemessen}>
                        {z.gemessen}
                        {z.version !== null && <span className="vp-ez-unter">{`Version ${z.version}`}</span>}
                      </td>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.erwartet}>
                        {z.erwartet}
                      </td>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.delta}>
                        {z.delta ?? '—'}
                      </td>
                      <td data-label={Z.MONAT_SPALTEN.urteil} data-testid="urteil">
                        {z.urteil}
                        {z.band && ` (${z.band})`}
                      </td>
                      <td className="vp-ez-zahl vp-ez-leise" data-label={W.ROH_SPALTE} data-testid="roh">
                        {z.roh ?? '—'}
                      </td>
                    </tr>
                  ) : z.art === 'nicht_gezaehlt' ? (
                    <tr key={z.periode} className="vp-ez-aus" data-testid={`wirkung-${z.periode}`}>
                      <th scope="row">{z.beschriftung}</th>
                      <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.gemessen}>
                        {z.gemessen}
                      </td>
                      <td colSpan={3} data-label={Z.MONAT_SPALTEN.grund} data-testid="grund">
                        {z.satz}
                      </td>
                      <td className="vp-ez-zahl vp-ez-leise" data-label={W.ROH_SPALTE}>
                        {z.roh ?? '—'}
                      </td>
                    </tr>
                  ) : (
                    <tr key={z.periode} className="vp-ez-offen" data-testid={`wirkung-${z.periode}`}>
                      <th scope="row">{z.beschriftung}</th>
                      <td colSpan={5}>{Z.NOCH_NICHT_ENDGUELTIG}</td>
                    </tr>
                  ),
                )}
                {summe && (
                  <tr className="vp-ez-summe" data-testid="massnahme-wirkung-summe">
                    <th scope="row">
                      {Z.SUMME}
                      <span className="vp-ez-unter">{summe.monate}</span>
                    </th>
                    <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.gemessen}>
                      {summe.gemessen}
                    </td>
                    <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.erwartet}>
                      {summe.erwartet}
                    </td>
                    <td className="vp-ez-zahl" data-label={Z.MONAT_SPALTEN.delta}>
                      {summe.delta ?? '—'}
                    </td>
                    <td data-label={Z.MONAT_SPALTEN.urteil}>
                      {summe.urteil}
                      {summe.band && ` (${summe.band})`}
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {w.summe && w.summe.kennzeichen.length > 0 && (
            <ul className="vp-ez-leise" data-testid="massnahme-wirkung-kennzeichen">
              {w.summe.kennzeichen.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          )}
          <p className="vp-ez-leise">{W.ROH_HINWEIS}</p>
        </>
      )}
    </section>
  );
}

/** Ein Stand Nr. n: der Satz der Route (Person, Datum, Begründung, Prüfsumme kurz), Vier-Augen und die volle Prüfsumme. */
function Stand({ b, testid }: { b: MassnahmeBewertung; testid?: string }) {
  const bestaetigt = W.bestaetigtSatz(b);
  return (
    <div className="vp-ma-stand" data-testid={testid}>
      <p className="vp-ez-satz">{b.status === 'abgelehnt' ? W.abgelehntSatz(b) : b.status === 'beantragt' ? W.beantragtSatz(b) : W.standSatz(b)}</p>
      {b.status !== 'bewertet' && <p>‚{b.begruendung}‘</p>}
      {b.status === 'bewertet' && bestaetigt && <p className="vp-ez-leise">{bestaetigt}</p>}
      <p className="vp-ez-pruefsumme">{W.standZeile(b)}</p>
    </div>
  );
}

/** „Alle Stände“: frühere, beantragte und abgelehnte Stände — erst beim Aufklappen gelesen, nie zurückgenommen. */
function AlleStaende({ m }: { m: Massnahme }) {
  const [liste, setListe] = useState<MassnahmeBewertung[] | null | 'fehler'>(null);
  const [offen, setOffen] = useState(false);
  useEffect(() => {
    if (!offen || liste !== null) return;
    api.massnahmeBewertungen(m.id).then(
      (r) => setListe(r.bewertungen),
      () => setListe('fehler'),
    );
  }, [offen, liste, m.id]);
  return (
    <details className="vp-ez-kopie" data-testid="massnahme-staende" onToggle={(e) => setOffen((e.target as HTMLDetailsElement).open)}>
      <summary>{W.ALLE_STAENDE}</summary>
      {liste === 'fehler' ? (
        <p className="vp-ez-leise">{W.STAENDE_LADEFEHLER}</p>
      ) : liste === null ? (
        offen && <Skeleton height={60} />
      ) : (
        <ol className="vp-ez-verlauf">
          {[...liste].reverse().map((b) => (
            <li key={b.stand_nr}>
              <Stand b={b} />
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/**
 * Spalte „Bewertung“ (§5.5, WK6, E6 = A): ohne bewerteten Stand „beobachtet — nicht belegt“; sonst der Stand Nr. n
 * mit Person, Datum, Begründung und Prüfsumme; ein offener Antrag (Vier-Augen) mit „bestätigen“/„ablehnen“ für eine
 * zweite Person; „bewerten“ mit Recht `verbesserung.abschliessen`. Frühere Stände aufklappbar.
 */
function BewertungKarte({ m, sub, onDialog }: { m: Massnahme; sub: string | null; onDialog: (s: 'bewerten' | 'freigeben' | 'ablehnen') => void }) {
  const b = m.bewertung;
  const antrag = m.bewertung_antrag;
  return (
    <section className="vp-ez-karte" aria-labelledby="ma-bewertung" data-testid="massnahme-bewertung">
      <h2 id="ma-bewertung">{W.BEWERTUNG}</h2>
      {b ? (
        <Stand b={b} testid="massnahme-stand" />
      ) : (
        <p className="vp-ez-satz" data-testid="massnahme-beobachtet">
          {W.bewertungOffenSatz()}
        </p>
      )}
      {antrag && (
        <>
          <Stand b={antrag} testid="massnahme-antrag" />
          {W.eigenerAntrag(m, sub) ? (
            <p className="vp-ez-leise">{W.EIGENER_ANTRAG}</p>
          ) : (
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
        </>
      )}
      {W.bewertbar(m) && (
        <Recht aktion="verbesserung.abschliessen" standort={m.standort_id}>
          <div className="vp-ez-aktionen">
            <Button size="sm" onClick={() => onDialog('bewerten')} data-testid="massnahme-bewerten">
              {W.KNOPF_BEWERTEN}
            </Button>
          </div>
        </Recht>
      )}
      {(b || antrag) && <AlleStaende key={`${b?.stand_nr ?? 0}-${antrag?.stand_nr ?? 0}`} m={m} />}
    </section>
  );
}

/** Wirkung und Bewertung nebeneinander (1440) bzw. untereinander (375); der Dialog gehört der Seite. */
export function MassnahmeWirkungBewertung({
  m,
  sub,
  onDialog,
}: {
  m: Massnahme;
  sub: string | null;
  onDialog: (s: 'bewerten' | 'freigeben' | 'ablehnen') => void;
}) {
  const [lage, setLage] = useState<Lage>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  // Ein neuer Stand ändert die Wirkung nicht (ein Leser) — gelesen wird sie je Maßnahme und Umsetzung.
  useEffect(() => {
    let aktiv = true;
    setLage({ art: 'laedt' });
    api.massnahmeWirkung(m.id).then(
      (w) => aktiv && setLage({ art: 'da', w }),
      () => aktiv && setLage({ art: 'fehler' }),
    );
    return () => {
      aktiv = false;
    };
  }, [m.id, m.umgesetzt_am, versuch]);
  return (
    <div className="vp-ma-wirkung">
      {lage.art === 'laedt' ? (
        <section className="vp-ez-karte" aria-busy="true" data-testid="massnahme-wirkung">
          <h2>{W.WIRKUNG}</h2>
          <Skeleton height={200} />
        </section>
      ) : lage.art === 'fehler' ? (
        <section className="vp-ez-karte" data-testid="massnahme-wirkung">
          <h2>{W.WIRKUNG}</h2>
          <ErrorState message={W.WIRKUNG_LADEFEHLER} onRetry={() => setVersuch((v) => v + 1)} />
        </section>
      ) : (
        <WirkungKarte m={m} w={lage.w} />
      )}
      <BewertungKarte m={m} sub={sub} onDialog={onDialog} />
    </div>
  );
}

/**
 * „bewerten“ (WK6, §5.7): Ergebnis `belegt · nicht belegt · nicht messbar` (ohne Messgrundlage nur „nicht messbar“)
 * und Begründung einer Person. Mit Vier-Augen folgt der Dialog der Route (409 `vieraugen_beantragen` → Antrag), eine
 * ZWEITE Person bestätigt oder lehnt ab (`schritt` `freigeben` · `ablehnen`). Aus einem Anstoß („neu bewerten“) geht
 * die Antwort an `…/anstoesse/{aid}/antwort` (IP-17-NAHT) — die Route setzt dann Stand Nr. n + 1 bzw. den Antrag.
 */
export function MassnahmeBewertenDialog({
  m,
  schritt,
  anstoss,
  onClose,
  onFertig,
}: {
  m: Massnahme;
  schritt: 'bewerten' | 'freigeben' | 'ablehnen';
  anstoss?: VorgangAnstoss | null;
  onClose: () => void;
  onFertig: (m: Massnahme) => void;
}) {
  const basis = `mab-${useId().replace(/:/g, '')}`;
  const optionen = W.ergebnisOptionen(m);
  const [ergebnis, setErgebnis] = useState<MassnahmeErgebnis | null>(optionen.length === 1 ? optionen[0].value : null);
  const [begruendung, setBegruendung] = useState('');
  const [zeigen, setZeigen] = useState<{ ergebnis?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titel =
    schritt === 'bewerten'
      ? `${UEMS_MASSNAHME} ${m.kennzeichen} ${anstoss ? W.ANTWORT_KNOPF.neu_bewertet : W.KNOPF_BEWERTEN}`
      : schritt === 'freigeben'
        ? W.KNOPF_FREIGEBEN
        : W.KNOPF_ABLEHNEN;

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const fehler = {
      ...(schritt === 'bewerten' && !ergebnis ? { ergebnis: 'Bitte wählen Sie ein Ergebnis.' } : {}),
      // Beim Bestätigen ist die Begründung wahlfrei (IP-12); steht eine da, gilt dieselbe Länge.
      ...(!Z.begruendungOk(begruendung) && !(schritt === 'freigeben' && !begruendung.trim()) ? { begruendung: Z.BEGRUENDUNG_HINWEIS } : {}),
    };
    setZeigen(fehler);
    const erstes = Object.keys(fehler)[0];
    if (erstes) {
      document.getElementById(`${basis}-${erstes}`)?.focus();
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
      onClose={onClose}
      title={titel}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="massnahme-bewerten-senden">
            {schritt === 'bewerten' ? W.KNOPF_BEWERTEN : titel}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-ez-form" noValidate onSubmit={(e) => void senden(e)} data-testid="massnahme-bewerten-dialog">
        {anstoss && <p className="vp-ez-leise">{W.anstossZeile(anstoss)}</p>}
        {schritt === 'bewerten' ? (
          <>
            <p className="vp-ez-satz">{m.messgrundlage ? W.bewertungOffenSatz() : m.ohne_messgrundlage?.satz}</p>
            <VpPicker
              id={`${basis}-ergebnis`}
              label="Ergebnis"
              options={optionen}
              value={ergebnis}
              onChange={(v) => setErgebnis(v as MassnahmeErgebnis)}
              placeholder="Ergebnis wählen"
              error={zeigen.ergebnis ?? null}
            />
            <p className="vp-ez-leise" data-testid="massnahme-bewerten-hinweis">
              {m.messgrundlage ? W.BELEGT_HINWEIS : W.NUR_NICHT_MESSBAR}
            </p>
          </>
        ) : (
          m.bewertung_antrag && <p className="vp-ez-leise">{W.beantragtSatz(m.bewertung_antrag)}</p>
        )}
        <Begruendung id={`${basis}-begruendung`} wert={begruendung} setze={setBegruendung} fehler={zeigen.begruendung ?? null} />
        <p className="vp-ez-leise">{W.ENDGUELTIG_HINWEIS}</p>
        <Ablehnung satz={satz} />
        <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
