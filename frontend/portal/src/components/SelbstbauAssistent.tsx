import { useEffect, useRef, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { VpPicker } from './VpPicker';
import { api, ApiError, type SiteComponents, type SiteComponentTemplate } from '../api';
import { prefill } from '../eigeneVorlagen';
import { AUTO_TEST_MS, neueKomponente } from '../anlegenFlow';
import {
  BILANZ_HINWEIS,
  DATA_TYPES,
  MAX_CHANNELS,
  REGISTER_KINDS,
  UNITS,
  VORLAGE_HINWEIS,
  WORD_ORDERS,
  geraetFehler,
  istBreit,
  lesbar,
  leseErgebnis,
  leselastHinweis,
  leseRumpf,
  messwerteFehler,
  modiconDeutung,
  neueVerbindung,
  neueZeile,
  speicherRumpf,
  zeilenFehler,
  type LeseErgebnis,
  type MesswertZeile,
  type VerbindungForm,
} from '../selbstbau';
import { Abschnitt, Abschnitte, EinrichtenFuss, EinrichtenKopf, EinrichtenSeite } from './Einrichten';

/** Was nach dem Speichern entstanden ist - der Wirt sagt es und springt darauf. */
export type SelbstbauErgebnis = { id: string | null; titel: string; hinweis: string | null };

/**
 * Der Weg „MODBUS-GERÄT SELBST BESCHREIBEN" (Einheitsmodell Stufe 3, Konzept
 * `vp-modbus-baukasten-k6` §2.3) als EINRICHTEN-SEITE (Konzept „Aufbau und
 * Gerätekatalog", Runde 2): Anschluss → Messwerte → Name auf EINER Seite.
 *
 * - Das Register steht sichtbar in jeder Zeile, und gelesen wird VON SELBST,
 *   sobald eine Zeile vollständig ist und die Eingabe ruht (`AUTO_TEST_MS`) -
 *   Roh- und umgerechneter Wert nebeneinander. „Erneut lesen" bleibt.
 * - Eine fünfstellige Handbuch-Nummer (40011) wird NIE still umgerechnet: die
 *   Zeile nennt die Modicon-Lesart und bietet sie als Knopf an; das Lesen zeigt,
 *   welche stimmt.
 * - „Als eigene Vorlage speichern" macht nach dem Anlegen aus dem Gerät eine
 *   private Vorlage dieser Anlage (`duplicateCustomComponent`) - ohne Adresse.
 *
 * Die Anlege-Semantik ist unverändert: `readCustomComponent` liefert den Beleg,
 * `createCustomComponent` legt an. Ob das Gerät später auch SCHALTEN darf, ist
 * ein eigener Schritt nach dem Anlegen; angelegt wird es zunächst nur lesend.
 *
 * Diese Datei RENDERT nur; jede Regel kommt aus dem reinen `selbstbau.ts`.
 */
export function SelbstbauAssistent({
  siteId,
  vorlage,
  vorher,
  onZurueck,
  onClose,
  onGespeichert,
}: {
  siteId: string;
  /**
   * Eine EIGENE Vorlage befüllt Anschluss und Messwerte vor.
   *
   * ⚠ Die ADRESSE bleibt leer - eine Vorlage beschreibt einen Gerätetyp, kein
   * Exemplar; sie zu raten ließe das zweite Gerät auf das erste zeigen.
   */
  vorlage?: SiteComponentTemplate | null;
  /** Die Komponenten VOR dem Anlegen - die neue wird belegt, nie geraten. */
  vorher: { id: string }[];
  /** Zurück in den Katalog; null = die Seite wurde nicht aus dem Katalog geöffnet. */
  onZurueck?: (() => void) | null;
  onClose: () => void;
  onGespeichert: (result: SiteComponents, info: SelbstbauErgebnis) => void;
}) {
  const start = vorlage ? prefill(vorlage) : null;
  const [verbindung, setVerbindung] = useState<VerbindungForm>(
    start ? { host: '', port: start.port, unitId: start.unitId } : neueVerbindung(),
  );
  const [zeilen, setZeilen] = useState<MesswertZeile[]>(
    start && start.zeilen.length ? start.zeilen.map((z) => ({ ...neueZeile(), ...z })) : [neueZeile()],
  );
  const [ergebnisse, setErgebnisse] = useState<Record<string, LeseErgebnis>>({});
  const [laufend, setLaufend] = useState<string | null>(null);
  const [beleg, setBeleg] = useState(false);
  const [name, setName] = useState(start?.label ?? '');
  // Aus einer Vorlage angelegt, gibt es sie schon - dann fragt die Seite nicht.
  const [alsVorlage, setAlsVorlage] = useState(false);
  const [speichern, setSpeichern] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  /*
    Jede Eingabe hat einen Stand; eine Lesung, die zu einem ÄLTEREN Stand
    zurückkommt, verfällt - sonst stünde ein Wert neben Angaben, zu denen er nie
    gelesen wurde.
  */
  const verbindungsStand = useRef(0);
  const zeilenStand = useRef<Record<string, number>>({});
  const letzteEingabe = useRef(0);

  const geraetMangel = geraetFehler(verbindung);
  const listenMangel = messwerteFehler(zeilen);
  const zeilenMangel = zeilen.flatMap((z) => zeilenFehler(z));
  const last = leselastHinweis(zeilen);
  const anschlussOk = geraetMangel.length === 0;
  const gelesen = zeilen.filter((z) => ergebnisse[z.key]?.zustand === 'bestanden').length;

  function setzeVerbindung(patch: Partial<VerbindungForm>) {
    setVerbindung((v) => ({ ...v, ...patch }));
    // Ein anderes Gerät: jede Lesung und der Beleg gelten ihm nicht mehr.
    verbindungsStand.current += 1;
    letzteEingabe.current = Date.now();
    setErgebnisse({});
    setBeleg(false);
  }

  function setzeZeile(key: string, patch: Partial<MesswertZeile>) {
    setZeilen((zs) => zs.map((z) => (z.key === key ? { ...z, ...patch } : z)));
    zeilenStand.current[key] = (zeilenStand.current[key] ?? 0) + 1;
    letzteEingabe.current = Date.now();
    // Eine geänderte Zeile entwertet ihr Leseergebnis.
    setErgebnisse((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  async function lesen(z: MesswertZeile) {
    const standV = verbindungsStand.current;
    const standZ = zeilenStand.current[z.key] ?? 0;
    const gilt = () => standV === verbindungsStand.current && standZ === (zeilenStand.current[z.key] ?? 0);
    setLaufend(z.key);
    try {
      const antwort = await api.readCustomComponent(siteId, leseRumpf(verbindung, z));
      if (!gilt()) return;
      setErgebnisse((e) => ({ ...e, [z.key]: leseErgebnis(antwort) }));
      if (antwort?.receipt) setBeleg(true);
    } catch (e) {
      if (!gilt()) return;
      setErgebnisse((prev) => ({
        ...prev,
        [z.key]: {
          zustand: 'fehlgeschlagen',
          text: e instanceof ApiError ? e.message : 'Die Lesung ist fehlgeschlagen.',
        },
      }));
    } finally {
      setLaufend((l) => (l === z.key ? null : l));
    }
  }

  /*
    Gelesen wird VON SELBST: die erste vollständige Zeile ohne Ergebnis, sobald
    die Eingabe ruht. Eine fehlgeschlagene Lesung trägt ein Ergebnis und wird
    deshalb nicht endlos wiederholt - dafür gibt es „Erneut lesen".
  */
  useEffect(() => {
    if (!anschlussOk || laufend || speichern) return;
    const naechste = zeilen.find((z) => lesbar(z) && !ergebnisse[z.key]);
    if (!naechste) return;
    const warten = Math.max(0, AUTO_TEST_MS - (Date.now() - letzteEingabe.current));
    const t = window.setTimeout(() => void lesen(naechste), warten);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anschlussOk, laufend, speichern, zeilen, ergebnisse, verbindung]);

  async function anlegen() {
    if (speichern) return;
    setSpeichern(true);
    setFehler(null);
    try {
      const result = await api.createCustomComponent(siteId, speicherRumpf(name, verbindung, zeilen));
      const id = neueKomponente(vorher, result.components);
      const titel = name.trim() || 'Eigenes Modbus-Gerät';
      let hinweis: string | null = null;
      if (alsVorlage) {
        try {
          if (!id) throw new Error('keine belegte Komponente');
          await api.duplicateCustomComponent(siteId, id, titel);
          hinweis = 'Die Vorlage steht im Katalog unter „Selbst beschreiben".';
        } catch {
          // Das Gerät IST angelegt - nur die Vorlage fehlt, und das wird gesagt.
          hinweis =
            'Die Vorlage konnte nicht gespeichert werden. Im Katalog unter „Selbst beschreiben" '
            + 'machen Sie sie aus dem Gerät.';
        }
      }
      onGespeichert(result, { id, titel, hinweis });
    } catch (e) {
      setFehler(e instanceof ApiError ? e.message : 'Speichern ist fehlgeschlagen.');
    } finally {
      setSpeichern(false);
    }
  }

  const grund = speichern
    ? null
    : !anschlussOk
      ? 'Erst die Adresse, dann liest die Box die Messwerte.'
      : !beleg
        ? 'Mindestens ein Messwert muss gelesen sein.'
        : (zeilenMangel[0] ?? listenMangel[0] ?? null);

  return (
    <EinrichtenSeite
      titel="Gerät einrichten"
      onClose={onClose}
      onZurueck={onZurueck}
      kopf={
        <EinrichtenKopf
          titel={vorlage ? vorlage.label : 'Modbus-TCP-Gerät'}
          unterzeile={
            vorlage
              ? 'Eigene Vorlage · Messwerte, Port und Unit-ID sind eingetragen'
              : 'Selbst beschreiben · Modbus über das Netzwerk'
          }
          kategorie="grid"
          icon="cpu"
          brauchen={vorlage ? ['IP-Adresse des Geräts'] : ['IP-Adresse des Geräts', 'Registerliste aus dem Handbuch']}
        />
      }
      fuss={
        <EinrichtenFuss
          grund={grund}
          onAbbrechen={onClose}
          primaer={{
            label: speichern ? 'Speichere …' : 'Speichern',
            onClick: () => void anlegen(),
            disabled: speichern || grund !== null,
            testId: 'einrichten-speichern',
            aktion: 'geraet.einrichten',
          }}
        />
      }
    >
      <Abschnitte>
        <Abschnitt nummer={1} zustand={anschlussOk ? 'fertig' : 'aktiv'} titel="Anschluss" stand={anschlussOk ? 'vollständig' : null}>
          <div className="vp-ein-drei">
            <div className="vp-assist-field">
              <label htmlFor="sb-host">IP-Adresse des Geräts</label>
              <Input
                id="sb-host"
                value={verbindung.host}
                placeholder="192.168.1.50"
                inputMode="decimal"
                autoComplete="off"
                onChange={(e) => setzeVerbindung({ host: e.target.value })}
                disabled={speichern}
              />
            </div>
            <div className="vp-assist-field">
              <label htmlFor="sb-port">Port</label>
              <Input
                id="sb-port"
                type="number"
                value={verbindung.port}
                onChange={(e) => setzeVerbindung({ port: e.target.value })}
                disabled={speichern}
              />
            </div>
            <div className="vp-assist-field">
              <label htmlFor="sb-unit">Unit-ID</label>
              <Input
                id="sb-unit"
                type="number"
                value={verbindung.unitId}
                onChange={(e) => setzeVerbindung({ unitId: e.target.value })}
                disabled={speichern}
              />
            </div>
          </div>
          {/* Ein Fehler erst, wenn es etwas zu prüfen gibt - ein leeres Feld ist noch keiner. */}
          {verbindung.host.trim() !== '' && geraetMangel.length > 0 ? (
            <p className="vp-assist-error" role="status">
              {geraetMangel[0]}
            </p>
          ) : (
            <p className="vp-assist-help">
              Modbus TCP in Ihrem eigenen Netz. Port und Unit-ID stehen im Handbuch; meist 502 und 1.
            </p>
          )}
        </Abschnitt>

        <Abschnitt
          nummer={2}
          zustand={!anschlussOk ? 'spaeter' : gelesen > 0 ? 'fertig' : 'aktiv'}
          titel="Messwerte"
          stand={gelesen > 0 ? `${gelesen} gelesen` : null}
          spaeter="Nach dem Anschluss - dann liest die Box jeden Messwert von selbst."
        >
          {zeilen.map((z, i) => (
            <MesswertKarte
              key={z.key}
              z={z}
              nummer={i + 1}
              entfernbar={zeilen.length > 1}
              ergebnis={ergebnisse[z.key] ?? null}
              liest={laufend === z.key}
              gesperrt={speichern}
              onAendern={(patch) => setzeZeile(z.key, patch)}
              onEntfernen={() => setZeilen((zs) => zs.filter((x) => x.key !== z.key))}
              onLesen={() => void lesen(z)}
            />
          ))}
          <div className="vp-sb-add">
            <Button
              variant="ghost"
              onClick={() => setZeilen((zs) => [...zs, neueZeile()])}
              disabled={zeilen.length >= MAX_CHANNELS || speichern}
            >
              ＋ Messwert hinzufügen
            </Button>
            {last && <p className="vp-assist-help">{last}</p>}
          </div>
          {listenMangel.length > 0 && <p className="vp-assist-error">{listenMangel[0]}</p>}
        </Abschnitt>

        <Abschnitt nummer={3} zustand={beleg ? 'aktiv' : 'spaeter'} titel="Name" spaeter="Nach dem ersten gelesenen Wert.">
          <div className="vp-assist-field">
            <label htmlFor="sb-name">So erscheint es im Aufbau</label>
            <Input
              id="sb-name"
              value={name}
              placeholder="z. B. Wärmepumpe Keller"
              onChange={(e) => setName(e.target.value)}
              disabled={speichern}
            />
            <p className="vp-assist-help">Leer lassen ist in Ordnung - dann heißt es „Eigenes Modbus-Gerät".</p>
          </div>
          {!vorlage && (
            <label className="vp-ein-cb">
              <input
                type="checkbox"
                checked={alsVorlage}
                onChange={(e) => setAlsVorlage(e.target.checked)}
                disabled={speichern}
              />
              <span>
                Als eigene Vorlage speichern
                <small>{VORLAGE_HINWEIS}</small>
              </span>
            </label>
          )}
          <p className="vp-ein-notiz">
            <Icon name="info" size={15} />
            <span>
              Angelegt wird das Gerät zunächst nur lesend. Soll VoltPilot es auch schalten, geben Sie das
              danach in einem eigenen Schritt frei.
            </span>
          </p>
          <p className="vp-assist-balance">{BILANZ_HINWEIS}</p>
        </Abschnitt>
      </Abschnitte>

      {fehler && (
        <p className="vp-assist-error" role="alert">
          {fehler}
        </p>
      )}
    </EinrichtenSeite>
  );
}

/** EINE Messwert-Zeile: Name, Register und Einheit vorn, der gelesene Wert darunter, der Rest unter „Weitere Angaben". */
function MesswertKarte({
  z,
  nummer,
  entfernbar,
  ergebnis,
  liest,
  gesperrt,
  onAendern,
  onEntfernen,
  onLesen,
}: {
  z: MesswertZeile;
  nummer: number;
  entfernbar: boolean;
  ergebnis: LeseErgebnis | null;
  liest: boolean;
  gesperrt: boolean;
  onAendern: (patch: Partial<MesswertZeile>) => void;
  onEntfernen: () => void;
  onLesen: () => void;
}) {
  const mangel = zeilenFehler(z);
  const modicon = modiconDeutung(z.address);
  return (
    <div className="vp-sb-row" data-testid={`messwert-${nummer}`}>
      <div className="vp-sb-row-head">
        <strong>Messwert {nummer}</strong>
        {entfernbar && (
          <button type="button" className="vp-sb-del" aria-label={`Messwert ${nummer} entfernen`} onClick={onEntfernen}>
            <Icon name="trash" />
          </button>
        )}
      </div>

      <div className="vp-ein-drei">
        <div className="vp-assist-field">
          <label htmlFor={`sb-label-${z.key}`}>Name</label>
          <Input
            id={`sb-label-${z.key}`}
            value={z.label}
            placeholder="z. B. Speicher oben"
            onChange={(e) => onAendern({ label: e.target.value })}
            disabled={gesperrt}
          />
        </div>
        <div className="vp-assist-field">
          <label htmlFor={`sb-addr-${z.key}`}>Register</label>
          <Input
            id={`sb-addr-${z.key}`}
            type="number"
            inputMode="numeric"
            value={z.address}
            placeholder="z. B. 10"
            onChange={(e) => onAendern({ address: e.target.value })}
            disabled={gesperrt}
          />
        </div>
        <div className="vp-assist-field">
          <VpPicker
            id={`sb-unit-${z.key}`}
            label="Einheit"
            options={UNITS.map((u) => ({ value: u, label: u === '' ? 'keine' : u }))}
            value={z.unit}
            onChange={(v) => onAendern({ unit: v })}
            searchPlaceholder="Einheit suchen …"
            disabled={gesperrt}
          />
        </div>
      </div>
      {/* Eine fünfstellige Handbuch-Nummer: die zweite Lesart als Knopf, nie still. */}
      {modicon && (
        <p className="vp-ein-notiz" data-testid="modicon-hinweis">
          <Icon name="info" size={15} />
          <span>
            {modicon.text}{' '}
            <button
              type="button"
              className="vp-ein-link"
              onClick={() => onAendern({ address: String(modicon.address), registerKind: modicon.kind })}
              disabled={gesperrt}
            >
              {modicon.knopf}
            </button>
          </span>
        </p>
      )}

      {/* Der gelesene Wert - roh UND umgerechnet: nur der direkte Vergleich
          macht einen Skalierungsfehler in einer Sekunde sichtbar. */}
      {liest && (
        <p className="vp-ein-laeuft" role="status">
          <span className="vp-spinner vp-ein-spin" aria-hidden="true" />
          Ihre Box liest den Wert …
        </p>
      )}
      {!liest && !ergebnis && lesbar(z) && (
        <p className="vp-ein-laeuft" role="status">
          Der Wert erscheint gleich von selbst.
        </p>
      )}
      {!liest && ergebnis?.zustand === 'bestanden' && (
        <div className="vp-sb-result" role="status">
          <dl>
            <div>
              <dt>Roh-Wert</dt>
              <dd>{ergebnis.roh}</dd>
            </div>
            <div>
              <dt>Umgerechnet</dt>
              <dd className="vp-sb-scaled">{ergebnis.skaliert}</dd>
            </div>
          </dl>
          {ergebnis.register && <p className="vp-assist-help">Registerwörter: {ergebnis.register}</p>}
          {/* Ein Hinweis, KEINE Sperre: ein Register, das wir für unplausibel
              halten, kann am echten Gerät richtig sein. */}
          {ergebnis.hinweis && <p className="vp-sb-hint">{ergebnis.hinweis}</p>}
        </div>
      )}
      {!liest && ergebnis?.zustand === 'fehlgeschlagen' && (
        <p className="vp-assist-error" role="status">
          {ergebnis.text}
        </p>
      )}
      {!liest && ergebnis && (
        <div className="vp-sb-read">
          <Button variant="outline" size="sm" onClick={onLesen} disabled={gesperrt || !lesbar(z)}>
            Erneut lesen
          </Button>
        </div>
      )}
      {mangel.length > 0 && (z.label.trim() !== '' || z.address.trim() !== '') && (
        <p className="vp-assist-help">{mangel[0]}</p>
      )}

      <details className="vp-sb-profi">
        <summary>Weitere Angaben aus dem Handbuch</summary>
        <div className="vp-sb-pair">
          <div className="vp-assist-field">
            <VpPicker
              id={`sb-kind-${z.key}`}
              label="Registerart"
              options={REGISTER_KINDS.map((r) => ({ value: r.value, label: r.label }))}
              value={z.registerKind}
              onChange={(v) => onAendern({ registerKind: v })}
              disabled={gesperrt}
            />
          </div>
          <div className="vp-assist-field">
            <VpPicker
              id={`sb-type-${z.key}`}
              label="Datentyp"
              options={DATA_TYPES.map((d) => ({ value: d.value, label: d.label }))}
              value={z.dataType}
              onChange={(v) => onAendern({ dataType: v })}
              disabled={gesperrt}
            />
          </div>
        </div>
        {/* Die Wortreihenfolge gibt es nur bei 32 Bit - ein Feld, das nichts
            bedeutet, ist eine Frage zu viel. */}
        {istBreit(z.dataType) && (
          <div className="vp-assist-field">
            <VpPicker
              id={`sb-order-${z.key}`}
              label="Wortreihenfolge"
              options={WORD_ORDERS.map((w) => ({ value: w.value, label: w.label }))}
              value={z.wordOrder}
              onChange={(v) => onAendern({ wordOrder: v })}
              disabled={gesperrt}
            />
          </div>
        )}
        <div className="vp-ein-drei">
          <div className="vp-assist-field">
            <label htmlFor={`sb-scale-${z.key}`}>Skalierung (×)</label>
            <Input
              id={`sb-scale-${z.key}`}
              value={z.scale}
              onChange={(e) => onAendern({ scale: e.target.value })}
              disabled={gesperrt}
            />
          </div>
          <div className="vp-assist-field">
            <label htmlFor={`sb-offset-${z.key}`}>Offset (+)</label>
            <Input
              id={`sb-offset-${z.key}`}
              value={z.offset}
              onChange={(e) => onAendern({ offset: e.target.value })}
              disabled={gesperrt}
            />
          </div>
          <div className="vp-assist-field">
            <label htmlFor={`sb-iv-${z.key}`}>Mindestabstand (s)</label>
            <Input
              id={`sb-iv-${z.key}`}
              type="number"
              value={z.minReadIntervalS}
              onChange={(e) => onAendern({ minReadIntervalS: e.target.value })}
              disabled={gesperrt}
            />
          </div>
        </div>
      </details>
    </div>
  );
}
