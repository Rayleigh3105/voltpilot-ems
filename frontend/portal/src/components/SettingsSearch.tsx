import { useId, useState } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { GROUP_LABEL, noHitText, SEARCH_PLACEHOLDER, searchSettings } from '../glossar';
import type { SettingsGroupId } from '../settingsNav';

/**
 * Das Suchfeld über den Gruppen (E6, Report §7 P9 / Befund B10). Es sucht über
 * Label **und Synonym** — „Strompreis", „Arbeitspreis", „ct/kWh" und selbst der
 * alte Name „Anlagentyp" landen an der richtigen Zeile. Alle Regeln stehen rein
 * in `src/glossar.ts`; diese Komponente rendert nur.
 *
 * Ein Treffer SPRINGT in seine Gruppe (und klappt sie am Telefon auf) — die
 * Suche filtert die Seite bewusst NICHT weg: das vollständige Inventar an einem
 * Ort ist die Zusage der Seite (P1), und eine gefilterte Liste nähme sie zurück.
 */
export function SettingsSearch({ onJump }: { onJump: (group: SettingsGroupId) => void }) {
  const [query, setQuery] = useState('');
  const inputId = useId();
  const listId = useId();
  const trimmed = query.trim();
  const hits = searchSettings(query);
  const open = trimmed.length > 0;

  function jump(group: SettingsGroupId) {
    setQuery('');
    onJump(group);
  }

  return (
    <div className="vp-set-search">
      <label className="vp-visually-hidden" htmlFor={inputId}>
        Einstellung suchen
      </label>
      <div className="vp-set-search-box">
        <Icon name="search" size={17} />
        <input
          id={inputId}
          type="search"
          className="vp-set-search-input"
          placeholder={SEARCH_PLACEHOLDER}
          value={query}
          autoComplete="off"
          aria-controls={listId}
          aria-expanded={open}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits.length > 0) {
              e.preventDefault();
              jump(hits[0].group);
            }
            if (e.key === 'Escape') setQuery('');
          }}
        />
      </div>
      {open ? (
        <div className="vp-set-search-res" id={listId}>
          {hits.length === 0 ? (
            <p className="vp-set-search-none">{noHitText(trimmed)}</p>
          ) : (
            <ul className="vp-set-search-list">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button type="button" className="vp-set-search-hit" onClick={() => jump(hit.group)}>
                    <span className="vp-set-search-lbl">
                      {hit.label}
                      {hit.fachwort ? <small>{hit.fachwort}</small> : null}
                    </span>
                    <span className="vp-set-search-grp">{GROUP_LABEL[hit.group]}</span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
