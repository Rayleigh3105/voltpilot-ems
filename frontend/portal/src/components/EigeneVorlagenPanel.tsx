/**
 * „Meine Vorlagen" - die EIGENEN Gerätevorlagen einer Anlage (Einheitsmodell
 * Stufe 6, Vervollständigung der Selbstbau-Tür).
 *
 * <p>Der Kern der Stufe 3 war der Weg IN eine Vorlage („Duplizieren"); es fehlte
 * alles danach: die Liste hatte im Portal keinen einzigen Aufrufer, es gab kein
 * Umbenennen (die erste Vorlage heißt automatisch „… (Vorlage)") und keinen Weg
 * ZURÜCK - aus einer Vorlage ein Gerät zu machen.
 *
 * <p>Diese Datei RENDERT nur; jede Regel und jeder Satz kommt aus dem reinen
 * `eigeneVorlagen.ts`.
 *
 * <p><b>Sie erscheint nur auf einer PORTAL-verwalteten Anlage</b> - dieselbe
 * Grenze wie beim Assistenten daneben: auf einer box-verwalteten Anlage besäße
 * die Box die Wahrheit, und ein Anlege-Weg von hier wäre eine Sackgasse.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { ApiError, api, type SiteComponentTemplate } from '../api';
import {
  KEINE_ADRESSE,
  kopfSatz,
  loeschFolgen,
  nameFehler,
  zeilen,
  type VorlagenZeile,
} from '../eigeneVorlagen';
import { ConfirmDialog } from './ConfirmDialog';
import './EigeneVorlagen.css';

export function EigeneVorlagenPanel({
  siteId,
  onAnlegen,
}: {
  siteId: string;
  /** Aus dieser Vorlage ein Gerät machen - der Wirt öffnet den Assistenten. */
  onAnlegen?: (vorlage: SiteComponentTemplate) => void;
}): JSX.Element | null {
  const [list, setList] = useState<SiteComponentTemplate[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [ask, setAsk] = useState<VorlagenZeile | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .siteComponentTemplates(siteId)
      .then((t) => alive && setList(t))
      .catch(() => {
        // Fail-soft: eine Anlage ohne eigene Vorlagen ist der Normalfall, und
        // ein Ladefehler darf das Anlagen-Modell nicht blockieren.
        if (alive) setList([]);
      });
    return () => {
      alive = false;
    };
  }, [siteId]);

  if (list == null) return null;

  const rows = zeilen(list);

  async function run(action: () => Promise<SiteComponentTemplate[]>) {
    setBusy(true);
    setFehler(null);
    try {
      setList(await action());
      return true;
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Das hat nicht geklappt.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function starteEdit(row: VorlagenZeile) {
    const v = list?.find((t) => t.templateRef === row.templateRef);
    setEdit(row.templateRef);
    setName(row.label);
    setNote(v?.note ?? '');
    setNameError(null);
  }

  async function speichern(ref: string) {
    const problem = nameFehler(name);
    if (problem) {
      setNameError(problem);
      return;
    }
    const ok = await run(() =>
      api.renameSiteComponentTemplate(siteId, ref, {
        label: name.trim(),
        note: note.trim() || null,
      }),
    );
    if (ok) setEdit(null);
  }

  return (
    <section className="vp-eigenevorlagen" data-testid="eigene-vorlagen">
      <header>
        <h3>Meine Vorlagen</h3>
        <p className="vp-muted">{kopfSatz(rows.length)}</p>
      </header>

      {fehler && <div className="vp-alert vp-alert-err">{fehler}</div>}

      {rows.length > 0 && (
        <>
          <ul className="vp-ev-list">
            {rows.map((r) => (
              <li key={r.templateRef}>
                {edit === r.templateRef ? (
                  <div className="vp-ev-edit">
                    <Input
                      label="Name"
                      value={name}
                      autoFocus
                      onChange={(e) => {
                        setName(e.target.value);
                        setNameError(null);
                      }}
                      error={nameError ?? undefined}
                    />
                    <Input
                      label="Notiz (optional)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      hint="Leer lassen entfernt die Notiz."
                    />
                    <div className="vp-ev-actions">
                      <Button variant="ghost" size="sm" onClick={() => setEdit(null)}>
                        Abbrechen
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => void speichern(r.templateRef)}>
                        Speichern
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="vp-ev-main">
                      <strong>{r.label}</strong>
                      <span className="vp-muted">{r.umfang}</span>
                      {r.note && <span className="vp-muted vp-ev-note">{r.note}</span>}
                    </div>
                    <div className="vp-ev-actions">
                      {onAnlegen && r.verwendbar && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            const v = list.find((t) => t.templateRef === r.templateRef);
                            if (v) onAnlegen(v);
                          }}
                        >
                          Gerät daraus anlegen
                        </Button>
                      )}
                      <button
                        type="button"
                        className="vp-ev-icon"
                        aria-label={`„${r.label}" umbenennen`}
                        onClick={() => starteEdit(r)}
                      >
                        <Icon name="pencil" size={16} />
                      </button>
                      <button
                        type="button"
                        className="vp-ev-icon vp-ev-del"
                        aria-label={`„${r.label}" löschen`}
                        onClick={() => setAsk(r)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="vp-muted vp-ev-hint">{KEINE_ADRESSE}</p>
        </>
      )}

      <ConfirmDialog
        open={ask != null}
        title="Vorlage löschen?"
        intro={ask ? `„${ask.label}" wird aus Ihrer Auswahl entfernt.` : ''}
        consequences={ask ? loeschFolgen(ask) : []}
        confirmLabel="Löschen"
        tone="danger"
        busy={busy}
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          if (!ask) return;
          const ok = await run(() => api.deleteSiteComponentTemplate(siteId, ask.templateRef));
          if (ok) setAsk(null);
        }}
      />
    </section>
  );
}
