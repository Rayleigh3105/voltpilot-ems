import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type OrtAktionen } from '../api';
import {
  archivierenFolgen,
  loeschenFolgen,
  wege,
  wiederherstellenFolgen,
  type ArchivObjektArt,
  type Folge,
} from '../ortArchiv';
import { alsOrtFehler } from '../standorte';
import './StandortDialog.css';
import './ArchivierenDialog.css';

/** `gesperrt` ist Z1: Archivieren geht gerade nicht — der Dialog nennt Grund und Weg. */
export type ArchivAktion = 'archivieren' | 'gesperrt' | 'wiederherstellen' | 'loeschen';

export interface ArchivObjekt {
  art: ArchivObjektArt;
  id: string;
  name: string;
  kurzzeichen: string;
  /** Woran es hängt (Name) — für den Protokollsatz beim Löschen. */
  eltern: string | null;
  /** Der Archivtag (ISO-Tag), nur an archivierten. */
  archiviertAm: string | null;
  aktionen: OrtAktionen | null;
}

/**
 * Die Rückfragen im Ortsbaum (UEMS AP-02 IP-15): Z1 „Archivieren nicht möglich“ mit Grund und
 * Weg, Z2 „… archivieren?“ mit der Folgenliste, Z3 „… wiederherstellen“ mit Namensprüfung (ein
 * belegter Name steht als Satz des Servers am Feld; umbenannt wird im selben Dialog) und die
 * Rückfrage vor dem Löschen ohne Historie (E1). Die Urteile sind die `aktionen` des Servers; die
 * Folgen formuliert `ortArchiv.ts`. Eine Ablehnung (z. B. inzwischen geändert) steht als Satz im
 * Dialog — nichts ist dann geschrieben.
 */
export function ArchivierenDialog({
  open,
  aktion,
  objekt,
  heute = null,
  onClose,
  onFertig,
}: {
  open: boolean;
  aktion: ArchivAktion;
  objekt: ArchivObjekt;
  /** Heute nach dem Server — für den Standort, dessen Wiederherstellen kein `aktionen` trägt. */
  heute?: string | null;
  onClose: () => void;
  onFertig: () => void;
}) {
  const basis = `vp-ad-${useId().replace(/:/g, '')}`;
  const archivieren = objekt.aktionen?.archivieren ?? null;
  const zurueck = objekt.aktionen?.wiederherstellen ?? null;
  const [name, setName] = useState(objekt.name);
  const [nameFehler, setNameFehler] = useState<string | null>(
    zurueck?.grund === 'name_belegt' ? zurueck.text : null,
  );
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameFeld = useRef<HTMLInputElement>(null);

  // Ein belegter Name ist der Anlass: der Fokus geht direkt an das Feld.
  useEffect(() => {
    if (aktion !== 'wiederherstellen' || !nameFehler) return;
    const r = requestAnimationFrame(() => nameFeld.current?.focus());
    return () => cancelAnimationFrame(r);
    // nur beim Öffnen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titel =
    aktion === 'gesperrt'
      ? 'Archivieren nicht möglich'
      : aktion === 'archivieren'
        ? `${objekt.name} archivieren?`
        : aktion === 'wiederherstellen'
          ? `${objekt.name} wiederherstellen`
          : `${objekt.name} löschen?`;

  async function senden(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setFehler(null);
    const neuerName = name.trim();
    if (aktion === 'wiederherstellen' && !neuerName) {
      setNameFehler('Der Name fehlt.');
      nameFeld.current?.focus();
      return;
    }
    setBusy(true);
    try {
      if (aktion === 'archivieren') {
        await (objekt.art === 'standort' ? api.standortArchivieren(objekt.id) : api.ortArchivieren(objekt.id));
      } else if (aktion === 'wiederherstellen') {
        const umbenannt = neuerName === objekt.name ? undefined : neuerName;
        await (objekt.art === 'standort'
          ? api.standortWiederherstellen(objekt.id, umbenannt)
          : api.ortWiederherstellen(objekt.id, umbenannt));
      } else if (aktion === 'loeschen') {
        await api.ortLoeschen(objekt.id);
      }
      onFertig();
    } catch (err) {
      const ort = err instanceof ApiError ? alsOrtFehler(err.body) : null;
      if (ort?.code === 'wiederherstellen_gesperrt' && ort.grund === 'name_belegt') {
        setNameFehler(ort.message);
        nameFeld.current?.focus();
      } else {
        setFehler(ort?.message ?? (err instanceof Error ? err.message : 'Das hat nicht geklappt.'));
      }
    } finally {
      setBusy(false);
    }
  }

  const fuss =
    aktion === 'gesperrt' ? (
      <Button onClick={onClose}>Schließen</Button>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
        <Button type="submit" form={`${basis}-form`} disabled={busy}>
          {aktion === 'archivieren' ? 'Archivieren' : aktion === 'wiederherstellen' ? 'Wiederherstellen' : 'Endgültig löschen'}
        </Button>
      </>
    );

  return (
    <Modal open={open} onClose={onClose} title={titel} footer={fuss}>
      <form id={`${basis}-form`} className="vp-sd vp-ad" noValidate onSubmit={(e) => void senden(e)}>
        {aktion === 'gesperrt' && archivieren && (
          <>
            <p className="vp-sd-vorspann">
              Solange an {objekt.name} etwas aktiv ist, wird nicht archiviert — nichts mit Historie verschwindet.
            </p>
            <p className="vp-ad-satz" data-testid="sperre-satz">
              {archivieren.text}
            </p>
            <section aria-labelledby={`${basis}-wege`}>
              <h3 id={`${basis}-wege`} className="vp-ad-titel">
                So geht es weiter
              </h3>
              <ul className="vp-ad-folgen vp-ad-folgen-gesperrt">
                {wege(archivieren.gruende).map((w) => (
                  <li key={w.wer}>
                    <Icon name="alert-triangle" size={16} />
                    <span className="vp-ad-folge">
                      <strong>{w.wer}</strong>
                      {w.weg && <span className="vp-ad-folge-text">{w.weg}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <p className="vp-ad-fuss">
              Danach steht im Menü „Archivieren …“. Alte Berichte zeigen {objekt.name} weiterhin.
            </p>
          </>
        )}

        {aktion === 'archivieren' && archivieren && (
          <>
            <p className="vp-sd-vorspann">{objekt.name} bleibt lesbar und in alten Berichten unverändert.</p>
            <FolgenListe titelId={`${basis}-folgen`} folgen={archivierenFolgen(objekt.art, archivieren)} />
          </>
        )}

        {aktion === 'wiederherstellen' && (
          <>
            <p className="vp-sd-vorspann">
              {objekt.name} kommt mit dem Kurzzeichen {objekt.kurzzeichen} zurück.
            </p>
            <Input
              ref={nameFeld}
              label="Name"
              value={name}
              error={nameFehler ?? undefined}
              hint={nameFehler ? undefined : 'Ist der Name inzwischen vergeben, geben Sie hier einen neuen ein.'}
              onChange={(e) => {
                setName(e.target.value);
                setNameFehler(null);
              }}
            />
            <FolgenListe
              titelId={`${basis}-folgen`}
              folgen={wiederherstellenFolgen(objekt.art, objekt.kurzzeichen, objekt.archiviertAm, zurueck?.ab ?? heute ?? '')}
            />
          </>
        )}

        {aktion === 'loeschen' && objekt.art !== 'standort' && (
          <>
            <p className="vp-sd-vorspann">Gelöscht wird nur, woran nie etwas hing.</p>
            <FolgenListe
              titelId={`${basis}-folgen`}
              folgen={loeschenFolgen(objekt.art, objekt.name, objekt.kurzzeichen, objekt.eltern)}
            />
          </>
        )}

        {fehler && (
          <p className="vp-ad-satz" role="alert">
            {fehler}
          </p>
        )}
      </form>
    </Modal>
  );
}

function FolgenListe({ titelId, folgen }: { titelId: string; folgen: Folge[] }) {
  return (
    <section aria-labelledby={titelId}>
      <h3 id={titelId} className="vp-ad-titel">
        Folgen
      </h3>
      <ul className="vp-ad-folgen">
        {folgen.map((f) => (
          <li key={f.titel}>
            <Icon name="check" size={16} />
            <span className="vp-ad-folge">
              <strong>{f.titel}</strong>
              <span className="vp-ad-folge-text">{f.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
