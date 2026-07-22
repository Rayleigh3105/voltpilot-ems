/**
 * Portal v3 M5 · Part D - the inspector editor for the sandboxed code node
 * (`vp.logic.function`, contract decision D-16).
 *
 * A PLAIN TEXTAREA on purpose: the portal's production nginx serves
 * `script-src 'self'` WITHOUT `unsafe-inline`, so a CDN editor (Monaco & co.)
 * cannot load and an inline bootstrap script would be blocked silently
 * (`npm run test:csp` guards this). A monospace textarea with a character
 * counter is honest and works offline.
 *
 * Render-only: the length rule lives in `flows/validate.ts` (and its Java +
 * flowc twins), the runtime safety in flowc's watchdog wrapper.
 */
import { Icon } from '../../../designsystem/components/core/Icon';

interface CodeNodeEditorProps {
  value: string;
  maxLength: number;
  timeoutMs: number | null;
  onChange: (code: string) => void;
  onTimeoutChange: (ms: number | null) => void;
  inputId: string;
}

export function CodeNodeEditor({
  value,
  maxLength,
  timeoutMs,
  onChange,
  onTimeoutChange,
  inputId,
}: CodeNodeEditorProps) {
  const used = value.length;
  const over = used > maxLength;
  return (
    <div className="vp-codenode">
      <label htmlFor={inputId}>
        <Icon name="code" size={14} /> Ihr Code
      </label>
      <textarea
        id={inputId}
        className="vp-codenode-area"
        spellCheck={false}
        rows={10}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={`${inputId}-help`}
      />
      <p className={`vp-codenode-count${over ? ' over' : ''}`}>
        {used} / {maxLength} Zeichen
      </p>
      <p className="vp-flowed-help" id={`${inputId}-help`}>
        <code>wert</code> ist der Wert am Eingang. Geben Sie mit <code>return</code> eine Zahl
        zurück - <code>null</code> bedeutet „nichts weitergeben".
      </p>

      <div className="vp-flowed-fld">
        <label htmlFor={`${inputId}-timeout`}>Zeitlimit (ms)</label>
        <input
          id={`${inputId}-timeout`}
          type="number"
          className="vp-select"
          min={1}
          max={500}
          value={timeoutMs == null ? '' : String(timeoutMs)}
          onChange={(e) => onTimeoutChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      </div>

      {/* The three clamps, stated plainly - this is what makes an open code
          node safe to hand to a customer (D1/D-16). */}
      <ul className="vp-codenode-clamps">
        <li>
          <Icon name="shield" size={13} /> Läuft <b>nur auf Ihrem Gerät</b> - nie in der Cloud.
        </li>
        <li>
          <Icon name="shield" size={13} /> Bricht nach dem Zeitlimit ab und meldet einen Fehler -
          er kann die Anlage nicht blockieren.
        </li>
        <li>
          <Icon name="shield" size={13} /> Kann ein Gerät nur <b>wünschen</b>: die Schutzgrenzen
          Ihrer Anlage (§ 14a, Lade-/Entladegrenzen, Ladestand) begrenzen jeden Befehl.
        </li>
      </ul>
    </div>
  );
}
