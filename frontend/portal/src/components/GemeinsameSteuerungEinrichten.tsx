import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  api,
  ApiError,
  type Device,
  type UemsDatenquelle,
  type UemsGemeinsameSteuerungEinrichten,
  type UemsGemeinsameSteuerungZustand,
  type UemsSteuerRichtung,
} from '../api';
import {
  anteilVon,
  befundSaetze,
  boxNamen,
  entwurfAus,
  entwurfLuecken,
  ergebnisHinweise,
  koerper,
  kw,
  lage,
  lueckenAusAntwort,
  positiveZahl,
  pufferSatz,
  urteilSatz,
  zustandsZeile,
  type Entwurf,
  type EntwurfLuecke,
} from '../gemeinsameSteuerungFlaeche';
import { hashForRoute, standortBereichRoute } from '../nav';
import { FLAECHE } from '../uemsGemeinsameSteuerung';
import { VpPicker } from './VpPicker';

const FRAGEN = [
  'Welche Boxen steuern mit?',
  'Welche Box misst am Netzanschluss?',
  'Grenzen am Netzanschluss',
  'Was erzeugt oder verbraucht hinter dem Anschluss, ohne dass eine Box es steuert?',
  'Zähler, Geräte und Signal je Box',
  'Ergebnis',
] as const;

const RICHTUNG: Record<UemsSteuerRichtung, string> = { einspeisung: 'Einspeisung', bezug: 'Bezug' };
const SIGNAL = [
  { value: 'ja', label: 'Ja' },
  { value: 'nein', label: 'Nein' },
  { value: 'unbekannt', label: 'Weiß ich nicht' },
];
const KEIN_ZAEHLER = '__kein__';

/**
 * Einrichten in sechs Fragen (UEMS AP-15 IP-23, §5.2) — dieselbe Folge zum Ändern, vorbelegt. Nach Frage 5 rechnet
 * `POST …/einrichten/vorschau` das Ergebnis des ENTWURFS (Frage 6; schreibt nichts, dieselben 422-Lücken wie das PUT).
 * Erst „Absenden“ (§5.2 Nr. 7) schreibt mit `PUT …/gemeinsame-steuerung` — Zustand „eingerichtet · wird geprüft“, an
 * den Boxen ändert sich nichts.
 */
export function GemeinsameSteuerungEinrichten({
  siteId,
  siteDevices,
  zustand: zustandVorher,
  standortId,
  onClose,
}: {
  siteId: string;
  siteDevices: readonly Device[];
  zustand: UemsGemeinsameSteuerungZustand | null;
  standortId: string | null;
  onClose: () => void;
}) {
  const [vorschlag, setVorschlag] = useState<UemsGemeinsameSteuerungEinrichten | null>(null);
  const [quellen, setQuellen] = useState<UemsDatenquelle[]>([]);
  const [entwurf, setEntwurf] = useState<Entwurf | null>(null);
  const [frage, setFrage] = useState(1);
  const [luecken, setLuecken] = useState<EntwurfLuecke[]>([]);
  const [geprueft, setGeprueft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  /** Frage 6: das Ergebnis des Entwurfs aus der Vorschau (nichts gespeichert). */
  const [ergebnis, setErgebnis] = useState<{ einrichten: UemsGemeinsameSteuerungEinrichten; zustand: UemsGemeinsameSteuerungZustand } | null>(null);
  /** Nach „Absenden“: der gespeicherte Zustand. */
  const [nachher, setNachher] = useState<UemsGemeinsameSteuerungZustand | null>(null);
  const [rueckfall, setRueckfall] = useState<Record<string, string>>({});
  const kopf = useRef<HTMLParagraphElement>(null);
  const aendern = lage(zustandVorher) !== 'nicht_eingerichtet';

  useEffect(() => {
    let aus = false;
    Promise.all([api.gemeinsameSteuerungEinrichten(siteId), api.datenquellen(siteId).catch(() => ({ datenquellen: [] }))]).then(
      ([e, q]) => {
        if (aus) return;
        setVorschlag(e);
        setQuellen(q.datenquellen.filter((x) => !x.archiviert_am));
        setEntwurf(entwurfAus(e, zustandVorher));
      },
      () => { if (!aus) setFehler('Der Vorschlag konnte nicht geladen werden. Bitte versuchen Sie es erneut.'); },
    );
    return () => { aus = true; };
  }, [siteId, zustandVorher]);

  useEffect(() => { kopf.current?.focus(); }, [frage, nachher]);

  const namen = boxNamen(siteDevices, vorschlag);
  const mit = entwurf?.boxen.filter((b) => b.mit) ?? [];
  const alleLuecken = entwurf ? [...entwurfLuecken(entwurf), ...luecken] : [];
  const lueckenDerFrage = (n: number) => (geprueft ? alleLuecken.filter((l) => l.frage === n) : luecken.filter((l) => l.frage === n));
  const lueckeBei = (p: (l: EntwurfLuecke) => boolean) => lueckenDerFrage(5).concat(lueckenDerFrage(4), lueckenDerFrage(2)).find(p)?.text;
  const quellenDerBox = (boxId: string) => quellen.filter((q) => q.zustaendige_box?.id === boxId);

  function setzen(f: (e: Entwurf) => Entwurf) {
    setEntwurf((e) => (e ? f(e) : e));
    setLuecken([]);
  }
  function box(boxId: string, f: (b: Entwurf['boxen'][number]) => Entwurf['boxen'][number]) {
    setzen((e) => ({ ...e, boxen: e.boxen.map((b) => (b.boxId === boxId ? f(b) : b)) }));
  }

  function weiter() {
    if (!entwurf) return;
    const offen = entwurfLuecken(entwurf).filter((l) => l.frage === frage);
    if (offen.length > 0) { setGeprueft(true); return; }
    setGeprueft(false);
    if (frage === 5) { void vorschau(); return; }
    setFrage((n) => n + 1);
  }

  /** Die Lücken des ganzen Entwurfs: zur ersten Frage mit einer. */
  function ohneLuecken(e: Entwurf): boolean {
    const offen = entwurfLuecken(e);
    if (offen.length === 0) return true;
    setGeprueft(true);
    setFrage(Math.min(...offen.map((l) => l.frage)));
    return false;
  }

  /** 422 · 409 des Servers an ihre Stelle (Vorschau und PUT antworten gleich). */
  function abgelehnt(err: unknown) {
    const body = err instanceof ApiError ? (err.body as { code?: string; message?: string } | undefined) : undefined;
    const l = lueckenAusAntwort(body);
    if (l.length > 0) {
      setLuecken(l);
      setFrage(Math.min(...l.map((x) => x.frage)));
    } else if (body?.code === 'erst_anhalten') {
      setFehler(FLAECHE.erst_anhalten);
    } else {
      setFehler(body?.message ?? 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.');
    }
  }

  /** Frage 6: das Ergebnis des Entwurfs — geschrieben wird nichts. */
  async function vorschau() {
    if (!entwurf || busy || !ohneLuecken(entwurf)) return;
    setBusy(true);
    setFehler(null);
    try {
      setErgebnis(await api.gemeinsameSteuerungVorschau(siteId, koerper(entwurf)));
      setFrage(6);
    } catch (err) {
      abgelehnt(err);
    } finally {
      setBusy(false);
    }
  }

  /** §5.2 Nr. 7: erst jetzt wird geschrieben. */
  async function absenden() {
    if (!entwurf || busy || !ohneLuecken(entwurf)) return;
    setBusy(true);
    setFehler(null);
    try {
      setNachher(await api.gemeinsameSteuerungSetzen(siteId, koerper(entwurf)));
    } catch (err) {
      abgelehnt(err);
    } finally {
      setBusy(false);
    }
  }

  async function rueckfallHinterlegen(komponenteId: string, richtung: UemsSteuerRichtung) {
    const wert = positiveZahl(rueckfall[komponenteId] ?? '') ?? ((rueckfall[komponenteId] ?? '').trim() === '0' ? 0 : null);
    if (wert == null || busy) return;
    setBusy(true);
    setFehler(null);
    try {
      await api.gemeinsameSteuerungRueckfall(siteId, komponenteId, { richtung, rueckfall: 'faellt_auf_wert', rueckfall_kw: wert });
      // der Rückfall ist eine Tatsache am Gerät (gespeichert); das Ergebnis bleibt ein Entwurf und wird neu gerechnet
      if (entwurf) setErgebnis(await api.gemeinsameSteuerungVorschau(siteId, koerper(entwurf)));
    } catch (err) {
      setFehler(err instanceof ApiError && err.message ? err.message : 'Der Rückfallwert konnte nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  }

  const bild = nachher == null ? ergebnis : null;
  const hinweise = bild && frage === 6 ? ergebnisHinweise(bild.einrichten, bild.zustand, namen) : [];
  const netzWeg = standortId ? hashForRoute(standortBereichRoute(standortId, 'netzanschluesse')) : null;
  const boxWeg = standortId ? hashForRoute(standortBereichRoute(standortId, 'boxen')) : null;
  const titel = aendern ? 'Gemeinsame Steuerung ändern' : 'Gemeinsame Steuerung einrichten';

  const fuss = nachher != null
    ? <Button onClick={onClose}>Fertig</Button>
    : <>
      <Button variant="ghost" disabled={busy} onClick={frage === 1 ? onClose : () => { setGeprueft(false); setFrage((n) => n - 1); }}>
        {frage === 1 ? 'Abbrechen' : 'Zurück'}
      </Button>
      {entwurf && (frage < 6
        ? <Button disabled={busy} onClick={weiter}>{busy ? 'Wird gerechnet …' : 'Weiter'}</Button>
        : <Button disabled={busy || ergebnis == null} onClick={() => void absenden()}>{busy ? 'Wird gespeichert …' : 'Absenden'}</Button>)}
    </>;

  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title={titel} footer={fuss}>
      <div className="vp-gs-folge" data-testid="gs-folge">
        <p ref={kopf} tabIndex={-1} className="vp-gs-frage-nr">{nachher != null ? 'Abgesendet' : `Frage ${frage} von 6 · ${FRAGEN[frage - 1]}`}</p>
        {fehler && <p className="vp-gs-fehler" role="alert">{fehler}</p>}
        {!entwurf && !fehler && <p role="status">Der Vorschlag wird geladen …</p>}

        {entwurf && vorschlag && frage === 1 && (
          <fieldset className="vp-gs-feld">
            <legend>{FRAGEN[0]}</legend>
            <p className="vp-gs-klein">Vorgeschlagen ist jede Box, hinter der ein steuerbares Gerät antwortet.</p>
            {vorschlag.boxen.map((b) => {
              const e = entwurf.boxen.find((x) => x.boxId === b.box_id)!;
              const liest = b.komponenten.map((k) => k.name ?? k.typ).join(' · ');
              return (
                <label key={b.box_id} className="vp-gs-wahl">
                  <input type="checkbox" checked={e.mit} onChange={(ev) => box(b.box_id, (x) => ({ ...x, mit: ev.target.checked }))} />
                  <span><b>Box {e.name}</b><small>{liest ? `liest: ${liest}` : 'liest noch nichts'}</small></span>
                </label>
              );
            })}
            {lueckenDerFrage(1).map((l) => <p key={l.text} className="vp-gs-luecke" role="alert">{l.text}</p>)}
          </fieldset>
        )}

        {entwurf && vorschlag && frage === 2 && (
          <fieldset className="vp-gs-feld">
            <legend>{FRAGEN[1]}</legend>
            {vorschlag.netzzaehler_box_id == null && (
              <p className="vp-gs-hinweis" role="note">
                {FLAECHE.netzzaehler_fehlt} {boxWeg && <a className="vp-gs-weg" href={boxWeg}>Datenquelle an einer Box anlegen</a>}
              </p>
            )}
            <VpPicker
              label="Box am Netzanschluss"
              value={entwurf.fuehrt}
              onChange={(v) => setzen((e) => ({ ...e, fuehrt: v }))}
              options={mit.map((b) => ({
                value: b.boxId,
                label: `Box ${b.name}`,
                sub: b.boxId === vorschlag.netzzaehler_box_id ? 'liest heute den Netzzähler' : undefined,
              }))}
            />
            {entwurf.fuehrt && (
              <VpPicker
                label="Datenquelle des Netzzählers"
                value={mit.find((b) => b.boxId === entwurf.fuehrt)?.messpunkt ?? null}
                onChange={(v) => box(entwurf.fuehrt!, (x) => ({ ...x, messpunkt: v }))}
                options={quellenDerBox(entwurf.fuehrt).map((q) => ({ value: q.id, label: `${q.kennzeichen}${q.name ? ` · ${q.name}` : ''}` }))}
                error={lueckeBei((l) => l.frage === 2 && l.boxId === entwurf.fuehrt)}
                emptyText={() => 'Diese Box liest noch keine Datenquelle.'}
              />
            )}
            {lueckenDerFrage(2).filter((l) => !l.boxId).map((l) => <p key={l.text} className="vp-gs-luecke" role="alert">{l.text}</p>)}
          </fieldset>
        )}

        {entwurf && vorschlag && frage === 3 && (
          <section className="vp-gs-feld" aria-label={FRAGEN[2]}>
            {vorschlag.grenzen?.einspeisung_kw == null && vorschlag.grenzen?.bezug_kw == null ? (
              <p className="vp-gs-hinweis" role="note">
                {FLAECHE.netzanschluss_fehlt} {netzWeg && <a className="vp-gs-weg" href={netzWeg}>Netzanschluss eintragen</a>}
              </p>
            ) : (
              <>
                <dl className="vp-gs-grenzen">
                  <div><dt>Einspeisung höchstens</dt><dd>{vorschlag.grenzen?.einspeisung_kw == null ? 'nicht eingetragen' : `${kw(vorschlag.grenzen.einspeisung_kw)} kW`}</dd></div>
                  <div><dt>Bezug höchstens</dt><dd>{vorschlag.grenzen?.bezug_kw == null ? 'nicht eingetragen' : `${kw(vorschlag.grenzen.bezug_kw)} kW`}</dd></div>
                </dl>
                <p className="vp-gs-klein">
                  Diese Grenzen gelten heute am Netzanschluss. {netzWeg && <a className="vp-gs-weg" href={netzWeg}>Am Netzanschluss ändern</a>}
                </p>
              </>
            )}
          </section>
        )}

        {entwurf && vorschlag && frage === 4 && (
          <fieldset className="vp-gs-feld">
            <legend>Erzeuger, die keine Box steuert</legend>
            <VpPicker
              label="Gibt es solche Erzeuger?"
              value={entwurf.erzeugerArt}
              onChange={(v) => setzen((e) => ({ ...e, erzeugerArt: v as 'keine' | 'liste', erzeuger: v === 'liste' && e.erzeuger.length === 0 ? [{ bezeichnung: '', nenn: '' }] : e.erzeuger }))}
              options={[{ value: 'keine', label: 'Keine' }, { value: 'liste', label: 'Ja — diese:' }]}
              error={lueckenDerFrage(4).find((l) => l.erzeuger == null && l.text.startsWith('Bitte „Keine“'))?.text}
            />
            {entwurf.erzeugerArt === 'liste' && entwurf.erzeuger.map((x, i) => (
              <div key={i} className="vp-gs-reihe">
                <Input label="Bezeichnung" value={x.bezeichnung}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) => setzen((e) => ({ ...e, erzeuger: e.erzeuger.map((y, j) => (j === i ? { ...y, bezeichnung: ev.target.value } : y)) }))} />
                <Input label="Nennleistung (kW)" inputMode="decimal" value={x.nenn}
                  error={lueckenDerFrage(4).find((l) => l.erzeuger === i)?.text}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) => setzen((e) => ({ ...e, erzeuger: e.erzeuger.map((y, j) => (j === i ? { ...y, nenn: ev.target.value } : y)) }))} />
              </div>
            ))}
            {entwurf.erzeugerArt === 'liste' && (
              <Button variant="ghost" onClick={() => setzen((e) => ({ ...e, erzeuger: [...e.erzeuger, { bezeichnung: '', nenn: '' }] }))}>Weiteren Erzeuger eintragen</Button>
            )}
            <Input
              label="Verbrauch, den keine Box steuert — höchstens (kW)"
              inputMode="decimal"
              value={entwurf.vorbehaltBezug}
              hint={vorschlag.vorbehalt?.aus_messwerten
                ? `Vorschlag aus den Messwerten: ${kw(vorschlag.vorbehalt.aus_messwerten.kw)} kW (höchster Viertelstundenwert ${kw(vorschlag.vorbehalt.aus_messwerten.hoechstwert_kw)} kW mit Zuschlag, ${vorschlag.vorbehalt.aus_messwerten.messtage} Messtage). ${FLAECHE.vorschlag_ohne_abgang}`
                : 'Noch kein Vorschlag aus Messwerten — bitte den höchsten Wert eintragen.'}
              error={lueckenDerFrage(4).find((l) => l.text.startsWith('Bitte den Wert'))?.text}
              onChange={(ev: ChangeEvent<HTMLInputElement>) => setzen((e) => ({ ...e, vorbehaltBezug: ev.target.value }))}
            />
          </fieldset>
        )}

        {entwurf && vorschlag && frage === 5 && mit.map((b) => (
          <fieldset key={b.boxId} className="vp-gs-feld" data-testid="gs-box-frage">
            <legend>Box {b.name}{b.boxId === entwurf.fuehrt ? ' · am Netzanschluss' : ''}</legend>
            {b.boxId !== entwurf.fuehrt && (
              <VpPicker
                label="Zähler dieser Box"
                hint="Ein Abgangszähler, hinter dem alles liegt, was diese Box steuert."
                value={b.messpunkt ?? KEIN_ZAEHLER}
                onChange={(v) => box(b.boxId, (x) => ({ ...x, messpunkt: v === KEIN_ZAEHLER ? null : v }))}
                options={[
                  ...quellenDerBox(b.boxId).map((q) => ({ value: q.id, label: `${q.kennzeichen}${q.name ? ` · ${q.name}` : ''}` })),
                  { value: KEIN_ZAEHLER, label: 'kein eigener Zähler', sub: 'dann zählen ihre Geräte' },
                ]}
              />
            )}
            {b.boxId !== entwurf.fuehrt && b.messpunkt != null && (
              <Input
                label={FLAECHE.ungeregelt_label}
                inputMode="decimal"
                value={b.ungeregeltBezug}
                hint={FLAECHE.ungeregelt_hinweis}
                error={lueckeBei((l) => l.frage === 5 && l.boxId === b.boxId && l.ungeregelt === true)}
                onChange={(ev: ChangeEvent<HTMLInputElement>) => box(b.boxId, (x) => ({ ...x, ungeregeltBezug: ev.target.value }))}
              />
            )}
            <p className="vp-gs-klein">Geräte, die diese Box steuern darf — bitte vollständig:</p>
            {b.geraete.length === 0 && <p className="vp-gs-klein">Diese Box steuert kein Gerät.</p>}
            {b.geraete.map((g) => (
              <div key={`${g.komponenteId}|${g.richtung}`} className="vp-gs-geraet" data-testid="gs-geraet">
                <Input
                  label={`${g.name} · ${RICHTUNG[g.richtung]} — Nennleistung (kW)`}
                  inputMode="decimal"
                  value={g.nenn}
                  error={lueckeBei((l) => l.frage === 5 && l.komponenteId === g.komponenteId && (l.richtung == null || l.richtung === g.richtung))}
                  onChange={(ev: ChangeEvent<HTMLInputElement>) => box(b.boxId, (x) => ({
                    ...x,
                    geraete: x.geraete.map((y) => (y.komponenteId === g.komponenteId && y.richtung === g.richtung ? { ...y, nenn: ev.target.value } : y)),
                  }))}
                />
              </div>
            ))}
            {lueckenDerFrage(5).filter((l) => l.boxId === b.boxId && !l.komponenteId && !l.ungeregelt).map((l) => <p key={l.text} className="vp-gs-luecke" role="alert">{l.text}</p>)}
            {lueckenDerFrage(5).filter((l) => l.boxId === b.boxId && l.komponenteId && !b.geraete.some((g) => g.komponenteId === l.komponenteId)).map((l) => (
              <p key={`${l.komponenteId}`} className="vp-gs-luecke" role="alert">{l.text}</p>
            ))}
            <VpPicker
              label="Bekommt diese Box das Signal des Netzbetreibers?"
              value={b.signal}
              onChange={(v) => box(b.boxId, (x) => ({ ...x, signal: v as 'ja' | 'nein' | 'unbekannt' }))}
              options={SIGNAL}
            />
          </fieldset>
        ))}

        {nachher != null && vorschlag && (
          <section className="vp-gs-feld" aria-label="Abgesendet" data-testid="gs-abgesendet">
            <p className="vp-gs-zeile" role="status" data-testid="gs-ergebnis-zustand">{zustandsZeile(nachher, vorschlag, namen)}</p>
            <p>{FLAECHE.abgesendet}</p>
            {befundSaetze(nachher, namen).map((b) => <p key={b.text} className="vp-gs-hinweis" data-testid="gs-befund">{b.text}</p>)}
          </section>
        )}

        {bild && frage === 6 && (
          <section className="vp-gs-feld" aria-label="Ergebnis" data-testid="gs-ergebnis">
            <p className="vp-gs-zeile" role="status" data-testid="gs-ergebnis-entwurf">{FLAECHE.ergebnis_entwurf}</p>
            {(['einspeisung', 'bezug'] as const).map((r) => {
              const a = bild.einrichten.ergebnis?.[r] ?? null;
              return (
                <div key={r} className="vp-gs-richtung" data-testid={`gs-richtung-${r}`}>
                  <h3>{RICHTUNG[r]}{a ? ` · Grenze ${kw(a.grenze_kw)} kW` : ''}</h3>
                  {a && (
                    <ul>
                      {bild.einrichten.boxen.filter((b) => b.rolle != null).map((b) => (
                        <li key={b.box_id}>Box {namen.get(b.box_id) ?? b.name}: {kw(anteilVon(bild.einrichten.ergebnis ?? null, r, b.box_id) ?? 0)} kW</li>
                      ))}
                    </ul>
                  )}
                  <p><b>Passt die Anlage zur Grenze?</b> {urteilSatz(a)}</p>
                  {pufferSatz(bild.einrichten, r) && <p data-testid={`gs-puffer-${r}`}>{pufferSatz(bild.einrichten, r)}</p>}
                </div>
              );
            })}
            {hinweise.map((h) => (
              <div key={h.text} className="vp-gs-hinweis" data-testid="gs-hinweis">
                <p>{h.text}</p>
                {h.rueckfall && (
                  <div className="vp-gs-reihe">
                    <Input label="Sicherer Rückfallwert (kW)" inputMode="decimal" value={rueckfall[h.rueckfall.komponenteId] ?? ''}
                      onChange={(ev: ChangeEvent<HTMLInputElement>) => setRueckfall((r) => ({ ...r, [h.rueckfall!.komponenteId]: ev.target.value }))} />
                    <Button variant="outline" disabled={busy} onClick={() => void rueckfallHinterlegen(h.rueckfall!.komponenteId, h.rueckfall!.richtung)}>Am Gerät hinterlegen</Button>
                  </div>
                )}
              </div>
            ))}
            {befundSaetze(bild.zustand, namen).filter((b) => !hinweise.some((h) => h.text === b.text))
              .map((b) => <p key={b.text} className="vp-gs-hinweis" data-testid="gs-befund">{b.text}</p>)}
          </section>
        )}
      </div>
    </Modal>
  );
}
