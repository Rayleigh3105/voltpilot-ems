import { Recht } from './Recht';
/**
 * Der FAHRZEUG-Dialog (Verbrauchsmanagement v1 / P7): eine Ladekarte benennen
 * und ihr eine Steuerart geben.
 *
 * ⚠ Er ist bewusst KEIN zweiter Steuerart-Dialog. Der große vierschrittige
 * Dialog (P2) fragt Quelle → Einstellungen → Ziel → Folgen; hier gibt es nur
 * die QUELLE, weil eine Sitzung nur sie tragen kann — und ein Schritt, der
 * nichts fragt, ist keine Frage. Was fehlt, wird GESAGT
 * (`KEIN_ZIEL_HINWEIS`), nicht verschwiegen.
 *
 * ⚠ Die Auswahl kommt aus dem KONTRAKT, nicht vom Server: welche Quellen eine
 * Sitzung tragen kann, entscheidet die Quellen-Bahn der Box, und die ist ein
 * Vertrag, kein Typ-Merkmal. Der Server prüft dieselbe Menge ein zweites Mal
 * (`FahrzeugSteuerart.QUELLEN`) — dem Client zu glauben wäre keine Prüfung.
 */
import { useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { VpPicker } from './VpPicker';
import {
  entfernenFolgen,
  folgen,
  KEIN_ZIEL_HINWEIS,
  MODUS_TEXT,
  OHNE_STEUERART,
  QUELLE_TEXT,
  wunschAus,
  type Fahrzeug,
  type FahrzeugQuelle,
  type FahrzeugWunsch,
  type FahrzeugZeile,
} from '../fahrzeugProfile';
// ⚠ Ein Bauteil bringt sein Stylesheet SELBST mit (die RegelKarten-Lehre, im
// Browser-Beweis gefunden): der Dialog trägt `vp-fz-*` und wird seit P7 von
// ZWEI Wirten geöffnet - der Fahrzeuge-Karte UND dem Ladevorgangs-Verlauf.
// Sich auf den Import des Wirts zu verlassen liefert dem zweiten eine
// ungestylte Fläche.
import './FahrzeugeKarte.css';

export interface FahrzeugDialogProps {
  zeile: FahrzeugZeile;
  fahrzeug: Fahrzeug | null;
  onClose: () => void;
  onSpeichern: (tagRef: string, wunsch: FahrzeugWunsch) => Promise<void>;
  onEntfernen?: (tagRef: string) => Promise<void>;
}

export function FahrzeugDialog({
  zeile, fahrzeug, onClose, onSpeichern, onEntfernen,
}: FahrzeugDialogProps) {
  const [name, setName] = useState(fahrzeug?.name ?? '');
  const [quelle, setQuelle] = useState<FahrzeugQuelle | null>(
    (fahrzeug?.steuerart?.quelle as FahrzeugQuelle | undefined) ?? null,
  );
  const [modus, setModus] = useState<'pausieren' | 'mindestleistung'>(
    fahrzeug?.steuerart?.ueberschussModus === 'mindestleistung' ? 'mindestleistung' : 'pausieren',
  );
  const [kw, setKw] = useState(
    fahrzeug?.steuerart?.mindestleistungKw != null
      ? String(fahrzeug.steuerart.mindestleistungKw).replace('.', ',') : '',
  );
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const entwurf = {
    name,
    quelle,
    ueberschussModus: modus,
    mindestleistungKw: zahl(kw),
  };
  const anzeigeName = name.trim() || zeile.name;

  const speichern = () => {
    setBusy(true);
    setFehler(null);
    onSpeichern(zeile.tagRef, wunschAus(entwurf))
      .then(onClose)
      .catch((e) => setFehler(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.'))
      .finally(() => setBusy(false));
  };

  const entfernen = () => {
    if (!onEntfernen) return;
    setBusy(true);
    setFehler(null);
    onEntfernen(zeile.tagRef)
      .then(onClose)
      .catch((e) => setFehler(e instanceof Error ? e.message : 'Entfernen fehlgeschlagen.'))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={zeile.name}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Abbrechen</Button>
          <Recht aktion="ladepunkt.betrieb"><Button onClick={speichern} disabled={busy}>Speichern</Button></Recht>
        </>
      )}
    >
      <div className="vp-fz-form">
        <Input
          label="Name für dieses Fahrzeug"
          value={name}
          onChange={(e: { target: { value: string } }) => setName(e.target.value)}
          placeholder="z. B. Dienstwagen"
          autoComplete="off"
        />

        <div>
          <p className="vp-fz-intro">Wie soll dieses Fahrzeug laden?</p>
          <div className="vp-fz-karten">
            {/* ⚠ Die RÜCKNAHME steht als eigene Wahl da, nicht als versteckter
                Sonderfall: „lädt wie der Ladepunkt" ist der Anfangszustand jeder
                Karte, und ohne diese Karte gäbe es keinen Weg zurück. */}
            <button
              type="button"
              className={`vp-fz-karte${quelle === null ? ' is-gewaehlt' : ''}`}
              aria-pressed={quelle === null}
              onClick={() => setQuelle(null)}
            >
              <b>{OHNE_STEUERART}</b>
              <small>Diese Karte folgt der Steuerart des Ladepunkts, an dem sie steckt.</small>
            </button>
            {(Object.keys(QUELLE_TEXT) as FahrzeugQuelle[]).map((q) => (
              <button
                key={q}
                type="button"
                className={`vp-fz-karte${quelle === q ? ' is-gewaehlt' : ''}`}
                aria-pressed={quelle === q}
                onClick={() => setQuelle(q)}
              >
                <b>{QUELLE_TEXT[q].titel}</b>
                <small>{QUELLE_TEXT[q].text}</small>
              </button>
            ))}
          </div>
        </div>

        {quelle === 'ueberschuss' && (
          <>
            <VpPicker
              id="fz-modus"
              label="Wenn die Sonne nicht reicht"
              options={[
                { value: 'pausieren', label: MODUS_TEXT.pausieren },
                { value: 'mindestleistung', label: MODUS_TEXT.mindestleistung },
              ]}
              value={modus}
              onChange={(v) => setModus(v === 'mindestleistung' ? 'mindestleistung' : 'pausieren')}
            />
            {modus === 'mindestleistung' && (
              <Input
                label="Mindestleistung (kW)"
                value={kw}
                onChange={(e: { target: { value: string } }) => setKw(e.target.value)}
                placeholder="4,2"
                inputMode="decimal"
                autoComplete="off"
              />
            )}
          </>
        )}

        <p className="vp-fz-note">{KEIN_ZIEL_HINWEIS}</p>

        <div>
          <p className="vp-fz-intro">Das passiert jetzt</p>
          <ul className="vp-fz-folgen">
            {folgen(entwurf, anzeigeName).map((s) => <li key={s}>{s}</li>)}
          </ul>
        </div>

        {zeile.hatProfil && onEntfernen && (
          <div>
            <ul className="vp-fz-folgen">
              {entfernenFolgen(anzeigeName).map((s) => <li key={s}>{s}</li>)}
            </ul>
            <Recht aktion="ladepunkt.betrieb"><Button variant="ghost" onClick={entfernen} disabled={busy}>
              Profil entfernen
            </Button></Recht>
          </div>
        )}

        {fehler && <p className="vp-fz-fehler">{fehler}</p>}
      </div>
    </Modal>
  );
}

/** „4,2" → 4.2; alles andere ist keine Zahl und wird nicht geraten. */
function zahl(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
