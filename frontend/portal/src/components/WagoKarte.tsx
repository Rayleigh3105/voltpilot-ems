/**
 * UEMS AP-05 IP-11 — die Energiekarte an der Messstelle: die dokumentierten Angaben, der Hebel
 * „Wandler und Anwenderskalierung prüfen“ (nur aus Belegen) und der Dialog „Karte getauscht“.
 *
 * ⚠ SICHTBARKEIT: Der Abschnitt erscheint NUR, wo es eine WAGO-Komponente gibt. Die Route
 * antwortet für jede andere Komponente mit 404 — dann zeichnet diese Fläche gar nichts, und eine
 * Anlage ohne WAGO-Karte sieht keinen neuen Einstieg. Das ist heute jede Anlage jedes Kunden.
 *
 * Die Marker im Verlauf sind davon getrennt: sie sind allgemein und erscheinen überall dort, wo
 * Ereignisse vorliegen (`WerteSektion`/`uemsVerlauf`), auch ohne WAGO.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { ApiError, api, type WagoKartenangaben, type WagoKartenwechsel } from '../api';
import { lesen, ortszeit, type ZeitpunktEingabe } from '../picker/zeitpunkt';
import { Recht } from './Recht';
import { useRollen } from '../rollen';
import {
  KARTE_TAUSCHEN,
  KARTE_TITEL,
  kartenAngaben,
  kartenHebel,
  kartenwechselFolgen,
  kartenwechselPruefen,
} from '../wagoKarte';
import { VpZeitpunktPicker } from './VpZeitpunktPicker';
import './WagoKarte.css';

export function WagoKarte({ anlageId, standortId, entityId, zone, einheit, jetzt, onGetauscht }: {
  /** Die ANLAGE — der Weg der Route (`/api/v1/sites/{anlageId}/components/…`). */
  anlageId: string;
  /** Der STANDORT — die Zuständigkeit, an der ein Recht hängt (nie die Anlage). */
  standortId: string | null;
  entityId: string;
  zone: string;
  /** Die Einheit des führenden Zählwerks — ohne sie nimmt der Dialog keinen Endstand an. */
  einheit: string | null;
  jetzt?: string;
  onGetauscht?: () => void;
}) {
  const [karte, setKarte] = useState<WagoKartenangaben | null>(null);
  const [offen, setOffen] = useState(false);
  const [stand, setStand] = useState(0);
  useEffect(() => {
    let aktiv = true;
    void api.wagoKarte(anlageId, entityId)
      // Nur eine ECHTE Kartenantwort zeichnet; alles andere ist keine WAGO-Komponente.
      .then((k) => { if (aktiv) setKarte(k && typeof k.version === 'number' ? k : null); })
      // 404 = keine WAGO-Komponente. Kein Fehler, kein Hinweis: die Fläche gibt es dort nicht.
      .catch(() => { if (aktiv) setKarte(null); });
    return () => { aktiv = false; };
  }, [anlageId, entityId, stand]);
  if (karte === null) return null;
  const hebel = kartenHebel(karte, zone);
  return (
    <section className="vp-rahmen-block vp-wk" data-testid="wago-karte" aria-labelledby="vp-wk-titel">
      <h3 id="vp-wk-titel">
        <Icon name="sliders" size={14} />
        {KARTE_TITEL}
      </h3>
      <ul className="vp-wk-liste">
        {kartenAngaben(karte).map((z) => <li key={z}>{z}</li>)}
      </ul>
      {hebel && (
        <div className="vp-wk-hebel" role="note" data-testid="wago-hebel">
          <p className="vp-wk-hebel-titel">{hebel.titel}</p>
          <p>{hebel.satz}</p>
        </div>
      )}
      <div className="vp-wk-fuss">
        <Recht aktion="geraet.einrichten" standort={standortId}><Button
          variant="ghost"
          size="sm"
          data-testid="wago-karte-tauschen"
          iconLeft={<Icon name="sliders" size={14} />}
          onClick={() => setOffen(true)}
        >
          {KARTE_TAUSCHEN}
        </Button></Recht>
      </div>
      {offen && (
        <KarteGetauschtDialog
          anlageId={anlageId}
          standortId={standortId}
          entityId={entityId}
          zone={zone}
          einheit={einheit}
          jetzt={jetzt}
          onClose={() => setOffen(false)}
          onGetauscht={() => { setStand((s) => s + 1); onGetauscht?.(); }}
        />
      )}
    </section>
  );
}

/**
 * „Karte getauscht“ (E6, Abnahme A10): Zeitpunkt, wahlweise der Endstand der alten Karte, und die
 * Prüfaufgabe für die Einstellungen der neuen Karte. KEIN Gerätewechsel — darum kein Feld für ein
 * neues Gerät, keine Verbindung, keine Bindung. Das Muster ist der Controllerwechsel-Dialog
 * (AP-04), nur ohne alles, was ein Gerät anlegt.
 */
export function KarteGetauschtDialog({ anlageId, standortId, entityId, zone, einheit, jetzt, onClose, onGetauscht }: {
  anlageId: string;
  standortId: string | null;
  entityId: string;
  zone: string;
  einheit: string | null;
  jetzt?: string;
  onClose: () => void;
  onGetauscht: () => void;
}) {
  const [uhr] = useState(() => jetzt ?? new Date().toISOString());
  const rollen = useRollen();
  const [zeit, setZeit] = useState<ZeitpunktEingabe>(() => ortszeit(uhr, zone));
  const [endstand, setEndstand] = useState('');
  const [pruefen, setPruefen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [folgen, setFolgen] = useState<string[] | null>(null);
  const sperre = useRef(false);
  const fehlerRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (fehler) fehlerRef.current?.focus(); }, [fehler]);
  const zeitpunkt = lesen(zeit, zone).wert;
  const darf = rollen.darf('geraet.einrichten', standortId);
  const speichern = async () => {
    const geprueft = kartenwechselPruefen(
      { zeitpunkt, endstand, einheit, einstellungenPruefen: pruefen }, uhr,
    );
    if (!geprueft.body) { setFehler(geprueft.fehler); return; }
    if (!darf || sperre.current) return;
    sperre.current = true; setBusy(true); setFehler(null);
    const auftrag: WagoKartenwechsel = geprueft.body;
    try {
      const k = await api.wagoKartenwechsel(anlageId, entityId, auftrag);
      setFolgen(kartenwechselFolgen(auftrag, k, zone));
      onGetauscht();
    } catch (e) {
      setFehler(e instanceof ApiError || e instanceof Error ? e.message
        : 'Der Kartentausch konnte nicht eingetragen werden.');
    } finally { sperre.current = false; setBusy(false); }
  };
  return (
    <Modal
      open
      title={folgen ? 'Kartentausch eingetragen' : KARTE_TAUSCHEN}
      onClose={() => { if (!busy) onClose(); }}
      footer={folgen ? <Button onClick={onClose}>Schließen</Button> : <>
        <Button variant="ghost" disabled={busy} onClick={onClose}>Abbrechen</Button>
        <Button disabled={busy || !darf} data-testid="wago-kartenwechsel-speichern" onClick={() => void speichern()}>
          {busy ? 'Wird eingetragen …' : 'Kartentausch eintragen'}
        </Button>
      </>}
    >
      <div className="vp-wk-dialog">
        {fehler && <p ref={fehlerRef} role="alert" tabIndex={-1} className="vp-wk-fehler">{fehler}</p>}
        {folgen ? (
          <section aria-label="Gespeicherte Folgen" role="status" className="vp-wk-folgen" data-testid="wago-kartenwechsel-folgen">
            {folgen.map((s, i) => <p key={`${i}:${s}`}>{s}</p>)}
          </section>
        ) : (
          <>
            <p>
              Die Karte wird getauscht, das Gerät bleibt. Messstelle und Kennzeichen bleiben; die
              Werte der alten Karte bleiben vollständig lesbar.
            </p>
            <VpZeitpunktPicker value={zeit} zone={zone} onChange={setZeit} disabled={busy} />
            <Input
              label={`Endstand der alten Karte (${einheit ?? 'Einheit nicht erfasst'}, optional)`}
              inputMode="decimal"
              data-testid="wago-endstand"
              disabled={busy || !einheit}
              value={endstand}
              onChange={(e) => setEndstand(e.target.value)}
            />
            <p className="vp-wk-hinweis">
              Bleibt der Endstand leer, wird kein Stand angenommen. Der Zählerstand der neuen Karte
              beginnt bei null; dieser Sprung zählt nicht als Verbrauch.
            </p>
            <label className="vp-wk-check">
              <input
                type="checkbox"
                data-testid="wago-pruefaufgabe"
                checked={pruefen}
                disabled={busy}
                onChange={(e) => setPruefen(e.target.checked)}
              />
              Einstellungen der neuen Karte prüfen lassen
            </label>
            <p className="vp-wk-hinweis">
              Dann gelten Anwenderskalierung und Register 35 wieder als nicht erfasst — was für die
              alte Karte erhoben war, gilt für die neue nicht.
            </p>
            {!darf && <p role="note">{rollen.grund}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}
