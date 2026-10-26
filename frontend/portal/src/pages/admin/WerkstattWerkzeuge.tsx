/**
 * Die Werkzeuge der Werkstatt-Seite, je Schritt eines: Passwort erzeugen (3a), Box in die Liste
 * aufnehmen, Tunnel-Schlüssel hinterlegen, Werkstatt-Probe, Fenster schließen, LAN-Netz (6a),
 * Beschriftung (8) und Abnahme. Jede Ableitung steht in `werkstatt.ts`; hier wird gerendert und
 * abgeschickt. Tunnel-Schlüssel und Fenster gehen über die Routen der Fernwartung.
 */
import { useMemo, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import { ApiError } from '../../api';
import { adminApi } from '../../admin/adminApi';
import {
  boxAnmeldung,
  schluesselGueltig,
  zeitpunkt,
  type FernwartungBox,
  type FernwartungFenster,
  type FernwartungTechniker,
  type FernwartungUebersicht,
} from '../../adminFernwartung';
import { pruefeKennung, kennungFehler, kennungSendbar } from '../../edgeRef';
import { qrCode, qrPfad } from '../../qrCode';
import {
  abnahmeSperre,
  beschriftung,
  erzeugePasswort,
  hostSchluesselAus,
  lanNetzForm,
  PROBE_GRUND,
  PROBE_MINUTEN,
  PRUEFUNGEN,
  type SchrittId,
  type WerkstattAbnahme,
  type WerkstattBox,
} from '../../werkstatt';
import { Befehl } from '../../components/FernwartungSsh';
import { VpPicker } from '../../components/VpPicker';

function fehlerText(e: unknown, sonst: string): string {
  return e instanceof ApiError ? e.message : sonst;
}

/** Ein Haken mit Beschriftung - das native Feld, damit Tastatur und Vorleser es kennen. */
export function Haken({
  checked,
  onChange,
  disabled,
  children,
  testId,
}: {
  checked: boolean;
  onChange: (an: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <label className="vp-ws-haken" data-testid={testId}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// ── Schritt 3: Root-Passwort (Entscheid 3a) ─────────────────────────────────

/**
 * Erzeugt das Passwort im Browser und zeigt es genau so lange, bis es abgelegt ist. Es geht nie an
 * die API und steht in keinem Speicher; nach dem Haken oder beim Verlassen der Seite ist es weg.
 */
export function PasswortWerkzeug({ erledigt, onAbgelegt }: { erledigt: boolean; onAbgelegt: () => void }) {
  const [passwort, setPasswort] = useState<string | null>(null);
  if (erledigt && !passwort) {
    return (
      <p className="vp-note" style={{ margin: 0 }} data-testid="ws-passwort-weg">
        Das Passwort dieser Box steht nur in der Passwortablage. Neu setzen heißt: neu erzeugen und passwd noch einmal.
      </p>
    );
  }
  if (!passwort) {
    return (
      <div className="vp-ws-werkzeug">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPasswort(erzeugePasswort((n) => crypto.getRandomValues(new Uint8Array(n))))}
        >
          Passwort erzeugen
        </Button>
        <span className="vp-muted">Es entsteht hier im Browser und geht nicht ans Portal.</span>
      </div>
    );
  }
  return (
    <div className="vp-ws-werkzeug vp-ws-spalte" data-testid="ws-passwort">
      <p className="vp-alert vp-alert-warn" style={{ margin: 0 }}>
        Nur jetzt sichtbar. In die Passwortablage übernehmen (Eintrag mit Datum; die Referenz kommt in Schritt 5 dazu),
        dann bei passwd zweimal einfügen.
      </p>
      <Befehl text={passwort} was="Passwort" />
      <Haken
        checked={false}
        testId="ws-passwort-abgelegt"
        onChange={(an) => {
          if (!an) return;
          setPasswort(null);
          onAbgelegt();
        }}
      >
        Liegt in der Ablage und ist auf der Box gesetzt
      </Haken>
    </div>
  );
}

// ── Schritt 5: Referenz, die Box kommt in die Liste ─────────────────────────

export function ReferenzWerkzeug({
  box,
  vorher,
  onAufgenommen,
}: {
  box: WerkstattBox | null;
  /** Was vor dem Aufnehmen schon abgehakt war (Schritte 1 bis 4). */
  vorher: SchrittId[];
  onAufgenommen: (box: WerkstattBox) => void;
}) {
  const [eingabe, setEingabe] = useState('');
  const [geprueft, setGeprueft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  if (box) {
    return (
      <p className="vp-note" style={{ margin: 0 }}>
        In der Werkstatt-Liste als <strong>{box.edgeRef}</strong>.
      </p>
    );
  }
  const p = pruefeKennung(eingabe);
  const feldFehler = kennungFehler(p, geprueft);
  async function aufnehmen() {
    setGeprueft(true);
    if (!kennungSendbar(p) || p.zustand === 'register') return;
    setBusy(true);
    setFehler(null);
    try {
      onAufgenommen(
        await adminApi.werkstattBoxAnlegen({ edgeRef: p.kennung, boxArt: 'edge-light', schritte: [...vorher, 'programm'] }),
      );
    } catch (e) {
      setFehler(fehlerText(e, 'Die Box ließ sich nicht in die Liste aufnehmen.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vp-ws-werkzeug vp-ws-spalte">
      <div className="vp-ws-feld">
        <Input
          label="Referenz der Box"
          placeholder="edge-…"
          value={eingabe}
          autoComplete="off"
          spellCheck={false}
          error={feldFehler ?? (geprueft && p.zustand === 'register' ? 'Eine Box-Referenz beginnt mit edge-.' : null)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEingabe(e.target.value)}
        />
      </div>
      <div className="vp-ws-werkzeug">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void aufnehmen()}>
          {busy ? 'Nehme auf…' : 'In die Werkstatt-Liste aufnehmen'}
        </Button>
        <span className="vp-muted">Hakt diesen Schritt und die vorigen mit ab.</span>
      </div>
      {fehler && <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>{fehler}</p>}
    </div>
  );
}

// ── Schritt 6: Tunnel-Schlüssel hinterlegen ─────────────────────────────────

export function TunnelSchluesselWerkzeug({
  edgeRef,
  tunnel,
  onHinterlegt,
}: {
  edgeRef: string | null;
  tunnel: FernwartungBox | null;
  onHinterlegt: () => void;
}) {
  const [key, setKey] = useState('');
  const [geprueft, setGeprueft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  if (tunnel) {
    return (
      <p className="vp-note" style={{ margin: 0 }} data-testid="ws-tunnel-hinterlegt">
        Hinterlegt: Tunnel-Adresse <strong>{tunnel.adresse}</strong>, Schlüssel {tunnel.publicKeyKurz}.
        {tunnel.status === 'gesperrt' && ' Die Box ist in der Fernwartung gesperrt; erst dort entsperren.'}
      </p>
    );
  }
  if (!edgeRef) {
    return <p className="vp-note" style={{ margin: 0 }}>Erst die Referenz eintragen (Schritt 5).</p>;
  }
  const keyFehler = schluesselGueltig(key) ? null : 'Das ist kein öffentlicher WireGuard-Schlüssel (44 Zeichen, endet auf „=“).';
  async function hinterlegen() {
    setGeprueft(true);
    if (keyFehler || !edgeRef) return;
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.fernwartungSchluessel(edgeRef, { publicKey: key.trim(), notiz: 'Werkstatt' });
      onHinterlegt();
    } catch (e) {
      setFehler(
        e instanceof ApiError && e.status === 409
          ? `${e.message} Einen Schlüssel tauschen geht unter Geräte › Fernwartung.`
          : fehlerText(e, 'Der Schlüssel ließ sich nicht hinterlegen.'),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vp-ws-werkzeug vp-ws-spalte">
      <div className="vp-ws-feld">
        <Input
          label="Öffentlicher Tunnel-Schlüssel"
          placeholder="44 Zeichen, endet auf ="
          value={key}
          autoComplete="off"
          spellCheck={false}
          error={geprueft ? keyFehler : null}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value)}
        />
      </div>
      <div className="vp-ws-werkzeug">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void hinterlegen()}>
          {busy ? 'Hinterlege…' : 'Im Portal hinterlegen'}
        </Button>
        <span className="vp-muted">Das Portal teilt die Tunnel-Adresse zu; Schritt 7 nennt danach die Befehlszeile.</span>
      </div>
      {fehler && <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>{fehler}</p>}
    </div>
  );
}

// ── Schritte 9 bis 11: Werkstatt-Probe ──────────────────────────────────────

/** Öffnet das Fenster der Probe, zeigt seinen Stand aus Portal und Tunnel-Dienst. */
export function ProbeWerkzeug({
  tunnel,
  techniker,
  uebersicht,
  probe,
  jetzt,
  onGeaendert,
}: {
  tunnel: FernwartungBox | null;
  techniker: FernwartungTechniker[];
  uebersicht: FernwartungUebersicht | null;
  probe: FernwartungFenster | null;
  jetzt: Date;
  onGeaendert: () => void;
}) {
  const geeignet = useMemo(() => techniker.filter((t) => t.status === 'aktiv' && t.sshFingerabdruck), [techniker]);
  const [wahl, setWahl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  if (!tunnel) return null;
  const offen = probe && (probe.zustand === 'offen' || probe.zustand === 'geplant');
  if (offen && probe) {
    const fall = boxAnmeldung(tunnel, techniker, uebersicht, jetzt)?.fenster.find((f) => f.fensterId === probe.id) ?? null;
    return (
      <div className="vp-ws-werkzeug vp-ws-spalte" data-testid="ws-probe-offen">
        <p className="vp-note" style={{ margin: 0 }}>
          Fenster für {probe.technikerName} offen bis {zeitpunkt(probe.ende, jetzt)}.
        </p>
        {fall ? (
          <div className="vp-fw-fall" data-testid="ws-probe-fall" data-fall={fall.fall}>
            <span className="vp-fw-fall-abzeichen">
              <Badge variant={fall.ton} dot>
                {fall.titel}
              </Badge>
            </span>
            <span className="vp-fw-fall-satz vp-muted">{fall.satz}</span>
          </div>
        ) : (
          <p className="vp-muted" style={{ margin: 0 }}>Das Fenster beginnt gleich; der Stand folgt.</p>
        )}
        <p className="vp-muted" style={{ margin: 0 }}>
          „Alles bereit“ heißt: Die Box hat den Schlüssel abgeholt. Ob die Anmeldung gelingt, zeigt nur die Anmeldung selbst.
        </p>
      </div>
    );
  }
  const optionen = geeignet.map((t) => ({ value: t.id, label: t.name, sub: `${t.adresse} · ${t.sshFingerabdruck}` }));
  const gewaehlt = wahl ?? (geeignet.length === 1 ? geeignet[0].id : null);
  async function oeffnen() {
    if (!gewaehlt || !tunnel) return;
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.fernwartungFensterOeffnen({
        edgeRef: tunnel.edgeRef,
        technikerId: gewaehlt,
        grund: PROBE_GRUND,
        dauerMinuten: PROBE_MINUTEN,
      });
      onGeaendert();
    } catch (e) {
      setFehler(fehlerText(e, 'Das Fenster ließ sich nicht öffnen.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vp-ws-werkzeug vp-ws-spalte" data-testid="ws-probe-start">
      {probe && (
        <p className="vp-note" style={{ margin: 0 }}>
          Letzte Probe: Fenster für {probe.technikerName}, {zeitpunkt(probe.beginn, jetzt)} bis{' '}
          {zeitpunkt(probe.wirksamesEnde, jetzt)} ({probe.zustand}).
        </p>
      )}
      {geeignet.length === 0 ? (
        <p className="vp-alert vp-alert-warn" style={{ margin: 0 }}>
          Es gibt keinen aktiven Techniker-Zugang mit SSH-Schlüssel. Unter Geräte › Fernwartung einen anlegen; ohne
          SSH-Schlüssel öffnet ein Fenster nur den Netzweg, und die Probe beweist nichts.
        </p>
      ) : (
        <>
          <VpPicker
            className="vp-ws-feld"
            label="Zugang für die Probe"
            options={optionen}
            value={gewaehlt}
            placeholder="Zugang wählen"
            onChange={setWahl}
          />
          <div className="vp-ws-werkzeug">
            <Button variant="primary" size="sm" disabled={busy || !gewaehlt} onClick={() => void oeffnen()}>
              {busy ? 'Öffne…' : probe ? 'Neue Probe: Fenster öffnen' : `Fenster für die Probe öffnen (${PROBE_MINUTEN} Minuten)`}
            </Button>
            <span className="vp-muted">Grund „{PROBE_GRUND}“; das Fenster steht im Protokoll der Fernwartung.</span>
          </div>
        </>
      )}
      {fehler && <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>{fehler}</p>}
    </div>
  );
}

export function FensterZuWerkzeug({
  probe,
  jetzt,
  onGeaendert,
}: {
  probe: FernwartungFenster | null;
  jetzt: Date;
  onGeaendert: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  if (!probe) return <p className="vp-note" style={{ margin: 0 }}>Erst die Probe (Schritt 9).</p>;
  if (probe.zustand !== 'offen' && probe.zustand !== 'geplant') {
    return (
      <p className="vp-note" style={{ margin: 0 }} data-testid="ws-fenster-zu">
        Fenster zu seit {zeitpunkt(probe.wirksamesEnde, jetzt)}
        {probe.geschlossenVon ? ` (geschlossen von ${probe.geschlossenVon})` : ' (abgelaufen)'}. Jetzt den Befehl oben noch
        einmal: Er muss mit „Connection timed out“ enden.
      </p>
    );
  }
  async function schliessen() {
    if (!probe) return;
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.fernwartungFensterSchliessen(probe.id);
      onGeaendert();
    } catch (e) {
      setFehler(fehlerText(e, 'Das Fenster ließ sich nicht schließen.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vp-ws-werkzeug vp-ws-spalte">
      <div className="vp-ws-werkzeug">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void schliessen()}>
          {busy ? 'Schließe…' : 'Fenster jetzt schließen'}
        </Button>
        <span className="vp-muted">Der Tunnel-Dienst schließt den Weg beim nächsten Abruf, auch eine laufende Sitzung.</span>
      </div>
      {fehler && <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>{fehler}</p>}
    </div>
  );
}

// ── Schritt 12: LAN-Netz (Entscheid 6a) ─────────────────────────────────────

export function LanWerkzeug({
  box,
  vorschlag,
  onGespeichert,
}: {
  box: WerkstattBox | null;
  vorschlag: string;
  onGespeichert: (box: WerkstattBox) => void;
}) {
  const [wert, setWert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  if (!box) return <p className="vp-note" style={{ margin: 0 }}>Erst die Referenz eintragen (Schritt 5).</p>;
  const text = wert ?? box.lanNetz ?? vorschlag;
  const formFehler = lanNetzForm(text) ? null : 'Adresse der Box mit Präfix, etwa 10.213.0.1/24 (Präfix /16 bis /28).';
  async function speichern() {
    if (formFehler || !box) return;
    setBusy(true);
    setFehler(null);
    try {
      onGespeichert(await adminApi.werkstattLanNetz(box.edgeRef, text.trim()));
      setWert(null);
    } catch (e) {
      setFehler(fehlerText(e, 'Das Netz ließ sich nicht festhalten.'));
    } finally {
      setBusy(false);
    }
  }
  const unveraendert = box.lanNetz != null && text.trim() === box.lanNetz;
  return (
    <div className="vp-ws-werkzeug vp-ws-spalte">
      <div className="vp-ws-feld">
        <Input
          label="LAN der Box (Adresse/Präfix)"
          value={text}
          autoComplete="off"
          spellCheck={false}
          hint={box.lanNetz ? `Festgehalten: ${box.lanNetz}` : `Vorschlag wie an der Labor-Mango: ${vorschlag}`}
          error={formFehler}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWert(e.target.value)}
        />
      </div>
      <div className="vp-ws-werkzeug">
        <Button variant="outline" size="sm" disabled={busy || unveraendert || !!formFehler} onClick={() => void speichern()}>
          {busy ? 'Halte fest…' : 'Netz festhalten'}
        </Button>
        <span className="vp-muted">Das Portal lehnt übliche Heimnetze und die Netze des Wartungsservers ab.</span>
      </div>
      {fehler && <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>{fehler}</p>}
    </div>
  );
}

// ── Beschriftung des Gehäuses (Entscheid 8, geändert am 26.10.2026) ─────────

/** Kantenlänge eines Moduls in der Vorschaudatei: zwei Druckbahnen (Regeln des Gehäuses). */
const MODUL_MM = 0.84;
const RUHE = 4;

/** Das Etikett als SVG in echter Größe: QR-Code mit Ruhezone, darunter die Referenz. */
export function beschriftungSvg(ref: string): string {
  const b = beschriftung(ref);
  const q = qrCode(b.link);
  const seite = q.groesse + 2 * RUHE;
  const hoehe = seite + 6;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${(seite * MODUL_MM).toFixed(2)}mm" height="${(hoehe * MODUL_MM).toFixed(2)}mm" viewBox="0 0 ${seite} ${hoehe}">`,
    `<rect width="${seite}" height="${hoehe}" fill="#fff"/>`,
    `<path d="${qrPfad(q, RUHE)}" fill="#000"/>`,
    `<text x="${seite / 2}" y="${seite + 3.6}" font-family="monospace" font-size="4.5" text-anchor="middle">${b.klartext}</text>`,
    '</svg>',
  ].join('');
}

export function BeschriftungKarte({ edgeRef }: { edgeRef: string | null }) {
  const b = edgeRef ? beschriftung(edgeRef) : null;
  const q = useMemo(() => (b ? qrCode(b.link) : null), [b?.link]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!b || !q || !edgeRef) {
    return <p className="vp-note" style={{ margin: 0 }}>Die Beschriftung entsteht aus der Referenz (Schritt 5).</p>;
  }
  const seite = q.groesse + 2 * RUHE;
  const datei = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(beschriftungSvg(edgeRef))}`;
  return (
    <div className="vp-ws-beschriftung" data-testid="ws-beschriftung">
      <figure className="vp-ws-etikett">
        <svg viewBox={`0 0 ${seite} ${seite}`} role="img" aria-label={`QR-Code: ${b.link}`} data-testid="ws-qr">
          <rect width={seite} height={seite} fill="#fff" />
          <path d={qrPfad(q, RUHE)} fill="#000" />
        </svg>
        <figcaption className="vp-ws-klartext">{b.klartext}</figcaption>
      </figure>
      <div className="vp-ws-spalte">
        <p style={{ margin: 0 }}>
          Auf das Gehäuse kommen die Referenz in Klarschrift und ein QR-Code mit dem Direktlink ins Portal. Wer ihn mit
          dem Telefon öffnet, landet nach der Anmeldung dort, wo er eine Box verbindet, mit dieser Referenz im Feld.
        </p>
        <Befehl text={b.link} was="Direktlink" />
        <p className="vp-muted" style={{ margin: 0 }}>
          QR-Code Fassung {q.fassung}, {q.groesse} × {q.groesse} Module, Fehlerkorrektur {q.korrektur}. Die Druckdatei für
          das Gehäuse baut das Gehäuse-Programm (edge-light/gehaeuse/glinet-gl-mt300n-v2); bis dahin ist das hier der
          Inhalt, keine Druckdatei.
        </p>
        <div className="vp-ws-werkzeug">
          <a className="vp-btn vp-btn--outline vp-btn--sm" href={datei} download={`beschriftung-${edgeRef}.svg`}>
            Vorlage als SVG (echte Größe)
          </a>
          <span className="vp-muted">Zum Probedruck auf Papier: lässt sich der Code mit dem Telefon lesen?</span>
        </div>
      </div>
    </div>
  );
}

// ── Abnahme ─────────────────────────────────────────────────────────────────

export function AbnahmeAnzeige({ a, jetzt }: { a: WerkstattAbnahme; jetzt: Date }) {
  return (
    <dl className="vp-ws-protokoll" data-testid="ws-abnahme-protokoll">
      <dt>Abgenommen</dt>
      <dd>
        {zeitpunkt(a.erfasstAm, jetzt)} von {a.erfasstVon}
      </dd>
      <dt>Host-Schlüssel</dt>
      <dd className="vp-fw-fingerabdruck">{a.hostSchluessel}</dd>
      <dt>Fassung</dt>
      <dd>{a.fassung}</dd>
      <dt>Tunnel · LAN</dt>
      <dd>
        {a.tunnelAdresse} · {a.lanNetz}
      </dd>
      <dt>Werkstatt-Probe</dt>
      <dd>
        {a.probe.technikerName}, {zeitpunkt(a.probe.beginn, jetzt)} bis {zeitpunkt(a.probe.ende, jetzt)}
        {a.probe.schluesselAbgeholtUm
          ? `; der Tunnel-Dienst meldete den Schlüssel abgeholt um ${zeitpunkt(a.probe.schluesselAbgeholtUm, jetzt)}`
          : '; ob die Box den Schlüssel abgeholt hat, hatte der Tunnel-Dienst nicht gemeldet'}
      </dd>
      <dt>Prüfungen</dt>
      <dd>
        {a.pruefungen.length} von {PRUEFUNGEN.length} abgehakt
      </dd>
      {a.notiz && (
        <>
          <dt>Notiz</dt>
          <dd>{a.notiz}</dd>
        </>
      )}
    </dl>
  );
}

export function AbnahmeFormular({
  box,
  tunnelAdresse,
  probe,
  onAngelegt,
}: {
  box: WerkstattBox;
  tunnelAdresse: string | null;
  probe: FernwartungFenster | null;
  onAngelegt: () => void;
}) {
  const [haken, setHaken] = useState<Set<string>>(new Set());
  const [host, setHost] = useState('');
  const [fassung, setFassung] = useState('');
  const [notiz, setNotiz] = useState('');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const sperre = abnahmeSperre(box, tunnelAdresse, probe, { hostSchluessel: host, fassung, pruefungen: haken });
  async function festhalten() {
    const abdruck = hostSchluesselAus(host);
    if (sperre.length > 0 || !probe || !abdruck) return;
    setBusy(true);
    setFehler(null);
    try {
      await adminApi.werkstattAbnahme(box.edgeRef, {
        hostSchluessel: abdruck,
        fassung: fassung.trim(),
        pruefungen: PRUEFUNGEN.map((p) => p.id),
        probeFensterId: probe.id,
        notiz: notiz.trim() || null,
      });
      onAngelegt();
    } catch (e) {
      setFehler(fehlerText(e, 'Die Abnahme ließ sich nicht festhalten.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vp-ws-spalte" data-testid="ws-abnahme-formular">
      <fieldset className="vp-ws-pruefungen">
        <legend>Die Prüfungen der Werkstatt-Regel</legend>
        {PRUEFUNGEN.map((p) => (
          <Haken
            key={p.id}
            checked={haken.has(p.id)}
            testId={`ws-pruefung-${p.id}`}
            onChange={(an) =>
              setHaken((alt) => {
                const neu = new Set(alt);
                if (an) neu.add(p.id);
                else neu.delete(p.id);
                return neu;
              })
            }
          >
            {p.text}
          </Haken>
        ))}
      </fieldset>
      <div className="vp-ws-feld">
        <Input
          label="Host-Schlüssel (aus Schritt 10)"
          placeholder="SHA256:…"
          value={host}
          autoComplete="off"
          spellCheck={false}
          hint={hostSchluesselAus(host) && hostSchluesselAus(host) !== host.trim() ? `Übernommen wird ${hostSchluesselAus(host)}` : undefined}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHost(e.target.value)}
        />
      </div>
      <div className="vp-ws-feld">
        <Input
          label="Fassung des Programms (aus /health)"
          placeholder="edge-light-g…"
          value={fassung}
          autoComplete="off"
          spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFassung(e.target.value)}
        />
      </div>
      <div className="vp-ws-feld">
        <Input
          label="Notiz"
          value={notiz}
          maxLength={500}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNotiz(e.target.value)}
        />
      </div>
      {sperre.length > 0 && (
        <ul className="vp-ws-sperre" data-testid="ws-abnahme-sperre">
          {sperre.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
      <div className="vp-ws-werkzeug">
        <Button variant="primary" disabled={busy || sperre.length > 0} onClick={() => void festhalten()}>
          {busy ? 'Halte fest…' : 'Abnahme festhalten'}
        </Button>
        <span className="vp-muted">Das Protokoll lässt sich nicht ändern; eine neue Abnahme ist ein neuer Eintrag.</span>
      </div>
      {fehler && <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>{fehler}</p>}
    </div>
  );
}
