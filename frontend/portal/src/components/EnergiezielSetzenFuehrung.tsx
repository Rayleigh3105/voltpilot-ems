import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Energieziel, type Kennzahl } from '../api';
import type { BezugsbasisVergleichZeitraum } from '../bezugsbasisVergleich';
import * as B from '../energiezielBild';
import * as Z from '../energieziele';
import { UEMS_NORMGRENZE } from '../glossar';
import { useRoutenHeute } from '../routenUhr';
import { VpPicker } from './VpPicker';
import '../pages/Energieziele.css';

type Schritt = 1 | 2 | 3;
type Daten =
  | { art: 'laedt' }
  | { art: 'fehler' }
  | { art: 'da'; kennzahlen: Kennzahl[]; laufend: Energieziel[] };

const SCHRITT_NAME: Record<Schritt, string> = { 1: 'Kennzahl', 2: 'Wert und Zeitraum', 3: 'Prüfen' };
const TITEL: Record<Schritt, string> = { 1: B.KNOPF_SETZEN, 2: 'Wie viel und bis wann?', 3: 'Prüfen und setzen' };

const monatNach = (m: string, n = 1) => {
  const i = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

/** Der früheste Beginn an einer Kennzahl: der Monat nach heute — und nach dem Ende eines laufenden Energieziels. */
export function fruehesterBeginn(heute: string, laufend: Pick<Energieziel, 'zielperiode'>[]): string {
  let start = monatNach(heute.slice(0, 7));
  for (const ez of laufend) {
    const nach = monatNach(ez.zielperiode.slice(8));
    if (nach > start) start = nach;
  }
  return start;
}

/** Die Schnellwahl des Zeitraums: der Rest des Jahres ab dem frühesten Beginn und das folgende Kalenderjahr. */
export function zeitraumWahl(start: string): { wert: string; label: string }[] {
  const jahr = start.slice(0, 4);
  const naechstes = String(Number(jahr) + 1);
  const aus: { wert: string; label: string }[] = [];
  if (!start.endsWith('-01') && !start.endsWith('-12')) aus.push({ wert: `${start}/${jahr}-12`, label: B.periodeText(start, `${jahr}-12`) });
  if (start.endsWith('-01')) aus.push({ wert: `${jahr}-01/${jahr}-12`, label: jahr });
  aus.push({ wert: `${naechstes}-01/${naechstes}-12`, label: naechstes });
  return aus;
}

/** Der Wortlaut, so wie er dasteht: „Stromeinsatz Montage je Stück: 3 % weniger, als die Bezugsbasis erwarten lässt.“ */
export const wortlautVon = (kennzahl: Pick<Kennzahl, 'name'>, zielwert: string) =>
  `${kennzahl.name}: ${B.zielText(zielwert).replace(/\u00a0/g, ' ')}, als die Bezugsbasis erwarten lässt.`;

/** „Zur Einordnung“ aus dem Vergleich der letzten zwölf abgeschlossenen Monate — ohne Zahl ein Satz ohne Zahl. */
function einordnung(z: BezugsbasisVergleichZeitraum | null, von: string, bis: string): string | null {
  if (!z) return null;
  const periode = B.periodeText(von, bis);
  if (z.delta_prozent === null) return `Zur Einordnung: Von ${periode} ist noch kein Monat bewertbar.`;
  const wie = z.richtung === 'gleich' ? 'so viel wie erwartet' : `${B.prozent(z.delta_prozent)} ${z.richtung} als erwartet`;
  const rahmen = z.urteil === 'im_rahmen' ? ', im Rahmen der Bezugsbasis' : '';
  return `Zur Einordnung: Von ${periode} lag die Kennzahl ${wie}${rahmen}${z.monate ? ` (${z.monate} Monaten)` : ''}.`;
}

/**
 * „Energieziel setzen“ geführt (Konzept Verbessern §6.9, PR 1): drei Schritte im zentrierten Fenster — die Kennzahl
 * wählen (nur mit freigegebener Bezugsbasis; eine belegte nennt ihren frühesten Beginn), Wert und Zeitraum mit
 * Einordnung und „So steht es da“, dann prüfen und setzen. „Heute“ ist der Tag der Route (eine Uhr, Befund 2); was die
 * Route ablehnt, steht als ihr Satz. Verantwortlich ist, wer die Kennzahl verantwortet (Vorgabe der Route).
 */
export function EnergiezielSetzenFuehrung({
  onClose,
  onGesetzt,
  kennzahlId = null,
}: {
  onClose: () => void;
  onGesetzt: (ez: Energieziel) => void;
  /** Vorbelegung, wenn der Einstieg schon an einer Kennzahl steht. */
  kennzahlId?: string | null;
}) {
  const basis = `ezf-${useId().replace(/:/g, '')}`;
  const heute = useRoutenHeute();
  const [daten, setDaten] = useState<Daten>({ art: 'laedt' });
  const [versuch, setVersuch] = useState(0);
  const [schritt, setSchritt] = useState<Schritt>(1);
  const [kz, setKz] = useState<string | null>(kennzahlId);
  const [betrag, setBetrag] = useState('');
  const [mehr, setMehr] = useState(false);
  const [periode, setPeriode] = useState<string | null>(null);
  const [anders, setAnders] = useState(false);
  const [von, setVon] = useState('');
  const [bis, setBis] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [fehler, setFehler] = useState<{ kennzahl?: string; betrag?: string; periode?: string; begruendung?: string }>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [vergleich, setVergleich] = useState<{ z: BezugsbasisVergleichZeitraum; von: string; bis: string } | null>(null);
  const titelRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let aktiv = true;
    setDaten({ art: 'laedt' });
    Promise.all([api.kennzahlen(), api.energieziele({ zustand: 'offen' })])
      .then(([k, e]) => {
        if (!aktiv) return;
        const mitBasis = k.kennzahlen.filter((x) => !x.archiviert_am && x.bezugsbasis?.freigabe_status === 'freigegeben');
        setDaten({ art: 'da', kennzahlen: mitBasis, laufend: e.energieziele });
      })
      .catch(() => aktiv && setDaten({ art: 'fehler' }));
    return () => {
      aktiv = false;
    };
  }, [versuch]);

  const kennzahl = daten.art === 'da' ? (daten.kennzahlen.find((k) => k.id === kz) ?? null) : null;
  const laufendHier = daten.art === 'da' && kz ? daten.laufend.filter((ez) => ez.kennzahl.id === kz) : [];
  const start = heute ? fruehesterBeginn(heute, laufendHier) : null;
  const wahl = useMemo(() => (start ? zeitraumWahl(start) : []), [start]);
  const monate = useMemo(() => (start ? Z.monatsWahl(`${monatNach(start, -1)}-15`, 60) : []), [start]);

  // Ein neuer Beginn (andere Kennzahl): die erste Schnellwahl vorbelegen.
  useEffect(() => {
    if (!start || wahl.length === 0) return;
    setPeriode(wahl[0].wert);
    setAnders(false);
    setVon(start);
    setBis(`${start.slice(0, 4)}-12`);
  }, [start, wahl]);

  useEffect(() => {
    if (!kz) return;
    let aktiv = true;
    setVergleich(null);
    api.bezugsbasisVergleich(kz).then(
      (v) => aktiv && setVergleich({ z: v.zeitraum, von: v.von.slice(0, 7), bis: v.bis.slice(0, 7) }),
      () => undefined,
    );
    return () => {
      aktiv = false;
    };
  }, [kz]);

  useEffect(() => {
    titelRef.current?.focus();
  }, [schritt]);

  const zielwert = (() => {
    const w = Z.zielwertAusEingabe(betrag);
    return w === null ? null : mehr ? -w : w;
  })();
  const zielwertText = zielwert === null ? null : zielwert.toFixed(1);
  const zp = anders ? `${von}/${bis}` : periode;
  const zpOk = !!zp && Z.zielperiodeOk(zp.slice(0, 7), zp.slice(8)) && (!start || zp.slice(0, 7) >= start);
  const wortlaut = kennzahl && zielwertText ? wortlautVon(kennzahl, zielwertText) : null;

  function weiter() {
    if (schritt === 1) {
      if (!kz) {
        setFehler({ kennzahl: 'Bitte wählen Sie eine Kennzahl.' });
        return;
      }
      setFehler({});
      setSchritt(2);
      return;
    }
    if (schritt === 2) {
      const f = {
        ...(zielwert === null ? { betrag: 'Eine Zahl zwischen 0 und 100 mit höchstens einer Nachkommastelle, zum Beispiel 4 oder 2,5.' } : {}),
        ...(!zpOk ? { periode: start ? `Der Zeitraum beginnt frühestens im ${B.monatLang(start)} und endet nicht vor seinem Beginn.` : 'Bitte wählen Sie einen Zeitraum.' } : {}),
        ...(!Z.begruendungOk(begruendung) ? { begruendung: 'Bitte schreiben Sie in ein bis zwei Sätzen, warum (mindestens zehn Zeichen).' } : {}),
      };
      setFehler(f);
      const erstes = Object.keys(f)[0];
      if (erstes) {
        document.getElementById(`${basis}-${erstes}`)?.focus();
        return;
      }
      setSchritt(3);
    }
  }

  async function setzen() {
    if (!kennzahl || zielwert === null || !zp || !wortlaut) return;
    setBusy(true);
    setSatz(null);
    try {
      onGesetzt(
        await api.energiezielAnlegen({
          kennzahl: kennzahl.id,
          zielwert_prozent: zielwert,
          zielperiode: zp,
          wortlaut,
          begruendung: begruendung.trim(),
        }),
      );
    } catch (e) {
      setSatz(Z.ablehnungSatz(e));
    } finally {
      setBusy(false);
    }
  }

  const fuss = (
    <>
      <Button variant="ghost" onClick={() => (schritt === 1 ? onClose() : setSchritt((s) => (s - 1) as Schritt))}>
        {schritt === 1 ? 'Abbrechen' : 'Zurück'}
      </Button>
      {schritt < 3 ? (
        <Button onClick={weiter} disabled={daten.art !== 'da' || !heute} data-testid="energieziel-setzen-weiter">
          Weiter
        </Button>
      ) : (
        <Button onClick={() => void setzen()} disabled={busy} data-testid="energieziel-setzen-senden">
          {B.KNOPF_SETZEN}
        </Button>
      )}
    </>
  );

  return (
    <Modal open onClose={onClose} title={TITEL[schritt]} footer={fuss}>
      <div className="vp-ezf" data-testid="energieziel-setzen">
        <div className="vp-ezf-schritt" aria-label={`Schritt ${schritt} von 3: ${SCHRITT_NAME[schritt]}`}>
          <div className="st">
            <span>
              <b>Schritt {schritt}</b> von 3
            </span>
            <span>{SCHRITT_NAME[schritt]}</span>
          </div>
          <div className="bar" aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <i key={i} className={i <= schritt ? 'an' : ''} />
            ))}
          </div>
        </div>
        <h3 ref={titelRef} tabIndex={-1} className="vp-ezf-frage">
          {schritt === 1 ? 'Woran wollen Sie es messen?' : schritt === 2 ? kennzahl?.name : 'So wird das Energieziel gesetzt'}
        </h3>

        {daten.art === 'laedt' ? (
          <div aria-busy="true" className="vp-ezl-skelett">
            <span className="vp-skeleton is-karte" />
          </div>
        ) : daten.art === 'fehler' ? (
          <div className="vp-ezl-karte is-fehler" role="alert">
            <p className="vp-ezl-leer">Die Kennzahlen ließen sich gerade nicht laden. Ihre Daten sind nicht betroffen.</p>
            <button type="button" className="vp-ezl-link" onClick={() => setVersuch((v) => v + 1)}>
              {B.ERNEUT}
            </button>
          </div>
        ) : schritt === 1 ? (
          <>
            {daten.kennzahlen.length === 0 ? (
              <p className="vp-ezl-text" data-testid="energieziel-setzen-keine-kennzahl">
                Noch hat keine Kennzahl eine freigegebene Bezugsbasis. Legen Sie sie unter Auswerten an der Kennzahl fest - dann lässt sich ein Energieziel setzen.
              </p>
            ) : (
              <div className="vp-ezf-wahl" role="radiogroup" aria-labelledby={`${basis}-kennzahl`} id={`${basis}-kennzahl`} tabIndex={-1}>
                {daten.kennzahlen.map((k) => {
                  const belegt = daten.laufend.filter((ez) => ez.kennzahl.id === k.id);
                  const ab = heute ? fruehesterBeginn(heute, belegt) : null;
                  const unter = [k.geltung_name, `Bezugsbasis ${k.bezugsbasis?.kennzeichen ?? ''}${k.bezugsbasis?.vorlaeufig ? ' (vorläufig)' : ''}`];
                  return (
                    <label key={k.id} className={`vp-ezf-wo${kz === k.id ? ' an' : ''}`} data-testid={`energieziel-setzen-kennzahl-${k.kennzeichen}`}>
                      <input type="radio" name={`${basis}-kz`} checked={kz === k.id} onChange={() => setKz(k.id)} />
                      <b>{k.name}</b>
                      <span className="s">
                        {belegt.length > 0 && ab
                          ? `Für ${B.zielperiodeText(belegt[belegt.length - 1].zielperiode)} läuft schon das ${B.energiezielName(belegt[belegt.length - 1])}. Ein weiteres geht ab ${B.monatLang(ab)}.`
                          : [...unter.filter(Boolean), 'noch ohne Energieziel'].join(' · ')}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {fehler.kennzahl && <p className="vp-ezf-fehler" role="alert">{fehler.kennzahl}</p>}
            <p className="vp-ezf-hilfe">Nur Kennzahlen mit freigegebener Bezugsbasis: ohne sie gibt es nichts, wogegen VoltPilot messen kann.</p>
          </>
        ) : schritt === 2 ? (
          <>
            <div className="vp-ezf-feld">
              <label htmlFor={`${basis}-betrag`}>{mehr ? 'Wie viel mehr lassen Sie zu?' : 'Wie viel weniger?'}</label>
              <div className={`vp-ezf-in${fehler.betrag ? ' is-fehler' : ''}`}>
                <input
                  id={`${basis}-betrag`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={betrag}
                  onChange={(e) => setBetrag(e.target.value)}
                  aria-invalid={!!fehler.betrag}
                  aria-describedby={`${basis}-betrag-hilfe`}
                  data-testid="energieziel-setzen-betrag"
                />
                <span className="e">{mehr ? '% mehr als erwartet' : '% weniger als erwartet'}</span>
              </div>
              {fehler.betrag && <p className="vp-ezf-fehler" role="alert">{fehler.betrag}</p>}
              <p className="vp-ezf-hilfe" id={`${basis}-betrag-hilfe`}>
                {vergleich ? einordnung(vergleich.z, vergleich.von, vergleich.bis) : 'Gemessen wird gegen das, was die Bezugsbasis bei Ihrer Produktion erwarten lässt.'}
              </p>
              <button type="button" className="vp-ezl-link" onClick={() => setMehr((m) => !m)}>
                {mehr ? 'Doch weniger vornehmen' : 'Mehr zulassen, etwa wegen einer neuen Anlage'}
              </button>
            </div>
            <fieldset className="vp-ezf-feld" id={`${basis}-periode`} tabIndex={-1}>
              <legend>Für welchen Zeitraum?</legend>
              <div className="vp-ezf-schnell">
                {wahl.map((w) => (
                  <button
                    key={w.wert}
                    type="button"
                    className="vp-ezf-chip"
                    aria-pressed={!anders && periode === w.wert}
                    onClick={() => {
                      setAnders(false);
                      setPeriode(w.wert);
                    }}
                  >
                    {w.label}
                  </button>
                ))}
                <button type="button" className="vp-ezf-chip" aria-pressed={anders} onClick={() => setAnders(true)}>
                  Anders
                </button>
              </div>
              {anders && (
                <div className="vp-ezf-zwei">
                  <VpPicker id={`${basis}-von`} label="Erster Monat" options={monate} value={von} onChange={setVon} />
                  <VpPicker id={`${basis}-bis`} label="Letzter Monat" options={monate} value={bis} onChange={setBis} />
                </div>
              )}
              {fehler.periode && <p className="vp-ezf-fehler" role="alert">{fehler.periode}</p>}
              {start && <p className="vp-ezf-hilfe">Ganze Monate, frühestens ab {B.monatLang(start)}.</p>}
            </fieldset>
            {wortlaut && zp && zpOk && (
              <div className="vp-ezf-so" data-testid="energieziel-setzen-so">
                <span className="l">So steht es da</span>
                <span className="w">
                  <b>{wortlaut}</b> · {B.zielperiodeText(zp)} · verantwortlich {kennzahl?.verantwortlich_name}
                </span>
              </div>
            )}
            <div className="vp-ezf-feld">
              <label htmlFor={`${basis}-begruendung`}>Warum dieses Energieziel?</label>
              <textarea
                id={`${basis}-begruendung`}
                rows={3}
                className={fehler.begruendung ? 'is-fehler' : ''}
                value={begruendung}
                placeholder="Zum Beispiel: Beschluss der Managementbewertung, neue Druckluftleitung in der Montage."
                onChange={(e) => setBegruendung(e.target.value)}
                aria-invalid={!!fehler.begruendung}
                data-testid="energieziel-setzen-begruendung"
              />
              {fehler.begruendung && <p className="vp-ezf-fehler" role="alert">{fehler.begruendung}</p>}
            </div>
          </>
        ) : (
          <>
            <dl className="vp-ezf-pruef" data-testid="energieziel-setzen-pruefen">
              <div>
                <dt>Gemessen an</dt>
                <dd>
                  {kennzahl?.name}
                  <small>Bezugsbasis {kennzahl?.bezugsbasis?.kennzeichen}</small>
                </dd>
                <button type="button" className="vp-ezl-link" onClick={() => setSchritt(1)}>Ändern</button>
              </div>
              <div>
                <dt>Vorgenommen</dt>
                <dd>
                  {zielwertText && B.zielText(zielwertText)} als erwartet
                  <small>{zp && B.zielperiodeText(zp)}</small>
                </dd>
                <button type="button" className="vp-ezl-link" onClick={() => setSchritt(2)}>Ändern</button>
              </div>
              <div>
                <dt>So steht es da</dt>
                <dd>{wortlaut}</dd>
              </div>
              <div>
                <dt>Warum</dt>
                <dd>‚{begruendung.trim()}‘</dd>
                <button type="button" className="vp-ezl-link" onClick={() => setSchritt(2)}>Ändern</button>
              </div>
              <div>
                <dt>Verantwortlich</dt>
                <dd>
                  {kennzahl?.verantwortlich_name}
                  <small>wer die Kennzahl verantwortet</small>
                </dd>
              </div>
            </dl>
            <p className="vp-ezf-hilfe">
              Danach zeigt VoltPilot jeden Monat, ob das Energieziel auf Kurs ist. Maßnahmen planen Sie direkt am Energieziel.
            </p>
            {satz && (
              <p className="vp-alert vp-alert-err" role="alert" data-testid="energieziel-setzen-ablehnung">
                {satz}
              </p>
            )}
          </>
        )}
        <p className="vp-ezf-grenze">{UEMS_NORMGRENZE}</p>
      </div>
    </Modal>
  );
}
