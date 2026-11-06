/**
 * Plattform → Katalog → **Steuerungs-Freigabe** (Captain-Order 10.08.2026;
 * Konzept `vp-adminview-konzept-k1` §4.4/§8, Scheibe S3: der Abschnitt
 * „Anlagen" - die Scharfschaltung je Box - ist in die Akte › Anlage
 * umgezogen; dort steht sie neben Plan, Fassung und den Werkzeugen statt an
 * einem vierten Ort).
 *
 * Der Befund, den diese Seite ursprünglich behoben hat, wörtlich: „der Kunde
 * hat auch einen Deye und da muss ich die Steuerung freigeben, obwohl ich das
 * schon mit einem anderen Kunden gemacht hab - ich hätte gedacht das merken
 * wir uns". Die Freigabe eines MODELLS lebte bis hierher entweder in einer
 * env-Datei (flottenweit, auf die Registerfamilie geschlüsselt) oder als
 * First-Light-Freigabe auf GENAU EINER Box - die Plattform hatte kein
 * Gedächtnis.
 *
 * Diese Seite bleibt darum das REGISTER (**Freigegebene Modelle** - ein
 * Prüfstandslauf endet hier als Eintrag, EINMAL, und gilt danach für jeden
 * Kunden) plus die read-only „Steuerbare Gerätetypen"-Sektion.
 *
 * ALLE Ableitung/Copy ist das reine `src/controlCertification.ts`
 * (unit-getestet); diese Seite lädt und rendert nur.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Input } from '../../../designsystem/components/forms/Input';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { VpPicker } from '../../components/VpPicker';
import {
  adminApi,
  type ControlCertification,
} from '../../admin/adminApi';
import {
  registerRows,
  registerSummary,
  revokeConsequences,
} from '../../controlCertification';
import { parseSektion } from '../../nav';
import { AdminPageHead } from './AdminPageHead';
import { GeraetetypenSektion } from './GeraetetypenSektion';
import './SteuerungsFreigabe.css';

export function SteuerungsFreigabePage(): JSX.Element {
  const [register, setRegister] = useState<ControlCertification[] | null>(null);
  // Nur noch für den EINEN Satz „X Modelle freigegeben · Y Anlagen aktiviert"
  // über dem Register (ein Aggregat, kein zweites Urteil über eine einzelne
  // Anlage - das steht seit S3 ausschließlich in ihrer Akte).
  const [activations, setActivations] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<{ brand: string; model: string } | null>(null);

  useEffect(() => {
    let active = true;
    setFailed(false);
    Promise.all([adminApi.controlCertifications(), adminApi.controlCandidates()]).then(
      ([r, p]) => {
        if (!active) return;
        setRegister(r ?? []);
        setActivations((p ?? []).filter((c) => c.activated).length);
      },
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  // Ein Lesezeichen auf die stillgelegte Gerätetypen-Seite landet über
  // `canonicalPlatformHash` hier - mit `?sektion=geraetetypen`. Ohne den Sprung
  // stünde der Kunde oben auf einer Seite, deren Inhalt er nicht sucht.
  const sektionRef = useRef<string | null>(parseSektion(window.location.hash));
  useEffect(() => {
    const sektion = sektionRef.current;
    if (!sektion || !register || activations == null) return;
    sektionRef.current = null;
    document.getElementById(`sektion-${sektion}`)?.scrollIntoView({ block: 'start' });
  }, [register, activations]);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      reload();
    } catch (e) {
      // Der Server-Satz gewinnt: er kennt den fachlichen Grund (z. B. „dieses
      // Modell steht bereits im Register").
      setError(e instanceof Error && e.message ? e.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  const rows = register ? registerRows(register) : [];

  return (
    <div className="vp-admin-page vp-cert-page">
      <AdminPageHead
        icon="settings"
        title="Steuerungs-Freigabe"
        description="Ein Wechselrichter-Modell wird einmal am Prüfstand freigegeben und gilt dann für die ganze Flotte. Scharfgeschaltet wird eine Anlage einzeln, im Reiter „Anlage“ ihrer Geräteakte."
      />

      {error && <div className="vp-alert-warn vp-cert-error">{error}</div>}

      {failed && (
        <ErrorState
          message="Die Steuerungs-Freigaben konnten nicht geladen werden."
          onRetry={reload}
        />
      )}
      {!failed && (!register || activations == null) && <TableSkeleton rows={4} />}

      {!failed && register && activations != null && (
        <section className="vp-admin-sec">
          <h2 className="vp-admin-sec-head">Freigegebene Modelle</h2>
          <p className="vp-cert-summary">
            {registerSummary(register, activations)}
          </p>

          {rows.length === 0 ? (
            <EmptyState
              title="Noch kein Modell freigegeben"
              description="Ein Prüfstandslauf endet hier als Eintrag - danach reicht bei jedem weiteren Kunden ein Klick."
            />
          ) : (
            <Card radius="lg" style={{ padding: 0, overflow: 'hidden' }}>
              <table className="vp-table responsive">
                <thead>
                  <tr>
                    <th>Modell</th>
                    <th>Registerfamilie</th>
                    <th>Prüfstand</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td data-label="Modell">
                        <div className="vp-cell-main">{r.model}</div>
                        <div className="vp-cell-sub">{r.brand}</div>
                      </td>
                      <td data-label="Registerfamilie">
                        <div className="vp-cell-main">{r.family}</div>
                        {r.pathLabel && <div className="vp-cell-sub">{r.pathLabel}</div>}
                      </td>
                      <td data-label="Prüfstand">
                        <div className="vp-cell-main">{r.certifiedAt}</div>
                        {/* Ohne Aussage steht hier NICHTS - „nicht umgekehrt"
                            wäre eine Behauptung über einen Lauf, der die
                            Frage nie beantwortet hat. */}
                        {r.signLabel && (
                          <div className="vp-cell-sub">Vorzeichen: {r.signLabel}</div>
                        )}
                        {/* Der Prüfstandsbeleg ist lang und technisch: aufklappbar statt immer offen. */}
                        {r.note && (
                          <details className="vp-cert-nachweis">
                            <summary>Nachweis</summary>
                            <div className="vp-cell-sub">{r.note}</div>
                          </details>
                        )}
                      </td>
                      <td data-label="">
                        <Button
                          variant="ghost"
                          onClick={() => setRevoking({ brand: r.brand, model: r.model })}
                        >
                          Zurücknehmen
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <CertifyForm
            busy={busy}
            onSubmit={(input) => run(() => adminApi.certifyControlModel(input))}
          />
        </section>
      )}

      {/* Stufe 3 (F4): dieselbe Frage, andere Geräteklasse - read-only, mit
          eigenem fail-soft Abruf. */}
      <GeraetetypenSektion />

      <ConfirmDialog
        open={revoking != null}
        title="Modell aus dem Register nehmen?"
        intro={`„${revoking?.model ?? ''}" gilt danach nicht mehr als freigegeben.`}
        consequences={revokeConsequences(revoking?.model ?? '', activations ?? 0)}
        confirmLabel="Zurücknehmen"
        tone="danger"
        busy={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          const r = revoking;
          setRevoking(null);
          if (r) void run(() => adminApi.revokeControlModel(r.brand, r.model));
        }}
      />
    </div>
  );
}

/**
 * Ein Prüfstandslauf endet hier. Bewusst schlicht: Marke, Modell,
 * Registerfamilie sind Pflicht, alles andere ist die BELEGTE Zusatzaussage -
 * und das Vorzeichen bleibt „keine Angabe", solange der Lauf es nicht gesagt
 * hat (das Gerät prüft dann nichts, statt eine Konvention zu behaupten).
 */
function CertifyForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (input: {
    brand: string;
    model: string;
    family: string;
    controlPath?: 'remote' | 'tou' | null;
    invertControlSign?: boolean | null;
    firmwareNote?: string | null;
    note?: string | null;
  }) => void;
}): JSX.Element {
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [family, setFamily] = useState('');
  const [path, setPath] = useState<'' | 'remote' | 'tou'>('');
  const [sign, setSign] = useState<'' | 'false' | 'true'>('');
  const [firmware, setFirmware] = useState('');
  const [note, setNote] = useState('');

  const ready = brand.trim() !== '' && model.trim() !== '' && family.trim() !== '';

  return (
    <details className="vp-cert-form">
      <summary>Modell freigeben (nach einem Prüfstandslauf)</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          onSubmit({
            brand: brand.trim(),
            model: model.trim(),
            family: family.trim(),
            controlPath: path === '' ? null : path,
            invertControlSign: sign === '' ? null : sign === 'true',
            firmwareNote: firmware.trim() || null,
            note: note.trim() || null,
          });
          setBrand('');
          setModel('');
          setFamily('');
          setPath('');
          setSign('');
          setFirmware('');
          setNote('');
        }}
      >
        <div className="vp-cert-grid">
          <label>
            Marke
            <Input value={brand} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBrand(e.target.value)} placeholder="deye" />
          </label>
          <label>
            Modell
            <Input
              value={model}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModel(e.target.value)}
              placeholder="SUN-30K-SG01HP3-EU"
            />
          </label>
          <label>
            Registerfamilie
            <Input
              value={family}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFamily(e.target.value)}
              placeholder="hybrid_3p"
            />
          </label>
          <VpPicker
            label="Steuerpfad"
            options={[
              { value: '', label: 'keine Angabe' },
              { value: 'remote', label: 'Remote-Register' },
              { value: 'tou', label: 'Time-of-Use' },
            ]}
            value={path}
            onChange={(v) => setPath(v as typeof path)}
          />
          <VpPicker
            label="Schreib-Vorzeichen"
            options={[
              { value: '', label: 'keine Angabe (nicht geprüft)' },
              { value: 'false', label: 'nicht umgekehrt' },
              { value: 'true', label: 'umgekehrt' },
            ]}
            value={sign}
            onChange={(v) => setSign(v as typeof sign)}
          />
          <label>
            Firmware (Klartext)
            <Input
              value={firmware}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFirmware(e.target.value)}
              placeholder="Protokoll V105.1+"
            />
          </label>
          <label className="vp-cert-wide">
            Notiz
            <Input
              value={note}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
              placeholder="Prüfstand, Datum, was belegt wurde"
            />
          </label>
        </div>
        <p className="vp-cert-hint">
          Die Firmware ist eine Notiz für Menschen, kein Filter: das Gerät kann keine
          Firmware-Version auslesen. Geprüft wird auf dem Gerät, ob Marke, Modell und
          Registerfamilie zu seiner eigenen Auswahl passen - und, falls angegeben, das
          Schreib-Vorzeichen.
        </p>
        <Button type="submit" disabled={!ready || busy}>
          Modell freigeben
        </Button>
      </form>
    </details>
  );
}
