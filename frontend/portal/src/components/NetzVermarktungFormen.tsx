/**
 * Die Blätter der Stammdaten Netz und Vermarktung in Anlage › Einstellungen › „Strom & Geld“ (UEMS EZ-10,
 * Konzept §4.2/§3.10): Direktvermarkter (Freitext + Kanal), Einspeisemanagement und je Erzeugungseinheit
 * Bezeichnung und MaStR-Nummer. Die Felder legt EZ-6 im Modell an; hier werden sie nur bearbeitbar.
 *
 * Umbenennen ändert nur die Anzeige - der Name im Registerbild bleibt und weicht er ab, steht ein Hinweis da.
 * Der Netzbetreiber steht am Netzanschluss; dieses Blatt erklärt das nur. `PUT …/netz-vermarktung` ersetzt
 * Direktvermarkter UND Einspeisemanagement - jedes Formular schickt das jeweils andere unverändert mit.
 */
import { useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  type DirektvermarkterKanal,
  type Einspeisemanagement,
  type Erzeugungseinheit,
  type NetzVermarktung,
  type NetzVermarktungAendern,
} from '../api';
import {
  einheitName,
  einheitNummer,
  einheitTyp,
  EINSPEISEMANAGEMENT_WORT,
  SEE_MUSTER,
  typHinweis,
} from '../anlagensteuerung';
import { zahl } from '../zahl';
import { Recht } from './Recht';
import { VpPicker } from './VpPicker';

const NICHT_ERFASST = '';
const KONFLIKT = 'Die Stammdaten wurden inzwischen geändert. Bitte schließen Sie das Blatt und öffnen Sie es erneut.';
const FEHLER = 'Die Änderung wurde nicht gespeichert. Bitte versuchen Sie es erneut.';

function basis(nv: NetzVermarktung): NetzVermarktungAendern {
  return {
    expected_revision: nv.revision,
    direktvermarkter: nv.direktvermarkter,
    direktvermarkter_kanal: nv.direktvermarkter_kanal,
    einspeisemanagement: nv.einspeisemanagement,
    einspeisemanagement_prozent: nv.einspeisemanagement_prozent,
  };
}

function fehlerText(e: unknown): string {
  return e instanceof ApiError && e.status === 409 ? KONFLIKT : FEHLER;
}

function Aktionen({ busy, recht, onCancel, onSave }: { busy: boolean; recht: string; onCancel: () => void; onSave: () => void }) {
  return (
    <div className="vp-tech-editactions">
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        Abbrechen
      </Button>
      <Recht aktion={recht}>
        <Button variant="primary" size="sm" onClick={onSave} disabled={busy}>
          {busy ? 'Wird gespeichert…' : 'Speichern'}
        </Button>
      </Recht>
    </div>
  );
}

/** Der Netzbetreiber: nur gelesen - er steht am Netzanschluss des Standorts. */
export function NetzbetreiberBlatt({ nv }: { nv: NetzVermarktung }) {
  return (
    <div className="vp-einst-blatt">
      <p className="vp-einst-gross">{nv.netzbetreiber ?? 'nicht eingetragen'}</p>
      <p className="vp-note">
        Der Netzbetreiber steht am Netzanschluss des Standorts und gilt für alle Anlagen daran. Ändern Sie ihn dort.
      </p>
      {nv.hinweise.map((h) => (
        <div key={h.art} className="vp-alert vp-alert-warn" role="status">
          {h.text}
        </div>
      ))}
      {nv.namen_aus_bild?.netzbetreiber && nv.hinweise.length === 0 && (
        <p className="vp-note">Die Steuerung nennt denselben Netzbetreiber.</p>
      )}
    </div>
  );
}

export function DirektvermarkterForm({
  siteId,
  nv,
  onCancel,
  onSaved,
}: {
  siteId: string;
  nv: NetzVermarktung;
  onCancel: () => void;
  onSaved: (nv: NetzVermarktung) => void;
}) {
  const [name, setName] = useState(nv.direktvermarkter ?? '');
  const [kanal, setKanal] = useState<string>(nv.direktvermarkter_kanal ?? NICHT_ERFASST);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const bild = nv.namen_aus_bild?.direktvermarkter ?? null;

  async function save() {
    if (name.trim().length > 120) {
      setError('Der Name hat höchstens 120 Zeichen.');
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.netzVermarktungAendern(siteId, {
          ...basis(nv),
          direktvermarkter: name.trim() || null,
          direktvermarkter_kanal: kanal === NICHT_ERFASST ? null : (kanal as DirektvermarkterKanal),
        }),
      );
    } catch (e) {
      setError(fehlerText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-tech-editform">
      <div className="vp-form-stack">
        <Input
          ref={nameRef}
          label="Direktvermarkter"
          value={name}
          maxLength={120}
          autoFocus
          placeholder={bild ?? 'z. B. Name des Direktvermarkters'}
          hint={
            bild
              ? `Die Steuerung nennt „${bild}“. Ihr Name ändert nur die Anzeige.`
              : 'Leer lassen, wenn die Anlage keinen Direktvermarkter hat.'
          }
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <VpPicker
          id="nv-kanal"
          label="Weg der Vorgaben"
          options={[
            { value: 'relais_ma', label: 'Relais und 4–20 mA', sub: 'z. B. Poolbox mit Kontakten und Sollwert-Signal' },
            { value: 'modbus', label: 'Modbus', sub: 'Der Direktvermarkter schreibt in die Steuerung' },
            { value: 'keiner', label: 'Kein Signal an die Steuerung', sub: 'Vermarktung ohne Fernsteuerung' },
            { value: NICHT_ERFASST, label: 'Nicht erfasst' },
          ]}
          value={kanal}
          onChange={setKanal}
        />
      </div>
      {error && (
        <div className="vp-alert vp-alert-err" role="alert">
          {error}
        </div>
      )}
      <Aktionen busy={busy} recht="anlage.verwalten" onCancel={onCancel} onSave={() => void save()} />
    </div>
  );
}

export function EinspeisemanagementForm({
  siteId,
  nv,
  onCancel,
  onSaved,
}: {
  siteId: string;
  nv: NetzVermarktung;
  onCancel: () => void;
  onSaved: (nv: NetzVermarktung) => void;
}) {
  const [art, setArt] = useState<string>(nv.einspeisemanagement ?? NICHT_ERFASST);
  const [prozent, setProzent] = useState(
    nv.einspeisemanagement_prozent != null ? String(nv.einspeisemanagement_prozent).replace('.', ',') : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prozentRef = useRef<HTMLInputElement>(null);

  async function save() {
    let p: number | null = null;
    if (art === 'statisch' && prozent.trim() !== '') {
      p = zahl(prozent);
      if (p == null || p < 0 || p > 100) {
        setError('Bitte geben Sie die Grenze als Zahl zwischen 0 und 100 an, z. B. 70.');
        prozentRef.current?.focus();
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.netzVermarktungAendern(siteId, {
          ...basis(nv),
          einspeisemanagement: art === NICHT_ERFASST ? null : (art as Einspeisemanagement),
          einspeisemanagement_prozent: art === 'statisch' ? p : null,
        }),
      );
    } catch (e) {
      setError(fehlerText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-tech-editform">
      <div className="vp-form-stack">
        <VpPicker
          id="nv-einspeisemanagement"
          label="Einspeisemanagement"
          options={[
            { value: 'statisch', label: EINSPEISEMANAGEMENT_WORT.statisch, sub: 'Eine feste Wirkleistungsgrenze in Prozent' },
            { value: 'stufen', label: EINSPEISEMANAGEMENT_WORT.stufen, sub: 'Der Netzbetreiber schaltet Stufen, z. B. 60 % / 30 % / 0 %' },
            { value: 'fernwirk', label: EINSPEISEMANAGEMENT_WORT.fernwirk, sub: 'Vorgaben über eine Fernwirkanlage, z. B. IEC 60870-5-101' },
            { value: NICHT_ERFASST, label: 'Nicht erfasst' },
          ]}
          value={art}
          onChange={setArt}
        />
        {art === 'statisch' && (
          <Input
            ref={prozentRef}
            label="Grenze (%)"
            inputMode="decimal"
            placeholder="z. B. 70"
            value={prozent}
            hint="Optional - Anteil der installierten Leistung, den die Anlage höchstens einspeisen darf."
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setProzent(e.target.value)}
          />
        )}
      </div>
      {error && (
        <div className="vp-alert vp-alert-err" role="alert">
          {error}
        </div>
      )}
      <Aktionen busy={busy} recht="anlage.verwalten" onCancel={onCancel} onSave={() => void save()} />
    </div>
  );
}

/** Bezeichnung und MaStR-Nummer einer Erzeugungseinheit; Art, Typ und Nennleistung reisen unverändert mit. */
export function EinheitForm({
  geraetId,
  einheit: e,
  onCancel,
  onSaved,
}: {
  geraetId: string;
  einheit: Erzeugungseinheit;
  onCancel: () => void;
  onSaved: (e: Erzeugungseinheit) => void;
}) {
  const [name, setName] = useState(e.bezeichnung ?? '');
  const [see, setSee] = useState(e.registry_unit_id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const seeRef = useRef<HTMLInputElement>(null);
  const hinweis = typHinweis(e);

  async function save() {
    const nummer = see.trim().toUpperCase().replace(/\s/g, '');
    if (name.trim().length > 120) {
      setError('Die Bezeichnung hat höchstens 120 Zeichen.');
      nameRef.current?.focus();
      return;
    }
    if (nummer && !SEE_MUSTER.test(nummer)) {
      setError('Die MaStR-Nummer einer Einheit beginnt mit SEE und hat danach zwölf Ziffern, z. B. SEE912345678901.');
      seeRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await api.erzeugungseinheitAendern(geraetId, e.te_nr, {
          einheit_art: e.einheit_art,
          bezeichnung: name.trim() || null,
          typ: e.typ,
          nennleistung_kw: e.nennleistung_kw,
          registry_unit_id: nummer || null,
        }),
      );
    } catch {
      setError(FEHLER);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-tech-editform">
      <p className="vp-note">
        {[einheitNummer(e), einheitTyp(e)].filter(Boolean).join(' · ')}. Umbenennen ändert nur die Anzeige - die
        Nummer im Registerbild und die Messreihe bleiben dieselben.
      </p>
      {hinweis && <p className="vp-note">{hinweis}</p>}
      <div className="vp-form-stack">
        <Input
          ref={nameRef}
          label="Bezeichnung"
          value={name}
          maxLength={120}
          autoFocus
          placeholder={einheitName({ ...e, bezeichnung: null })}
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setName(ev.target.value)}
        />
        <Input
          ref={seeRef}
          label="MaStR-Nummer der Einheit"
          value={see}
          placeholder="SEE…"
          hint="Die Einheitennummer aus dem Marktstammdatenregister (SEE und zwölf Ziffern)."
          onChange={(ev: React.ChangeEvent<HTMLInputElement>) => setSee(ev.target.value)}
        />
      </div>
      {error && (
        <div className="vp-alert vp-alert-err" role="alert">
          {error}
        </div>
      )}
      <Aktionen busy={busy} recht="geraet.einrichten" onCancel={onCancel} onSave={() => void save()} />
    </div>
  );
}

