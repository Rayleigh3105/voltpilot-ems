/**
 * Ein Eintrag der Logik im Formular (Ansicht „Aufbau“, Bericht 12.3): Gerät, Eingang, Stellwert mit Bereich und
 * „wer stellt“, Regel zwischen Stellwerten, abgeleiteter Wert, Zustand (Schalter, Zähler, Zeitgeber), Ausgang,
 * Erklärsatz, Meldung, Probe. Das Formular hält den Eintrag in der Form des Textes; gespeichert wird über
 * `schreibeEintrag`, das nur geänderte Felder schreibt.
 */
import { useMemo, useState } from 'react';
import type { LogikQuellen } from '../../api';
import type { VpOption } from '../../picker/optionen';
import { Blatt } from '../Blatt';
import { Ic } from '../Ic';
import type { FormArt } from './aufbau';
import {
  AuswahlFeld,
  BedingungenFeld,
  bedingungenAus,
  bedingungenIn,
  FormelFeld,
  PaareFeld,
  paareAus,
  paareIn,
  TextFeld,
  WahlFeld,
  type Marke,
} from './Felder';

type Obj = Record<string, unknown>;

export interface EintragBlattProps {
  art: FormArt;
  titel: string;
  /** Kennung des Eintrags; `null` = ein neuer Eintrag in einem Objekt-Abschnitt (die Kennung wird gewählt). */
  schluessel: string | null;
  /** Der Eintrag in der Form des Textes; `undefined` = neu. */
  wert: unknown;
  /** Schon vergebene Namen (Eingänge, Stellwerte, Formeln, Zustände, Geräte): eine neue Kennung darf keiner sein. */
  vergeben: Set<string>;
  marken: Marke[];
  quellen: LogikQuellen | null;
  /** Die Geräte der Logik (Kennung → Name), für Ausgänge. */
  geraete: { kennung: string; name: string; entity: string }[];
  /** Der letzte Erklärsatz darf „sonst“ sein. */
  letzterSatz?: boolean;
  onSpeichern: (schluessel: string, wert: unknown) => void;
  onEntfernen?: () => void;
  onClose: () => void;
}

const KENNUNG = /^[a-z][a-z0-9_]{0,31}$/;
const VERBOTEN = new Set(['on', 'off', 'yes', 'no', 'true', 'false']);

/** Eine Kennung aus einem Namen: klein, ohne Umlaute, Unterstrich statt Leerraum. */
export function kennungAus(name: string): string {
  const k = name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '');
  return k.slice(0, 32);
}

export function kennungFehler(k: string, vergeben: Set<string>): string | null {
  if (!k) return 'Bitte eine Kennung angeben.';
  if (!KENNUNG.test(k)) return 'Klein, beginnt mit einem Buchstaben, nur a-z, 0-9 und _ (höchstens 32 Zeichen).';
  if (VERBOTEN.has(k)) return '„' + k + '“ ist als Name nicht erlaubt (ein Ja/Nein-Wort).';
  if (vergeben.has(k)) return 'Diesen Namen gibt es in der Logik schon.';
  return null;
}

function s(v: unknown): string {
  return v === undefined || v === null ? '' : v === true ? 'on' : v === false ? 'off' : String(v);
}

/** Ohne leere Felder, damit der Text keine leeren Schlüssel bekommt. */
function ohneLeere(o: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

const UHRZEIT = /^\d{1,2}:\d{2}$/;

export function EintragBlatt(p: EintragBlattProps) {
  const neu = p.wert === undefined;
  const [kennung, setKennung] = useState(p.schluessel ?? '');
  const [kennungBeruehrt, setKennungBeruehrt] = useState(false);
  const [w, setW] = useState<Obj>(() => (p.wert && typeof p.wert === 'object' ? structuredClone(p.wert as Obj) : {}));
  const [formel, setFormel] = useState(() => s(typeof p.wert === 'object' ? '' : p.wert));
  const [versucht, setVersucht] = useState(false);
  const setze = (teil: Obj) => setW((x) => ({ ...x, ...teil }));
  const brauchtKennung = p.schluessel === null;

  const vorschlag = (name: string) => {
    if (brauchtKennung && !kennungBeruehrt) setKennung(kennungAus(name));
  };
  const kFehler = brauchtKennung ? kennungFehler(kennung, p.vergeben) : null;

  const inhalt = useMemo(() => formular(p, w, setze, formel, setFormel, vorschlag), [p, w, formel]); // eslint-disable-line react-hooks/exhaustive-deps

  const speichern = () => {
    setVersucht(true);
    if (kFehler) return;
    const k = brauchtKennung ? kennung : (p.schluessel as string);
    p.onSpeichern(k, ergebnis(p.art, w, formel));
  };

  return (
    <Blatt
      symbol={SYMBOL[p.art]}
      titel={p.titel}
      unter={neu ? 'Neu' : brauchtKennung ? null : p.schluessel}
      voll
      onClose={p.onClose}
      fuss={
        <>
          {p.onEntfernen ? (
            <button type="button" className="btn sek lk-gefahr" onClick={p.onEntfernen}>
              <Ic n="x" s={18} />
              Entfernen
            </button>
          ) : null}
          <button type="button" className="btn" onClick={speichern}>
            <Ic n="check" s={18} />
            Übernehmen
          </button>
        </>
      }
    >
      <form className="lk-form" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); speichern(); }}>
        {brauchtKennung ? (
          <TextFeld
            label="Kennung im Text"
            wert={kennung}
            mono
            onWert={(k) => { setKennung(k); setKennungBeruehrt(true); }}
            hilfe="So heißt der Eintrag in Formeln."
            fehler={versucht ? kFehler : null}
          />
        ) : null}
        {inhalt}
      </form>
    </Blatt>
  );
}

const SYMBOL: Record<FormArt, string> = {
  geraet: 'power', eingang: 'gauge', stellwert: 'sliders', zusammen: 'link', formel: 'layers', zustand: 'flag',
  ausgang: 'zap', lage: 'info', meldung: 'alert', probe: 'check',
};

/** Der Eintrag in der Form des Textes, wie das Formular ihn zuletzt hält. */
function ergebnis(art: FormArt, w: Obj, formel: string): unknown {
  switch (art) {
    case 'formel':
      return formel.trim();
    case 'zusammen': {
      if (w.__name === undefined && w.__formel === undefined) return w;
      const [name, f] = Object.entries(w).find(([k]) => !k.startsWith('__')) ?? ['', ''];
      const n = (w.__name !== undefined ? s(w.__name) : name).trim();
      return { [n || 'Regel']: (w.__formel !== undefined ? s(w.__formel) : s(f)).trim() };
    }
    case 'zustand': {
      const o = { ...w };
      for (const k of ['on_when', 'on_when_any', 'off_when', 'off_when_any']) o[k] = bedingungenNormal(o[k]);
      if (Array.isArray(o.steps)) {
        o.steps = (o.steps as Obj[]).map((st) => {
          const x = { ...st };
          for (const k of ['when', 'when_any']) x[k] = bedingungenNormal(x[k]);
          delete x.__aenderung;
          return ohneLeere(x);
        });
      }
      return ohneLeere(o);
    }
    case 'stellwert': {
      const o = { ...w };
      if (Array.isArray(o.range) && (o.range as string[]).every((r) => !s(r).trim())) delete o.range;
      if (Array.isArray(o.__optionen)) o.options = paareIn(o.__optionen as [string, string][]);
      delete o.__optionen;
      delete o.__art;
      if (o.help && typeof o.help === 'object') {
        const h = o.help as Obj;
        o.help = s(h.when_on).trim() || s(h.when_off).trim() ? { when_on: s(h.when_on), when_off: s(h.when_off) } : undefined;
      }
      return ohneLeere(o);
    }
    case 'probe': {
      const o = { ...w };
      if (Array.isArray(o.given)) o.given = paareIn(o.given as [string, string][]);
      if (Array.isArray(o.expect)) o.expect = paareIn(o.expect as [string, string][]);
      return ohneLeere(o);
    }
    default:
      return ohneLeere(w);
  }
}

/** Bearbeitete Bedingungen (aus dem Formular) in die Textform; unberührte bleiben, wie sie im Text stehen. */
function bedingungenNormal(v: unknown): unknown {
  const bearbeitet = Array.isArray(v) && v.every((c) => c && typeof c === 'object' && 'formel' in (c as Obj) && 'name' in (c as Obj)
    && Object.keys(c as Obj).length === 2);
  return bearbeitet ? bedingungenIn(v as never) : v;
}

const AUSGANG_ARTEN: { wert: string; label: string; hilfe: string }[] = [
  { wert: 'on_off', label: 'Ein/Aus', hilfe: 'Eine Bedingung: an, wenn sie gilt.' },
  { wert: 'level', label: 'Stufe', hilfe: 'Eine Zahl: 0 bis Zahl der Ausgänge.' },
  { wert: 'setpoint', label: 'Sollwert', hilfe: 'Ein Wert in °C oder kW.' },
  { wert: 'mode', label: 'Betriebsart', hilfe: 'Ein Wort: normal, boost, cool, heat, fan_only, dry, auto.' },
  { wert: 'percent', label: 'Anteil', hilfe: '0 bis 100 %. Die Box führt ihn noch nicht aus.' },
];

const LAGE_ARTEN = [
  { wert: 'solar', label: 'Sonne' }, { wert: 'grid', label: 'Netz' }, { wert: 'waiting', label: 'wartet' },
  { wert: 'idle', label: 'ruht' }, { wert: 'fault', label: 'Störung' },
];

const WER = [
  { wert: 'customer', label: 'Kunde' }, { wert: 'customer_admin', label: 'Kundenadministrator' },
  { wert: 'installer', label: 'Fachbetrieb' },
];

function quellenOptionen(q: LogikQuellen | null, aktuell: string): VpOption[] {
  const out: VpOption[] = (q?.quellen ?? []).map((x) => ({
    value: x.source,
    label: x.name,
    sub: `${x.source} · ${x.einheit === 'ja_nein' ? 'ja/nein' : x.einheit}`,
    group: x.entity_id ? (x.signal === 'temperature' && !x.name.includes('·') ? 'Fühler' : 'Signale von Geräten') : 'An jeder Anlage',
  }));
  if (aktuell && !out.some((o) => o.value === aktuell)) {
    out.unshift({ value: aktuell, label: aktuell, sub: 'an dieser Anlage nicht gefunden', group: 'An jeder Anlage' });
  }
  return out;
}

function geraeteOptionen(q: LogikQuellen | null, aktuell: string): VpOption[] {
  const art: Record<string, string> = { level: 'Stufe', on_off: 'Ein/Aus', setpoint: 'Sollwert', mode: 'Betriebsart' };
  const out: VpOption[] = (q?.geraete ?? []).map((g) => ({
    value: g.entity_id,
    label: g.name,
    sub: g.ausgaenge.map((a) => art[a] ?? a).join(' · '),
  }));
  if (aktuell && !out.some((o) => o.value === aktuell)) out.unshift({ value: aktuell, label: aktuell, sub: 'an dieser Anlage nicht gefunden' });
  return out;
}

function formular(
  p: EintragBlattProps,
  w: Obj,
  setze: (t: Obj) => void,
  formel: string,
  setFormel: (f: string) => void,
  vorschlag: (name: string) => void,
) {
  const m = p.marken;
  switch (p.art) {
    case 'geraet': {
      const g = p.quellen?.geraete.find((x) => x.entity_id === s(w.entity));
      return (
        <>
          <AuswahlFeld
            label="Gerät der Anlage"
            wert={s(w.entity) || null}
            optionen={geraeteOptionen(p.quellen, s(w.entity))}
            onWert={(entity) => {
              const name = p.quellen?.geraete.find((x) => x.entity_id === entity)?.name ?? '';
              setze({ entity, name: s(w.name) || name });
              if (!s(w.name)) vorschlag(name);
            }}
            hilfe="Nur Geräte, die die Box schalten kann."
          />
          <TextFeld label="Name in der Logik" wert={s(w.name)} onWert={(name) => { setze({ name }); vorschlag(name); }} />
          {g ? <p className="leise">Die Box führt aus: {g.ausgaenge.join(', ')}.</p> : null}
        </>
      );
    }
    case 'eingang':
      return (
        <>
          <AuswahlFeld
            label="Quelle"
            wert={s(w.source) || null}
            optionen={quellenOptionen(p.quellen, s(w.source))}
            onWert={(source) => {
              const name = p.quellen?.quellen.find((x) => x.source === source)?.name ?? '';
              setze({ source, name: s(w.name) || name });
              if (!s(w.name)) vorschlag(name);
            }}
          />
          <TextFeld label="Name" wert={s(w.name)} onWert={(name) => { setze({ name }); vorschlag(name); }} />
          <TextFeld label="Höchstalter" wert={s(w.max_age)} onWert={(max_age) => setze({ max_age })} platzhalter="z. B. 60 s oder 5 min"
            hilfe="Ist der Wert älter, gilt er als unbekannt." mono />
        </>
      );
    case 'stellwert':
      return stellwertFormular(w, setze, vorschlag);
    case 'zusammen': {
      const [name, f] = Object.entries(w).find(([k]) => !k.startsWith('__')) ?? ['', ''];
      const n = w.__name !== undefined ? s(w.__name) : name;
      const fo = w.__formel !== undefined ? s(w.__formel) : s(f);
      return (
        <>
          <TextFeld label="Satz" wert={n} onWert={(x) => setze({ __name: x, __formel: fo })} platzhalter="z. B. Das Netzziel liegt unter dem Sonnenziel" />
          <FormelFeld label="Formel" wert={fo} onWert={(x) => setze({ __name: n, __formel: x })} marken={m} platzhalter="z. B. netz_ziel <= ziel" />
        </>
      );
    }
    case 'formel':
      return <FormelFeld label="Formel" wert={formel} onWert={setFormel} marken={m} hilfe="Gilt immer mit den Werten von jetzt." />;
    case 'zustand':
      return zustandFormular(p, w, setze, vorschlag);
    case 'ausgang': {
      const g = p.geraete.find((x) => x.kennung === p.schluessel) ?? null;
      const kann = p.quellen?.geraete.find((x) => x.entity_id === g?.entity)?.ausgaenge ?? null;
      const da = AUSGANG_ARTEN.filter((a) => w[a.wert] !== undefined);
      const frei = AUSGANG_ARTEN.filter((a) => w[a.wert] === undefined);
      return (
        <>
          {p.schluessel === null ? null : <p className="leise">Gerät: {g?.name ?? p.schluessel}{kann ? `. Die Box führt aus: ${kann.join(', ')}.` : ''}</p>}
          {da.map((a) => (
            <div className="lk-zeile" key={a.wert}>
              <div>
                <FormelFeld label={a.label} wert={s(w[a.wert])} onWert={(x) => setze({ [a.wert]: x })} marken={m} hilfe={a.hilfe} />
              </div>
              <button type="button" className="lk-weg" aria-label={`${a.label} entfernen`} onClick={() => setze({ [a.wert]: undefined })}>
                <Ic n="x" s={18} />
              </button>
            </div>
          ))}
          {frei.length ? (
            <div className="lk-marken">
              {frei.map((a) => (
                <button type="button" className="lk-marke" key={a.wert} onClick={() => setze({ [a.wert]: '' })}>+ {a.label}</button>
              ))}
            </div>
          ) : null}
        </>
      );
    }
    case 'lage': {
      const sonst = w.else === true;
      return (
        <>
          {p.letzterSatz ? (
            <WahlFeld label="Wann" wert={sonst ? 'sonst' : 'wenn'} optionen={[{ wert: 'wenn', label: 'Wenn …' }, { wert: 'sonst', label: 'Sonst' }]}
              onWert={(x) => setze(x === 'sonst' ? { else: true, when: undefined } : { else: undefined, when: s(w.when) })} />
          ) : null}
          {!sonst ? <FormelFeld label="Wenn" wert={s(w.when)} onWert={(when) => setze({ when })} marken={m} /> : null}
          <TextFeld label="Titel" wert={s(w.title)} onWert={(title) => setze({ title })} />
          <WahlFeld label="Art" wert={s(w.type) || null} optionen={LAGE_ARTEN} onWert={(type) => setze({ type })} />
          <TextFeld label="Satz" wert={s(w.text)} onWert={(text) => setze({ text })}
            hilfe="{name} setzt einen Wert von jetzt ein, etwa {ziel}." />
        </>
      );
    }
    case 'meldung': {
      const an = Array.isArray(w.to) ? (w.to as string[]) : [];
      const schalte = (wer: string) => setze({ to: an.includes(wer) ? an.filter((x) => x !== wer) : [...an, wer] });
      return (
        <>
          <FormelFeld label="Wenn" wert={s(w.when)} onWert={(when) => setze({ when })} marken={m} />
          <div className="lk-feld">
            <span className="lk-feld-t">An</span>
            <div className="lk-wahl" role="group" aria-label="An">
              <button type="button" aria-pressed={an.includes('customer')} onClick={() => schalte('customer')}>Kunde</button>
              <button type="button" aria-pressed={an.includes('installer')} onClick={() => schalte('installer')}>Fachbetrieb</button>
            </div>
          </div>
          <TextFeld label="Satz" wert={s(w.text)} onWert={(text) => setze({ text })} />
          <TextFeld label="Frühestens wieder nach" wert={s(w.repeat_after)} onWert={(repeat_after) => setze({ repeat_after })} platzhalter="1 h" mono />
        </>
      );
    }
    case 'probe': {
      const given = Array.isArray(w.given) ? (w.given as [string, string][]) : paareAus(w.given);
      const expect = Array.isArray(w.expect) ? (w.expect as [string, string][]) : paareAus(w.expect);
      return (
        <>
          <TextFeld label="Name" wert={s(w.name)} onWert={(name) => setze({ name })} platzhalter="z. B. Kalter Morgen" />
          <PaareFeld label="Gegeben" wert={given} onWert={(x) => setze({ given: x })} links="Name" rechts="Wert"
            hilfe="Eingänge, Stellwerte, Zustände, clock, restart." />
          <TextFeld label="Nach" wert={s(w.after)} onWert={(after) => setze({ after })} platzhalter="z. B. 3 min" mono />
          <PaareFeld label="Erwartet" wert={expect} onWert={(x) => setze({ expect: x })} links="Name" rechts="Wert"
            hilfe="Zustände, gerät.level, status (Titel), notifications." />
        </>
      );
    }
  }
  return null;
}

function stellwertArt(w: Obj): 'zahl' | 'uhrzeit' | 'schalter' | 'auswahl' {
  if (w.__art) return w.__art as never;
  if (w.type === 'boolean') return 'schalter';
  if (w.type === 'select') return 'auswahl';
  if (UHRZEIT.test(s(w.default))) return 'uhrzeit';
  return 'zahl';
}

function stellwertFormular(w: Obj, setze: (t: Obj) => void, vorschlag: (name: string) => void) {
  const art = stellwertArt(w);
  const range = Array.isArray(w.range) ? (w.range as unknown[]).map(s) : ['', ''];
  const optionen = Array.isArray(w.__optionen) ? (w.__optionen as [string, string][]) : paareAus(w.options);
  const temperatur = s(w.default).trim().endsWith('°C');
  const hilfe = w.help && typeof w.help === 'object' ? (w.help as Obj) : null;
  return (
    <>
      <TextFeld label="Name" wert={s(w.name)} onWert={(name) => { setze({ name }); vorschlag(name); }} platzhalter="z. B. Winterregelung" />
      <WahlFeld
        label="Art"
        wert={art}
        optionen={[{ wert: 'zahl', label: 'Zahl mit Einheit' }, { wert: 'uhrzeit', label: 'Uhrzeit' }, { wert: 'schalter', label: 'Schalter' }, { wert: 'auswahl', label: 'Auswahl' }]}
        onWert={(a) => setze({
          __art: a,
          type: a === 'schalter' ? 'boolean' : a === 'auswahl' ? 'select' : undefined,
          default: a === 'schalter' ? 'off' : a === 'uhrzeit' ? '06:00' : a === 'zahl' ? '' : s(w.default),
          range: a === 'zahl' || a === 'uhrzeit' ? w.range : undefined,
          step: a === 'zahl' ? w.step : undefined,
          help: a === 'schalter' ? w.help : typeof w.help === 'string' ? w.help : undefined,
        })}
      />
      {art === 'schalter' ? (
        <WahlFeld label="Vorgabe" wert={s(w.default) === 'on' ? 'on' : 'off'} optionen={[{ wert: 'on', label: 'an' }, { wert: 'off', label: 'aus' }]} onWert={(d) => setze({ default: d })} />
      ) : art === 'auswahl' ? (
        <>
          <PaareFeld label="Möglichkeiten" wert={optionen} onWert={(o) => setze({ __optionen: o })} links="Wort" rechts="Name" />
          <WahlFeld label="Vorgabe" wert={s(w.default) || null} optionen={optionen.filter(([k]) => k).map(([k, v]) => ({ wert: k, label: v || k }))} onWert={(d) => setze({ default: d })} />
        </>
      ) : (
        <>
          <TextFeld label="Vorgabe" wert={s(w.default)} onWert={(d) => setze({ default: d })} platzhalter={art === 'uhrzeit' ? '06:00' : 'z. B. 57 °C'} mono />
          <div className="lk-zwei">
            <TextFeld label="Von" wert={range[0]} onWert={(v) => setze({ range: [v, range[1]] })} mono />
            <TextFeld label="Bis" wert={range[1]} onWert={(v) => setze({ range: [range[0], v] })} mono />
          </div>
          {art === 'zahl' ? <TextFeld label="Schritt" wert={s(w.step)} onWert={(step) => setze({ step })} platzhalter="z. B. 1 K" mono /> : null}
        </>
      )}
      <WahlFeld
        label="Wer stellt"
        wert={s(w.editable_by) || 'installer'}
        optionen={WER}
        onWert={(editable_by) => setze({ editable_by })}
        hilfe={temperatur ? 'Eine Temperatur stellt der Kunde immer, in ihrem Bereich.' : 'Kundenadministrator und Fachbetrieb stellen jeden Wert.'}
      />
      {art === 'schalter' ? (
        <>
          <TextFeld label="Satz, wenn an" wert={hilfe ? s(hilfe.when_on) : s(w.help)} onWert={(x) => setze({ help: { when_on: x, when_off: hilfe ? s(hilfe.when_off) : '' } })} />
          <TextFeld label="Satz, wenn aus" wert={hilfe ? s(hilfe.when_off) : ''} onWert={(x) => setze({ help: { when_on: hilfe ? s(hilfe.when_on) : s(w.help), when_off: x } })} />
        </>
      ) : (
        <TextFeld label="Hilfe" wert={typeof w.help === 'string' ? w.help : ''} onWert={(help) => setze({ help })} hilfe="Ein Satz unter dem Regler, mit {name} für Werte von jetzt." />
      )}
    </>
  );
}

function zustandFormular(p: EintragBlattProps, w: Obj, setze: (t: Obj) => void, vorschlag: (name: string) => void) {
  const m = p.marken;
  const typ = s(w.type) || 'boolean';
  const bed = (k: string) => (Array.isArray(w[k]) && (w[k] as unknown[]).every((x) => x && typeof x === 'object' && 'formel' in (x as Obj))
    ? (w[k] as never) : bedingungenAus(w[k]));
  return (
    <>
      {p.wert === undefined ? (
        <WahlFeld label="Art" wert={typ} optionen={[{ wert: 'boolean', label: 'Schalter' }, { wert: 'counter', label: 'Zähler' }, { wert: 'timer', label: 'Zeitgeber' }]}
          onWert={(type) => setze(type === 'boolean' ? { type, after_restart: 'off' } : type === 'timer' ? { type, after_restart: 'off', duration: '' } : { type, min: 0, max: 3, after_restart: 0, steps: [] })} />
      ) : null}
      <TextFeld label="Name für Menschen" wert={s(w.name)} onWert={(name) => { setze({ name }); vorschlag(name); }} hilfe="Wie er im Blatt „Warum?“ heißt; ohne Namen die Kennung." />
      {typ === 'boolean' ? (
        <>
          <BedingungenFeld label="Geht an, wenn alles gilt" wert={bed('on_when')} onWert={(b) => setze({ on_when: b })} marken={m} />
          <BedingungenFeld label="Geht an, wenn eines gilt" wert={bed('on_when_any')} onWert={(b) => setze({ on_when_any: b })} marken={m} hilfe="Freiwillig." />
          <BedingungenFeld label="Geht aus, wenn alles gilt" wert={bed('off_when')} onWert={(b) => setze({ off_when: b })} marken={m} hilfe="Freiwillig." />
          <BedingungenFeld label="Geht aus, sobald eines gilt" wert={bed('off_when_any')} onWert={(b) => setze({ off_when_any: b })} marken={m} hilfe="Aus gewinnt." />
          <TextFeld label="Satz, wenn er angeht" wert={s(w.on_text)} onWert={(on_text) => setze({ on_text })} hilfe="Im Blatt „Warum?“, mit {name} für Werte von jetzt." />
          <TextFeld label="Satz, wenn er ausgeht" wert={s(w.off_text)} onWert={(off_text) => setze({ off_text })} />
          <WahlFeld label="Nach einem Neustart" wert={s(w.after_restart) || 'off'} optionen={[{ wert: 'off', label: 'aus' }, { wert: 'on', label: 'an' }, { wert: 'keep', label: 'wie vorher' }]} onWert={(after_restart) => setze({ after_restart })} />
        </>
      ) : typ === 'timer' ? (
        <>
          <FormelFeld label="Dauer" wert={s(w.duration)} onWert={(duration) => setze({ duration })} marken={m} hilfe="Ein Wert oder eine Formel, etwa 30 min oder sperrzeit." />
          <WahlFeld label="Nach einem Neustart" wert={s(w.after_restart) || 'off'} optionen={[{ wert: 'off', label: 'steht' }, { wert: 'keep', label: 'läuft weiter' }]} onWert={(after_restart) => setze({ after_restart })} />
        </>
      ) : (
        <>
          <div className="lk-zwei">
            <TextFeld label="Von" wert={s(w.min)} onWert={(min) => setze({ min })} mono />
            <TextFeld label="Bis" wert={s(w.max)} onWert={(max) => setze({ max })} mono />
          </div>
          <TextFeld label="Nach einem Neustart" wert={s(w.after_restart)} onWert={(after_restart) => setze({ after_restart })} hilfe="Eine Zahl, oder keep für „wie vorher“." mono />
          <SchritteFeld schritte={Array.isArray(w.steps) ? (w.steps as Obj[]) : []} onSchritte={(steps) => setze({ steps })} marken={m} />
        </>
      )}
    </>
  );
}

function SchritteFeld({ schritte, onSchritte, marken }: { schritte: Obj[]; onSchritte: (s: Obj[]) => void; marken: Marke[] }) {
  const setze = (i: number, t: Obj) => onSchritte(schritte.map((x, j) => (j === i ? { ...x, ...t } : x)));
  const bed = (x: unknown) => (Array.isArray(x) && x.every((c) => c && typeof c === 'object' && 'formel' in (c as Obj)) ? (x as never) : bedingungenAus(x));
  return (
    <div className="lk-feld">
      <span className="lk-feld-t">Schritte</span>
      <small>Je Takt gilt der erste zutreffende Schritt.</small>
      {schritte.map((st, i) => {
        const auf = st.set !== undefined || st.__aenderung === 'auf';
        return (
          <section className="lk-schritt" key={i} aria-label={`Schritt ${i + 1}`}>
            <header>
              <span>Schritt {i + 1}</span>
              <span className="lk-knoepfe">
                <button type="button" className="lk-pfeil" aria-label="Nach oben" disabled={i === 0} onClick={() => onSchritte(tausche(schritte, i, i - 1))}><Ic n="up" s={16} /></button>
                <button type="button" className="lk-pfeil" aria-label="Nach unten" disabled={i === schritte.length - 1} onClick={() => onSchritte(tausche(schritte, i, i + 1))}><Ic n="down" s={16} /></button>
                <button type="button" className="lk-pfeil" aria-label={`Schritt ${i + 1} entfernen`} onClick={() => onSchritte(schritte.filter((_, j) => j !== i))}><Ic n="x" s={16} /></button>
              </span>
            </header>
            <TextFeld label="Kennung" wert={s(st.name)} onWert={(name) => setze(i, { name })} mono />
            <TextFeld label="Satz für den Kunden" wert={s(st.text)} onWert={(text) => setze(i, { text })} />
            <WahlFeld label="Ändert" wert={auf ? 'auf' : 'um'} optionen={[{ wert: 'um', label: 'um' }, { wert: 'auf', label: 'auf' }]}
              onWert={(x) => setze(i, x === 'auf' ? { __aenderung: 'auf', set: s(st.set ?? st.by), by: undefined } : { __aenderung: 'um', by: s(st.by ?? st.set), set: undefined })} />
            {auf
              ? <FormelFeld label="Auf" wert={s(st.set)} onWert={(set) => setze(i, { set })} marken={marken} />
              : <TextFeld label="Um" wert={s(st.by)} onWert={(by) => setze(i, { by })} platzhalter="+1 oder -1" mono />}
            <TextFeld label="Frühestens nach" wert={s(st.not_before)} onWert={(not_before) => setze(i, { not_before })} platzhalter="z. B. 6 min" hilfe="Ab dem letzten Wechsel." mono />
            <BedingungenFeld label="Wenn alles gilt" wert={bed(st.when)} onWert={(b) => setze(i, { when: b })} marken={marken} />
            <BedingungenFeld label="Und eines davon gilt" wert={bed(st.when_any)} onWert={(b) => setze(i, { when_any: b })} marken={marken} hilfe="Freiwillig." />
            <TextFeld label="Dann" wert={s(st.then)} onWert={(then) => setze(i, { then })} platzhalter="start(sperre) if …" hilfe="Freiwillig: einen Zeitgeber starten." mono />
          </section>
        );
      })}
      <button type="button" className="lnk lk-plus" onClick={() => onSchritte([...schritte, { name: `schritt_${schritte.length + 1}`, by: '+1', when: [] }])}>
        <Ic n="plus" s={16} />
        Schritt
      </button>
    </div>
  );
}

function tausche<T>(liste: T[], i: number, j: number): T[] {
  const out = [...liste];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
