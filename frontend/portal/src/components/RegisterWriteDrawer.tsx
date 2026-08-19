import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import { Drawer } from '../../designsystem/components/shell/Drawer';
import { ApiError, api, type RegisterWriteEvent, type RegisterWriteOutcome } from '../api';
import {
  EEPROM_HINWEIS,
  VERANTWORTUNG,
  adresseEcho,
  adresseFehler,
  beleg,
  bestaetigenLabel,
  journalSatz,
  klasseTon,
  vorschau,
  wertFehler,
} from '../registerWrite';
import { ConfirmDialog } from './ConfirmDialog';

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
 */
export function RegisterWriteDrawer({
  open,
  siteId,
  deviceId,
  tenantId,
  geraetName,
  onClose,
}: {
  open: boolean;
  siteId: string;
  deviceId: string;
  /** Der Mandant der Anlage - er stampft den Umschalter-Kopf NUR für diese Aufrufe. */
  tenantId?: string;
  geraetName: string;
  onClose: () => void;
}) {
  const [adresse, setAdresse] = useState('0x00E7');
  const [wert, setWert] = useState('');
  const [notiz, setNotiz] = useState('');
  const [ist, setIst] = useState<RegisterWriteOutcome | null>(null);
  const [ergebnis, setErgebnis] = useState<RegisterWriteOutcome | null>(null);
  const [verlauf, setVerlauf] = useState<RegisterWriteEvent[]>([]);
  const [frage, setFrage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let abgebrochen = false;
    api.registerWriteHistory(siteId, deviceId, tenantId)
      .then((rows) => { if (!abgebrochen) setVerlauf(rows); })
      // Der Verlauf ist Beiwerk - er darf die Strecke nie blockieren.
      .catch(() => { if (!abgebrochen) setVerlauf([]); });
    return () => { abgebrochen = true; };
  }, [open, siteId, deviceId, tenantId, ergebnis]);

  if (!open) return null;

  const adrMangel = adresseFehler(adresse);
  const sicht = ist ? vorschau(ist) : null;
  const wertMangel = wert.trim() ? wertFehler(wert) : null;
  // ⚠ Was den Schreibvorgang verhindern WIRD, steht VOR dem Klick.
  const notizFehlt = !!sicht?.notizPflicht && !notiz.trim();
  const kannSchreiben = !!sicht?.gelesen && !!wert.trim() && !wertMangel && !notizFehlt;
  const bel = ergebnis && ergebnis.mode === 'schreiben' ? beleg(ergebnis) : null;

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
    setFehler(null);
    setErgebnis(null);
    try {
      setIst(await api.registerWritePreview(siteId,
        { deviceId, address: adresse.trim() }, tenantId));
    } catch (e) {
      setIst(null);
      setFehler(e instanceof ApiError ? e.message : 'Der Ist-Wert konnte nicht gelesen werden.');
    } finally {
      setBusy(false);
    }
  }

  async function schreiben() {
    setFrage(false);
    setBusy(true);
    setFehler(null);
    try {
      const out = await api.registerWrite(siteId, {
        deviceId,
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

  return (
    <>
      <Drawer
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
          <h4>1 · Register wählen und Ist-Wert lesen</h4>
          <Input
            label="Registeradresse"
            value={adresse}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              felderGeaendert(() => setAdresse(e.target.value))}
            hint={adresseEcho(adresse) ?? 'Dezimal (231) oder hexadezimal (0x00E7).'}
            error={adrMangel ?? undefined}
          />
          <Button variant="outline" onClick={lesen} disabled={busy || !!adrMangel}>
            Ist-Wert lesen
          </Button>

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
            </div>
          )}

          {/* ── Schritt 2: Vorschau & Bestätigen ───────────────────────── */}
          {sicht?.gelesen && (
            <>
              <h4>2 · Neuen Wert eintragen und bestätigen</h4>
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
              <Button
                variant="primary"
                onClick={() => setFrage(true)}
                disabled={busy || !kannSchreiben}
                data-testid="regwrite-schreiben"
              >
                {bestaetigenLabel(adresse, wert || '0', null)}
              </Button>
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
      </Drawer>

      <ConfirmDialog
        open={frage}
        title="Register jetzt schreiben"
        intro={bestaetigenLabel(adresse, wert || '0', null)}
        consequences={[
          'Das Register wird GENAU EINMAL beschrieben - kein zweiter Versuch.',
          'Der Wert bleibt dauerhaft im Gerät gespeichert, bis ihn jemand ändert.',
          'Hat sich der Ist-Wert seit der Vorschau geändert, verweigert das Gerät.',
          'Der Vorgang wird mit Ihrem Namen und Ihrem Grund dauerhaft protokolliert.',
        ]}
        confirmLabel="Jetzt schreiben"
        tone="danger"
        busy={busy}
        onConfirm={schreiben}
        onCancel={() => setFrage(false)}
      />
    </>
  );
}
