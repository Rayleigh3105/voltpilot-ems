import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  type FunktionFreigabeZeile,
  type Funktionen,
  type FunktionSteuernErgebnis,
  type FunktionSteuernPruefung,
  type Netzanschluss,
  type SiteEntity,
  type StandorteAmStichtag,
} from '../api';
import {
  BETRIEBSMODELLE,
  SPATER,
  STEUERN_SCHRITTE,
  STEUERN_TITEL,
  STEUERN_TITEL_KURZ,
  anlagenDesStandorts,
  browserSpeicher,
  entwurfSpeichern,
  freigabeDarstellung,
  grenzeFehler,
  hatSpeicher,
  komponentenZeilen,
  kw,
  netzanschlussDerAnlage,
  teilnahmeSatz,
  vor,
  waehleVerbraucher,
  zurueck,
  type SteuernSchritt,
} from '../steuernAssistent';
import type { SteuerartWunsch } from '../steuerartDialog';
import type { SiteVerbraucher, VerbraucherEintrag } from '../verbraucherZone';
import { useIsPhone } from '../useIsPhone';
import { AnlegenDialog } from './AnlegenDialog';
import { Recht } from './Recht';
import { SchaltFreigabeDrawer } from './SchaltFreigabeDrawer';
import { SteuerartDialog } from './SteuerartDialog';
import { VpPicker } from './VpPicker';
import './SteuernAssistent.css';

type SteuerartEntwurf = { eintrag: VerbraucherEintrag; wunsch: SteuerartWunsch };

/**
 * Schritte 1–4 des Assistenten „Steuern & Optimieren“ (AP-01 IP-10a).
 *
 * Der Assistent sammelt die Betriebsweise als ENTWURF. Weder eine Steuerart
 * noch ein Betriebsmodell wird hier aktiviert; insbesondere schreibt diese
 * Komponente niemals `/profiles`. Starten gehört ausschließlich IP-10b.
 */
export function SteuernAssistent({
  standortId: vorwahl = null,
  anlageId: anlageVorwahl = null,
  onClose,
}: {
  standortId?: string | null;
  anlageId?: string | null;
  onClose: () => void;
}) {
  const basis = `vp-sta-${useId().replace(/:/g, '')}`;
  const isPhone = useIsPhone();
  const fehlerRef = useRef<HTMLParagraphElement>(null);
  const [standorte, setStandorte] = useState<StandorteAmStichtag | null>(null);
  const [funktionen, setFunktionen] = useState<Funktionen | null>(null);
  const [standortId, setStandortId] = useState<string | null>(vorwahl);
  const [anlageId, setAnlageId] = useState<string | null>(anlageVorwahl);
  const [schritt, setSchritt] = useState<SteuernSchritt>(1);
  const [entities, setEntities] = useState<SiteEntity[]>([]);
  const [verbraucher, setVerbraucher] = useState<SiteVerbraucher | null>(null);
  const [netzanschluesse, setNetzanschluesse] = useState<Netzanschluss[]>([]);
  const [grenze, setGrenze] = useState('');
  const [vereinbartUebergang, setVereinbartUebergang] = useState('');
  const [steuerarten, setSteuerarten] = useState<Record<string, SteuerartEntwurf>>({});
  const [steuerartDialog, setSteuerartDialog] = useState<VerbraucherEintrag | null>(null);
  const [schaltFreigabe, setSchaltFreigabe] = useState<FunktionFreigabeZeile | null>(null);
  const [betriebsmodell, setBetriebsmodell] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pruefung, setPruefung] = useState<FunktionSteuernPruefung | null>(null);
  const [ergebnis, setErgebnis] = useState<FunktionSteuernErgebnis | null>(null);

  useEffect(() => {
    let lebt = true;
    Promise.all([api.standorte(), api.funktionen()]).then(([s, f]) => {
      if (!lebt) return;
      setStandorte(s);
      setFunktionen(f);
      if (!standortId && s.standorte.length === 1) setStandortId(s.standorte[0].id);
    }).catch(() => lebt && setFehler('Die Standorte konnten nicht geladen werden.'));
    return () => { lebt = false; };
  }, []); // Die Startauswahl ist absichtlich eine Momentaufnahme dieser Öffnung.

  const standort = standorte?.standorte.find((s) => s.id === standortId) ?? null;
  const funktion = funktionen?.standorte.find((s) => s.id === standortId) ?? null;
  const anlagen = useMemo(() => anlagenDesStandorts(standort), [standort]);

  useEffect(() => {
    if (!anlageId || !standortId) return;
    let lebt = true;
    setBusy(true);
    setFehler(null);
    Promise.all([
      api.siteEntities(anlageId),
      api.siteVerbraucher(anlageId),
      api.netzanschluesse(standortId),
      api.chargingConfig(anlageId),
    ]).then(([e, v, n, c]) => {
      if (!lebt) return;
      setEntities(e.entities);
      setVerbraucher(v);
      setNetzanschluesse(n.netzanschluesse);
      if (c.gridLimitKw != null) setGrenze(String(c.gridLimitKw));
    }).catch(() => lebt && setFehler('Die Angaben der Anlage konnten nicht geladen werden.')).finally(() => lebt && setBusy(false));
    return () => { lebt = false; };
  }, [anlageId, standortId]);

  useEffect(() => { if (fehler) fehlerRef.current?.focus(); }, [fehler]);

  async function pruefungLaden() {
    if (!anlageId) return;
    setBusy(true);
    setFehler(null);
    try {
      setPruefung(await api.funktionSteuernPruefung(anlageId));
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Prüfliste konnte nicht geladen werden.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (schritt === 2 || schritt === 5) void pruefungLaden(); }, [schritt, anlageId]);

  const zeilen = komponentenZeilen(entities);
  const freigabeIds = new Set(pruefung?.freigaben.komponenten.map((k) => k.entity_id) ?? []);
  const uebrigeZeilen = zeilen.filter((z) => !freigabeIds.has(z.id));
  const anschluss = netzanschlussDerAnlage(netzanschluesse, anlageId ?? '');
  const vereinbart = kw(anschluss?.vereinbart_kw) ?? kw(vereinbartUebergang);
  const grenzeEinwand = !anschluss && (vereinbart == null || vereinbart <= 0)
    ? 'Bitte tragen Sie die vereinbarte Leistung des Netzanschlusses ein.'
    : grenzeFehler(grenze, vereinbart);
  const steuerbare = waehleVerbraucher(verbraucher?.verbraucher ?? []);
  const alleSteuerarten = steuerbare.length === 0 || steuerbare.every((v) => steuerarten[v.entityId]);
  const speicher = hatSpeicher(entities);
  const betriebsweiseVollstaendig = alleSteuerarten && (!speicher || betriebsmodell !== '');

  function waehleStandort(id: string) {
    setStandortId(id);
    setAnlageId(null);
    setFehler(null);
  }

  async function weiter() {
    setFehler(null);
    if (schritt === 1 && !anlageId) return setFehler('Bitte wählen Sie eine Anlage.');
    if (schritt === 1) {
      const t = funktion?.steuern.anlagen.find((a) => a.id === anlageId)?.teilnahme;
      if (!t || t.zustand === 'kein_objekt' || t.zustand === 'archiviert') {
        setBusy(true);
        try {
          await api.funktionSteuern(anlageId!, 'aufnehmen');
        } catch (e) {
          setFehler(e instanceof Error ? e.message : 'Die Anlage konnte nicht aufgenommen werden.');
          return;
        } finally {
          setBusy(false);
        }
      }
    }
    if (schritt === 3) {
      if (grenzeEinwand) return setFehler(grenzeEinwand);
      setBusy(true);
      try {
        await api.saveCustomerChargingFrame(anlageId!, {
          gridLimitKw: kw(grenze)!,
          ...(anschluss ? {} : { vereinbartKw: vereinbart! }),
        });
      } catch (e) {
        setFehler(e instanceof Error ? e.message : 'Die Anschlussgrenze konnte nicht gespeichert werden.');
        return;
      } finally {
        setBusy(false);
      }
    }
    const naechster = vor(schritt);
    if (naechster) setSchritt(naechster);
  }

  async function starten() {
    if (!anlageId || !pruefung?.bereit) return;
    setBusy(true);
    setFehler(null);
    try {
      setErgebnis(await api.funktionSteuern(anlageId, 'starten'));
      setSchritt(6);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Steuerung konnte nicht gestartet werden.');
      await pruefungLaden();
    } finally {
      setBusy(false);
    }
  }

  const fuss = schritt === 4 ? (
    <div className="vp-sta-fuss">
      <Button variant="ghost" onClick={onClose}>{SPATER}</Button>
      <Button onClick={() => {
        if (!standortId || !anlageId) return;
        entwurfSpeichern(browserSpeicher(), {
          standortId,
          anlageId,
          steuerarten: Object.fromEntries(Object.entries(steuerarten).map(([id, e]) => [id, e.wunsch])),
          betriebsmodell: betriebsmodell || null,
        });
        setSchritt(5);
      }} disabled={!betriebsweiseVollstaendig}>Betriebsweise übernehmen</Button>
    </div>
  ) : schritt === 5 ? (
    <div className="vp-sta-fuss">
      <Button variant="ghost" onClick={onClose}>{SPATER}</Button>
      {pruefung?.bereit
        ? <Button onClick={starten} disabled={busy}>Steuerung starten</Button>
        : <Button variant="outline" onClick={pruefungLaden} disabled={busy}>Erneut prüfen</Button>}
    </div>
  ) : schritt === 6 ? (
    <div className="vp-sta-fuss vp-sta-fuss-fertig">
      <Button onClick={onClose}>Fertig</Button>
    </div>
  ) : (
    <div className="vp-sta-fuss">
      <Button variant="ghost" onClick={onClose}>{SPATER}</Button>
      <Button onClick={weiter} disabled={busy || (schritt === 1 && !anlageId) || (schritt === 3 && grenzeEinwand != null)}>
        Weiter
      </Button>
    </div>
  );

  return (
    <>
      {!steuerartDialog && !schaltFreigabe && (
        <AnlegenDialog
          titel={isPhone ? STEUERN_TITEL_KURZ : STEUERN_TITEL}
          schritte={[...STEUERN_SCHRITTE]}
          aktiv={schritt}
          onClose={onClose}
          onBack={zurueck(schritt) ? () => setSchritt(zurueck(schritt)!) : null}
          footer={fuss}
        >
          {fehler && <p className="vp-sta-fehler" role="alert" tabIndex={-1} ref={fehlerRef}>{fehler}</p>}

          {schritt === 1 && (
            <section className="vp-sta-schritt" data-schritt="anlage" aria-labelledby={`${basis}-anlage`}>
              <h3 id={`${basis}-anlage`}>Welche Anlage wird aufgenommen?</h3>
              <p>Steuern &amp; Optimieren gilt für den Standort. Jede Anlage wird einzeln aufgenommen und bleibt bis zum ausdrücklichen Start in Ruhe.</p>
              {standorte && standorte.standorte.length > 1 && (
                <VpPicker label="Standort" value={standortId} onChange={waehleStandort}
                  options={standorte.standorte.map((s) => ({ value: s.id, label: s.name }))} />
              )}
              <div className="vp-sta-auswahl" role="radiogroup" aria-label="Anlage">
                {anlagen.map((a) => {
                  const teilnahme = teilnahmeSatz(funktion, a.id);
                  return (
                    <label key={a.id} className={`${anlageId === a.id ? 'is-gewaehlt' : ''}${teilnahme ? ' is-teilnehmend' : ''}`}>
                      <input type="radio" name={`${basis}-anlage-wahl`} value={a.id} checked={anlageId === a.id}
                        disabled={teilnahme != null}
                        onChange={() => { setAnlageId(a.id); setFehler(null); }} />
                      <span><strong>{a.name}</strong><small>{teilnahme ?? 'Noch nicht aufgenommen'}</small></span>
                    </label>
                  );
                })}
              </div>
              {standort && <p className="vp-sta-hinweis">Standort: {standort.name}</p>}
            </section>
          )}

          {schritt === 2 && (
            <section className="vp-sta-schritt" data-schritt="freigeben">
              <h3>Was darf VoltPilot steuern?</h3>
              <p>Messende Komponenten bleiben unverändert. Steuerbare Komponenten folgen ihren vorhandenen Freigabe-Wegen.</p>
              {pruefung?.freigaben && (
                <div className="vp-sta-freigabe-kopf" aria-live="polite">
                  <strong>{pruefung.freigaben.text}</strong>
                  <span>Selbstbau, OCPP und Wechselrichter werden getrennt geprüft.</span>
                </div>
              )}
              {pruefung?.freigaben && (
                <ul className="vp-sta-freigaben" aria-label="Freigabe-Wege">
                  {pruefung.freigaben.komponenten.map((k) => {
                    const d = freigabeDarstellung(k);
                    return (
                      <li key={k.entity_id} data-weg={k.weg} data-freigegeben={k.freigegeben ? 'ja' : 'nein'}>
                        <span className="vp-sta-pruefmarke" aria-hidden="true">{k.freigegeben ? '✓' : '!'}</span>
                        <div><strong>{d.titel}</strong><span>{d.status}</span><small>{d.hinweis}</small></div>
                        {d.aktion && <Recht standort={standortId} aktion="freigabe.erteilen"><Button
                          variant="outline" onClick={() => setSchaltFreigabe(k)}>{d.aktion}</Button></Recht>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <ul className="vp-sta-komponenten">
                {uebrigeZeilen.map((z) => (
                  <li key={z.id}>
                    <span><strong>{z.name}</strong><small>{z.status}</small></span>
                    {z.weg && <Recht standort={standortId} aktion="freigabe.erteilen"><span className="vp-sta-weg">{z.weg}</span></Recht>}
                  </li>
                ))}
              </ul>
              {zeilen.length === 0 && !busy && <p>Für diese Anlage wurden keine Komponenten gemeldet.</p>}
            </section>
          )}

          {schritt === 3 && (
            <section className="vp-sta-schritt" data-schritt="grenze">
              <h3>Welche Grenze gilt?</h3>
              <p>Die Anschlussgrenze schützt den Netzanschluss. Sie wird gegen die vereinbarte Leistung geprüft.</p>
              <div className="vp-sta-felder">
                <Input label="Anschlussgrenze (kW)" type="number" min={0} step={0.1} value={grenze}
                  onChange={(e) => { setGrenze(e.target.value); setFehler(null); }} />
                {anschluss ? (
                  <div className="vp-sta-fakt"><span>Netzanschluss</span><strong>{anschluss.kennzeichen} · {vereinbart == null ? 'vereinbarte Leistung fehlt' : `${vereinbart.toLocaleString('de-DE')} kW vereinbart`}</strong></div>
                ) : (
                  <Input label="Vereinbarte Leistung (kW)" type="number" min={0} step={0.1} value={vereinbartUebergang}
                    onChange={(e) => { setVereinbartUebergang(e.target.value); setFehler(null); }} />
                )}
                {verbraucher?.ladepunkte.rahmen?.hoechsteHausLastKw != null && (
                  <div className="vp-sta-fakt"><span>Höchste Hauslast der letzten 7 Tage</span><strong>{verbraucher.ladepunkte.rahmen.hoechsteHausLastKw.toLocaleString('de-DE')} kW</strong></div>
                )}
              </div>
              {grenze && <p className={grenzeEinwand ? 'vp-sta-fehler' : 'vp-sta-ok'}>{grenzeEinwand ?? 'Die Grenze liegt innerhalb der vereinbarten Leistung.'}</p>}
            </section>
          )}

          {schritt === 4 && (
            <section className="vp-sta-schritt" data-schritt="betriebsweise">
              <h3>Wie soll gesteuert werden?</h3>
              <p>Diese Auswahl bereitet die Betriebsweise vor. Sie schaltet noch nichts ein.</p>
              <div className="vp-sta-steuerarten">
                <h4>Steuerarten</h4>
                {steuerbare.map((v) => (
                  <div key={v.entityId} className="vp-sta-steuerart">
                    <span><strong>{v.name || v.typLabel}</strong><small>{steuerarten[v.entityId] ? 'Auswahl vorbereitet — noch nicht aktiv' : 'Noch keine Steuerart gewählt'}</small></span>
                    <Recht standort={standortId} aktion="betriebsweise.aendern"><Button variant="outline" onClick={() => setSteuerartDialog(v)}>{steuerarten[v.entityId] ? 'Ändern' : 'Steuerart wählen'}</Button></Recht>
                  </div>
                ))}
                {steuerbare.length === 0 && <p>Keine steuerbare Komponente mit wählbarer Steuerart.</p>}
              </div>
              {speicher ? (
                <fieldset className="vp-sta-modelle">
                  <legend>Betriebsmodell des Speichers</legend>
                  {BETRIEBSMODELLE.map((m) => (
                    <label key={m.id} className={betriebsmodell === m.id ? 'is-gewaehlt' : ''}>
                      <input type="radio" name={`${basis}-modell`} value={m.id} checked={betriebsmodell === m.id}
                        onChange={() => setBetriebsmodell(m.id)} />
                      <span><strong>{m.label}</strong><small>{m.text}</small></span>
                    </label>
                  ))}
                </fieldset>
              ) : <p className="vp-sta-hinweis">Kein Speicher — kein Betriebsmodell nötig.</p>}
              <p className="vp-sta-ruhe">Steuerung bleibt in Ruhe. Starten folgt erst nach der Prüfung in Schritt 6.</p>
            </section>
          )}

          {schritt === 5 && (
            <section className="vp-sta-schritt" data-schritt="pruefen" aria-labelledby={`${basis}-pruefen`}>
              <h3 id={`${basis}-pruefen`}>Ist der Start sicher?</h3>
              <p>Die Prüfliste wird aus den aktuellen Fakten der Anlage gebildet.</p>
              {pruefung && (
                <ul className="vp-sta-pruefliste" aria-label="Prüfliste">
                  {pruefung.zeilen.map((z) => (
                    <li key={z.pruefung} data-bestanden={z.bestanden === null ? 'offen' : z.bestanden ? 'ja' : 'nein'}>
                      <span className="vp-sta-pruefmarke" aria-hidden="true">{z.bestanden ? '✓' : z.bestanden === null ? '–' : '!'}</span>
                      <div><strong>{z.fakt}</strong>{z.grund && <span>{z.grund}</span>}{z.weg && <small>{z.weg}</small>}</div>
                    </li>
                  ))}
                </ul>
              )}
              {pruefung?.bereit && <aside className="vp-sta-folgen"><strong>Das passiert nach dem Start</strong><p>{pruefung.folgen}</p></aside>}
              {!busy && !pruefung && !fehler && <p>Die Prüfliste ist noch nicht verfügbar.</p>}
            </section>
          )}

          {schritt === 6 && (
            <section className="vp-sta-schritt vp-sta-fertig" data-schritt="starten" aria-labelledby={`${basis}-starten`}>
              <h3 id={`${basis}-starten`}>Steuerung ist gestartet</h3>
              <p>Der nächste Fahrplan berücksichtigt die vorbereitete Betriebsweise. Ob die Box bereits ausführt, sehen Sie getrennt am Anlagenstatus.</p>
              <div className="vp-sta-anlagenzeile">
                <span><strong>{pruefung?.anlage ?? 'Anlage'}</strong><small>{pruefung?.standort}</small></span>
                <strong>{ergebnis?.aktion === 'starten' ? 'Gestartet' : 'Start bestätigt'}</strong>
              </div>
            </section>
          )}
        </AnlegenDialog>
      )}

      {steuerartDialog && (
        <SteuerartDialog
          eintrag={steuerartDialog}
          standard={verbraucher?.ladepunkte.standard ?? null}
          onClose={() => setSteuerartDialog(null)}
          onSpeichern={(wunsch) => {
            // Nur Entwurf: kein PUT und damit keine aktive Steuerart vor Schritt 6.
            setSteuerarten((alt) => ({ ...alt, [steuerartDialog.entityId]: { eintrag: steuerartDialog, wunsch } }));
            setSteuerartDialog(null);
          }}
        />
      )}

      {schaltFreigabe && anlageId && (
        <SchaltFreigabeDrawer
          open
          siteId={anlageId}
          entityId={schaltFreigabe.entity_id}
          komponentenName={schaltFreigabe.name}
          bereitsFreigegeben={schaltFreigabe.freigegeben}
          onClose={() => setSchaltFreigabe(null)}
          onChanged={() => {
            setSchaltFreigabe(null);
            void Promise.all([
              api.siteEntities(anlageId),
              api.siteVerbraucher(anlageId),
              api.funktionSteuernPruefung(anlageId),
            ]).then(([e, v, p]) => {
              setEntities(e.entities);
              setVerbraucher(v);
              setPruefung(p);
            }).catch(() => setFehler('Der neue Freigabe-Stand konnte nicht geladen werden.'));
          }}
        />
      )}
    </>
  );
}
