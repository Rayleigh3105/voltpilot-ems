/**
 * Der Text einer Logik mit Zeilennummern, Einfärbung und Meldungen an der Zeile (Steuerlogik Stufe 4, Bericht 9):
 * ein schlichtes Textfeld über einer eingefärbten Fläche - keine Editor-Bibliothek (Inhaltsrichtlinie des Portals).
 * `CodeLesen` zeigt ihn nur (am Telefon und für alle, die nicht schreiben), `CodeEditor` lässt schreiben.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, type KeyboardEvent } from 'react';
import type { LogikMeldung } from '../../api';
import { faerbeZeile } from './einfaerben';

/** Die schwerste Meldung je Zeile: Fehler und Proben vor Hinweisen. */
export function meldungenJeZeile(meldungen: LogikMeldung[]): Map<number, LogikMeldung[]> {
  const m = new Map<number, LogikMeldung[]>();
  for (const x of meldungen) {
    if (!x.zeile) continue;
    m.set(x.zeile, [...(m.get(x.zeile) ?? []), x]);
  }
  return m;
}

function artDerZeile(liste: LogikMeldung[] | undefined): string {
  if (!liste?.length) return '';
  return liste.some((x) => x.art !== 'hinweis') ? 'fehler' : 'hinweis';
}

function Stuecke({ zeile }: { zeile: string }) {
  return (
    <>
      {faerbeZeile(zeile).map((s, j) => (
        s.art === 'leer' || s.art === 'einzug' || s.art === 'bezeichner'
          ? <span key={j}>{s.t}</span>
          : <span key={j} className={`t-${s.art}`}>{s.t}</span>
      ))}
    </>
  );
}

function Zeilen({ text, jeZeile, umbruch, ab = 1 }: { text: string; jeZeile: Map<number, LogikMeldung[]>; umbruch: boolean; ab?: number }) {
  const zeilen = text.split('\n');
  return (
    <pre aria-hidden="true">
      {zeilen.map((z, i) => {
        const einzug = umbruch ? (z.match(/^(\s*(-\s+)?)/)?.[0].length ?? 0) : 0;
        return (
          <span
            key={i}
            className={artDerZeile(jeZeile.get(i + ab))}
            style={umbruch && einzug ? { paddingLeft: `${einzug}ch`, textIndent: `-${einzug}ch` } : undefined}
          >
            <Stuecke zeile={z} />
            {z === '' ? '​' : null}
          </span>
        );
      })}
    </pre>
  );
}

function Rinne({ anzahl, jeZeile, onZeile, ab = 1 }: { anzahl: number; jeZeile: Map<number, LogikMeldung[]>; onZeile?: (z: number) => void; ab?: number }) {
  return (
    <div className="lk-rinne" aria-hidden="true">
      {Array.from({ length: anzahl }, (_, i) => {
        const liste = jeZeile.get(i + ab);
        const art = artDerZeile(liste);
        return (
          <span key={i} className={art} title={liste?.map((x) => x.text).join('\n')} onMouseDown={onZeile ? (e) => { e.preventDefault(); onZeile(i + 1); } : undefined}>
            {art ? <i /> : null}
            {i + ab}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Der Text nur zum Lesen. Ohne `immer` steht er nur am Telefon (statt des Textfelds); `umbruch` bricht lange Zeilen
 * mit hängendem Einzug um (am Telefon und in Blättern), sonst scrollt der Rahmen.
 */
export function CodeLesen({ text, meldungen, label, immer, umbruch = true, ab = 1 }: {
  text: string; meldungen: LogikMeldung[]; label: string; immer?: boolean; umbruch?: boolean; ab?: number;
}) {
  const jeZeile = useMemo(() => meldungenJeZeile(meldungen), [meldungen]);
  if (umbruch) {
    // Mit Umbruch trägt jede Zeile ihre Nummer selbst: eine umbrochene Zeile ist höher, die Nummer bleibt bei ihr.
    return (
      <div className={`lk-code lk-umbruch${immer ? '' : ' lk-lesen'}`} role="region" aria-label={label} tabIndex={0}>
        <div className="lk-uz-liste" aria-hidden="true">
          {text.split('\n').map((z, i) => {
            const art = artDerZeile(jeZeile.get(i + ab));
            const einzug = z.match(/^(\s*(-\s+)?)/)?.[0].length ?? 0;
            return (
              <div key={i} className={`lk-uz ${art}`} title={jeZeile.get(i + ab)?.map((x) => x.text).join('\n')}>
                <span className="lk-uz-nr">{art ? <i /> : null}{i + ab}</span>
                <span className="lk-uz-code" style={einzug ? { paddingLeft: `calc(${einzug}ch + 10px)`, textIndent: `-${einzug}ch` } : undefined}>
                  <Stuecke zeile={z} />
                </span>
              </div>
            );
          })}
        </div>
        <span className="sr">{text}</span>
      </div>
    );
  }
  return (
    <div className={`lk-code${immer ? '' : ' lk-lesen'}`} role="region" aria-label={label} tabIndex={0}>
      <div className="lk-code-innen">
        <Rinne anzahl={text.split('\n').length} jeZeile={jeZeile} ab={ab} />
        <div className="lk-flaeche">
          <Zeilen text={text} jeZeile={jeZeile} umbruch={umbruch} ab={ab} />
        </div>
      </div>
      <span className="sr">{text}</span>
    </div>
  );
}

export interface CodeEditorGriff {
  /** Setzt den Cursor an den Anfang einer Zeile und zeigt sie. */
  zuZeile: (zeile: number) => void;
}

/**
 * Das Textfeld: es liegt deckungsgleich über der eingefärbten Fläche (gleiche Schrift, gleiche Zeilenhöhe, kein
 * Umbruch); es wächst mit dem Text, gescrollt wird der Rahmen. Tab rückt um zwei Leerzeichen ein (YAML kennt keine
 * Tabulatoren), Umschalt+Tab aus; Escape verlässt das Feld, damit die Tastatur nicht gefangen bleibt.
 */
export const CodeEditor = forwardRef<CodeEditorGriff, {
  text: string;
  meldungen: LogikMeldung[];
  label: string;
  onText: (t: string) => void;
}>(function CodeEditor({ text, meldungen, label, onText }, ref) {
  const feld = useRef<HTMLTextAreaElement>(null);
  const rahmen = useRef<HTMLDivElement>(null);
  const jeZeile = useMemo(() => meldungenJeZeile(meldungen), [meldungen]);
  const zeilen = text.split('\n');
  const breite = Math.max(...zeilen.map((z) => z.length)) + 4;

  const zuZeile = (zeile: number) => {
    const t = feld.current;
    if (!t) return;
    const offset = zeilen.slice(0, Math.max(0, zeile - 1)).reduce((n, z) => n + z.length + 1, 0);
    t.focus({ preventScroll: true });
    t.setSelectionRange(offset, offset + (zeilen[zeile - 1]?.length ?? 0));
    const r = rahmen.current;
    if (r) {
      const oben = (zeile - 1) * 20;
      if (oben < r.scrollTop || oben > r.scrollTop + r.clientHeight - 60) r.scrollTop = Math.max(0, oben - r.clientHeight / 3);
      r.scrollLeft = 0;
    }
  };
  useImperativeHandle(ref, () => ({ zuZeile }));

  const taste = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    if (e.key === 'Escape') {
      t.blur();
      return;
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b, value } = t;
    const anfang = value.lastIndexOf('\n', a - 1) + 1;
    if (e.shiftKey) {
      const block = value.slice(anfang, b);
      const neu = block.replace(/^ {1,2}/gm, '');
      onText(value.slice(0, anfang) + neu + value.slice(b));
      requestAnimationFrame(() => t.setSelectionRange(Math.max(anfang, a - 2), b - (block.length - neu.length)));
    } else if (a === b) {
      onText(`${value.slice(0, a)}  ${value.slice(b)}`);
      requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
    } else {
      const block = value.slice(anfang, b);
      const neu = block.replace(/^/gm, '  ');
      onText(value.slice(0, anfang) + neu + value.slice(b));
      requestAnimationFrame(() => t.setSelectionRange(a + 2, b + (neu.length - block.length)));
    }
  };

  return (
    <div className="lk-code lk-editor" ref={rahmen}>
      <div className="lk-code-innen">
        <Rinne anzahl={zeilen.length} jeZeile={jeZeile} onZeile={zuZeile} />
        <div className="lk-flaeche" style={{ minWidth: `calc(${breite}ch + 28px)` }}>
          <Zeilen text={text} jeZeile={jeZeile} umbruch={false} />
          <textarea
            ref={feld}
            aria-label={label}
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            wrap="off"
            onChange={(e) => onText(e.target.value)}
            onKeyDown={taste}
          />
        </div>
      </div>
    </div>
  );
});
