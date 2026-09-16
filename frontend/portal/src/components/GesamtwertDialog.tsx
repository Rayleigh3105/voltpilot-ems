import { Recht } from './Recht';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Messkanal, type Messstelle } from '../api';
import { measurementTree, type VerlaufGroup } from '../verlauf';
import {
  GESAMTWERT,
  KEINE_WERTE,
  MAX_NAME,
  SCHRITT1_FRAGE,
  SCHRITT1_SUB,
  SCHRITTE,
  abgeleiteteGroesse,
  alsAnfrage,
  entwurfFehler,
  frischeVon,
  leererEntwurf,
  nameVorschlag,
  punkt,
  rechenzeile,
  schluessel,
  schritt1Fertig,
  sperrgrund,
  tagesverlauf,
  termAus,
  unvollstaendigSatz,
  vorschau,
  wertText,
  type Entwurf,
  type KanalPunkt,
  type Quellwert,
  type Schritt,
} from '../gesamtwert';
import type { VpOption } from '../picker/optionen';
import { VpPicker } from './VpPicker';
import './Gesamtwert.css';

/**
 * Der GEFÜHRTE Assistent für einen „Gesamtwert" (Konzept `vp-helfer-konzept-h1`):
 * fünf Schritte — Werte · Rechnen · Name · Vorschau · Fertig — im zentrierten
 * `Modal` (am Telefon Vollbild). Ein Geschwister von `EigeneAuswertungDialog`:
 * gleiche Grammatik, DERSELBE Messwert-Baum (`verlauf.measurementTree`), gleiche
 * Ehrlichkeitsregel — nur baut er statt einer Kachel eine berechnete Messstelle
 * (die gewichtete Summe, AP-10).
 *
 * Render-only: jede Regel liegt im reinen `src/gesamtwert.ts`.
 */
export function GesamtwertDialog({
  open,
  siteId,
  onClose,
  onGespeichert,
}: {
  open: boolean;
  siteId: string;
  onClose: () => void;
  /** Der neue Gesamtwert ist angelegt — der Wirt lädt die Anzeige neu. */
  onGespeichert?: (messstelle: Messstelle) => void;
}) {
  const [schritt, setSchritt] = useState<Schritt>(1);
  const [entwurf, setEntwurf] = useState<Entwurf>(() => leererEntwurf());
  const [nameBeruehrt, setNameBeruehrt] = useState(false);
  const [faktorenOffen, setFaktorenOffen] = useState(false);

  const [quellen, setQuellen] = useState<Quellwert[] | null>(null);
  const [reihen, setReihen] = useState<Map<string, KanalPunkt[]>>(new Map());
  const [kennzeichen, setKennzeichen] = useState<string | null>(null);

  const [speichern, setSpeichern] = useState(false);
  const [serverFehler, setServerFehler] = useState<string | null>(null);
  const [ergebnis, setErgebnis] = useState<Messstelle | null>(null);

  // Beim Öffnen: Zustand frisch, und den Messwert-Baum + Größen + Live-Werte
  // holen (die Handlung ist selten und bewusst — nicht der heisse Cockpit-Pfad).
  useEffect(() => {
    if (!open) return;
    setSchritt(1);
    setEntwurf(leererEntwurf());
    setNameBeruehrt(false);
    setFaktorenOffen(false);
    setServerFehler(null);
    setErgebnis(null);
  }, [open]);

  const geladen = useRef(false);
  useEffect(() => {
    if (!open) {
      geladen.current = false;
      return undefined;
    }
    if (geladen.current) return undefined;
    geladen.current = true;
    let aktiv = true;
    setQuellen(null);
    setReihen(new Map());
    api.kennzeichenVorschlag().then(
      (v) => aktiv && setKennzeichen(v.kennzeichen),
      () => aktiv && setKennzeichen(null),
    );
    ladeQuellen(siteId)
      .then(({ quellen: qs, reihen: rs }) => {
        if (!aktiv) return;
        setQuellen(qs);
        setReihen(rs);
      })
      .catch(() => {
        if (aktiv) {
          setQuellen([]);
          setReihen(new Map());
        }
      });
    return () => {
      aktiv = false;
    };
  }, [open, siteId]);

  const quellenByKey = useMemo(() => {
    const m = new Map<string, Quellwert>();
    for (const q of quellen ?? []) m.set(schluessel(q), q);
    return m;
  }, [quellen]);

  const gewaehlteQuellen = entwurf.terme.map((t) => t.quelle);
  const jetzt = Date.now();

  const optionen: VpOption[] = useMemo(
    () =>
      (quellen ?? []).map((q) => {
        const grund = sperrgrund(q, gewaehlteQuellen);
        const wert = wertText(q.wert, q.einheit ?? '');
        const geraet = q.geraet ? `${q.geraet} · ` : '';
        return {
          value: schluessel(q),
          label: q.name,
          sub: `${geraet}${wert}`,
          dot: punkt(frischeVon(q.stand, q.wert, jetzt)),
          disabled: grund != null,
          disabledHint: grund ?? undefined,
        };
      }),
    // gewaehlteQuellen/jetzt sind bewusst in den Deps über `entwurf.terme`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quellen, entwurf.terme],
  );

  const gewaehlteKeys = entwurf.terme.map((t) => schluessel(t.quelle));

  const beiAuswahl = (values: string[]) => {
    setEntwurf((e) => {
      const nachKey = new Map(e.terme.map((t) => [schluessel(t.quelle), t]));
      const terme = values
        .map((v) => nachKey.get(v) ?? (quellenByKey.has(v) ? termAus(quellenByKey.get(v)!) : null))
        .filter((t): t is NonNullable<typeof t> => t != null);
      return { ...e, terme };
    });
  };

  // Der Name-VORSCHLAG folgt der Auswahl, bis der Kunde ihn selbst anfasst.
  useEffect(() => {
    if (nameBeruehrt) return;
    setEntwurf((e) => ({ ...e, name: nameVorschlag(e.terme) }));
  }, [nameBeruehrt, entwurf.terme]);

  const groesse = abgeleiteteGroesse(entwurf.terme);
  const vorschauWert = vorschau(entwurf.terme);
  const verlaufPunkte = useMemo(
    () => tagesverlauf(entwurf.terme, reihen),
    [entwurf.terme, reihen],
  );
  const fehler = entwurfFehler(entwurf);

  const speichereJetzt = async () => {
    if (fehler || speichern) return;
    setSpeichern(true);
    setServerFehler(null);
    try {
      const neu = await api.berechneteMessstelleAnlegen(alsAnfrage(entwurf));
      setErgebnis(neu);
      onGespeichert?.(neu);
      setSchritt(5);
    } catch (e) {
      setServerFehler(
        e instanceof Error && e.message
          ? e.message
          : 'Das Speichern ist gerade nicht gelungen. Bitte versuchen Sie es noch einmal.',
      );
    } finally {
      setSpeichern(false);
    }
  };

  const neuAnlegen = () => {
    geladen.current = false;
    setSchritt(1);
    setEntwurf(leererEntwurf());
    setNameBeruehrt(false);
    setFaktorenOffen(false);
    setServerFehler(null);
    setErgebnis(null);
    // ein frischer Kennzeichen-Vorschlag + Live-Werte
    setQuellen(null);
    api.kennzeichenVorschlag().then((v) => setKennzeichen(v.kennzeichen)).catch(() => setKennzeichen(null));
    ladeQuellen(siteId)
      .then(({ quellen: qs, reihen: rs }) => {
        setQuellen(qs);
        setReihen(rs);
      })
      .catch(() => setQuellen([]));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={schritt === 5 ? 'Fertig' : `Neuer ${GESAMTWERT}`}
      footer={Fuss()}
    >
      <div className="vp-gw">
        <ol className="vp-steps" aria-label="Schritte">
          {SCHRITTE.map((label, i) => {
            const n = (i + 1) as Schritt;
            const state = n < schritt ? 'done' : n === schritt ? 'active' : 'todo';
            return (
              <li key={label} className={`vp-step vp-step-${state}`}>
                <span className="vp-step-num" aria-hidden="true">
                  {state === 'done' ? <Icon name="check" size={13} strokeWidth={3} /> : n}
                </span>
                <span className="vp-step-label">{label}</span>
              </li>
            );
          })}
        </ol>

        {/* ⚠ Die Schritte werden als FUNKTIONEN aufgerufen, NICHT als
            `<Schritt/>`-Komponenten gerendert: eine je Render neu definierte
            Komponente hätte einen neuen Typ und würde ihre Kinder (den Picker)
            bei jeder Auswahl neu mounten — das Panel klappte nach dem ersten
            Haken zu. Als Aufruf werden sie in DIESEN Render eingezogen. */}
        {schritt === 1 && SchrittWerte()}
        {schritt === 2 && SchrittRechnen()}
        {schritt === 3 && SchrittName()}
        {schritt === 4 && SchrittVorschau()}
        {schritt === 5 && SchrittFertig()}
      </div>
    </Modal>
  );

  // ---------------------------------------------------------------- Schritte

  function SchrittWerte() {
    return (
      <>
        <p className="vp-gw-eyebrow">Schritt 1 von 5</p>
        <p className="vp-gw-title">{SCHRITT1_FRAGE}</p>
        <p className="vp-gw-sub">{SCHRITT1_SUB}</p>
        <div className="vp-gw-step-body">
          {quellen == null ? (
            <p className="vp-gw-hint">Messwerte werden geladen …</p>
          ) : quellen.length === 0 ? (
            <p className="vp-gw-hint">{KEINE_WERTE}</p>
          ) : (
            <>
              <VpPicker
                label="Messwerte"
                ariaLabel="Messwerte wählen"
                options={optionen}
                values={gewaehlteKeys}
                onChangeMany={beiAuswahl}
                placeholder="Messwerte wählen …"
                searchPlaceholder="Messwert suchen …"
                hint={
                  groesse
                    ? `Alle Werte: ${groesse.groesse} · ${groesse.richtung} · ${groesse.einheit}.`
                    : 'Wählen Sie Werte, die dieselbe Messgröße haben.'
                }
              />
              {entwurf.terme.length > 0 && (
                <div className="vp-gw-chosen">
                  {entwurf.terme.map((t) => (
                    <div key={schluessel(t.quelle)} className="vp-gw-crow">
                      <span className="vp-gw-sq">{kurz(t.quelle.name)}</span>
                      <span className="vp-gw-crow-name">
                        {t.quelle.name}
                        {t.quelle.geraet && <small>{t.quelle.geraet}</small>}
                      </span>
                      <span className="vp-gw-crow-val">
                        <span className={`vp-gw-dot ${punkt(frischeVon(t.quelle.stand, t.quelle.wert, jetzt))}`} />
                        {wertText(t.quelle.wert, t.quelle.einheit ?? '')}
                      </span>
                      <button
                        type="button"
                        className="vp-gw-remove"
                        aria-label={`${t.quelle.name} entfernen`}
                        onClick={() =>
                          beiAuswahl(gewaehlteKeys.filter((k) => k !== schluessel(t.quelle)))
                        }
                      >
                        <Icon name="x" size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </>
    );
  }

  function SchrittRechnen() {
    return (
      <>
        <p className="vp-gw-eyebrow">Schritt 2 von 5</p>
        <p className="vp-gw-title">Wie zählen wir sie?</p>
        <p className="vp-gw-sub">Standard ist „plus". Die Feineinstellung brauchen Sie nur selten.</p>
        <div className="vp-gw-step-body">
          <div className="vp-gw-terms">
            {entwurf.terme.map((t, i) => (
              <div key={schluessel(t.quelle)} className="vp-gw-term">
                <span className="vp-gw-term-name">
                  {t.quelle.name}
                  {t.quelle.geraet && <small>{t.quelle.geraet}</small>}
                </span>
                <span className="vp-gw-seg" role="group" aria-label={`Vorzeichen für ${t.quelle.name}`}>
                  <button
                    type="button"
                    className={t.vorzeichen === '+' ? 'on' : ''}
                    aria-pressed={t.vorzeichen === '+'}
                    onClick={() => setzeVorzeichen(i, '+')}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className={t.vorzeichen === '-' ? 'on' : ''}
                    aria-pressed={t.vorzeichen === '-'}
                    onClick={() => setzeVorzeichen(i, '-')}
                  >
                    −
                  </button>
                </span>
                {faktorenOffen && (
                  <label className="vp-gw-factor">
                    Faktor
                    <input
                      type="number"
                      inputMode="decimal"
                      step="0.1"
                      value={t.faktor}
                      onChange={(e) => setzeFaktor(i, e.target.value)}
                    />
                  </label>
                )}
              </div>
            ))}
          </div>
          {!faktorenOffen ? (
            <button type="button" className="vp-gw-fine" onClick={() => setFaktorenOffen(true)}>
              ＋ Feineinstellung (Faktor) anzeigen
            </button>
          ) : (
            <button type="button" className="vp-gw-fine" onClick={() => setFaktorenOffen(false)}>
              Feineinstellung ausblenden
            </button>
          )}
        </div>
      </>
    );
  }

  function SchrittName() {
    return (
      <>
        <p className="vp-gw-eyebrow">Schritt 3 von 5</p>
        <p className="vp-gw-title">Wie nennen Sie ihn?</p>
        <p className="vp-gw-sub">Ein Name, den Sie wiedererkennen.</p>
        <div className="vp-gw-step-body">
          <div className="vp-gw-field">
            <label htmlFor="vp-gw-name">Name</label>
            <div className="vp-gw-name-line">
              <input
                id="vp-gw-name"
                type="text"
                value={entwurf.name}
                maxLength={MAX_NAME}
                autoFocus
                onChange={(e) => {
                  setNameBeruehrt(true);
                  setEntwurf((s) => ({ ...s, name: e.target.value }));
                }}
              />
              {kennzeichen && <span className="vp-gw-kz">{kennzeichen}</span>}
            </div>
          </div>
        </div>
      </>
    );
  }

  function SchrittVorschau() {
    const einheit = vorschauWert.einheit;
    return (
      <>
        <p className="vp-gw-eyebrow">Schritt 4 von 5</p>
        <p className="vp-gw-title">Sieht das richtig aus?</p>
        <p className="vp-gw-sub">So rechnet „{entwurf.name || GESAMTWERT}" gerade — live aus Ihrer Anlage.</p>
        <div className="vp-gw-step-body">
          <div className="vp-gw-preview">
            <div className="vp-gw-preview-top">
              <span className="vp-gw-chip calc">berechnet</span>
            </div>
            {vorschauWert.unvollstaendig ? (
              <div className="vp-gw-big leer">unvollständig</div>
            ) : (
              <div className="vp-gw-big">{wertText(vorschauWert.wert, '')}</div>
            )}
            {groesse && (
              <div className="vp-gw-unit">
                {groesse.groesse} · {groesse.richtung} · {einheit}
              </div>
            )}
            <div className="vp-gw-calc">{rechenzeile(entwurf.terme)}</div>
            <Sparkline punkte={verlaufPunkte} />
          </div>
          {vorschauWert.unvollstaendig && (
            <p className="vp-gw-warn">{unvollstaendigSatz(vorschauWert.fehlende)}</p>
          )}
          {serverFehler && (
            <p className="vp-gw-error" role="alert">
              {serverFehler}
            </p>
          )}
        </div>
      </>
    );
  }

  function SchrittFertig() {
    return (
      <div className="vp-gw-step-body">
        <div className="vp-gw-done">
          <div className="vp-gw-done-circle">
            <Icon name="check" size={30} strokeWidth={3} />
          </div>
          <h3>„{ergebnis?.name || entwurf.name}" ist angelegt</h3>
          <p>Ab jetzt überall wie ein gemessener Wert.</p>
          <div className="vp-gw-appears">
            <div className="a">
              <Icon name="dashboard" size={16} /> In der Übersicht als Kachel
            </div>
            <div className="a">
              <Icon name="trending-up" size={16} /> Im Verlauf als eigene Kurve
            </div>
            <div className="a">
              <Icon name="list" size={16} /> Wählbar in „Eigene Auswertung"
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------- Fuß

  function Fuss() {
    if (schritt === 1) {
      return (
        <div className="vp-gw-foot">
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={() => setSchritt(2)} disabled={!schritt1Fertig(entwurf.terme)}>
            {entwurf.terme.length > 0 ? `Weiter · ${entwurf.terme.length} Werte` : 'Weiter'}
          </Button>
        </div>
      );
    }
    if (schritt === 2) {
      return (
        <div className="vp-gw-foot">
          <Button variant="ghost" onClick={() => setSchritt(1)}>
            Zurück
          </Button>
          <Button onClick={() => setSchritt(3)}>Weiter</Button>
        </div>
      );
    }
    if (schritt === 3) {
      return (
        <div className="vp-gw-foot">
          <Button variant="ghost" onClick={() => setSchritt(2)}>
            Zurück
          </Button>
          <Button onClick={() => setSchritt(4)} disabled={!entwurf.name.trim()}>
            Weiter
          </Button>
        </div>
      );
    }
    if (schritt === 4) {
      return (
        <div className="vp-gw-foot">
          <Button variant="ghost" onClick={() => setSchritt(3)}>
            Zurück
          </Button>
          <Recht aktion="messstelle.formel"><Button onClick={speichereJetzt} disabled={fehler != null || speichern}>
            {speichern ? 'Speichern …' : 'Speichern'}
          </Button></Recht>
        </div>
      );
    }
    return (
      <div className="vp-gw-foot">
        <Recht aktion="messstelle.formel"><Button variant="ghost" onClick={neuAnlegen}>
          Weiteren anlegen
        </Button></Recht>
        <Button onClick={onClose}>Fertig</Button>
      </div>
    );
  }

  function setzeVorzeichen(i: number, v: '+' | '-') {
    setEntwurf((e) => ({
      ...e,
      terme: e.terme.map((t, j) => (j === i ? { ...t, vorzeichen: v } : t)),
    }));
  }
  function setzeFaktor(i: number, roh: string) {
    const n = Number(roh.replace(',', '.'));
    setEntwurf((e) => ({
      ...e,
      terme: e.terme.map((t, j) => (j === i ? { ...t, faktor: Number.isFinite(n) ? n : t.faktor } : t)),
    }));
  }
}

/** Ein kurzes Kürzel für das Quadrat-Abzeichen (die ersten Buchstaben/Ziffern). */
function kurz(name: string): string {
  const t = name.replace(/[^A-Za-zÄÖÜäöü0-9]/g, '');
  return (t.slice(0, 3) || '·').toUpperCase();
}

/**
 * Ein kleiner Tages-Verlauf der Summe — ehrlich: gibt es keinen Wert, steht das
 * da, statt eine erfundene Kurve zu zeichnen. Reine Anzeige aus den (client-
 * seitig summierten) Punkten.
 */
function Sparkline({ punkte }: { punkte: { start: string; wert: number | null }[] }) {
  const werte = punkte.map((p) => p.wert).filter((w): w is number => w != null);
  if (werte.length < 2) {
    return <p className="vp-gw-spark-leer">Für den Verlauf reicht die Messung noch nicht.</p>;
  }
  const min = Math.min(...werte, 0);
  const max = Math.max(...werte);
  const spanne = max - min || 1;
  const W = 320;
  const H = 60;
  const n = punkte.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (w: number) => H - ((w - min) / spanne) * (H - 6) - 3;
  // Nur die zusammenhängenden Nicht-Null-Punkte tragen die Linie.
  let d = '';
  let started = false;
  punkte.forEach((p, i) => {
    if (p.wert == null) {
      started = false;
      return;
    }
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.wert).toFixed(1)} `;
    started = true;
  });
  return (
    <svg className="vp-gw-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d.trim()} fill="none" stroke="#E65100" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Datenladung (Orchestrierung — die reine Ableitung wohnt in gesamtwert.ts)
// ---------------------------------------------------------------------------

/**
 * Holt für den Assistenten den Messwert-Baum, reichert ihn je Kanal um seine
 * Vertrags-Größe (Messkanäle) und seinen zuletzt gemessenen Wert (Tagesverlauf)
 * an, und gibt zusätzlich die Tagesreihen je Kanal für die Vorschau-Kurve
 * zurück. Nur v2-Anlagen (echte Komponenten) tragen Gesamtwerte.
 */
async function ladeQuellen(
  siteId: string,
): Promise<{ quellen: Quellwert[]; reihen: Map<string, KanalPunkt[]> }> {
  const [entities, topology] = await Promise.all([
    api.siteEntities(siteId),
    api.topology(siteId).catch(() => null),
  ]);
  const baum: VerlaufGroup[] = topology ? measurementTree(entities, topology) : [];
  if (baum.length === 0) return { quellen: [], reihen: new Map() };

  const entityIds = [...new Set(baum.map((g) => g.entityId))];

  // Je Komponente: die Messkanäle (Größe) und der Tagesverlauf (Live-Wert).
  const messkanaele = new Map<string, Map<string, Messkanal>>();
  const historie = new Map<string, Awaited<ReturnType<typeof api.entityHistory>> | null>();
  await Promise.all(
    entityIds.map(async (id) => {
      const [mk, hi] = await Promise.all([
        api.komponenteMesskanaele(siteId, id).catch(() => null),
        api.entityHistory(siteId, id, 'day').catch(() => null),
      ]);
      const byKanal = new Map<string, Messkanal>();
      for (const k of mk?.messkanaele ?? []) byKanal.set(k.kanal, k);
      messkanaele.set(id, byKanal);
      historie.set(id, hi);
    }),
  );

  const reihen = new Map<string, KanalPunkt[]>();
  const quellen: Quellwert[] = [];
  for (const g of baum) {
    const mk = messkanaele.get(g.entityId) ?? new Map<string, Messkanal>();
    const hi = historie.get(g.entityId) ?? null;
    for (const it of g.items) {
      const kanal = mk.get(it.channel);
      const buckets = hi?.channels?.[it.channel] ?? [];
      const punkte: KanalPunkt[] = buckets.map((b) => ({ start: b.start, wert: b.last ?? b.avg }));
      reihen.set(`${it.entityId}::${it.channel}`, punkte);
      const letzter = [...buckets].reverse().find((b) => (b.last ?? b.avg) != null);
      quellen.push({
        entityId: it.entityId,
        channel: it.channel,
        name: it.label,
        geraet: g.deviceLine ? g.deviceLine.split(' · ')[0] : null,
        groesse: kanal?.groesse ?? null,
        richtung: kanal?.richtung ?? null,
        einheit: kanal?.einheit ?? it.unit ?? null,
        wertart: kanal?.wertart ?? null,
        vorzeichenNetz: kanal?.direction === 'import_export',
        wert: letzter ? letzter.last ?? letzter.avg : null,
        stand: letzter ? letzter.start : null,
      });
    }
  }
  return { quellen, reihen };
}
