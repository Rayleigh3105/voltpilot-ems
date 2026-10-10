import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Netzanschluss, type NetzanschlussVorschlag, type StandortAmStichtag } from '../api';
import { useRollen } from '../rollen';
import * as N from '../netzanschlussListe';
import { VpPicker } from './VpPicker';
import { VpDatePicker } from './VpDatePicker';

export function NetzanschlussDialog({
  standort,
  liste,
  vorschlag,
  ziel,
  bestand,
  heute,
  onClose,
  onGespeichert,
}: {
  standort: StandortAmStichtag;
  liste: Netzanschluss[];
  vorschlag: string;
  ziel: Netzanschluss | null;
  bestand?: NetzanschlussVorschlag;
  heute: string;
  onClose: () => void;
  onGespeichert: (n: Netzanschluss) => void;
}) {
  const [e, setE] = useState<N.Entwurf>(() =>
    bestand
      ? {
          ...N.neuerEntwurf(bestand.kennzeichen),
          name: bestand.name,
          messung: '',
        }
      : N.neuerEntwurf(vorschlag),
  );
  const [anlage, setAnlage] = useState<string | null>(bestand?.anlage_id ?? null);
  const [ab, setAb] = useState(bestand?.bindung_ab ?? heute);
  const [grund, setGrund] = useState('');
  const [fehler, setFehler] = useState<Record<string, string>>({});
  const [meldung, setMeldung] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const rollen = useRollen();
  const rueckwirkend = Boolean((ziel || bestand) && ab < heute);
  const erlaubt =
    rollen.darf(N.RECHT, standort.id) &&
    (!rueckwirkend || rollen.darf('aenderung.rueckwirkend', standort.id));
  const urteil = ziel ? N.bindungPruefen(liste, ziel, anlage ?? '', ab, heute) : null;
  const aktuell = anlage ? N.anschlussDerAnlage(liste, anlage, heute) : null;
  const fokussiere = (id: string) =>
    requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`#na-${id}`)?.focus());
  const speichern = async () => {
    if (busy || !erlaubt) return;
    const f: Record<string, string> = ziel
      ? urteil?.feld
        ? { [urteil.feld]: urteil.text }
        : {}
      : N.pruefen(e, standort.id);
    if (bestand && !ab) f.ab = 'Bitte einen gültigen Tag wählen.';
    if (rueckwirkend && !grund.trim()) f.grund = 'Bitte die rückwirkende Änderung begründen.';
    setFehler(f);
    if (Object.keys(f).length) {
      fokussiere(Object.keys(f)[0]);
      return;
    }
    setBusy(true);
    setMeldung(null);
    try {
      onGespeichert(
        bestand
          ? await api.netzanschlussUebernehmen(standort.id, bestand.anlage_id, {
              ...N.anfrage(e),
              bindung_ab: ab,
              grund: grund.trim() || null,
            })
          : ziel
            ? await api.netzanschlussBinden(standort.id, ziel.id, {
                anlage_id: anlage!,
                gueltig_ab: ab,
                grund: grund.trim() || null,
              })
            : await api.netzanschlussAnlegen(standort.id, N.anfrage(e)),
      );
    } catch (err) {
      setMeldung(N.fehlerSatz(err));
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus());
    } finally {
      setBusy(false);
    }
  };
  const feldGeaendert = (key: string) =>
    setFehler((vorher) => {
      const danach = { ...vorher };
      delete danach[key];
      return danach;
    });
  const feld = (key: N.Feld, label: string, props = {}) => (
    <Input
      id={`na-${key}`}
      label={label}
      value={e[key]}
      disabled={busy}
      error={fehler[key]}
      onChange={(ev) => {
        feldGeaendert(key);
        setE((v) => ({ ...v, [key]: ev.target.value }));
      }}
      {...props}
    />
  );
  return (
    <Modal
      open
      title={bestand ? 'Vorschlag ergänzen' : ziel ? 'Anlage binden / wechseln' : N.ANLEGEN}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Abbrechen
          </Button>
          {erlaubt && (
            <Button type="submit" form="na-form" disabled={busy}>
              {busy ? 'Wird gespeichert …' : bestand ? 'Übernehmen' : 'Speichern'}
            </Button>
          )}
        </>
      }
    >
      <form
        ref={form}
        id="na-form"
        className="vp-na-form"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          void speichern();
        }}
      >
        {(ziel || bestand) && (
          <>
            {ziel && (
              <p>
                <strong>
                  {ziel.kennzeichen} · {ziel.name}
                </strong>
              </p>
            )}
            <VpPicker
              id="na-anlage"
              label="Anlage"
              value={anlage}
              options={N.anlagenOptionen(standort.anlagen, liste, heute)}
              placeholder="Anlage wählen …"
              search="immer"
              disabled={busy || Boolean(bestand)}
              error={fehler.anlage}
              onChange={(v) => {
                feldGeaendert('anlage');
                setAnlage(v);
              }}
            />
            {standort.anlagen.length === 0 && <p>An diesem Standort ist noch keine Anlage zugeordnet.</p>}
            {aktuell && (
              <p>
                Gebunden an {aktuell.kennzeichen}. Die neue Bindung ersetzt die bisherige ab dem gewählten
                Tag.
              </p>
            )}
            <VpDatePicker
              id="na-ab"
              label="Gilt ab"
              value={ab}
              onChange={(v) => {
                feldGeaendert('ab');
                setAb(v);
              }}
              disabled={busy}
              error={fehler.ab}
              min={rollen.darf('aenderung.rueckwirkend', standort.id) ? undefined : heute}
            />
            {urteil && !urteil.feld && <p>{urteil.text}</p>}
            {rueckwirkend && (
              <>
                <p className="vp-na-rueckwirkend">Rückwirkend</p>
                <Input
                  id="na-grund"
                  label="Begründung"
                  value={grund}
                  error={fehler.grund}
                  disabled={busy}
                  onChange={(ev) => {
                    feldGeaendert('grund');
                    setGrund(ev.target.value);
                  }}
                />
              </>
            )}
          </>
        )}
        {!ziel && (
          <>
            {bestand && (
              <p>
                Anlage und Bindungsbeginn sind vorausgewählt. Bitte ergänzen Sie die Angaben zum
                Netzanschluss. Erst „Übernehmen“ legt ihn an und bindet die Anlage.
              </p>
            )}
            {feld('name', 'Name', { autoFocus: true })}
            {feld('kennzeichen', 'Kennzeichen', {
              hint: 'Leer lassen für das nächste freie Kennzeichen.',
            })}
            {feld('malo', 'Marktlokation', {
              inputMode: 'numeric',
              maxLength: 11,
              hint: 'Freiwillig; elf Ziffern.',
            })}
            {feld('netzbetreiber', 'Netzbetreiber')}
            <div className="vp-na-felder">
              {feld('anschluss_kva', 'Anschlussleistung (kVA)', {
                inputMode: 'decimal',
              })}
              {feld('vereinbart_kw', 'Vereinbarte Leistung (kW)', {
                inputMode: 'decimal',
              })}
            </div>
            <VpPicker
              id="na-messung"
              label="Messung"
              placeholder="Bitte ergänzen …"
              error={fehler.messung}
              value={e.messung}
              options={[
                { value: 'RLM', label: 'RLM' },
                { value: 'SLP', label: 'SLP' },
              ]}
              disabled={busy}
              onChange={(v) => {
                if (v === 'RLM' || v === 'SLP') {
                  feldGeaendert('messung');
                  setE((e) => ({ ...e, messung: v }));
                }
              }}
            />
          </>
        )}
        {!erlaubt && <p role="note">{rollen.grund}</p>}
        {meldung && (
          <p role="alert" tabIndex={-1}>
            {meldung}
          </p>
        )}
      </form>
    </Modal>
  );
}
