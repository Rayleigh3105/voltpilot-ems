import { Recht } from './Recht';
import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import {
  ApiError, api,
  type RegisterWriteEvent, type RegisterWriteOutcome, type RegisterWriteTarget,
} from '../api';
import {
  EEPROM_HINWEIS,
  LESE_DAUER_HINWEIS,
  LESE_LAEUFT,
  VERANTWORTUNG,
  adresseEcho,
  adresseFehler,
  beleg,
  bestaetigenLabel,
  bestaetigungsFolgen,
  freieAdresseFehler,
  journalSatz,
  klasseTon,
  registerKenntnis,
  vorschau,
  wertFehler,
  ziele,
  zielInput,
  zielKey,
} from '../registerWrite';
import { ConfirmDialog } from './ConfirmDialog';

/** Der Schlüssel der FREI getippten Adresse - keine Zeile des Pickers. */
const FREI = 'frei';

/**
 * Der Register-Drawer: die ZWEI-SCHRITT-STRECKE aus dem Konzept
 * `vp-reg-schreib-konzept-p8` §2.3 - erst den Ist-Wert LESEN, dann bestätigen,
 * danach ein Beleg mit Rücklesung.
 *
 * <p><b>Die Reihenfolge ist keine Hürde, sie IST der erste Schritt.</b> Die
 * Vorschau läuft über dieselbe Lane, über die geschrieben würde, beweist damit
 * mit, dass der Weg offen ist (Tor an? Lane erreichbar? Selbstkonflikt?), und
 * macht einen Skalen- oder Adressfehler SICHTBAR, bevor irgendetwas passiert.
 *
 * <p>Er RENDERT nur: jeder Satz, jede Warnklasse und jedes Urteil liegt in der
 * reinen `src/registerWrite.ts` - dieselbe Quelle, aus der die Befehle-Seite
 * ihren vierten Strom formuliert.
 *
 * <p><b>Seit Stufe 2 beginnt er mit dem ZIEL</b> (Konzept §2.3): auf einer
 * Anlage mit mehreren Geräten ist das Ziel eine bewusste Auswahl, nie ein
 * Default im Verborgenen. Ein Gerät OHNE Schreibweg steht mit seinem Grund in
 * der Liste - es wegzulassen erzeugte die Frage „warum fehlt mein Gerät?" und
 * beantwortete sie nirgends.
 */
export function RegisterWriteDrawer({
  open,
  siteId,
  deviceId,
  tenantId,
  geraetName,
  vorwahl = null,
  verlaufFilter,
  onClose,
}: {
  open: boolean;
  siteId: string;
  deviceId: string;
  /** Der Mandant der Anlage - er stampft den Umschalter-Kopf NUR für diese Aufrufe. */
  tenantId?: string;
  geraetName: string;
  /**
   * Der Schlüssel eines VORGEWÄHLTEN Ziels (Anlagen-Zentrale Stufe 1, §7.5).
   * Er wird nur übernommen, wenn er wirklich zu einem gelieferten Ziel gehört -
   * eine Vorwahl ins Leere wäre schlimmer als keine, weil sie den ersten
   * Schritt als erledigt aussehen ließe.
   */
  vorwahl?: string | null;
  /**
   * Der VERLAUFS-Filter der Geräteseite: er grenzt das Journal der Box auf die
   * Vorgänge DIESES Geräts ein. Ohne ihn (Kunden-/Plattform-Fläche) steht das
   * ganze Journal der Box da - das ist dort die richtige Menge.
   */
  verlaufFilter?: (rows: RegisterWriteEvent[]) => RegisterWriteEvent[];
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<RegisterWriteTarget[]>([]);
  const [zielKeyState, setZielKey] = useState<string | null>(null);
  const [freierHost, setFreierHost] = useState('');
  const [freierPort, setFreierPort] = useState('502');
  const [freieUnit, setFreieUnit] = useState('1');
  const [adresse, setAdresse] = useState('0x00E7');
  const [wert, setWert] = useState('');
  const [notiz, setNotiz] = useState('');
  const [ist, setIst] = useState<RegisterWriteOutcome | null>(null);
  const [ergebnis, setErgebnis] = useState<RegisterWriteOutcome | null>(null);
  const [verlauf, setVerlauf] = useState<RegisterWriteEvent[]>([]);
  const [frage, setFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  // Eigener Zustand fuer die LESUNG: waehrend eines Schreibvorgangs ist `busy`
  // ebenfalls gesetzt, und „Wird gelesen …" waere dann schlicht falsch.
  const [liest, setLiest] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let abgebrochen = false;
    // Der Picker ist Beiwerk in dem Sinne, dass die primäre Lane auch ohne ihn
    // funktioniert - ein Fehlschlag darf die Strecke also nie blockieren.
    api.registerWriteTargets(siteId, tenantId)
      .then((rows) => {
        if (abgebrochen) return;
        setTargets(rows);
        // ⚠ Nur eine Vorwahl übernehmen, die es WIRKLICH gibt - und nur, solange
        // der Mensch noch nichts gewählt hat (sein Klick gewinnt immer).
        setZielKey((jetzt) => (jetzt ?? (vorwahl && rows.some((t) => zielKey(t) === vorwahl)
          ? vorwahl
          : null)));
      })
      .catch(() => { if (!abgebrochen) setTargets([]); });
    return () => { abgebrochen = true; };
  }, [open, siteId, tenantId, vorwahl]);

  useEffect(() => {
    if (!open) return;
    let abgebrochen = false;
    api.registerWriteHistory(siteId, deviceId, tenantId)
      .then((rows) => { if (!abgebrochen) setVerlauf(verlaufFilter ? verlaufFilter(rows) : rows); })
      // Der Verlauf ist Beiwerk - er darf die Strecke nie blockieren.
      .catch(() => { if (!abgebrochen) setVerlauf([]); });
    return () => { abgebrochen = true; };
  }, [open, siteId, deviceId, tenantId, ergebnis, verlaufFilter]);

  if (!open) return null;

  const zielListe = ziele(targets);
  const gewaehltesTarget = targets.find((t) => zielKey(t) === zielKeyState) ?? null;
  const gewaehlt = zielListe.find((z) => z.key === zielKeyState) ?? null;
  // ⚠ „frei" ist keine Zeile des Pickers, sondern die ausdrückliche Wahl einer
  // Adresse, die niemand eingerichtet hat - deshalb ihr eigener Schalter.
  const freiGewaehlt = zielKeyState === FREI;
  const hostMangel = freiGewaehlt ? freieAdresseFehler(freierHost) : null;
  const kenntnis = freiGewaehlt
    ? 'VoltPilot kennt die Register dieses Geräts nicht. Sie sehen nur den '
      + 'Rohwert - Name und Umrechnung fehlen, geschrieben werden kann trotzdem.'
    : registerKenntnis(gewaehlt);
  const zielBereit = freiGewaehlt ? !hostMangel : !!gewaehlt?.waehlbar;

  const adrMangel = adresseFehler(adresse);
  const sicht = ist ? vorschau(ist) : null;
  const wertMangel = wert.trim() ? wertFehler(wert) : null;
  // ⚠ Was den Schreibvorgang verhindern WIRD, steht VOR dem Klick.
  const notizFehlt = !!sicht?.notizPflicht && !notiz.trim();
  const kannSchreiben = !!sicht?.gelesen && !!wert.trim() && !wertMangel && !notizFehlt;
  const bel = ergebnis && ergebnis.mode === 'schreiben' ? beleg(ergebnis) : null;

  function zielGewaehlt(key: string) {
    felderGeaendert(() => setZielKey(key));
  }

  function felderGeaendert(patch: () => void) {
    patch();
    // Eine geänderte Adresse ist ein ANDERES Register - die Vorschau dazu ist
    // damit wertlos, und ohne Vorschau gibt es keinen zweiten Schritt.
    setIst(null);
    setErgebnis(null);
    setFehler(null);
  }

  async function lesen() {
    setBusy(true);
    setLiest(true);
    setFehler(null);
    setErgebnis(null);
    try {
      setIst(await api.registerWritePreview(siteId,
        { deviceId, address: adresse.trim(), ...zielFelder() }, tenantId));
    } catch (e) {
      setIst(null);
      setFehler(e instanceof ApiError ? e.message : 'Der Ist-Wert konnte nicht gelesen werden.');
    } finally {
      setBusy(false);
      setLiest(false);
    }
  }

  async function schreiben() {
    setFrage(false);
    setBusy(true);
    setFehler(null);
    try {
      const out = await api.registerWrite(siteId, {
        deviceId,
        ...zielFelder(),
        address: adresse.trim(),
        value: wert.trim(),
        expectedBefore: sicht?.expectedBefore ?? null,
        note: notiz.trim() || undefined,
      }, tenantId);
      setErgebnis(out);
      // Nach einem Schreibvorgang ist der alte Ist-Wert Geschichte: die nächste
      // Bestätigung braucht eine frische Lesung.
      setIst(null);
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Der Schreibvorgang ist fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Der SKALIERTE neue Wert - nur wo der Server eine Skala genannt hat. Er wird
   * hier NICHT gerechnet, sondern aus der bekannten Skala des Ist-Werts
   * abgeleitet; ohne sie steht auf dem Knopf nur die rohe Zahl.
   */
  function skaliert(): number | null {
    if (!ist || ist.beforeRaw == null || ist.beforeScaled == null) return null;
    const roh = Number.parseInt(wert.trim(), wert.trim().toLowerCase().startsWith('0x') ? 16 : 10);
    if (!Number.isFinite(roh) || ist.beforeRaw === 0) return null;
    return (ist.beforeScaled / ist.beforeRaw) * roh;
  }

  /** Was als Ziel mitreist - aus der Auswahl, nie geraten. */
  function zielFelder() {
    if (freiGewaehlt) {
      const port = Number.parseInt(freierPort, 10);
      const unit = Number.parseInt(freieUnit, 10);
      return {
        lane: 'lan',
        host: freierHost.trim(),
        ...(Number.isFinite(port) ? { port } : {}),
        ...(Number.isFinite(unit) ? { unitId: unit } : {}),
      };
    }
    return zielInput(gewaehltesTarget);
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Register schreiben"
        icon={
          <IconTile category="primary" size={40}>
            <Icon name="pencil" size={20} />
          </IconTile>
        }
      >
        <section className="vp-regwrite" data-testid="regwrite">
          <p className="vp-assist-sub">{geraetName}</p>

          {/* ── Schritt 1: Ziel & Register ─────────────────────────────── */}
          <h4>1 · Ziel wählen</h4>
          <ul className="vp-regwrite-ziele" data-testid="regwrite-ziele">
            {zielListe.map((z) => (
              <li key={z.key}>
                <label>
                  <input
                    type="radio"
                    name="regwrite-ziel"
                    value={z.key}
                    checked={zielKeyState === z.key}
                    disabled={!z.waehlbar}
                    onChange={() => zielGewaehlt(z.key)}
                  />
                  <span>
                    <strong>{z.titel}</strong>
                    <span className="vp-muted vp-text-sm"> · {z.laneWort}</span>
                    {z.unterzeile && (
                      <span className="vp-muted vp-text-sm"><br />{z.unterzeile}</span>
                    )}
                    {z.grund && (
                      <span className="vp-text-sm" data-testid="regwrite-ziel-grund">
                        <br />{z.grund}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
            <li>
              <label>
                <input
                  type="radio"
                  name="regwrite-ziel"
                  value={FREI}
                  checked={freiGewaehlt}
                  onChange={() => zielGewaehlt(FREI)}
                />
                <span>
                  <strong>Freie Adresse im Netzwerk</strong>
                  <span className="vp-muted vp-text-sm"> · Experte</span>
                </span>
              </label>
            </li>
          </ul>
          {freiGewaehlt && (
            <div className="vp-regwrite-frei" data-testid="regwrite-frei">
              <Input
                label="IP-Adresse im Kunden-Netz"
                value={freierHost}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  felderGeaendert(() => setFreierHost(e.target.value))}
                hint="Nur Adressen im eigenen Netz - das Gerät prüft das selbst."
                error={hostMangel ?? undefined}
              />
              <Input
                label="Port"
                value={freierPort}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  felderGeaendert(() => setFreierPort(e.target.value))}
                hint="Vorgabe 502."
              />
              <Input
                label="Unit-ID"
                value={freieUnit}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  felderGeaendert(() => setFreieUnit(e.target.value))}
                hint="Vorgabe 1."
              />
            </div>
          )}
          {kenntnis && zielBereit && (
            <p className="vp-text-sm" data-testid="regwrite-kenntnis">{kenntnis}</p>
          )}

          <h4>2 · Register wählen und Ist-Wert lesen</h4>
          <Input
            label="Registeradresse"
            value={adresse}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              felderGeaendert(() => setAdresse(e.target.value))}
            hint={adresseEcho(adresse) ?? 'Dezimal (231) oder hexadezimal (0x00E7).'}
            error={adrMangel ?? undefined}
          />
          <Button
            variant="outline"
            onClick={lesen}
            disabled={busy || !!adrMangel || !zielBereit}
            data-testid="regwrite-lesen"
          >
            {liest ? LESE_LAEUFT : 'Ist-Wert lesen'}
          </Button>
          {liest && (
            <p className="vp-text-sm vp-muted" data-testid="regwrite-lesedauer">
              {LESE_DAUER_HINWEIS}
            </p>
          )}

          {sicht && (
            <div className="vp-regwrite-ist" data-testid="regwrite-ist">
              <p className={sicht.ton === 'ok' ? undefined : 'vp-edge-stand-warn'}>
                {sicht.satz}
              </p>
              {sicht.klasseWort && (
                <p className="vp-text-sm" data-testid="regwrite-klasse">
                  <strong>{sicht.klasseWort}</strong>
                  {ist?.registerLabel ? ` · ${ist.registerLabel}` : ''}
                </p>
              )}
              {sicht.warnung && (
                <p
                  className={klasseTon(sicht.klasse) === 'danger'
                    ? 'vp-edge-stand-warn' : 'vp-text-sm'}
                  data-testid="regwrite-warnung"
                >
                  {sicht.warnung}
                </p>
              )}
              {sicht.hinweis && (
                <p className="vp-text-sm" data-testid="regwrite-hinweis">{sicht.hinweis}</p>
              )}
              {sicht.schreibzaehler && (
                <p className="vp-text-sm" data-testid="regwrite-zaehler">
                  {sicht.schreibzaehler}
                </p>
              )}
            </div>
          )}

          {/* ── Schritt 2: Vorschau & Bestätigen ───────────────────────── */}
          {sicht?.gelesen && (
            <>
              <h4>3 · Neuen Wert eintragen und bestätigen</h4>
              <Input
                label="Neuer Rohwert"
                value={wert}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setWert(e.target.value)}
                hint="Der ROHE Registerwert, nicht kW."
                error={wertMangel ?? undefined}
              />
              <Input
                label={sicht.notizPflicht ? 'Grund (Pflicht)' : 'Grund (optional)'}
                value={notiz}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setNotiz(e.target.value)}
                hint="z. B. die Freigabe des Netzbetreibers - sie wird wörtlich protokolliert."
                error={notizFehlt ? 'Für dieses Register ist der Grund Pflicht.' : undefined}
              />
              <p className="vp-text-sm">{EEPROM_HINWEIS}</p>
              <p className="vp-text-sm">{VERANTWORTUNG}</p>
              <Recht aktion="register.schreiben"><Button
                variant="primary"
                onClick={() => setFrage(true)}
                disabled={busy || !kannSchreiben}
                data-testid="regwrite-schreiben"
              >
                {bestaetigenLabel(adresse, wert || '0', skaliert(), ist?.scaleUnit ?? null)}
              </Button></Recht>
            </>
          )}

          {/* ── Schritt 3: Beleg ───────────────────────────────────────── */}
          {bel && (
            <div className="vp-regwrite-beleg" data-testid="regwrite-beleg">
              <p className={bel.ton === 'ok' ? undefined : 'vp-edge-stand-warn'}>{bel.satz}</p>
              {bel.detail && <p className="vp-text-sm">{bel.detail}</p>}
              {ergebnis?.targetLabel && (
                <p className="vp-muted vp-text-sm">{ergebnis.targetLabel}</p>
              )}
            </div>
          )}

          {fehler && <p className="vp-edge-stand-warn">{fehler}</p>}

          {verlauf.length > 0 && (
            <div className="vp-regwrite-verlauf" data-testid="regwrite-verlauf">
              <h4>Verlauf dieses Geräts</h4>
              <ul>
                {verlauf.map((e) => <li key={e.id}>{journalSatz(e)}</li>)}
              </ul>
            </div>
          )}
        </section>
      </Modal>

      <ConfirmDialog
        open={frage}
        title="Register jetzt schreiben"
        intro={bestaetigenLabel(adresse, wert || '0', skaliert(), ist?.scaleUnit ?? null)}
        consequences={bestaetigungsFolgen()}
        confirmLabel="Jetzt schreiben"
        tone="danger"
        busy={busy}
        onConfirm={schreiben}
        onCancel={() => setFrage(false)}
      />
    </>
  );
}
