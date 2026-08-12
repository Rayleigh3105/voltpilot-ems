/**
 * Plattform → **Gerätevorlagen** (Einheitsmodell Stufe 6).
 *
 * <p>Der Sinn der Seite in einem Satz: eine neue geprüfte Gerätevorlage
 * entsteht hier als DATENSATZ — ohne Software-Auslieferung, ohne Treiber-PR.
 * Ein SG-Ready-Relais wird damit eine Vorlage statt eines Codes.
 *
 * <p>ALLE Ableitung/Copy ist das reine `src/adminVorlagen.ts` (unit-getestet);
 * diese Seite lädt, rendert und fragt nach.
 *
 * <p><b>Zwei Grenzen sind SICHTBAR, nicht nur serverseitig:</b> eine
 * eingebaute Vorlage trägt ihren Sperrgrund direkt an der Zeile (ein
 * deaktivierter Knopf ohne Grund liest sich wie ein Fehler), und eine Rücknahme
 * geht durch den Haus-Dialog mit einer Folgenliste, die ausdrücklich nennt, was
 * GLEICH bleibt.
 */
import { useEffect, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Drawer } from '../../../designsystem/components/shell/Drawer';
import { ApiError } from '../../api';
import { adminApi, type SaveComponentTemplateInput } from '../../admin/adminApi';
import {
  fassungsZustand,
  gruppen,
  herkunft,
  pruefstand,
  ruecknahmeFolgen,
  spur,
  umfang,
  bestand,
  type AdminVorlage,
  type VorlagenGruppe,
} from '../../adminVorlagen';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState, ErrorState, TableSkeleton } from '../../components/States';
import { AdminPageHead } from './AdminPageHead';

export function VorlagenPage(): JSX.Element {
  const [rows, setRows] = useState<AdminVorlage[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ base: VorlagenGruppe | null } | null>(null);
  const [ask, setAsk] = useState<{ gruppe: VorlagenGruppe; version: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    setLoadError(null);
    try {
      setRows(await adminApi.listComponentTemplates());
    } catch (e) {
      setLoadError(
        e instanceof ApiError ? e.message : 'Die Vorlagen konnten nicht geladen werden.',
      );
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Das hat nicht geklappt.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const list = rows ? gruppen(rows) : [];

  return (
    <div className="vp-admin-page">
      <AdminPageHead
        icon="layers"
        title="Gerätevorlagen"
        description="Eine geprüfte Vorlage ist ein Datensatz, kein Software-Update: sobald sie hier steht, bietet der Anlege-Assistent sie jedem Kunden an. Eingebaute Vorlagen kommen aus dem Geräte-Katalog der Edge-Software und werden hier nur angezeigt."
        actions={
          <Button onClick={() => setDrawer({ base: null })} disabled={!rows}>
            ＋ Vorlage eintragen
          </Button>
        }
      />

      {error && <div className="vp-alert vp-alert-err">{error}</div>}

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => void reload()} />
      ) : rows == null ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={5} cols={5} />
        </Card>
      ) : list.length === 0 ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="layers"
            title="Das Register ist leer"
            description="Der Start-Abgleich der eingebauten Vorlagen hat noch nicht gelaufen. Sobald er lief, stehen hier alle Geräte des Katalogs."
          />
        </Card>
      ) : (
        <>
          <p className="vp-muted" data-testid="bestand">
            {bestand(list)}
          </p>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div className="vp-table-scroll">
              <table className="vp-table responsive" data-testid="vorlagen">
                <thead>
                  <tr>
                    <th>Gerät</th>
                    <th>Herkunft</th>
                    <th>Prüfstand</th>
                    <th>In der Auswahl</th>
                    <th>Genutzt von</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((g) => {
                    const neueste = g.fassungen[0];
                    const h = herkunft(g.kind);
                    const p = pruefstand(neueste.certificationStatus);
                    return (
                      <>
                        <tr
                          key={g.templateRef}
                          className="vp-row-click"
                          onClick={() =>
                            setOpen(open === g.templateRef ? null : g.templateRef)
                          }
                        >
                          <td data-label="Gerät">
                            <span className="vp-cell-main">
                              <span>
                                {g.brandLabel} · {g.modelLabel}
                              </span>
                              <span className="vp-cell-sub">{g.communicationLabel}</span>
                            </span>
                          </td>
                          <td data-label="Herkunft">
                            <Badge variant={h.ton} dot>
                              {h.label}
                            </Badge>
                          </td>
                          <td data-label="Prüfstand">
                            <Badge variant={p.ton}>{p.label}</Badge>
                          </td>
                          <td data-label="In der Auswahl">
                            {g.waehlbar ? (
                              `Fassung ${g.waehlbar.version}`
                            ) : (
                              <span className="vp-muted">Nicht wählbar</span>
                            )}
                          </td>
                          <td data-label="Genutzt von">
                            {g.benutztVon === 0 ? (
                              <span className="vp-muted">—</span>
                            ) : (
                              `${g.benutztVon}`
                            )}
                          </td>
                          <td>
                            <Icon
                              name={open === g.templateRef ? 'chevron-down' : 'chevron-right'}
                              size={16}
                            />
                          </td>
                        </tr>
                        {open === g.templateRef && (
                          <tr key={`${g.templateRef}-detail`}>
                            <td colSpan={6}>
                              <Fassungen
                                gruppe={g}
                                busy={busy}
                                onNeueFassung={() => setDrawer({ base: g })}
                                onZurueckziehen={(version) => setAsk({ gruppe: g, version })}
                                onFreigeben={(version) =>
                                  void run(() =>
                                    adminApi.setComponentTemplateWithdrawn(
                                      g.templateRef,
                                      version,
                                      false,
                                    ),
                                  )
                                }
                              />
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <VorlageDrawer
        open={drawer != null}
        base={drawer?.base ?? null}
        busy={busy}
        onClose={() => setDrawer(null)}
        onSave={async (input) => {
          const base = drawer?.base ?? null;
          const ok = await run(() =>
            base
              ? adminApi.addComponentTemplateVersion(base.templateRef, input)
              : adminApi.createComponentTemplate(input),
          );
          if (ok) setDrawer(null);
        }}
      />

      <ConfirmDialog
        open={ask != null}
        title="Vorlage aus der Auswahl nehmen?"
        intro={
          ask
            ? `Fassung ${ask.version} von „${ask.gruppe.brandLabel} ${ask.gruppe.modelLabel}“ wird nicht mehr angeboten.`
            : ''
        }
        consequences={ask ? ruecknahmeFolgen(ask.gruppe, ask.version) : []}
        confirmLabel="Zurückziehen"
        busy={busy}
        onCancel={() => setAsk(null)}
        onConfirm={async () => {
          if (!ask) return;
          const ok = await run(() =>
            adminApi.setComponentTemplateWithdrawn(ask.gruppe.templateRef, ask.version, true),
          );
          if (ok) setAsk(null);
        }}
      />
    </div>
  );
}

/** Die Fassungen einer Vorlage samt Papier-Spur - der Aufklapp-Bereich. */
function Fassungen({
  gruppe,
  busy,
  onNeueFassung,
  onZurueckziehen,
  onFreigeben,
}: {
  gruppe: VorlagenGruppe;
  busy: boolean;
  onNeueFassung: () => void;
  onZurueckziehen: (version: number) => void;
  onFreigeben: (version: number) => void;
}): JSX.Element {
  return (
    <div className="vp-vorlage-detail">
      {!gruppe.editierbar && (
        <p className="vp-alert vp-alert-info" data-testid="gesperrt">
          {gruppe.gesperrtWeil}
        </p>
      )}
      <ul className="vp-vorlage-fassungen">
        {gruppe.fassungen.map((f) => {
          const z = fassungsZustand(f, gruppe);
          return (
            <li key={f.version}>
              <div className="vp-vorlage-fassung-kopf">
                <strong>Fassung {f.version}</strong>
                <Badge variant={z.ton}>{z.label}</Badge>
                {gruppe.editierbar &&
                  (f.withdrawnAt ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onFreigeben(f.version)}
                    >
                      Wieder freigeben
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onZurueckziehen(f.version)}
                    >
                      Zurückziehen
                    </Button>
                  ))}
              </div>
              <p className="vp-muted">{umfang(f).join(' · ')}</p>
              {f.certificationNote && <p className="vp-muted">{f.certificationNote}</p>}
              {spur(f).length > 0 && (
                <p className="vp-muted vp-vorlage-spur">{spur(f).join(' · ')}</p>
              )}
            </li>
          );
        })}
      </ul>
      {gruppe.editierbar && (
        <Button variant="ghost" size="sm" onClick={onNeueFassung} disabled={busy}>
          ＋ Neue Fassung
        </Button>
      )}
    </div>
  );
}

/**
 * Das Formular. Es fragt NICHT nach dem Vorlagen-Schlüssel — der wird
 * serverseitig aus Marke und Modell abgeleitet und ist opak; ein Feld dafür
 * wäre die Einladung, ihn „schöner" zu machen.
 */
function VorlageDrawer({
  open,
  base,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  base: VorlagenGruppe | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: SaveComponentTemplateInput) => void;
}): JSX.Element | null {
  const vorlage = base?.fassungen[0] ?? null;
  const [brand, setBrand] = useState('');
  const [brandLabel, setBrandLabel] = useState('');
  const [model, setModel] = useState('');
  const [modelLabel, setModelLabel] = useState('');
  const [communication, setCommunication] = useState('modbus_tcp');
  const [status, setStatus] = useState('in_certification');
  const [note, setNote] = useState('');
  const [schema, setSchema] = useState(DEFAULT_SCHEMA);
  const [channels, setChannels] = useState('');
  const [writes, setWrites] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setBrand(vorlage?.brand ?? '');
    setBrandLabel(vorlage?.brandLabel ?? '');
    setModel(vorlage?.model ?? '');
    setModelLabel(vorlage?.modelLabel ?? '');
    setCommunication(vorlage?.communication ?? 'modbus_tcp');
    setStatus(vorlage?.certificationStatus ?? 'in_certification');
    setNote(vorlage?.certificationNote ?? '');
    setSchema(pretty(vorlage?.transportSchema) || DEFAULT_SCHEMA);
    setChannels(pretty(vorlage?.channels));
    setWrites(pretty(vorlage?.writes));
  }, [open, base]);

  if (!open) return null;

  function submit() {
    setFormError(null);
    let parsedSchema: unknown[];
    try {
      parsedSchema = JSON.parse(schema);
    } catch {
      setFormError('Die Verbindungsfelder sind kein gültiges JSON.');
      return;
    }
    const input: SaveComponentTemplateInput = {
      brand: brand.trim(),
      brandLabel: brandLabel.trim(),
      model: model.trim(),
      modelLabel: modelLabel.trim(),
      communication,
      transportSchema: parsedSchema,
      certificationStatus: status,
      certificationNote: note.trim() || null,
    };
    // ⚠ Absent heißt „hier nicht erklärt". Ein leeres Feld darf deshalb NICHT
    // zu `[]` werden - der Server lehnt das ab, und zu Recht.
    for (const [raw, key] of [
      [channels, 'channels'],
      [writes, 'writes'],
    ] as const) {
      if (!raw.trim()) continue;
      try {
        input[key] = JSON.parse(raw);
      } catch {
        setFormError(
          key === 'channels'
            ? 'Die Messwerte sind kein gültiges JSON.'
            : 'Die Schreib-Fähigkeiten sind kein gültiges JSON.',
        );
        return;
      }
    }
    onSave(input);
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={base ? `Neue Fassung: ${base.modelLabel}` : 'Vorlage eintragen'}
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="layers" size={20} />
        </IconTile>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={submit} disabled={busy}>
            {base ? 'Fassung anlegen' : 'Vorlage eintragen'}
          </Button>
        </>
      }
    >
      <div className="vp-form-stack">
        {formError && <div className="vp-alert vp-alert-err">{formError}</div>}
        <p className="vp-muted">
          Marke und Modell bilden den Schlüssel dieser Vorlage — bei einer neuen Fassung
          bleiben sie deshalb, wie sie sind.
        </p>
        <Input
          label="Marke (Kennung)"
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          disabled={base != null}
          hint="Kleinbuchstaben, Ziffern, Unterstrich — z. B. acme"
        />
        <Input
          label="Marke (Anzeige)"
          value={brandLabel}
          onChange={(e) => setBrandLabel(e.target.value)}
        />
        <Input
          label="Modell (Kennung)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={base != null}
        />
        <Input
          label="Modell (Anzeige)"
          value={modelLabel}
          onChange={(e) => setModelLabel(e.target.value)}
        />
        <label className="vp-field">
          <span className="vp-field-label">Anbindung</span>
          <select value={communication} onChange={(e) => setCommunication(e.target.value)}>
            {COMMUNICATIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="vp-field">
          <span className="vp-field-label">Prüf-Zustand</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="in_certification">Prüfung läuft</option>
            <option value="certified">Geprüft</option>
            <option value="not_certified">Ungeprüft</option>
          </select>
          <span className="vp-field-help">
            Nur eine geprüfte Vorlage darf eine Schreib-Definition tragen — ohne Prüfung
            steht die Plattform nicht für den Schreibweg ein.
          </span>
        </label>
        <Input
          label="Prüf-Notiz"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="Was am Prüfstand belegt wurde."
        />
        <label className="vp-field">
          <span className="vp-field-label">Verbindungsfelder (JSON)</span>
          <textarea rows={6} value={schema} onChange={(e) => setSchema(e.target.value)} />
          <span className="vp-field-help">
            Die Felder, die der Assistent abfragt: key, label, type, required, default, help.
          </span>
        </label>
        <label className="vp-field">
          <span className="vp-field-label">Messwerte (JSON, optional)</span>
          <textarea rows={5} value={channels} onChange={(e) => setChannels(e.target.value)} />
          <span className="vp-field-help">
            Leer lassen, wenn die Vorlage die Messwerte nicht erklärt — eine leere Liste
            würde behaupten, das Gerät liefere keine.
          </span>
        </label>
        <label className="vp-field">
          <span className="vp-field-label">Schreib-Fähigkeiten (JSON, optional)</span>
          <textarea rows={5} value={writes} onChange={(e) => setWrites(e.target.value)} />
          <span className="vp-field-help">
            Jede braucht ihren Sicherheitswert — das ist, was bei Stille oder einem Widerruf
            geschrieben wird.
          </span>
        </label>
      </div>
    </Drawer>
  );
}

const COMMUNICATIONS = [
  { value: 'modbus_tcp', label: 'Modbus TCP' },
  { value: 'solarman_v5', label: 'Solarman V5 (WLAN-Stick)' },
  { value: 'fronius_solar_api', label: 'Fronius Solar API' },
  { value: 'fronius_sunspec', label: 'Fronius SunSpec' },
  { value: 'goe_http_api', label: 'go-e HTTP-API' },
  { value: 'shelly_http', label: 'Shelly HTTP' },
];

const DEFAULT_SCHEMA = `[
  { "key": "ip", "label": "IP-Adresse", "type": "text", "required": true },
  { "key": "port", "label": "Port", "type": "number", "default": 502 }
]`;

function pretty(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}
