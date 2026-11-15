/**
 * Die Seite EINER Logik (Steuerlogik Stufe 4, Bericht 6, 12.3, 13, 17.7): zwei Ansichten desselben Textes - Aufbau
 * (Formulare) und Text (YAML mit Meldungen an der Zeile) -, dazu Mitlaufen, Fassungen und Protokoll.
 *
 * Der Text ist die EINE Quelle: der Aufbau schreibt in ihn, der Text liest aus ihm (Bericht 6.6). Ein ungespeicherter
 * Entwurf liegt im Browser; „Prüfen“ fragt den Logik-Dienst mit denselben Regeln wie die Box, gespeichert wird nur,
 * was die Prüfung nicht sperrt. Wer die Logik nicht bearbeiten darf, sieht sie und fragt eine Änderung an. Scharf
 * schaltet in Stufe 4 die Plattform; der Kunde legt eine Fassung dafür vor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  type LogikAnsicht,
  type LogikGeprueft,
  type LogikMeldung,
  type LogikQuellen,
  type Site,
  type SteuerlogikVorschau,
} from '../../api';
import { api } from '../../apiVoll';
import { logikHash, parseLogik, type AnlagenSub, type LogikAnsichtId } from '../../nav';
import { replaceCurrentNavigation } from '../../navigationBlocker';
import { LIST_POLL_MS } from '../../pollCadence';
import { Blatt } from '../Blatt';
import { Ic } from '../Ic';
import { AufbauAnsicht } from './AufbauAnsicht';
import type { CodeEditorGriff } from './Code';
import { FassungenAnsicht } from './FassungenAnsicht';
import { AuswahlFeld, TextFeld } from './Felder';
import { MitlaufenAnsicht } from './MitlaufenAnsicht';
import { ProtokollAnsicht } from './ProtokollAnsicht';
import {
  aktiveFassung,
  ansichtPille,
  ladeEntwurf,
  merkeEntwurf,
  naechsterSchritt,
  vergissEntwurf,
  type Handlung,
} from './seite';
import { TextAnsicht } from './TextAnsicht';
import { lies } from './text';
import { startText } from './vorlage';
import '../steuerung.css';
import './logik.css';

const ANSICHTEN: { id: LogikAnsichtId; label: string }[] = [
  { id: 'aufbau', label: 'Aufbau' },
  { id: 'text', label: 'Text' },
  { id: 'mitlaufen', label: 'Mitlaufen' },
  { id: 'fassungen', label: 'Fassungen' },
  { id: 'protokoll', label: 'Protokoll' },
];

const PRUEF_WARTE_MS = 700;

/** Der Satz einer Ablehnung der API; ohne Satz ein allgemeiner. */
function grund(e: unknown, sonst: string): string {
  if (e instanceof ApiError && e.body && typeof e.body === 'object' && typeof (e.body as { message?: unknown }).message === 'string') {
    return (e.body as { message: string }).message;
  }
  return e instanceof Error && e.message ? e.message : sonst;
}

function meldungenDerAblehnung(e: unknown): LogikMeldung[] {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== 'object') return [];
  const m = (e.body as { meldungen?: unknown }).meldungen;
  return Array.isArray(m) ? (m as LogikMeldung[]) : [];
}

export interface LogikSeiteProps {
  site: Site;
  onOpenSub: (sub: AnlagenSub) => void;
}

export function LogikSeite({ site, onOpenSub }: LogikSeiteProps) {
  const [adresse, setAdresse] = useState(() => parseLogik(window.location.hash));
  useEffect(() => {
    const neu = () => setAdresse(parseLogik(window.location.hash));
    window.addEventListener('hashchange', neu);
    return () => window.removeEventListener('hashchange', neu);
  }, []);
  const logikId = adresse.id;
  const neueLogik = logikId === 'neu';

  const [ansicht, setAnsicht] = useState<LogikAnsicht | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [quellen, setQuellen] = useState<LogikQuellen | null>(null);
  const [basis, setBasis] = useState<{ fassung: number; text: string } | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [geprueft, setGeprueft] = useState<{ text: string; g: LogikGeprueft } | null>(null);
  const [pruefend, setPruefend] = useState(false);
  const [blatt, setBlatt] = useState<null | { art: 'speichern' } | { art: 'verwerfen' } | { art: 'anfrage'; kennung: string | null }
    | { art: 'anfragen' } | { art: 'zurueck'; fassung: number } | { art: 'stilllegen' } | { art: 'scharf'; fassung: number }>(null);
  const [meldung, setMeldung] = useState<{ text: string; fehler?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const textRef = useRef<CodeEditorGriff>(null);
  const [zielZeile, setZielZeile] = useState<number | null>(null);

  const darf = neueLogik ? true : !!ansicht?.darfBearbeiten;
  // Eine Rückmeldung steht so lange wie in der Steuerung, eine Ablehnung bis man sie antippt.
  useEffect(() => {
    if (!meldung || meldung.fehler) return;
    const t = window.setTimeout(() => setMeldung(null), 4200);
    return () => window.clearTimeout(t);
  }, [meldung]);

  const lade = useCallback(async (behalteEntwurf = true) => {
    if (!logikId || neueLogik) return;
    try {
      const a = await api.logikAnsicht(site.id, logikId);
      setAnsicht(a);
      const neueste = a.fassungen[0];
      if (!neueste) return;
      const t = await api.logikText(site.id, logikId, neueste.fassung);
      setBasis({ fassung: neueste.fassung, text: t.text });
      const e = behalteEntwurf ? ladeEntwurf(site.id, logikId) : null;
      setText(e && e.basis === neueste.fassung ? e.text : t.text);
      setLadeFehler(null);
    } catch (e) {
      setLadeFehler(grund(e, 'Die Logik ließ sich nicht laden.'));
    }
  }, [site.id, logikId, neueLogik]);

  useEffect(() => {
    setAnsicht(null);
    setBasis(null);
    setText(null);
    setGeprueft(null);
    if (neueLogik) {
      const e = ladeEntwurf(site.id, 'neu');
      setText(e ? e.text : null);
      return;
    }
    void lade();
  }, [lade, neueLogik, site.id]);

  useEffect(() => {
    let gilt = true;
    api.logikQuellen(site.id).then((q) => { if (gilt) setQuellen(q); }, () => {});
    return () => { gilt = false; };
  }, [site.id]);

  // Mitlaufen: was die Box meldet, kommt mit dem Herzschlag - die Ansicht holt es nach.
  useEffect(() => {
    if (adresse.ansicht !== 'mitlaufen' || neueLogik) return;
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void lade(); }, LIST_POLL_MS);
    return () => window.clearInterval(t);
  }, [adresse.ansicht, lade, neueLogik]);

  const veraendert = text != null && (neueLogik || (basis != null && text !== basis.text));

  // Der Entwurf überlebt einen Wechsel der Seite und ein Neuladen (nur in diesem Browser).
  useEffect(() => {
    if (!logikId || text == null) return;
    if (veraendert) merkeEntwurf(site.id, logikId, { basis: basis?.fassung ?? 0, text });
    else vergissEntwurf(site.id, logikId);
  }, [site.id, logikId, text, veraendert, basis]);

  // Prüfen beim Schreiben: kurz nach der letzten Änderung, mit denselben Regeln wie Dienst und Box.
  useEffect(() => {
    if (!darf || text == null || !veraendert) return;
    if (geprueft?.text === text) return;
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      setPruefend(true);
      api.logikPruefen(site.id, text, ac.signal).then(
        (g) => setGeprueft({ text, g }),
        (e) => { if (!ac.signal.aborted) setGeprueft({ text, g: { lesbar: false, sperrt: true, message: grund(e, 'Die Prüfung ist gerade nicht erreichbar.'), bericht: null, meldungen: [] } }); },
      ).finally(() => { if (!ac.signal.aborted) setPruefend(false); });
    }, PRUEF_WARTE_MS);
    return () => { window.clearTimeout(t); ac.abort(); };
  }, [darf, text, veraendert, site.id, geprueft?.text]);

  const meldungen: LogikMeldung[] = useMemo(() => {
    if (veraendert) return geprueft ? geprueft.g.meldungen ?? geprueft.g.bericht?.meldungen ?? [] : [];
    return ansicht?.fassungen[0]?.bericht?.meldungen ?? [];
  }, [veraendert, geprueft, ansicht]);

  const zeige = (a: LogikAnsichtId) => {
    if (!logikId) return;
    const h = logikHash(site.id, logikId, a);
    replaceCurrentNavigation(h);
    window.history.replaceState(null, '', h);
    setAdresse({ id: logikId, ansicht: a });
  };

  const zuText = (zeile: number) => {
    zeige('text');
    setZielZeile(zeile);
  };
  useEffect(() => {
    if (adresse.ansicht !== 'text' || zielZeile == null) return;
    const t = window.setTimeout(() => { textRef.current?.zuZeile(zielZeile); setZielZeile(null); }, 50);
    return () => window.clearTimeout(t);
  }, [adresse.ansicht, zielZeile]);

  const zurueckZuRegeln = () => onOpenSub('regeln');

  const schritt = async (fassung: number, was: Handlung | 'zurueck' | 'stilllegen') => {
    if (!logikId || neueLogik) return;
    if (was === 'scharf') {
      setBlatt({ art: 'scharf', fassung });
      return;
    }
    setBusy(true);
    try {
      if (was === 'stilllegen') await api.logikStilllegen(site.id, logikId);
      else await api.logikFassungSchritt(site.id, logikId, fassung, was);
      setMeldung({
        text: was === 'mitlaufen' ? `Fassung ${fassung} läuft mit. Die Box rechnet, schaltet aber nichts.`
          : was === 'vorlegen' ? `Fassung ${fassung} ist vorgelegt.`
            : was === 'zurueck' ? `Zurück auf Fassung ${fassung}. Das wirkt sofort.`
              : 'Die Logik ist stillgelegt. Ihre Geräte sind frei.',
      });
      setBlatt(null);
      await lade();
    } catch (e) {
      setMeldung({ text: grund(e, 'Das ging nicht.'), fehler: true });
    } finally {
      setBusy(false);
    }
  };

  const speichern = async (notiz: string) => {
    if (text == null || !logikId) return;
    setBusy(true);
    try {
      const g = await api.logikSpeichern(site.id, text, notiz.trim() || null, neueLogik ? undefined : logikId,
        neueLogik ? undefined : basis?.fassung);
      vergissEntwurf(site.id, logikId);
      setBlatt(null);
      setMeldung({ text: `Fassung ${g.fassung} ist gespeichert. Sie läuft noch nicht.` });
      if (neueLogik) {
        vergissEntwurf(site.id, 'neu');
        window.location.hash = logikHash(site.id, g.logikId, 'aufbau');
      } else {
        await lade(false);
      }
    } catch (e) {
      const m = meldungenDerAblehnung(e);
      if (m.length) setGeprueft({ text, g: { lesbar: false, sperrt: true, message: grund(e, ''), bericht: null, meldungen: m } });
      setMeldung({ text: grund(e, 'Die Fassung ließ sich nicht speichern.'), fehler: true });
    } finally {
      setBusy(false);
    }
  };

  if (!logikId) {
    return <div className="stn"><p className="stn-fehler">Diese Adresse nennt keine Logik.</p></div>;
  }

  // Eine neue Logik beginnt mit Name und Gerät; daraus entsteht ein Text, der die Prüfung besteht.
  if (neueLogik && text == null) {
    return (
      <div className="stn">
        <div className="lk">
          <button type="button" className="lk-zurueck" onClick={zurueckZuRegeln}><Ic n="chevL" s={16} />Regeln</button>
          <div className="lk-kopf"><div><h1>Neue Logik</h1></div></div>
          <NeueLogik quellen={quellen} onStart={(t) => setText(t)} />
        </div>
      </div>
    );
  }

  if (ladeFehler) {
    return (
      <div className="stn"><div className="lk">
        <button type="button" className="lk-zurueck" onClick={zurueckZuRegeln}><Ic n="chevL" s={16} />Regeln</button>
        <p className="stn-fehler" role="alert">{ladeFehler}</p>
      </div></div>
    );
  }
  if (text == null || (!neueLogik && !ansicht)) {
    return <div className="stn"><div className="lk"><div className="vp-skeleton" style={{ height: 240, borderRadius: 20 }} aria-label="Logik wird geladen" /></div></div>;
  }

  const g = lies(text);
  const name = g.ok ? String((g.doc.toJS() as { name?: unknown })?.name ?? 'Logik') : ansicht?.name ?? 'Logik';
  const p = ansicht ? ansichtPille(ansicht) : { wort: 'Neu', klasse: 'wait' as const };
  const aktiv = ansicht ? aktiveFassung(ansicht) : null;
  const naechster = ansicht && !veraendert ? naechsterSchritt(ansicht) : null;
  const offeneAnfragen = ansicht?.anfragen.filter((x) => !x.erledigtAm) ?? [];
  const ansichten = neueLogik ? ANSICHTEN.slice(0, 2) : ANSICHTEN;
  const aktuelleAnsicht = ansichten.some((x) => x.id === adresse.ansicht) ? adresse.ansicht : 'aufbau';
  const aktuellGeprueft = geprueft?.text === text ? geprueft.g : null;
  const fehlerZahl = meldungen.filter((m) => m.art !== 'hinweis').length;

  return (
    <div className="stn">
      <div className="lk">
        <button type="button" className="lk-zurueck" onClick={zurueckZuRegeln}><Ic n="chevL" s={16} />Regeln</button>
        <div className="lk-kopf">
          <div style={{ minWidth: 0 }}>
            <h1>{name}</h1>
            <div className="lk-unter">
              <span className={`pill ${p.klasse}`}><i />{p.wort}</span>
              {veraendert ? <span className="pill hand"><i />Entwurf</span> : null}
            </div>
          </div>
          <div className="lk-kopf-knoepfe">
            {ansicht && !darf && ansicht.darfAnfragen ? (
              <button type="button" className="btn sek" onClick={(e) => { e.currentTarget.focus(); setBlatt({ art: 'anfrage', kennung: null }); }}>
                Änderung anfragen
              </button>
            ) : null}
            {ansicht && darf && aktiv ? (
              <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); setBlatt({ art: 'stilllegen' }); }}>Stilllegen</button>
            ) : null}
          </div>
        </div>

        {darf && offeneAnfragen.length ? (
          <div className="lk-band warn" role="status">
            <Ic n="info" s={18} />
            <span>
              {offeneAnfragen.length === 1 ? 'Eine Bitte um Änderung liegt vor.' : `${offeneAnfragen.length} Bitten um Änderung liegen vor.`}
              <span className="lk-band-knoepfe"><button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); setBlatt({ art: 'anfragen' }); }}>Ansehen</button></span>
            </span>
          </div>
        ) : null}
        {naechster ? (
          <div className="lk-band" role="status">
            <Ic n="info" s={18} />
            <span>
              {naechster.satz}
              {naechster.handlungen.length ? (
                <span className="lk-band-knoepfe">
                  {naechster.handlungen.map((h) => (
                    <button type="button" key={h} className={h === 'scharf' ? 'tbtn on' : 'tbtn'} disabled={busy || (h === 'mitlaufen' && !ansicht?.boxKann)}
                      onClick={() => void schritt(h === 'scharf' ? (ansicht?.fassungen.find((f) => f.vorgelegtAm && !f.scharfAm)?.fassung ?? ansicht!.fassungen[0].fassung) : ansicht!.fassungen[0].fassung, h)}>
                      {h === 'mitlaufen' ? 'Mitlaufen lassen' : h === 'vorlegen' ? 'Zur Freigabe vorlegen' : 'Scharf schalten'}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        <div className="stn-reiter" role="tablist" aria-label="Ansichten der Logik">
          {ansichten.map((a) => (
            <button key={a.id} type="button" role="tab" aria-selected={a.id === aktuelleAnsicht} onClick={() => a.id !== aktuelleAnsicht && zeige(a.id)}>
              {a.label}
              {a.id === 'text' && fehlerZahl ? <span className="n" aria-label={`${fehlerZahl} Meldungen`}>{fehlerZahl}</span> : null}
            </button>
          ))}
        </div>

        <div role="tabpanel" aria-label={ansichten.find((a) => a.id === aktuelleAnsicht)?.label}>
          {aktuelleAnsicht === 'aufbau' ? (
            <AufbauAnsicht text={text} darf={darf} quellen={quellen} meldungen={meldungen} onText={setText} zuText={zuText} />
          ) : aktuelleAnsicht === 'text' ? (
            <TextAnsicht ref={textRef} text={text} darf={darf} meldungen={meldungen} onText={setText} />
          ) : aktuelleAnsicht === 'mitlaufen' && ansicht ? (
            <MitlaufenAnsicht siteId={site.id} ansicht={ansicht} jetzt={new Date()}
              onStart={darf && !veraendert ? () => void schritt(ansicht.fassungen[0].fassung, 'mitlaufen') : null} />
          ) : aktuelleAnsicht === 'fassungen' && ansicht ? (
            <FassungenAnsicht siteId={site.id} ansicht={ansicht}
              onSchritt={(f, s) => (s === 'zurueck' ? setBlatt({ art: 'zurueck', fassung: f }) : void schritt(f, s))}
              onUebernehmen={(f) => void api.logikText(site.id, logikId, f).then((t) => { setText(t.text); zeige('aufbau'); setMeldung({ text: `Der Text von Fassung ${f} ist jetzt Ihr Entwurf.` }); })} />
          ) : aktuelleAnsicht === 'protokoll' && ansicht ? (
            <ProtokollAnsicht siteId={site.id} logikId={logikId} name={name} stand={ansicht.einstellung?.stand ?? 0} />
          ) : null}
        </div>

        {darf && veraendert ? (
          <div className="lk-fuss" role="region" aria-label="Entwurf">
            <Pruefstand pruefend={pruefend} geprueft={aktuellGeprueft} />
            <div className="lk-knoepfe">
              <button type="button" className="btn sek" onClick={(e) => { e.currentTarget.focus(); setBlatt({ art: 'verwerfen' }); }}>Verwerfen</button>
              <button type="button" className="btn" disabled={busy || pruefend || !aktuellGeprueft || aktuellGeprueft.sperrt}
                onClick={(e) => { e.currentTarget.focus(); setBlatt({ art: 'speichern' }); }}>
                Als Fassung speichern
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {meldung ? (
        <div className="stn-toast" role={meldung.fehler ? 'alert' : 'status'} onClick={() => setMeldung(null)}>
          <Ic n={meldung.fehler ? 'alert' : 'check'} s={18} />
          <span>{meldung.text}</span>
        </div>
      ) : null}

      {blatt?.art === 'speichern' && aktuellGeprueft ? (
        <SpeichernBlatt geprueft={aktuellGeprueft} busy={busy} neu={neueLogik} fassung={(basis?.fassung ?? 0) + 1}
          onClose={() => setBlatt(null)} onSpeichern={(n) => void speichern(n)} />
      ) : null}
      {blatt?.art === 'verwerfen' ? (
        <Blatt symbol="alert" titel="Entwurf verwerfen?" onClose={() => setBlatt(null)}
          fuss={<>
            <button type="button" className="btn sek" onClick={() => setBlatt(null)}>Behalten</button>
            <button type="button" className="btn" onClick={() => {
              setBlatt(null);
              vergissEntwurf(site.id, logikId);
              if (neueLogik) { setText(null); zurueckZuRegeln(); } else setText(basis?.text ?? '');
            }}>Verwerfen</button>
          </>}>
          <p className="leise">{neueLogik ? 'Die neue Logik wird nicht gespeichert.' : `Der Text geht zurück auf Fassung ${basis?.fassung}.`}</p>
        </Blatt>
      ) : null}
      {blatt?.art === 'zurueck' ? (
        <Blatt symbol="history" titel={`Zurück auf Fassung ${blatt.fassung}?`} onClose={() => setBlatt(null)}
          fuss={<>
            <button type="button" className="btn sek" onClick={() => setBlatt(null)}>Abbrechen</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void schritt(blatt.fassung, 'zurueck')}>Zurück</button>
          </>}>
          <p className="leise">
            Fassung {blatt.fassung} löst {aktiv ? `Fassung ${aktiv.fassung}` : 'die laufende'} sofort ab, {aktiv?.zustand === 'scharf' ? 'scharf' : 'mitlaufend'}.
            Zustände gleichen Namens bleiben, gestellte Werte auch, soweit sie passen.
          </p>
        </Blatt>
      ) : null}
      {blatt?.art === 'stilllegen' && aktiv ? (
        <Blatt symbol="pause" titel="Logik stilllegen?" onClose={() => setBlatt(null)}
          fuss={<>
            <button type="button" className="btn sek" onClick={() => setBlatt(null)}>Abbrechen</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void schritt(aktiv.fassung, 'stilllegen')}>Stilllegen</button>
          </>}>
          <p className="leise">
            {aktiv.zustand === 'scharf'
              ? 'Die Box hört sofort auf, nach der Logik zu schalten. Ihre Geräte sind frei und folgen wieder ihrer eigenen Steuerung.'
              : 'Die Box hört auf, die Logik mitzurechnen.'} Fassungen und Protokoll bleiben.
          </p>
        </Blatt>
      ) : null}
      {blatt?.art === 'anfrage' && ansicht ? (
        <AnfrageBlatt ansicht={ansicht} kennung={blatt.kennung} onClose={() => setBlatt(null)}
          onSenden={async (kennung, t) => {
            await api.logikAnfragen(site.id, logikId, t, kennung);
            setBlatt(null);
            setMeldung({ text: 'Ihre Anfrage ist angekommen.' });
            await lade();
          }} />
      ) : null}
      {blatt?.art === 'anfragen' && ansicht ? (
        <Blatt symbol="info" titel="Bitten um Änderung" voll onClose={() => setBlatt(null)}>
          <ul className="lk-liste">
            {ansicht.anfragen.map((x) => (
              <li key={x.id}>
                <div className="lk-zeile-kopf">
                  <b>{x.kennung ? `Zu „${x.kennung}“` : 'Zur Logik'}</b>
                  {x.erledigtAm ? <span className="pill off"><i />erledigt</span> : (
                    <button type="button" className="tbtn" onClick={() => void api.logikAnfrageErledigt(site.id, logikId, x.id).then(() => lade())}>Erledigt</button>
                  )}
                </div>
                <span>{x.text}</span>
                <small>{new Date(x.am).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' })} · {x.von ?? 'unbekannt'}</small>
              </li>
            ))}
          </ul>
        </Blatt>
      ) : null}
      {blatt?.art === 'scharf' && ansicht ? (
        <ScharfBlatt siteId={site.id} logikId={logikId} fassung={blatt.fassung} onClose={() => setBlatt(null)}
          onFertig={async (n) => { setBlatt(null); setMeldung({ text: `Fassung ${n} ist scharf. Die Box schaltet nach ihr.` }); await lade(); }} />
      ) : null}
    </div>
  );
}

function Pruefstand({ pruefend, geprueft }: { pruefend: boolean; geprueft: LogikGeprueft | null }) {
  if (pruefend || !geprueft) {
    return <span className="lk-pruefung laeuft" role="status"><Ic n="clock" s={18} /><span>Wird geprüft …</span></span>;
  }
  if (!geprueft.lesbar) {
    return <span className="lk-pruefung fehler" role="status"><Ic n="alert" s={18} /><span>Nicht lesbar{geprueft.meldungen?.[0]?.zeile ? ` (Zeile ${geprueft.meldungen[0].zeile})` : ''}</span></span>;
  }
  const fehler = (geprueft.meldungen ?? []).filter((m) => m.art !== 'hinweis').length;
  if (geprueft.sperrt) {
    return <span className="lk-pruefung fehler" role="status"><Ic n="alert" s={18} /><span>{fehler === 1 ? '1 Fehler' : `${fehler} Fehler`}</span></span>;
  }
  const p = geprueft.bericht?.proben ?? [];
  return (
    <span className="lk-pruefung ok" role="status">
      <Ic n="check" s={18} />
      <span>Geprüft{p.length ? ` · ${p.length} ${p.length === 1 ? 'Probe' : 'Proben'} bestanden` : ' · ohne Proben'}</span>
    </span>
  );
}

function SpeichernBlatt({ geprueft, busy, neu, fassung, onClose, onSpeichern }: {
  geprueft: LogikGeprueft; busy: boolean; neu: boolean; fassung: number; onClose: () => void; onSpeichern: (notiz: string) => void;
}) {
  const [notiz, setNotiz] = useState('');
  const hinweise = (geprueft.meldungen ?? []).filter((m) => m.art === 'hinweis');
  return (
    <Blatt symbol="check" titel={neu ? 'Logik speichern' : `Als Fassung ${fassung} speichern`} unter="Sie läuft danach noch nicht." onClose={onClose}
      fuss={<button type="button" className="btn" disabled={busy} onClick={() => onSpeichern(notiz)}>Speichern</button>}>
      <form className="lk-form" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); onSpeichern(notiz); }}>
        <TextFeld label="Was hat sich geändert?" wert={notiz} onWert={setNotiz} hilfe="Freiwillig, steht an der Fassung." />
        {hinweise.length ? (
          <div className="blk">
            <h3>Hinweise der Prüfung</h3>
            <ul className="lk-meldungen">
              {hinweise.map((h, i) => <li key={i}><button type="button" className="hinweis" disabled><Ic n="info" s={16} /><b>Hinweis</b><span>{h.text}</span></button></li>)}
            </ul>
          </div>
        ) : null}
      </form>
    </Blatt>
  );
}

function AnfrageBlatt({ ansicht, kennung, onClose, onSenden }: {
  ansicht: LogikAnsicht; kennung: string | null; onClose: () => void; onSenden: (kennung: string | null, text: string) => Promise<void>;
}) {
  const [k, setK] = useState<string>(kennung ?? '');
  const [t, setT] = useState('');
  const [fehler, setFehler] = useState<string | null>(null);
  const stellwerte = ansicht.fassungen[0]?.bericht?.stellwerte ?? [];
  const senden = () => {
    if (!t.trim()) { setFehler('Bitte kurz schreiben, was sich ändern soll.'); return; }
    onSenden(k || null, t.trim()).catch((e) => setFehler(grund(e, 'Die Anfrage ließ sich nicht senden.')));
  };
  return (
    <Blatt symbol="info" titel="Änderung anfragen" unter={ansicht.name} onClose={onClose}
      fuss={<button type="button" className="btn" onClick={senden}>Anfrage senden</button>}>
      <form className="lk-form" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); senden(); }}>
        <AuswahlFeld label="Worum geht es?" wert={k} onWert={setK}
          optionen={[{ value: '', label: 'Die ganze Logik' }, ...stellwerte.map((s) => ({ value: s.kennung, label: s.name, sub: s.einheit ?? null }))]} />
        <TextFeld label="Was soll sich ändern?" wert={t} onWert={setT} fehler={fehler} platzhalter="z. B. Bitte schon ab 5 Uhr aus dem Netz heizen" />
        <p className="leise">Wer die Logik bearbeitet, sieht Ihre Anfrage an der Logik.</p>
      </form>
    </Blatt>
  );
}

/** Scharf schalten (nur die Plattform, Stufe 4): Hinweise gesammelt, eine Bestätigung (E5 = C). */
function ScharfBlatt({ siteId, logikId, fassung, onClose, onFertig }: {
  siteId: string; logikId: string; fassung: number; onClose: () => void; onFertig: (n: number) => Promise<void>;
}) {
  const [v, setV] = useState<SteuerlogikVorschau | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.steuerlogikVorschauFassung(siteId, logikId, fassung).then(setV, (e) => setFehler(grund(e, 'Die Vorschau ließ sich nicht laden.')));
  }, [siteId, logikId, fassung]);
  const los = async () => {
    setBusy(true);
    try {
      await api.steuerlogikScharf(siteId, logikId, fassung);
      await onFertig(fassung);
    } catch (e) {
      setFehler(grund(e, 'Scharf schalten ging nicht.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Blatt symbol="power" titel={`Fassung ${fassung} scharf schalten`} unter="Die Box schaltet danach nach dieser Fassung." voll onClose={onClose}
      fuss={<button type="button" className="btn" disabled={busy || !v?.moeglich} onClick={() => void los()}>Hinweise gelesen, scharf schalten</button>}>
      <div style={{ display: 'grid', gap: 12 }}>
        {fehler ? <p className="stn-fehler" role="alert">{fehler}</p> : null}
        {!v && !fehler ? <p className="leise">Wird geladen …</p> : null}
        {v ? (
          <>
            {v.konflikte.length ? (
              <div className="blk"><h3>Geht nicht</h3><ul className="lk-meldungen">{v.konflikte.map((k, i) => <li key={i}><button type="button" disabled><Ic n="alert" s={16} /><b>{k.geraet}</b><span>{k.text}</span></button></li>)}</ul></div>
            ) : null}
            <div className="blk"><h3>Diese Geräte gehören dann der Logik</h3><p>{v.geraete.join(', ') || '–'}</p></div>
            {v.kundeStellt.length ? <div className="blk"><h3>Das stellt der Kunde</h3><p>{v.kundeStellt.join(', ')}</p></div> : null}
            <div className="blk"><h3>Hinweise</h3><ul className="lk-meldungen">{v.hinweise.map((h, i) => <li key={i}><button type="button" className="hinweis" disabled><Ic n="info" s={16} /><b>Hinweis</b><span>{h}</span></button></li>)}</ul></div>
          </>
        ) : null}
      </div>
    </Blatt>
  );
}

/** Der Anfang einer neuen Logik: Name und Gerät; der Text entsteht daraus und besteht die Prüfung. */
function NeueLogik({ quellen, onStart }: { quellen: LogikQuellen | null; onStart: (text: string) => void }) {
  const [name, setName] = useState('');
  const [geraet, setGeraet] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const geraete = quellen?.geraete ?? [];
  const los = () => {
    const g = geraete.find((x) => x.entity_id === geraet);
    if (!name.trim()) { setFehler('Bitte einen Namen angeben.'); return; }
    if (!g) { setFehler('Bitte ein Gerät wählen.'); return; }
    onStart(startText(name.trim(), g));
  };
  return (
    <section className="card lk-abschnitt" aria-label="Neue Logik">
      <p>Eine Logik beginnt mit einem Gerät, das mit Sonnenstrom läuft. Danach bauen Sie sie im Aufbau oder im Text weiter.</p>
      <form className="lk-form" onSubmit={(e) => { e.preventDefault(); los(); }}>
        <TextFeld label="Name" wert={name} onWert={setName} platzhalter="z. B. Heizung" fehler={fehler && !name.trim() ? fehler : null} />
        <AuswahlFeld label="Gerät" wert={geraet} onWert={setGeraet} platzhalter={quellen ? 'Gerät wählen …' : 'Geräte werden geladen …'}
          optionen={geraete.map((g) => ({ value: g.entity_id, label: g.name, sub: g.typ }))}
          hilfe={quellen && !geraete.length ? 'An dieser Anlage gibt es kein Gerät, das die Box schalten kann.' : 'Nur Geräte, die die Box schalten kann.'} />
        {fehler && name.trim() ? <p className="stn-fehler" role="alert">{fehler}</p> : null}
        <button type="submit" className="btn" style={{ justifySelf: 'start' }}>Logik beginnen</button>
      </form>
    </section>
  );
}
