/**
 * Ein Baustein unter „Neue Regel“ (Steuerlogik Stufe 5, Bericht 6.7): der Satz mit antippbaren Lücken, darunter
 * „So verhält sie sich“ - die Proben des Bausteins als ein Tag, gerechnet vom Logik-Dienst mit genau diesen Werten.
 * Gespeichert wird eine gewöhnliche Logik (Fassung 1, läuft noch nicht); danach geht es auf ihre Seite, wo sie
 * mitläuft und vorgelegt wird wie jede andere.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BausteinEingesetzt, BausteinKopf, BausteinLuecke } from '../../api';
import { api } from '../../apiVoll';
import { Recht } from '../../components/Recht';
import { logikHash } from '../../nav';
import { Blatt } from '../Blatt';
import { Ic } from '../Ic';
import { artKlasse, startWerte, symbol, tag, uhrSchritt, unterDemSatz, wertText, zahlSchritt } from './baustein';

/** So lange nach der letzten Änderung fragt das Blatt den Dienst (wie „Prüfen“ beim Schreiben). */
const VORSCHAU_WARTE_MS = 350;

function grund(e: unknown, sonst: string): string {
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' && m ? m : sonst;
}

export function BausteinBlatt({ siteId, kopf, onClose, onEntfernt }: {
  siteId: string;
  kopf: BausteinKopf;
  onClose: () => void;
  onEntfernt: () => void;
}) {
  const [werte, setWerte] = useState<Record<string, unknown>>(() => startWerte(kopf.luecken));
  const [name, setName] = useState(kopf.name ?? 'Logik');
  const [fokus, setFokus] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState<{ fuer: string; e: BausteinEingesetzt } | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entfernen, setEntfernen] = useState(false);
  const schluessel = JSON.stringify({ werte, name });
  const laufend = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      laufend.current?.abort();
      const ab = new AbortController();
      laufend.current = ab;
      api.bausteinVorschau(siteId, kopf.id, { name: name.trim() || undefined, werte }, ab.signal)
        .then((e) => { if (!ab.signal.aborted) { setVorschau({ fuer: schluessel, e }); setFehler(null); } })
        .catch((e) => { if (!ab.signal.aborted) setFehler(grund(e, 'Der Logik-Dienst ist gerade nicht erreichbar.')); });
    }, VORSCHAU_WARTE_MS);
    return () => window.clearTimeout(t);
    // `schluessel` fasst Werte und Name zusammen; die Vorschau gilt genau für ihn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, kopf.id, schluessel]);
  useEffect(() => () => laufend.current?.abort(), []);

  const e = vorschau?.e ?? null;
  const aktuell = vorschau?.fuer === schluessel;
  const luecken = e?.luecken ?? kopf.luecken;
  const zeige = (l: BausteinLuecke) => wertText(e?.luecken.find((x) => x.kennung === l.kennung) ?? l, werte[l.kennung]);
  const setze = (k: string, w: unknown) => setWerte({ ...werte, [k]: w });
  const lueckenFehler = aktuell ? luecken.filter((l) => l.fehler) : [];
  const sperrt = aktuell && (!e?.vollstaendig || !!e?.bericht?.sperrt);
  const ersteMeldung = e?.bericht?.meldungen?.find((m) => m.art !== 'hinweis')?.text ?? null;

  const tok = (l: BausteinLuecke) => (
    <button
      type="button"
      key={l.kennung}
      className={`tok ${l.art === 'stellwert' ? 'val' : 'dev'}`}
      aria-expanded={fokus === l.kennung}
      aria-label={`${l.name}: ${zeige(l)}`}
      onClick={() => setFokus(fokus === l.kennung ? null : l.kennung)}
    >
      {l.art === 'geraet' ? <Ic n={symbol({ luecken: [l] })} s={17} /> : l.art === 'eingang' ? <Ic n="thermo" s={17} /> : null}
      {zeige(l)}
    </button>
  );

  // Fließtext mit Lücken; ein Satzzeichen direkt hinter einer Lücke bleibt bei ihr (nie allein am Zeilenanfang).
  const satz: ReactNode[] = [];
  kopf.satz.forEach((t, i) => {
    if (t.luecke == null) {
      const rest = satz.length && /^[.,;:!?)]/.test(t.text ?? '') ? (t.text ?? '').replace(/^[.,;:!?)]+/, '') : t.text ?? '';
      if (rest) satz.push(<span className="bs-w" key={`t${i}`}>{rest}</span>);
      return;
    }
    const l = luecken.find((x) => x.kennung === t.luecke);
    if (!l) return;
    const zeichen = /^[.,;:!?)]+/.exec(kopf.satz[i + 1]?.text ?? '')?.[0] ?? '';
    satz.push(zeichen ? <span className="bs-kette" key={`k${i}`}>{tok(l)}{zeichen}</span> : tok(l));
  });
  const darunter = unterDemSatz(luecken);

  const gewaehlt = fokus ? luecken.find((l) => l.kennung === fokus) ?? null : null;
  const picker = gewaehlt ? <Waehler l={gewaehlt} wert={werte[gewaehlt.kennung]} werte={werte} luecken={luecken}
    onWert={(w) => setze(gewaehlt.kennung, w)} onFertig={() => setFokus(null)} /> : null;

  const speichern = async () => {
    setBusy(true);
    try {
      const g = await api.bausteinEinsetzen(siteId, kopf.id, { name: name.trim() || undefined, werte });
      window.location.hash = logikHash(siteId, g.logikId, 'mitlaufen');
    } catch (err) {
      setFehler(grund(err, 'Die Logik ließ sich nicht speichern.'));
      setBusy(false);
    }
  };
  const entferne = async () => {
    if (!entfernen) { setEntfernen(true); return; }
    setBusy(true);
    try {
      await api.bausteinEntfernen(siteId, kopf.id);
      onEntfernt();
    } catch (err) {
      setFehler(grund(err, 'Der Baustein ließ sich nicht entfernen.'));
      setBusy(false);
    }
  };

  const momente = e ? tag(e.verhalten) : [];
  return (
    <Blatt
      titel="Neue Regel"
      unter={kopf.name}
      symbol={symbol(kopf)}
      voll
      onClose={onClose}
      fuss={
        <>
          {kopf.eigen ? (
            <button type="button" className="btn sek" disabled={busy} onClick={() => void entferne()}
              style={entfernen ? { color: 'var(--c-destructive)', boxShadow: 'inset 0 0 0 1.5px var(--c-destructive)' } : undefined}>
              {entfernen ? 'Endgültig entfernen' : 'Entfernen'}
            </button>
          ) : (
            <button type="button" className="btn sek" onClick={onClose}>Abbrechen</button>
          )}
          <Recht aktion="logik.bearbeiten"><button type="button" className="btn" disabled={busy || !aktuell || sperrt}
            onClick={() => void speichern()}>
            <Ic n="check" s={18} />
            {busy ? 'Speichert …' : 'Speichern'}
          </button></Recht>
        </>
      }
    >
      <div className="satz bs-satz" aria-label="Regel als Satz">{satz}</div>
      {darunter.length ? (
        <div className="bs-darunter">
          {darunter.map((l) => (
            <div className="bs-zeile" key={l.kennung}><span>{l.name}</span>{tok(l)}</div>
          ))}
        </div>
      ) : null}
      {picker}
      {lueckenFehler.map((l) => (
        <div className="konflikt" key={`f-${l.kennung}`}><Ic n="alert" s={18} /><span>{l.name}: {l.fehler}</span></div>
      ))}
      <div className="blk bs-tag" aria-label="So verhält sie sich" role="region">
        <h3>So verhält sie sich{e ? <span className="meta">{momente.length} Fälle</span> : null}</h3>
        {fehler ? <div className="konflikt" role="alert"><Ic n="alert" s={18} /><span>{fehler}</span></div> : null}
        {!e && !fehler ? <div className="vp-skeleton" style={{ height: 180, borderRadius: 14 }} aria-label="Rechnet …" /> : null}
        {e ? (
          <ol className={`bs-momente${aktuell ? '' : ' alt'}`}>
            {momente.map((m) => (
              <li key={`${m.uhr}-${m.fall}`}>
                <time>{m.uhr}</time>
                <span className={`bs-punkt ${artKlasse(m.art)}`} aria-hidden="true" />
                <span className="bs-moment">
                  <b>{m.titel}</b>
                  <small>{m.fall}</small>
                </span>
                {!m.besteht ? <Ic n="alert" s={16} className="bs-warn" /> : null}
              </li>
            ))}
          </ol>
        ) : null}
        {aktuell && sperrt && !lueckenFehler.length ? (
          <div className="konflikt"><Ic n="alert" s={18} /><span>{ersteMeldung ?? 'So lässt sie sich nicht speichern.'}</span></div>
        ) : null}
      </div>
      <label className="bs-name">
        <span>Name</span>
        <input value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} />
      </label>
      <p className="leise bs-schutz"><Ic n="shield" s={16} />Schutzgrenzen und Ihre Eingriffe gehen vor.</p>
    </Blatt>
  );
}

/** Der Wähler zur angetippten Lücke: Geräte und Fühler der Anlage, Zahl, Uhrzeit, an/aus, Auswahl. */
function Waehler({ l, wert, luecken, werte, onWert, onFertig }: {
  l: BausteinLuecke;
  wert: unknown;
  luecken: BausteinLuecke[];
  werte: Record<string, unknown>;
  onWert: (w: unknown) => void;
  onFertig: () => void;
}) {
  if (l.art !== 'stellwert') {
    const belegt = new Set(luecken.filter((x) => x.art === 'geraet' && x.kennung !== l.kennung).map((x) => werte[x.kennung]));
    return (
      <div className="pick">
        <b>{l.name}</b>
        <div className="vgrid">
          {(l.kandidaten ?? []).map((k) => (
            <button type="button" className="vopt" key={k.entity_id} aria-pressed={wert === k.entity_id}
              disabled={l.art === 'geraet' && belegt.has(k.entity_id)}
              onClick={() => { onWert(k.entity_id); onFertig(); }}>
              <Ic n={l.art === 'geraet' ? symbol({ luecken: [l] }) : 'thermo'} s={18} />
              <span>{k.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  const s = l.stellwert;
  if (s?.art === 'boolean' || s?.art === 'select') {
    const wahl = s.art === 'boolean' ? [{ wert: 'on', name: 'an' }, { wert: 'off', name: 'aus' }] : s.optionen ?? [];
    return (
      <div className="pick">
        <b>{l.name}</b>
        <div className="chips">
          {wahl.map((o) => (
            <button type="button" key={o.wert} aria-pressed={wert === o.wert} onClick={() => { onWert(o.wert); onFertig(); }}>{o.name}</button>
          ))}
        </div>
      </div>
    );
  }
  const uhr = s?.art === 'uhrzeit';
  const weiter = (r: 1 | -1) => (uhr ? uhrSchritt(wert, r) : zahlSchritt(l, wert, r));
  const text = wertText(l, wert);
  return (
    <div className="pick">
      <b>{l.name}</b>
      <div className="prow">
        <span>{uhr ? 'Uhrzeit' : s?.von != null && s?.bis != null ? `${wertText(l, `${s.von} ${s.einheit ?? ''}`)} bis ${wertText(l, `${s.bis} ${s.einheit ?? ''}`)}` : ''}</span>
        <span className="stp">
          <button type="button" aria-label="weniger" disabled={weiter(-1) == null} onClick={() => { const w = weiter(-1); if (w != null) onWert(w); }}><Ic n="minus" s={18} /></button>
          <output aria-live="polite">{text}</output>
          <button type="button" aria-label="mehr" disabled={weiter(1) == null} onClick={() => { const w = weiter(1); if (w != null) onWert(w); }}><Ic n="plus" s={18} /></button>
        </span>
      </div>
    </div>
  );
}
