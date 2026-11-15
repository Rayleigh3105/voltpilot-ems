/**
 * Die Felder der Formulare im Aufbau (Steuerlogik Stufe 4). Eine Formel ist ein Feld in Maschinenschrift; darunter
 * stehen die Namen der Logik als Marken zum Einfügen - eine Bedingung entsteht als Satz aus Marken, wie im
 * Satzbaukasten der Regeln, aber mit jedem Wert der Logik (Bericht 12.3).
 */
import { useId, useRef, type ReactNode } from 'react';
import { VpPicker } from '../../components/VpPicker';
import type { VpOption } from '../../picker/optionen';
import { Ic } from '../Ic';

export function Feld({ label, hilfe, fehler, children, id }: { label: string; hilfe?: ReactNode; fehler?: string | null; children: ReactNode; id?: string }) {
  return (
    <div className="lk-feld">
      {id ? <label htmlFor={id}>{label}</label> : <span className="lk-feld-t">{label}</span>}
      {children}
      {fehler ? <small className="fehler" role="alert">{fehler}</small> : hilfe ? <small>{hilfe}</small> : null}
    </div>
  );
}

export function TextFeld({ label, wert, onWert, hilfe, fehler, platzhalter, mono }: {
  label: string; wert: string; onWert: (w: string) => void; hilfe?: ReactNode; fehler?: string | null; platzhalter?: string; mono?: boolean;
}) {
  const id = useId();
  return (
    <Feld label={label} hilfe={hilfe} fehler={fehler} id={id}>
      <input
        id={id}
        className={`lk-eingabe${mono ? ' mono' : ''}`}
        value={wert}
        placeholder={platzhalter}
        aria-invalid={fehler ? true : undefined}
        spellCheck={!mono}
        onChange={(e) => onWert(e.target.value)}
      />
    </Feld>
  );
}

/** Ein Name der Logik zum Einfügen in eine Formel. */
export interface Marke {
  name: string;
  satz: string;
  gruppe: string;
}

export function Marken({ marken, onMarke }: { marken: Marke[]; onMarke: (name: string) => void }) {
  if (!marken.length) return null;
  const gruppen = [...new Set(marken.map((m) => m.gruppe))];
  return (
    <div className="lk-zeilen" aria-label="Namen zum Einfügen">
      {gruppen.map((g) => (
        <div key={g} className="lk-marken">
          <span className="lk-marken-t">{g}</span>
          {marken.filter((m) => m.gruppe === g).map((m) => (
            <button type="button" className="lk-marke" key={m.name} title={m.satz} onMouseDown={(e) => e.preventDefault()} onClick={() => onMarke(m.name)}>
              <code>{m.name}</code>
              {m.satz !== m.name ? m.satz : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Ein Feld für eine Formel mit den Namen der Logik darunter; eingefügt wird an der Schreibmarke. */
export function FormelFeld({ label, wert, onWert, hilfe, marken, platzhalter }: {
  label: string; wert: string; onWert: (w: string) => void; hilfe?: ReactNode; marken: Marke[]; platzhalter?: string;
}) {
  const id = useId();
  const feld = useRef<HTMLInputElement>(null);
  const fuegeEin = (name: string) => {
    const f = feld.current;
    const a = f?.selectionStart ?? wert.length;
    const b = f?.selectionEnd ?? wert.length;
    const vor = wert.slice(0, a);
    const luecke = vor && !/[\s(]$/.test(vor) ? ' ' : '';
    const neu = `${vor}${luecke}${name}${wert.slice(b)}`;
    onWert(neu);
    requestAnimationFrame(() => {
      f?.focus();
      const p = a + luecke.length + name.length;
      f?.setSelectionRange(p, p);
    });
  };
  return (
    <Feld label={label} hilfe={hilfe} id={id}>
      <input
        ref={feld}
        id={id}
        className="lk-eingabe mono"
        value={wert}
        placeholder={platzhalter}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => onWert(e.target.value)}
      />
      <Marken marken={marken} onMarke={fuegeEin} />
    </Feld>
  );
}

export function WahlFeld<T extends string>({ label, wert, optionen, onWert, hilfe }: {
  label: string; wert: T | null; optionen: { wert: T; label: string }[]; onWert: (w: T) => void; hilfe?: ReactNode;
}) {
  return (
    <Feld label={label} hilfe={hilfe}>
      <div className="lk-wahl" role="group" aria-label={label}>
        {optionen.map((o) => (
          <button type="button" key={o.wert} aria-pressed={wert === o.wert} onClick={() => onWert(o.wert)}>
            {o.label}
          </button>
        ))}
      </div>
    </Feld>
  );
}

export function AuswahlFeld({ label, wert, optionen, onWert, hilfe, platzhalter }: {
  label: string; wert: string | null; optionen: VpOption[]; onWert: (w: string) => void; hilfe?: ReactNode; platzhalter?: string;
}) {
  return <VpPicker label={label} options={optionen} value={wert} onChange={onWert} hint={hilfe} placeholder={platzhalter} />;
}

/** Eine Bedingung: optional ein Name (der Satz im Blatt „Warum?“), dazu die Formel. */
export interface Bedingung {
  name: string;
  formel: string;
}

/** Bedingungen aus der Textform: eine Formel oder eine Liste aus Formeln und `{Name: Formel}`. */
export function bedingungenAus(v: unknown): Bedingung[] {
  if (v === undefined || v === null) return [];
  const liste = Array.isArray(v) ? v : [v];
  return liste.map((c) => {
    if (c && typeof c === 'object') {
      const [name, formel] = Object.entries(c as Record<string, unknown>)[0] ?? ['', ''];
      return { name, formel: String(formel ?? '') };
    }
    return { name: '', formel: String(c) };
  });
}

/** Bedingungen in die Textform; leere Zeilen fallen weg, ohne Zeile das Feld. */
export function bedingungenIn(b: Bedingung[]): unknown {
  const liste = b.filter((c) => c.formel.trim()).map((c) => (c.name.trim() ? { [c.name.trim()]: c.formel.trim() } : c.formel.trim()));
  return liste.length ? liste : undefined;
}

export function BedingungenFeld({ label, hilfe, wert, onWert, marken }: {
  label: string; hilfe?: ReactNode; wert: Bedingung[]; onWert: (b: Bedingung[]) => void; marken: Marke[];
}) {
  const setze = (i: number, b: Partial<Bedingung>) => onWert(wert.map((x, j) => (j === i ? { ...x, ...b } : x)));
  return (
    <Feld label={label} hilfe={hilfe}>
      <div className="lk-zeilen">
        {wert.map((b, i) => (
          <div className="lk-zeile" key={i}>
            <div>
              <TextFeld label="Satz für den Kunden" wert={b.name} onWert={(name) => setze(i, { name })} platzhalter="z. B. Der Speicher ist warm" />
              <FormelFeld label="Formel" wert={b.formel} onWert={(formel) => setze(i, { formel })} marken={marken} platzhalter="z. B. t >= ziel" />
            </div>
            <button type="button" className="lk-weg" aria-label={`Bedingung ${i + 1} entfernen`} onClick={() => onWert(wert.filter((_, j) => j !== i))}>
              <Ic n="x" s={18} />
            </button>
          </div>
        ))}
        <button type="button" className="lnk lk-plus" onClick={() => onWert([...wert, { name: '', formel: '' }])}>
          <Ic n="plus" s={16} />
          Bedingung
        </button>
      </div>
    </Feld>
  );
}

/** Paare aus Name und Wert (Auswahl, Gegeben und Erwartet einer Probe). */
export function PaareFeld({ label, hilfe, wert, onWert, links, rechts }: {
  label: string; hilfe?: ReactNode; wert: [string, string][]; onWert: (p: [string, string][]) => void; links: string; rechts: string;
}) {
  const setze = (i: number, p: [string, string]) => onWert(wert.map((x, j) => (j === i ? p : x)));
  return (
    <Feld label={label} hilfe={hilfe}>
      <div className="lk-zeilen">
        {wert.map(([k, v], i) => (
          <div className="lk-zeile" key={i}>
            <div className="lk-zwei">
              <TextFeld label={links} wert={k} onWert={(x) => setze(i, [x, v])} mono />
              <TextFeld label={rechts} wert={v} onWert={(x) => setze(i, [k, x])} mono />
            </div>
            <button type="button" className="lk-weg" aria-label={`Zeile ${i + 1} entfernen`} onClick={() => onWert(wert.filter((_, j) => j !== i))}>
              <Ic n="x" s={18} />
            </button>
          </div>
        ))}
        <button type="button" className="lnk lk-plus" onClick={() => onWert([...wert, ['', '']])}>
          <Ic n="plus" s={16} />
          Zeile
        </button>
      </div>
    </Feld>
  );
}

export function paareAus(v: unknown): [string, string][] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>).map(([k, w]) => [k, w === true ? 'on' : w === false ? 'off' : String(w)]);
}

export function paareIn(p: [string, string][]): Record<string, string> | undefined {
  const o: Record<string, string> = {};
  for (const [k, v] of p) if (k.trim() && v.trim()) o[k.trim()] = v.trim();
  return Object.keys(o).length ? o : undefined;
}
