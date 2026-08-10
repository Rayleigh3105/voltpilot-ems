/**
 * Plattform → **Steuerungs-Freigabe** (Captain-Order 10.08.2026).
 *
 * Der Befund, den diese Seite behebt, wörtlich: „der Kunde hat auch einen Deye
 * und da muss ich die Steuerung freigeben, obwohl ich das schon mit einem
 * anderen Kunden gemacht hab - ich hätte gedacht das merken wir uns". Die
 * Freigabe eines MODELLS lebte bis hierher entweder in einer env-Datei
 * (flottenweit, auf die Registerfamilie geschlüsselt) oder als
 * First-Light-Freigabe auf GENAU EINER Box - die Plattform hatte kein
 * Gedächtnis.
 *
 * Zwei Abschnitte, weil es zwei Entscheidungen sind:
 *
 *  1. **Freigegebene Modelle** - das Register. Ein Prüfstandslauf endet hier
 *     als Eintrag, EINMAL, und gilt danach für jeden Kunden.
 *  2. **Anlagen** - die Scharfschaltung. Sie bleibt ein ausdrücklicher Akt (es
 *     geht um Schreibzugriff auf den Wechselrichter eines Kunden), ist aber nur
 *     noch EIN Klick, sichtbar, sobald das Register das Modell deckt.
 *
 * ALLE Ableitung/Copy ist das reine `src/controlCertification.ts`
 * (unit-getestet); diese Seite lädt und rendert nur.
 */
import React, { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Input } from '../../../designsystem/components/forms/Input';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import {
  adminApi,
  type ControlCandidate,
  type ControlCertification,
} from '../../admin/adminApi';
import {
  activateConsequences,
  certSourceLabel,
  deactivateConsequences,
  plantCertView,
  registerRows,
  registerSummary,
  revokeConsequences,
} from '../../controlCertification';
import { AdminPageHead } from './AdminPageHead';

export function SteuerungsFreigabePage(): JSX.Element {
  const [register, setRegister] = useState<ControlCertification[] | null>(null);
  const [plants, setPlants] = useState<ControlCandidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<{ brand: string; model: string } | null>(null);
  const [arming, setArming] = useState<ControlCandidate | null>(null);
  const [disarming, setDisarming] = useState<ControlCandidate | null>(null);

  useEffect(() => {
    let active = true;
    setFailed(false);
    Promise.all([adminApi.controlCertifications(), adminApi.controlCandidates()]).then(
      ([r, p]) => {
        if (!active) return;
        setRegister(r ?? []);
        setPlants(p ?? []);
      },
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

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
    <div className="vp-admin-page">
      <AdminPageHead
        icon="settings"
        title="Steuerungs-Freigabe"
        description="Ein Wechselrichter-Modell wird EINMAL am Prüfstand freigegeben und gilt danach für die ganze Flotte. Ob eine Anlage wirklich gesteuert wird, bleibt trotzdem eine ausdrückliche Entscheidung - ein Klick je Anlage."
      />

      {error && <div className="vp-alert-warn vp-cert-error">{error}</div>}

      {failed && (
        <ErrorState
          message="Die Steuerungs-Freigaben konnten nicht geladen werden."
          onRetry={reload}
        />
      )}
      {!failed && (!register || !plants) && <TableSkeleton rows={4} />}

      {!failed && register && plants && (
        <>
          <section className="vp-admin-sec">
            <h2 className="vp-admin-sec-head">Freigegebene Modelle</h2>
            <p className="vp-cert-summary">
              {registerSummary(register, plants.filter((p) => p.activated).length)}
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
                          {r.note && <div className="vp-cell-sub">{r.note}</div>}
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

          <section className="vp-admin-sec">
            <h2 className="vp-admin-sec-head">Anlagen</h2>
            <p className="vp-cert-summary">
              Die Scharfschaltung bleibt eine ausdrückliche Entscheidung - es geht um
              Schreibzugriff auf den Wechselrichter eines Kunden. Sie ist nur noch EIN Klick,
              sobald das Register das Modell deckt.
            </p>
            {plants.length === 0 ? (
              <EmptyState
                title="Keine Anlage verbunden"
                description="Sobald ein Gerät beansprucht ist, erscheint es hier."
              />
            ) : (
              <Card radius="lg" style={{ padding: 0, overflow: 'hidden' }}>
                <table className="vp-table responsive">
                  <thead>
                    <tr>
                      <th>Anlage</th>
                      <th>Mandant</th>
                      <th>Zustand</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {plants.map((p) => {
                      const view = plantCertView(p.activated, p.platformCertVerdict);
                      return (
                        <tr key={p.deviceId}>
                          <td data-label="Anlage">
                            <div className="vp-cell-main">{p.siteName}</div>
                            <div className="vp-cell-sub">{p.externalRef}</div>
                          </td>
                          <td data-label="Mandant">{p.tenantName}</td>
                          <td data-label="Zustand">
                            <Badge variant={view.tone} dot>
                              {view.label}
                            </Badge>
                            {/* Der Grund steht IMMER daneben - ein Zustandswort
                                ohne Ursache ist ein Rätsel. */}
                            {view.hint && <div className="vp-cell-sub">{view.hint}</div>}
                            {p.activated && p.activatedBy && (
                              <div className="vp-cell-sub">aktiviert durch {p.activatedBy}</div>
                            )}
                            {/* WORAUS die Freigabe kommt - das ist der
                                Unterschied zwischen „haengt am Register" und
                                „haengt an einer First-Light-Freigabe an DIESER
                                Box": nur die erste faellt weg, wenn das Modell
                                aus dem Register genommen wird. */}
                            {certSourceLabel(p.certSource) && (
                              <div className="vp-cell-sub">
                                Freigabe: {certSourceLabel(p.certSource)}
                              </div>
                            )}
                          </td>
                          <td data-label="">
                            {p.activated ? (
                              <Button variant="ghost" onClick={() => setDisarming(p)}>
                                Zurücknehmen
                              </Button>
                            ) : (
                              /* Ein Knopf, der strukturell nichts bewirken kann,
                                 wird nicht angeboten - dort steht der Grund. */
                              view.canActivate && (
                                <Button onClick={() => setArming(p)}>Steuerung aktivieren</Button>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        open={revoking != null}
        title="Modell aus dem Register nehmen?"
        intro={`„${revoking?.model ?? ''}" gilt danach nicht mehr als freigegeben.`}
        consequences={revokeConsequences(revoking?.model ?? '', (plants ?? []).filter((p) => p.activated).length)}
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

      <ConfirmDialog
        open={arming != null}
        title="Steuerung für diese Anlage aktivieren?"
        intro={`VoltPilot darf danach den Wechselrichter von „${arming?.siteName ?? ''}" ansteuern.`}
        consequences={activateConsequences(arming?.siteName ?? '')}
        confirmLabel="Steuerung aktivieren"
        busy={busy}
        onCancel={() => setArming(null)}
        onConfirm={() => {
          const a = arming;
          setArming(null);
          if (a) void run(() => adminApi.activateControl(a.deviceId));
        }}
      />

      <ConfirmDialog
        open={disarming != null}
        title="Steuerung dieser Anlage zurücknehmen?"
        intro={`„${disarming?.siteName ?? ''}" wird danach nur noch ausgelesen.`}
        consequences={deactivateConsequences(disarming?.siteName ?? '')}
        confirmLabel="Zurücknehmen"
        tone="danger"
        busy={busy}
        onCancel={() => setDisarming(null)}
        onConfirm={() => {
          const d = disarming;
          setDisarming(null);
          if (d) void run(() => adminApi.deactivateControl(d.deviceId));
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
          <label>
            Steuerpfad
            <select value={path} onChange={(e) => setPath(e.target.value as typeof path)}>
              <option value="">keine Angabe</option>
              <option value="remote">Remote-Register</option>
              <option value="tou">Time-of-Use</option>
            </select>
          </label>
          <label>
            Schreib-Vorzeichen
            <select value={sign} onChange={(e) => setSign(e.target.value as typeof sign)}>
              <option value="">keine Angabe (nicht geprüft)</option>
              <option value="false">nicht umgekehrt</option>
              <option value="true">umgekehrt</option>
            </select>
          </label>
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
