/**
 * Der SSH-Schlüssel des Technikers in der Fernwartung (Fenster-Schlüssel,
 * Schritt 1): die Befehle zum Erzeugen, das Eingabefeld, der Dialog am
 * Zugang und die fertigen Befehle in der Zeile eines offenen Fensters.
 * Jede Ableitung steht in `adminFernwartung.ts`; hier wird gerendert.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError } from '../api';
import { adminApi } from '../admin/adminApi';
import {
  SSH_ERZEUGEN,
  SSH_STAND_SATZ,
  sshSchluesselPruefen,
  sshText,
  type BoxAnmeldung,
  type FernwartungTechniker,
} from '../adminFernwartung';

/** In die Zwischenablage; ohne sicheren Kontext (http im LAN) über den alten Weg. */
async function kopiere(text: string, neben: HTMLElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // weiter mit dem Rückfall
  }
  try {
    // Neben dem Knopf statt am Seitenende: so bleibt der Fokus im Dialog.
    const feld = document.createElement('textarea');
    feld.value = text;
    feld.setAttribute('readonly', '');
    feld.setAttribute('aria-hidden', 'true');
    feld.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    neben.appendChild(feld);
    feld.select();
    const ok = document.execCommand('copy');
    feld.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Eine Befehlszeile zum Kopieren. Sie bricht um, statt abgeschnitten zu werden. */
export function Befehl({ text, was }: { text: string; was: string }) {
  const [stand, setStand] = useState<'ruhe' | 'kopiert' | 'fehler'>('ruhe');
  const zeile = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLElement>(null);

  useEffect(() => {
    if (stand === 'ruhe') return;
    const t = window.setTimeout(() => setStand('ruhe'), 2500);
    return () => window.clearTimeout(t);
  }, [stand]);

  async function kopieren(knopf: HTMLButtonElement) {
    const ok = zeile.current ? await kopiere(text, zeile.current) : false;
    if (!ok && code.current) {
      // Wenigstens markieren: dann genügt Strg+C.
      const auswahl = window.getSelection();
      const bereich = document.createRange();
      bereich.selectNodeContents(code.current);
      auswahl?.removeAllRanges();
      auswahl?.addRange(bereich);
    }
    knopf.focus();
    setStand(ok ? 'kopiert' : 'fehler');
  }

  return (
    <div className="vp-fw-befehl" ref={zeile}>
      <code ref={code}>{text}</code>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`${was} kopieren`}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => void kopieren(e.currentTarget)}
      >
        <span aria-live="polite">
          {stand === 'kopiert' ? 'Kopiert' : stand === 'fehler' ? 'Markiert' : 'Kopieren'}
        </span>
      </Button>
    </div>
  );
}

/** Die Befehle, mit denen der Techniker sein Schlüsselpaar erzeugt - je System. */
export function SshErzeugenHinweis() {
  return (
    <div className="vp-fw-erzeugen" data-testid="fw-ssh-erzeugen">
      <p className="vp-note" style={{ margin: 0 }}>
        Den Schlüssel erzeugt der Techniker einmal je Gerät. Es muss ein RSA-Schlüssel sein: Die Boxen
        nehmen keinen anderen an. Der zweite Befehl zeigt die eine Zeile, die hierher gehört; die Datei
        ohne <code>.pub</code> ist der private Teil und bleibt auf dem Gerät.
      </p>
      {SSH_ERZEUGEN.map((s) => (
        <div key={s.system} className="vp-fw-erzeugen-system">
          <span className="vp-field-label">{s.system}</span>
          <Befehl text={s.erzeugen} was={`Befehl zum Erzeugen unter ${s.system}`} />
          <Befehl text={s.anzeigen} was={`Befehl zum Anzeigen unter ${s.system}`} />
          {s.hinweis && <span className="vp-field-help">{s.hinweis}</span>}
        </div>
      ))}
    </div>
  );
}

/** Das Eingabefeld für die Zeile aus der `.pub`-Datei. */
export function SshSchluesselFeld({
  id,
  wert,
  onChange,
  fehler,
  feld,
  pflicht,
}: {
  id: string;
  wert: string;
  onChange: (wert: string) => void;
  fehler: string | null;
  feld: RefObject<HTMLTextAreaElement>;
  pflicht?: boolean;
}) {
  return (
    <div className="vp-fw-sshfeld">
      <label className="vp-field-label" htmlFor={id}>
        Öffentlicher SSH-Schlüssel{pflicht ? ' *' : ''}
      </label>
      <textarea
        ref={feld}
        id={id}
        rows={4}
        value={wert}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="ssh-rsa AAAAB3NzaC1yc2EA…"
        aria-invalid={fehler != null}
        aria-describedby={`${id}-hilfe`}
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="vp-field-help" id={`${id}-hilfe`}>
        {pflicht
          ? 'Die eine Zeile aus der .pub-Datei. Der Kommentar am Ende wird nicht gespeichert.'
          : 'Freiwillig: die eine Zeile aus der .pub-Datei. Ohne SSH-Schlüssel öffnet ein Fenster für diesen Zugang nur den Netzweg.'}
      </span>
      {fehler && (
        <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>
          {fehler}
        </p>
      )}
    </div>
  );
}

/** Der hinterlegte Schlüssel mit den Befehlen, die denselben Fingerabdruck auf dem Gerät zeigen. */
export function SshFingerabdruck({ techniker }: { techniker: FernwartungTechniker }) {
  return (
    <div className="vp-form-stack" data-testid="fw-ssh-fingerabdruck">
      <p className="vp-alert vp-alert-ok vp-fw-umbruch" style={{ margin: 0 }}>
        SSH-Schlüssel hinterlegt. Fingerabdruck: <strong>{sshText(techniker)}</strong>
      </p>
      <p className="vp-note" style={{ margin: 0 }}>
        Zum Vergleich auf dem Gerät des Technikers; dort muss derselbe Fingerabdruck erscheinen:
      </p>
      {SSH_ERZEUGEN.map((s) => (
        <div key={s.system} className="vp-fw-erzeugen-system">
          <span className="vp-field-label">{s.system}</span>
          <Befehl text={s.fingerabdruck} was={`Befehl für den Fingerabdruck unter ${s.system}`} />
        </div>
      ))}
    </div>
  );
}

/**
 * Zu den offenen Fenstern einer Box: die fertigen Befehle (sie hängen nur an
 * der Box) und je Fenster der Satz, ob der Zugang einen SSH-Schlüssel trägt
 * oder das Fenster nur den Netzweg öffnet.
 */
export function BoxAnmeldungBlock({ anmeldung, boxRef }: { anmeldung: BoxAnmeldung; boxRef: string }) {
  return (
    <div className="vp-fw-anmeldung" data-testid="fw-anmeldung" data-box={boxRef}>
      <span className="vp-fw-anmeldung-titel">Anmelden im offenen Fenster</span>
      <div className="vp-fw-anmeldung-zeile">
        <span className="vp-fw-anmeldung-was">SSH</span>
        <Befehl text={anmeldung.befehle.ssh} was="SSH-Befehl" />
      </div>
      <div className="vp-fw-anmeldung-zeile">
        <span className="vp-fw-anmeldung-was">Web-App</span>
        <div className="vp-fw-anmeldung-web">
          <Befehl text={anmeldung.befehle.webApp} was="Befehl für die Web-App" />
          <span className="vp-cell-sub">
            danach im Browser: <code>{anmeldung.befehle.webAdresse}</code>
          </span>
        </div>
      </div>
      <ul className="vp-fw-anmeldung-fenster">
        {anmeldung.fenster.map((f) => (
          <li
            key={f.fensterId}
            className={`vp-fw-umbruch${f.ton === 'warn' ? ' vp-alert vp-alert-warn' : ' vp-note'}`}
            data-testid={`fw-anmeldung-${f.schluessel}`}
          >
            {f.satz}
          </li>
        ))}
      </ul>
    </div>
  );
}

type Schritt = 'eingabe' | 'entfernen' | 'gesetzt' | 'entfernt';

/** Den SSH-Schlüssel eines bestehenden Zugangs hinterlegen, ersetzen oder entfernen. */
export function SshSchluesselDialog({
  techniker,
  onClose,
  onFertig,
}: {
  techniker: FernwartungTechniker | null;
  onClose: () => void;
  onFertig: () => void;
}) {
  const [wert, setWert] = useState('');
  const [schritt, setSchritt] = useState<Schritt>('eingabe');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [geprueft, setGeprueft] = useState(false);
  const [ergebnis, setErgebnis] = useState<FernwartungTechniker | null>(null);
  const feld = useRef<HTMLTextAreaElement>(null);

  const id = techniker?.id ?? null;
  useEffect(() => {
    if (!id) return;
    setWert('');
    setSchritt('eingabe');
    setFehler(null);
    setGeprueft(false);
    setErgebnis(null);
  }, [id]);

  if (!techniker) return null;
  const pruefung = sshSchluesselPruefen(wert);
  const eingabeFehler = pruefung.ok ? null : pruefung.fehler;
  const vorhanden = techniker.sshFingerabdruck != null;

  async function sende(was: () => Promise<FernwartungTechniker>, danach: Schritt, sonst: string) {
    setBusy(true);
    setFehler(null);
    try {
      setErgebnis(await was());
      setSchritt(danach);
      onFertig();
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : sonst);
    } finally {
      setBusy(false);
    }
  }

  function hinterlegen() {
    setGeprueft(true);
    if (eingabeFehler || !techniker) {
      feld.current?.focus();
      return;
    }
    void sende(
      () => adminApi.fernwartungTechnikerSshSetzen(techniker.id, wert.trim()),
      'gesetzt',
      'Der SSH-Schlüssel ließ sich nicht hinterlegen.',
    );
  }

  function entfernen() {
    if (!techniker) return;
    void sende(
      () => adminApi.fernwartungTechnikerSshEntfernen(techniker.id),
      'entfernt',
      'Der SSH-Schlüssel ließ sich nicht entfernen.',
    );
  }

  const footer =
    schritt === 'gesetzt' || schritt === 'entfernt' ? (
      <Button variant="primary" onClick={onClose}>
        Fertig
      </Button>
    ) : schritt === 'entfernen' ? (
      <>
        <Button variant="ghost" onClick={() => setSchritt('eingabe')} disabled={busy}>
          Zurück
        </Button>
        <Button variant="primary" onClick={entfernen} disabled={busy}>
          {busy ? 'Entferne…' : 'Schlüssel entfernen'}
        </Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
        <Button variant="primary" onClick={hinterlegen} disabled={busy}>
          {busy ? 'Speichere…' : vorhanden ? 'Schlüssel ersetzen' : 'Schlüssel hinterlegen'}
        </Button>
      </>
    );

  return (
    <Modal
      open
      onClose={onClose}
      title="SSH-Schlüssel"
      icon={
        <IconTile category="primary" size={40}>
          <Icon name="shield" size={20} />
        </IconTile>
      }
      footer={footer}
    >
      <div className="vp-form-stack" data-testid="fw-ssh-dialog">
        <p className="vp-fw-umbruch" style={{ margin: 0 }}>
          Zugang „{techniker.name}“ ({techniker.adresse})
        </p>
        {schritt === 'gesetzt' && ergebnis && <SshFingerabdruck techniker={ergebnis} />}
        {schritt === 'entfernt' && (
          <p className="vp-alert vp-alert-ok" style={{ margin: 0 }}>
            SSH-Schlüssel entfernt. Fenster für diesen Zugang öffnen jetzt nur noch den Netzweg.
          </p>
        )}
        {schritt === 'entfernen' && (
          <div className="vp-alert vp-alert-warn vp-fw-umbruch" style={{ margin: 0 }} data-testid="fw-ssh-entfernen">
            <p style={{ margin: 0 }}>
              Den SSH-Schlüssel {sshText(techniker)} entfernen? Fenster für diesen Zugang öffnen danach
              nur noch den Netzweg. Ein offenes Fenster bleibt offen; der Tunnel-Dienst gibt den Schlüssel
              ab dem nächsten Abruf nicht mehr weiter. Das Entfernen steht im Protokoll.
            </p>
          </div>
        )}
        {schritt === 'eingabe' && (
          <>
            {vorhanden ? (
              <div className="vp-fw-ssh-stand">
                <p className="vp-note vp-fw-umbruch" style={{ margin: 0 }} data-testid="fw-ssh-aktuell">
                  Hinterlegt: <strong>{sshText(techniker)}</strong>
                </p>
                <Button variant="ghost" size="sm" onClick={() => setSchritt('entfernen')} disabled={busy}>
                  Entfernen
                </Button>
              </div>
            ) : (
              <p className="vp-alert vp-alert-warn" style={{ margin: 0 }} data-testid="fw-ssh-aktuell">
                Kein SSH-Schlüssel hinterlegt: Fenster für diesen Zugang öffnen nur den Netzweg.
              </p>
            )}
            <SshSchluesselFeld
              id="fw-ssh-schluessel"
              wert={wert}
              onChange={(w) => {
                setWert(w);
                setFehler(null);
              }}
              fehler={geprueft ? eingabeFehler : null}
              feld={feld}
              pflicht
            />
            <SshErzeugenHinweis />
            <p className="vp-note" style={{ margin: 0 }}>
              {SSH_STAND_SATZ}
            </p>
          </>
        )}
        {fehler && (
          <p className="vp-alert vp-alert-err" style={{ margin: 0 }}>
            {fehler}
          </p>
        )}
      </div>
    </Modal>
  );
}
