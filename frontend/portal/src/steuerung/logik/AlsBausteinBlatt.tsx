/**
 * „Als Baustein speichern“ (Steuerlogik Stufe 5, E4 = A): der Fachbetrieb speichert eine Fassung für seine Kunden,
 * VoltPilot für alle. Geräte und Fühler werden Lücken, ihre Kennungen bleiben in dieser Anlage. Der Satz nennt Lücken
 * mit `{name}`: ein Tipp auf ein Gerät oder einen Wert setzt ihn ein.
 */
import { useState } from 'react';
import type { LogikBericht } from '../../api';
import { api } from '../../apiVoll';
import { Blatt } from '../Blatt';
import { Ic } from '../Ic';
import { satzVorschlag } from './baustein';

export function AlsBausteinBlatt({ siteId, logikId, fassung, name, beschreibung, bericht, plattform, onClose, onGespeichert }: {
  siteId: string;
  logikId: string;
  fassung: number;
  name: string;
  beschreibung: string | null;
  bericht: LogikBericht | null;
  plattform: boolean;
  onClose: () => void;
  onGespeichert: (text: string) => void;
}) {
  const geraete = bericht?.geraete ?? [];
  // Fühler und Signale eines Geräts der Anlage (keine feste Quelle): auch sie sind Lücken.
  const fest = /^(site|battery|sun|price)\./;
  const fuehler = (bericht?.eingaenge ?? []).filter((e) => !fest.test(e.source));
  const werte = (bericht?.stellwerte ?? []).filter((s) => s.art !== 'schedule');
  const [titel, setTitel] = useState(name);
  const [satz, setSatz] = useState(() => satzVorschlag(beschreibung, geraete.map((g) => g.kennung)));
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const setzeEin = (k: string) => setSatz(`${satz.replace(/\s+$/, '')} {${k}}`);

  const speichern = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await api.bausteinSpeichern(siteId, logikId, fassung, titel.trim(), satz.trim());
      onGespeichert(plattform ? 'Gespeichert. Der Baustein steht allen Kunden zur Wahl.' : 'Gespeichert. Ihre Kunden finden ihn unter „Neue Regel“.');
    } catch (e) {
      const m = (e as { message?: unknown })?.message;
      setFehler(typeof m === 'string' && m ? m : 'Der Baustein ließ sich nicht speichern.');
      setBusy(false);
    }
  };

  return (
    <Blatt
      titel="Als Baustein speichern"
      unter={plattform ? 'Für alle Kunden' : 'Für Ihre Kunden'}
      symbol="layers"
      onClose={onClose}
      fuss={
        <>
          <button type="button" className="btn sek" onClick={onClose}>Abbrechen</button>
          <button type="button" className="btn" disabled={busy || !titel.trim() || !satz.trim()} onClick={() => void speichern()}>
            <Ic n="check" s={18} />{busy ? 'Speichert …' : 'Speichern'}
          </button>
        </>
      }
    >
      <label className="bs-name">
        <span>Name</span>
        <input value={titel} maxLength={80} onChange={(e) => setTitel(e.target.value)} />
      </label>
      <label className="bs-name">
        <span>Satz</span>
        <textarea value={satz} maxLength={300} rows={3} onChange={(e) => setSatz(e.target.value)} />
      </label>
      <div className="blk">
        <h3>Lücken einsetzen</h3>
        <div className="chips">
          {[...geraete, ...fuehler, ...werte].map((x) => (
            <button type="button" key={x.kennung} title={`{${x.kennung}}`} onClick={() => setzeEin(x.kennung)}>{x.name}</button>
          ))}
        </div>
        <p className="leise">Geräte und Fühler wählt der Kunde. Werte im Satz stellt er beim Einsetzen.</p>
      </div>
      {fehler ? <div className="konflikt" role="alert"><Ic n="alert" s={18} /><span>{fehler}</span></div> : null}
    </Blatt>
  );
}
