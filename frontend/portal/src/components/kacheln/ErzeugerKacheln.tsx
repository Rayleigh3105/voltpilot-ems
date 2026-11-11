import { dauer, einheitUnter, type ErzeugerLage, type GeregeltZeile } from '../../erzeuger';
import { kw, prozent } from '../../leitungsplan';
import { Gross, Kachel, type RasterGroesse } from './Kachel';

/**
 * Die Kacheln einer Erzeugeranlage (Konzept „Erzeuger am WAGO-Modbus-Server“ §4.5, EZ-8): je Einheit
 * Ist, Soll und Zustand (bei Biogas mit Gasspeicher), „Wer hat heute geregelt?“ und - bis die Erlöse
 * für Biogas kommen (EZ-12) - „Unterm Strich“ mit „—“. Reine Anzeige; die Ableitung ist `erzeuger.ts`.
 */
interface Basis {
  groesse?: RasterGroesse;
  onOpen?: (() => void) | null;
}

/** „Motoren“ bzw. „Wechselrichter“: je Einheit Ist, darunter Soll und Zustand. */
export function EinheitenKachel({ lage, ...b }: Basis & { lage: ErzeugerLage }) {
  const motor = lage.art === 'bhkw';
  const name = motor ? 'Motoren' : lage.art === 'pv' ? 'Wechselrichter' : 'Einheiten';
  return (
    <Kachel {...b} id="einheiten" name={name} icon={motor ? 'flame' : 'sun'} ton="pv" ziel="Steuerung">
      <ul className="vp-k-ez">
        {lage.einheiten.map((e) => (
          <li key={e.teNr}>
            <span className="vp-k-ez-name">
              {e.typName ? `${e.name} · ${e.typName}` : e.name}
              <small>{einheitUnter(e)}</small>
            </span>
            <b>{kw(e.istKw)}</b>
          </li>
        ))}
        {motor && (
          <li className="is-speicher">
            <span className="vp-k-ez-name">Gasspeicher</span>
            <b>{prozent(lage.gasspeicherPct)}</b>
            {lage.gasspeicherPct != null && (
              <span className="vp-k-ez-balken" aria-hidden="true">
                <i style={{ width: `${Math.min(100, Math.max(0, lage.gasspeicherPct))}%` }} />
              </span>
            )}
          </li>
        )}
      </ul>
    </Kachel>
  );
}

/** „Wer hat heute geregelt?“: Anzahl und Dauer je Urheber seit Mitternacht. */
export function GeregeltKachel({ zeilen, ...b }: Basis & { zeilen: GeregeltZeile[] | null }) {
  return (
    <Kachel {...b} id="geregelt" name="Wer hat heute geregelt?" icon="zap" ton="grid" ziel="Verlauf">
      {zeilen ? (
        <ul className="vp-k-ez">
          {zeilen.map((z) => (
            <li key={z.key}>
              <span className="vp-k-ez-name mit-punkt">
                <i className={`vp-k-ez-punkt is-${z.key}`} aria-hidden="true" />
                {z.urheber}
              </span>
              <b>{z.anzahl === 0 ? 'heute nicht' : `${z.anzahl}× · ${dauer(z.dauerMs)}`}</b>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vp-k-sub">Für heute liegen noch keine Wechsel der Vorgaben vor.</p>
      )}
    </Kachel>
  );
}

/** „Unterm Strich“ bei Biogas: noch ohne Erlöse - „—“ statt einer erfundenen Zahl (EW-7 A, EZ-12). */
export function ErzeugerGeldKachel(b: Basis) {
  return (
    <Kachel {...b} id="geld" name="Unterm Strich" icon="euro" ton="geld" groesse={b.groesse ?? 'klein'}>
      <Gross wert="—" />
      <p className="vp-k-sub">Erlöse für Biogas folgen, sobald Marktwert und Vermarktungsentgelt hinterlegt sind.</p>
    </Kachel>
  );
}
