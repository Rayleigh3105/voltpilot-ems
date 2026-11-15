/**
 * Die Ansicht „Text“ (Steuerlogik Stufe 4, Bericht 13): die YAML-Schreibform mit englischen Wörtern (E9 = B),
 * Zeilennummern, eigener Einfärbung und den Meldungen der Prüfung an ihrer Zeile. Am Telefon lesbar, geschrieben
 * wird am Rechner. Daneben die Wortliste als Nachschlageseite.
 */
import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { LogikMeldung } from '../../api';
import { Ic } from '../Ic';
import { CodeEditor, CodeLesen, type CodeEditorGriff } from './Code';
import { WoerterBlatt } from './WoerterBlatt';

export interface TextAnsichtProps {
  text: string;
  darf: boolean;
  meldungen: LogikMeldung[];
  onText: (t: string) => void;
}

/** Fehler und Proben zuerst, dann Hinweise; je Art nach Zeile. */
export function sortiert(meldungen: LogikMeldung[]): LogikMeldung[] {
  const rang = (m: LogikMeldung) => (m.art === 'hinweis' ? 1 : 0);
  return [...meldungen].sort((a, b) => rang(a) - rang(b) || (a.zeile ?? 1e9) - (b.zeile ?? 1e9));
}

export const TextAnsicht = forwardRef<CodeEditorGriff, TextAnsichtProps>(function TextAnsicht({ text, darf, meldungen, onText }, ref) {
  const editor = useRef<CodeEditorGriff>(null);
  const [woerter, setWoerter] = useState(false);
  useImperativeHandle(ref, () => ({ zuZeile: (z: number) => editor.current?.zuZeile(z) }));
  const liste = sortiert(meldungen);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div className="lk-text-kopf">
        <span className="meta">YAML · {text.split('\n').length} Zeilen{darf ? '' : ' · nur lesen'}</span>
        <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); setWoerter(true); }}>
          <Ic n="list" s={16} />
          Wörter
        </button>
      </div>
      {darf ? (
        <>
          <CodeEditor ref={editor} text={text} meldungen={meldungen} label="Text der Logik" onText={onText} />
          <CodeLesen text={text} meldungen={meldungen} label="Text der Logik" />
          <p className="leise lk-lesen-hinweis">Schreiben geht am Rechner. Einzelne Einträge ändern Sie im Aufbau.</p>
        </>
      ) : (
        <CodeLesen text={text} meldungen={meldungen} label="Text der Logik" immer umbruch={false} />
      )}
      {liste.length ? (
        <ul className="lk-meldungen" aria-label="Meldungen der Prüfung">
          {liste.map((m, i) => (
            <li key={i}>
              <button type="button" className={m.art === 'hinweis' ? 'hinweis' : undefined} disabled={!m.zeile}
                onClick={() => m.zeile && editor.current?.zuZeile(m.zeile)}>
                <Ic n={m.art === 'hinweis' ? 'info' : 'alert'} s={16} />
                <b>{m.zeile ? `Zeile ${m.zeile}` : m.art === 'hinweis' ? 'Hinweis' : 'Fehler'}</b>
                <span>{m.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {woerter ? <WoerterBlatt onClose={() => setWoerter(false)} /> : null}
    </div>
  );
});
