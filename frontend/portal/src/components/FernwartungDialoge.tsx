/**
 * Die Dialoge der Fernwartung, geteilt von der Plattform-Seite
 * („Geräte › Fernwartung") und der Karte auf der Box-Seite. Jede Ableitung
 * steht in `adminFernwartung.ts`; hier wird nur gerendert und abgeschickt.
 */
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Switch } from '../../designsystem/components/forms/Switch';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError } from '../api';
import { adminApi } from '../admin/adminApi';
import { normalizeDeviceIdInput } from '../anlageFlow';
import {
  boxBefehl,
  dauerOptionen,
  nurNetzwegSatz,
  schluesselGueltig,
  sshSchluesselPruefen,
  sshText,
  technikerKonfig,
  technikerOptionen,
  UNBEKANNT_SATZ,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungSchluesselAntwort,
  type FernwartungServer,
  type FernwartungTechniker,
  type FernwartungTechnikerAntwort,
  type Lage,
} from '../adminFernwartung';
import { SshErzeugenHinweis, SshFingerabdruck, SshSchluesselFeld } from './FernwartungSsh';
import { VpPicker } from './VpPicker';

/** Eine Lage-Zeile (Server, Tunnel-Dienst): Ton, Titel, ein Satz. */
export function LageZeile({ lage, testId }: { lage: Lage; testId?: string }) {
  return (
    <div className={`vp-fw-lage vp-fw-lage-${lage.ton}`} data-testid={testId}>
      <Badge variant={lage.ton} dot>
        {lage.titel}
      </Badge>
      <span className="vp-muted">{lage.text}</span>
    </div>
  );
}

function fehlerText(e: unknown, sonst: string): string {
  return e instanceof ApiError ? e.message : sonst;
}

function Kopf({ icon }: { icon: 'lock' | 'shield' | 'users' }) {
  return (
    <IconTile category="primary" size={40}>
      <Icon name={icon} size={20} />
    </IconTile>
  );
}

// ── Fenster öffnen ───────────────────────────────────────────────────────────

export function FensterDialog({
  box,
  techniker,
  maxMinuten,
  onClose,
  onGeoeffnet,
}: {
  box: FernwartungBox | null;
  techniker: FernwartungTechniker[];
  maxMinuten: number;
  onClose: () => void;
  onGeoeffnet: (f: FernwartungFenster) => void;
}) {
  const jetzt = new Date();
  const [technikerId, setTechnikerId] = useState<string | null>(null);
  const [dauer, setDauer] = useState<string>('60');
  const [grund, setGrund] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [geprueft, setGeprueft] = useState(false);
  const grundRef = useRef<HTMLTextAreaElement>(null);

  const offen = box != null;
  useEffect(() => {
    if (!offen || !box) return;
    const wahl = technikerOptionen(techniker, box, new Date()).filter((o) => !o.disabled);
    setTechnikerId(wahl.length === 1 ? wahl[0].value : null);
    const dauern = dauerOptionen(maxMinuten).filter((o) => !o.disabled);
    setDauer(dauern.some((o) => o.value === '60') ? '60' : (dauern[0]?.value ?? ''));
    setGrund('');
    setFehler(null);
    setGeprueft(false);
    // Nur beim Öffnen neu belegen, nicht bei jedem Nachladen der Liste.
  }, [offen, box?.edgeRef]);

  if (!box) return null;
  const grundFehler = grund.trim().length < 3 ? 'Ein Grund ist Pflicht (mindestens 3 Zeichen).' : null;
  const technikerFehler = technikerId ? null : 'Bitte einen Techniker-Zugang wählen.';
  const gewaehlt = techniker.find((t) => t.id === technikerId) ?? null;

  async function absenden() {
    setGeprueft(true);
    if (technikerFehler || grundFehler || !box) {
      if (!technikerFehler && grundFehler) grundRef.current?.focus();
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const f = await adminApi.fernwartungFensterOeffnen({
        edgeRef: box.edgeRef,
        technikerId: technikerId as string,
        grund: grund.trim(),
        dauerMinuten: Number(dauer),
      });
      onGeoeffnet(f);
    } catch (e) {
      setFehler(fehlerText(e, 'Das Fenster ließ sich nicht öffnen.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Fernwartung öffnen"
      icon={<Kopf icon="lock" />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={absenden} disabled={busy}>
            {busy ? 'Öffne…' : 'Fenster öffnen'}
          </Button>
        </>
      }
    >
      {/* Die Box steht hier und nicht im Titel: der ist einzeilig und schnitte sie am Telefon ab. */}
      <p className="vp-fw-umbruch" style={{ marginTop: 0 }} data-testid="fw-fenster-box">
        Box {box.edgeRef} ({box.adresse})
      </p>
      <p className="vp-note" style={{ marginTop: 0 }}>
        Der Techniker erreicht die Box über den Wartungstunnel nur in diesem Zeitfenster; danach
        schließt der Server den Weg von selbst. {UNBEKANNT_SATZ}
      </p>
      <div className="vp-form-stack">
        <VpPicker
          id="fw-fenster-techniker"
          label="Techniker-Zugang *"
          options={technikerOptionen(techniker, box, jetzt)}
          value={technikerId}
          onChange={setTechnikerId}
          placeholder="Zugang wählen"
        />
        {geprueft && technikerFehler && <p className="vp-alert vp-alert-err">{technikerFehler}</p>}
        {gewaehlt &&
          (gewaehlt.sshFingerabdruck ? (
            <p className="vp-note vp-fw-umbruch" style={{ margin: 0 }} data-testid="fw-fenster-ssh">
              SSH-Schlüssel dieses Zugangs: {sshText(gewaehlt)}
            </p>
          ) : (
            <p className="vp-alert vp-alert-warn" style={{ margin: 0 }} data-testid="fw-fenster-nur-netzweg">
              {nurNetzwegSatz(gewaehlt.name)}
            </p>
          ))}
        <VpPicker
          id="fw-fenster-dauer"
          label="Dauer *"
          options={dauerOptionen(maxMinuten)}
          value={dauer}
          onChange={setDauer}
        />
        <label className="vp-field">
          <span className="vp-field-label">Grund *</span>
          <textarea
            ref={grundRef}
            rows={3}
            maxLength={500}
            value={grund}
            aria-invalid={geprueft && grundFehler != null}
            placeholder="z. B. Update auf Stufe 2 einspielen"
            onChange={(e) => setGrund(e.target.value)}
          />
          <span className="vp-field-help">Steht im Protokoll; der Kunde sieht ihn nicht.</span>
        </label>
        {geprueft && grundFehler && <p className="vp-alert vp-alert-err">{grundFehler}</p>}
        {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
      </div>
    </Modal>
  );
}

// ── Box-Schlüssel hinterlegen ────────────────────────────────────────────────

export function SchluesselDialog({
  offen,
  vorbelegt,
  onClose,
  onFertig,
}: {
  offen: boolean;
  /** Box-Referenz, wenn der Dialog von einer Box aus geöffnet wird. */
  vorbelegt?: string | null;
  onClose: () => void;
  onFertig: () => void;
}) {
  const [ref, setRef] = useState('');
  const [key, setKey] = useState('');
  const [notiz, setNotiz] = useState('');
  const [tausch, setTausch] = useState(false);
  const [tauschFrage, setTauschFrage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [antwort, setAntwort] = useState<FernwartungSchluesselAntwort | null>(null);
  const [geprueft, setGeprueft] = useState(false);
  const refFeld = useRef<HTMLInputElement>(null);
  const keyFeld = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!offen) return;
    setRef(vorbelegt ?? '');
    setKey('');
    setNotiz('');
    setTausch(false);
    setTauschFrage(null);
    setFehler(null);
    setAntwort(null);
    setGeprueft(false);
  }, [offen, vorbelegt]);

  if (!offen) return null;
  const refFehler = ref.trim() ? null : 'Die Box-Referenz fehlt (z. B. edge-k7m2xq3).';
  const keyFehler = schluesselGueltig(key)
    ? null
    : 'Das ist kein öffentlicher WireGuard-Schlüssel (44 Zeichen Base64, endet auf „=“).';

  async function absenden() {
    setGeprueft(true);
    if (refFehler || keyFehler) {
      (refFehler ? refFeld : keyFeld).current?.focus();
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const a = await adminApi.fernwartungSchluessel(ref.trim(), {
        publicKey: key.trim(),
        schluesselTausch: tausch,
        notiz: notiz.trim() || null,
      });
      setAntwort(a);
      onFertig();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && /Schlüsseltausch/.test(e.message)) {
        setTauschFrage(e.message);
      } else {
        setFehler(fehlerText(e, 'Der Schlüssel ließ sich nicht hinterlegen.'));
      }
    } finally {
      setBusy(false);
    }
  }

  const befehl = antwort ? boxBefehl(antwort.box, antwort.server) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="Tunnel-Schlüssel einer Box hinterlegen"
      icon={<Kopf icon="shield" />}
      footer={
        antwort ? (
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={absenden} disabled={busy || (tauschFrage != null && !tausch)}>
              {busy ? 'Hinterlege…' : 'Hinterlegen'}
            </Button>
          </>
        )
      }
    >
      {antwort ? (
        <div className="vp-form-stack" data-testid="fw-schluessel-ergebnis">
          <p className="vp-alert vp-alert-ok" style={{ margin: 0 }}>
            {antwort.ergebnis === 'angelegt'
              ? `Hinterlegt. ${antwort.box.edgeRef} bekommt die Tunnel-Adresse ${antwort.box.adresse}.`
              : antwort.ergebnis === 'getauscht'
                ? `Schlüssel getauscht. ${antwort.box.edgeRef} behält die Adresse ${antwort.box.adresse}.`
                : `Unverändert: dieser Schlüssel war für ${antwort.box.edgeRef} schon hinterlegt (${antwort.box.adresse}).`}
          </p>
          {befehl ? (
            <>
              <p className="vp-note" style={{ margin: 0 }}>
                Auf der Box einrichten (aus dem Repo, die Box im LAN oder über den alten Tunnel):
              </p>
              <pre className="vp-fw-code">{befehl}</pre>
            </>
          ) : (
            <p className="vp-alert vp-alert-warn" style={{ margin: 0 }}>
              Der Wartungsserver ist noch nicht eingerichtet: Es gibt noch keinen Server-Schlüssel, den
              die Box eintragen könnte. Die Adresse ist trotzdem reserviert.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Den Schlüssel erzeugt die Box selbst (<code>service-tunnel.sh &lt;box&gt; key</code>); hier
            kommt nur der öffentliche Teil hin. Übergang, bis die Werkstatt-Registrierung das übernimmt.
          </p>
          <div className="vp-form-stack">
            <Input
              ref={refFeld}
              label="Box-Referenz *"
              placeholder="edge-k7m2xq3"
              value={ref}
              autoComplete="off"
              spellCheck={false}
              disabled={!!vorbelegt}
              error={geprueft ? refFehler : null}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setRef(normalizeDeviceIdInput(e.target.value))
              }
            />
            <Input
              ref={keyFeld}
              label="Öffentlicher WireGuard-Schlüssel *"
              placeholder="44 Zeichen, endet auf ="
              value={key}
              autoComplete="off"
              spellCheck={false}
              error={geprueft ? keyFehler : null}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setKey(e.target.value);
                setTauschFrage(null);
                setTausch(false);
              }}
            />
            <Input
              label="Notiz"
              value={notiz}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNotiz(e.target.value)}
            />
            {tauschFrage && (
              <div className="vp-alert vp-alert-warn" data-testid="fw-tausch">
                <p style={{ marginTop: 0 }}>{tauschFrage}</p>
                <Switch
                  id="fw-tausch"
                  checked={tausch}
                  onChange={(e) => setTausch(e.target.checked)}
                  label="Ja, Schlüssel tauschen - die Box wurde zurückgesetzt oder neu aufgesetzt"
                />
              </div>
            )}
            {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Techniker-Zugang anlegen ─────────────────────────────────────────────────

export function TechnikerDialog({
  offen,
  onClose,
  onFertig,
}: {
  offen: boolean;
  onClose: () => void;
  onFertig: () => void;
}) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [ssh, setSsh] = useState('');
  const [notiz, setNotiz] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [antwort, setAntwort] = useState<FernwartungTechnikerAntwort | null>(null);
  const [geprueft, setGeprueft] = useState(false);
  const nameFeld = useRef<HTMLInputElement>(null);
  const keyFeld = useRef<HTMLInputElement>(null);
  const sshFeld = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!offen) return;
    setName('');
    setKey('');
    setSsh('');
    setNotiz('');
    setFehler(null);
    setAntwort(null);
    setGeprueft(false);
  }, [offen]);

  if (!offen) return null;
  const nameFehler = name.trim() ? null : 'Ein Name ist Pflicht, z. B. „Max (Laptop)“.';
  const keyFehler = schluesselGueltig(key)
    ? null
    : 'Das ist kein öffentlicher WireGuard-Schlüssel (44 Zeichen Base64, endet auf „=“).';
  // Der SSH-Schlüssel ist freiwillig; ein eingetragener muss aber stimmen.
  const sshPruefung = ssh.trim() ? sshSchluesselPruefen(ssh) : null;
  const sshFehler = sshPruefung && !sshPruefung.ok ? sshPruefung.fehler : null;

  async function absenden() {
    setGeprueft(true);
    if (nameFehler || keyFehler || sshFehler) {
      (nameFehler ? nameFeld : keyFehler ? keyFeld : sshFeld).current?.focus();
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const a = await adminApi.fernwartungTechnikerAnlegen({
        name: name.trim(),
        publicKey: key.trim(),
        notiz: notiz.trim() || null,
        sshPublicKey: ssh.trim() || null,
      });
      setAntwort(a);
      onFertig();
    } catch (e) {
      setFehler(fehlerText(e, 'Der Zugang ließ sich nicht anlegen.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Techniker-Zugang anlegen"
      icon={<Kopf icon="users" />}
      footer={
        antwort ? (
          <Button variant="primary" onClick={onClose}>
            Fertig
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={absenden} disabled={busy}>
              {busy ? 'Lege an…' : 'Zugang anlegen'}
            </Button>
          </>
        )
      }
    >
      {antwort ? (
        <div className="vp-form-stack">
          <TechnikerKonfigAnzeige techniker={antwort.techniker} server={antwort.server} neu />
          {antwort.techniker.sshFingerabdruck ? (
            <SshFingerabdruck techniker={antwort.techniker} />
          ) : (
            <p className="vp-alert vp-alert-warn" style={{ margin: 0 }} data-testid="fw-techniker-ohne-ssh">
              Kein SSH-Schlüssel hinterlegt: Fenster für diesen Zugang öffnen nur den Netzweg. Er lässt
              sich später am Zugang unter „SSH-Schlüssel“ nachtragen.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="vp-note" style={{ marginTop: 0 }}>
            Ein Zugang je Gerät. Beide Schlüsselpaare entstehen auf dem Gerät des Technikers; hier kommen
            nur die öffentlichen Teile hin. WireGuard öffnet den Weg zum Wartungsserver
            (<code>wg genkey | tee privat.key | wg pubkey</code>), der SSH-Schlüssel ist für die Anmeldung
            an der Box.
          </p>
          <div className="vp-form-stack">
            <Input
              ref={nameFeld}
              label="Name *"
              placeholder="Max (Laptop)"
              maxLength={80}
              value={name}
              error={geprueft ? nameFehler : null}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            />
            <Input
              ref={keyFeld}
              label="Öffentlicher WireGuard-Schlüssel *"
              placeholder="44 Zeichen, endet auf ="
              value={key}
              autoComplete="off"
              spellCheck={false}
              error={geprueft ? keyFehler : null}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value)}
            />
            <SshSchluesselFeld
              id="fw-techniker-ssh"
              wert={ssh}
              onChange={setSsh}
              fehler={geprueft ? sshFehler : null}
              feld={sshFeld}
            />
            <SshErzeugenHinweis />
            <Input
              label="Notiz"
              value={notiz}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNotiz(e.target.value)}
            />
            {fehler && <p className="vp-alert vp-alert-err">{fehler}</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Die Gerätekonfiguration eines Zugangs (ohne privaten Schlüssel). */
export function TechnikerKonfigAnzeige({
  techniker,
  server,
  neu,
}: {
  techniker: FernwartungTechniker;
  server: FernwartungServer;
  neu?: boolean;
}) {
  return (
    <div className="vp-form-stack" data-testid="fw-techniker-konfig">
      {neu && (
        <p className="vp-alert vp-alert-ok" style={{ margin: 0 }}>
          Angelegt. „{techniker.name}“ bekommt die Tunnel-Adresse {techniker.adresse}.
        </p>
      )}
      {!server.eingerichtet && (
        <p className="vp-alert vp-alert-warn" style={{ margin: 0 }}>
          Der Wartungsserver ist noch nicht eingerichtet; der Server-Schlüssel fehlt in der Vorlage.
        </p>
      )}
      <p className="vp-note" style={{ margin: 0 }}>
        WireGuard-Konfiguration für dieses Gerät. Den privaten Schlüssel dort einsetzen; er gehört nie
        ins Portal. Erreichbar sind Boxen nur in einem offenen Fenster.
      </p>
      <pre className="vp-fw-code">{technikerKonfig(techniker, server)}</pre>
    </div>
  );
}
