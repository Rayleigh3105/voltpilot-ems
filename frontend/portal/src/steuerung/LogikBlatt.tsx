/**
 * Das Blatt „Warum?“ einer scharfen Logik (Steuerlogik Stufe 3, Bericht 6.5, 7.1, 17.3): was sie gerade tut und
 * warum, die Geräte mit dem, was sie tun, die Bedingungen mit Haken, die Werte des Kunden als Regler (E2 = B: ein
 * Zielwert in °C immer), die Werte des Fachbetriebs gesperrt - für Kundenadministrator und Fachbetrieb hinter
 * „Ändern“ (E3 = B) - und der Verlauf des Tages. Alles Ableiten steht in `steuerlogikKarte.ts`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { type SteuerlogikKarte, type SteuerlogikStellwert, type SteuerlogikVerlauf } from '../api';
import { api } from '../apiVoll';
import { VpTimePicker } from '../components/VpTimePicker';
import {
  erfuellt,
  geltend,
  geraetZeile,
  gruppen,
  insDokument,
  istAn,
  kopf,
  pille,
  schritt,
  stand,
  verlaufZeilen,
  wartetText,
  warumSortiert,
  warumTitel,
  wertText,
  zahlAus,
  zahlDeutsch,
  stellen,
} from '../steuerlogikKarte';
import { Blatt } from './Blatt';
import { Ic } from './Ic';

export interface LogikBlattProps {
  siteId: string;
  karte: SteuerlogikKarte;
  jetzt: Date;
  onClose: () => void;
  /** Stellt einen Wert (Form des Dokuments); die Seite lädt danach die Karte neu. */
  onStelle: (kennung: string, wert: unknown) => Promise<void>;
}

const WARTE_MS = 700;

export function LogikBlatt({ siteId, karte, jetzt, onClose, onStelle }: LogikBlattProps) {
  const p = pille(karte);
  const k = kopf(karte);
  const { frei, fachbetrieb } = gruppen(karte.stellwerte);
  const darfFachbetrieb = fachbetrieb.some((s) => s.aendern);
  const [fbOffen, setFbOffen] = useState(false);
  const [alleBedingungen, setAlleBedingungen] = useState(false);
  const [alleZeilen, setAlleZeilen] = useState(false);
  const [verlauf, setVerlauf] = useState<SteuerlogikVerlauf | null>(null);
  const [entwurf, setEntwurf] = useState<Record<string, unknown>>({});
  const [fehler, setFehler] = useState<string | null>(null);
  const zeitgeber = useRef<Record<string, number>>({});

  useEffect(() => {
    let aktiv = true;
    api.siteSteuerlogikVerlauf(siteId, karte.logikId).then((v) => { if (aktiv) setVerlauf(v); }, () => {});
    return () => { aktiv = false; };
  }, [siteId, karte.logikId, karte.stand]);
  useEffect(() => () => { for (const t of Object.values(zeitgeber.current)) window.clearTimeout(t); }, []);

  // Ein Entwurf fällt weg, sobald die Box den gestellten Wert zurückmeldet.
  useEffect(() => {
    setEntwurf((e) => {
      const n = { ...e };
      for (const s of karte.stellwerte) if (s.uebernommen && n[s.kennung] !== undefined && JSON.stringify(s.wert) === JSON.stringify(n[s.kennung])) delete n[s.kennung];
      return n;
    });
  }, [karte]);

  const stelle = (s: SteuerlogikStellwert, wert: unknown, sofort = false) => {
    setEntwurf((e) => ({ ...e, [s.kennung]: wert }));
    window.clearTimeout(zeitgeber.current[s.kennung]);
    zeitgeber.current[s.kennung] = window.setTimeout(() => {
      setFehler(null);
      onStelle(s.kennung, wert).catch((e: unknown) => {
        setFehler(e instanceof Error && e.message ? e.message : 'Der Wert konnte nicht gestellt werden.');
        setEntwurf((x) => { const n = { ...x }; delete n[s.kennung]; return n; });
      });
    }, sofort ? 0 : WARTE_MS);
  };

  const zeilen = useMemo(() => (verlauf ? verlaufZeilen(verlauf, karte) : []), [verlauf, karte]);
  const warum = warumSortiert(karte.warum);
  const zusatz = karte.stoerungen.filter((s) => s.text !== k.titel && s.text !== k.satz);
  const sichtbareGruppen = alleBedingungen ? warum : warum.slice(0, 2);

  return (
    <Blatt
      symbol={p.klasse === 'lock' ? 'alert' : 'sliders'}
      titel={karte.name}
      unter={`Logik · Fassung ${karte.fassung}`}
      voll
      onClose={onClose}
      fuss={<button type="button" className="btn" onClick={onClose}>Fertig</button>}
    >
      <div className="blk lg-jetzt">
        <h3>
          Jetzt{stand(karte, jetzt) ? ` · ${stand(karte, jetzt)}` : ''}
          <span className={`pill ${p.klasse}`}><i />{p.wort}</span>
        </h3>
        <p className="lg-titel">{k.titel}</p>
        {k.satz ? <p className="lg-satz">{k.satz}</p> : null}
        {zusatz.length > 0 ? (
          <ul className="lg-stoerungen">
            {zusatz.map((s) => (
              <li key={s.code + s.text}><Ic n="alert" s={16} /><span>{s.text}</span></li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="blk">
        <h3>Geräte</h3>
        <ul className="lg-geraete">
          {karte.geraete.map((g) => {
            const z = geraetZeile(g);
            return (
              <li key={g.kennung}>
                <span><b>{z.name}</b>{z.grund ? <small>{z.grund}</small> : null}</span>
                <em>{z.jetzt}</em>
              </li>
            );
          })}
        </ul>
      </div>

      {warum.length > 0 ? (
        <div className="blk">
          <h3>Was gerade entscheidet</h3>
          {sichtbareGruppen.map((g, i) => {
            const e = erfuellt(g);
            const w = wartetText(g.wartet_s);
            return (
              <div className="lg-gruppe" key={`${g.zustand}-${g.was}-${g.schritt ?? ''}-${g.modus}-${i}`}>
                <p className="lg-gruppe-t">
                  <span>{warumTitel(g)}</span>
                  {w ? <small>{w}</small> : e === true ? <small>erfüllt</small> : null}
                </p>
                <ul className="lg-check">
                  {g.bedingungen.map((b) => (
                    <li key={b.name} className={b.ok === true ? 'ok' : b.ok === false ? 'nein' : 'offen'}>
                      <span className="lg-z" aria-label={b.ok === true ? 'erfüllt' : b.ok === false ? 'nicht erfüllt' : 'unbekannt'}>
                        <Ic n={b.ok === true ? 'check' : b.ok === false ? 'minus' : 'help'} s={15} />
                      </span>
                      <span>
                        {b.name}
                        {b.werte?.length ? <small>{b.werte.map((x) => `${x.name} ${x.text}`).join(' · ')}</small> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {warum.length > 2 ? (
            <button type="button" className="lnk" aria-expanded={alleBedingungen} onClick={() => setAlleBedingungen((x) => !x)}>
              {alleBedingungen ? 'Weniger anzeigen' : `Alle ${warum.length} Gruppen anzeigen`}
            </button>
          ) : null}
        </div>
      ) : null}

      {frei.length > 0 ? (
        <div className="blk">
          <h3>Das stellen Sie ein</h3>
          {frei.map((s) => (
            <Wert key={s.kennung} s={s} entwurf={entwurf[s.kennung]} stelle={stelle} gesperrt={!s.aendern} />
          ))}
        </div>
      ) : null}

      {fachbetrieb.length > 0 ? (
        <div className="blk">
          <h3>
            Das legt Ihr Fachbetrieb fest
            {darfFachbetrieb ? (
              <button type="button" className="lnk" aria-expanded={fbOffen} onClick={() => setFbOffen((x) => !x)}>
                {fbOffen ? 'Fertig' : 'Ändern'}
              </button>
            ) : (
              <span className="meta">{fachbetrieb.length === 1 ? '1 Wert' : `${fachbetrieb.length} Werte`}</span>
            )}
          </h3>
          {fbOffen
            ? fachbetrieb.map((s) => <Wert key={s.kennung} s={s} entwurf={entwurf[s.kennung]} stelle={stelle} gesperrt={!s.aendern} />)
            : (
              <ul className="lg-feste">
                {fachbetrieb.map((s) => (
                  <li key={s.kennung}>
                    <span>{s.name}</span>
                    <b>{s.uebernommen && s.text ? s.text : wertText(s, geltend(s))}<Ic n="lock" s={14} /></b>
                  </li>
                ))}
              </ul>
            )}
          {!darfFachbetrieb ? <p>Soll ein Wert anders sein, fragen Sie Ihren Fachbetrieb.</p> : null}
        </div>
      ) : null}
      {fehler ? <p className="stn-fehler" role="alert">{fehler}</p> : null}

      <div className="blk">
        <h3>Heute</h3>
        {verlauf == null ? (
          <p>Der Verlauf lädt …</p>
        ) : zeilen.length === 0 ? (
          <p>Heute hat sich noch nichts geändert.</p>
        ) : (
          <>
            <ul className="lg-verlauf">
              {(alleZeilen ? zeilen : zeilen.slice(0, 6)).map((z, i) => (
                <li key={`${z.t}-${i}`} className={z.art}>
                  <time>{z.uhr}</time>
                  <span>{z.satz}</span>
                </li>
              ))}
            </ul>
            {zeilen.length > 6 ? (
              <button type="button" className="lnk" aria-expanded={alleZeilen} onClick={() => setAlleZeilen((x) => !x)}>
                {alleZeilen ? 'Weniger anzeigen' : `Alle ${zeilen.length} anzeigen`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </Blatt>
  );
}

/** Ein Wert als Regler, Schalter, Uhrzeit oder Auswahl; „wird übernommen …“, bis die Box ihn zurückmeldet. */
function Wert({ s, entwurf, stelle, gesperrt }: {
  s: SteuerlogikStellwert;
  entwurf: unknown;
  stelle: (s: SteuerlogikStellwert, wert: unknown, sofort?: boolean) => void;
  gesperrt: boolean;
}) {
  const wert = entwurf !== undefined ? entwurf : geltend(s);
  const offen = entwurf !== undefined || !s.uebernommen;
  const name = (
    <span>
      {s.name}
      <small>{offen ? 'wird übernommen …' : s.hilfe ?? (s.zielwert && s.von != null && s.bis != null ? `${wertText(s, s.von)} bis ${wertText(s, s.bis)}` : null)}</small>
    </span>
  );
  if (gesperrt || s.art === 'schedule') {
    return (
      <div className="prow">
        {name}
        <b className="lg-wert">{s.text ?? wertText(s, wert)}{gesperrt ? <Ic n="lock" s={14} /> : null}</b>
      </div>
    );
  }
  if (s.art === 'boolean') {
    const an = istAn(wert);
    return (
      <div className="prow">
        {name}
        <button type="button" className="sw" role="switch" aria-checked={an} aria-label={s.name} onClick={() => stelle(s, an ? 'off' : 'on', true)} />
      </div>
    );
  }
  if (s.art === 'select') {
    return (
      <div className="lg-wahl">
        {name}
        <div className="chips" role="group" aria-label={s.name}>
          {(s.optionen ?? []).map((o) => (
            <button type="button" key={o.wert} className="chip" aria-pressed={wert === o.wert} onClick={() => stelle(s, o.wert, true)}>
              {o.name}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (s.art === 'uhrzeit') {
    return (
      <div className="lg-uhr">
        <VpTimePicker label={s.name} value={typeof wert === 'string' ? wert : ''} onChange={(v) => { if (v) stelle(s, v, true); }} />
        {offen ? <small>wird übernommen …</small> : null}
      </div>
    );
  }
  const v = zahlAus(wert) ?? s.von ?? 0;
  const nk = stellen(s.schritt);
  const minus = schritt(s, v, -1);
  const plus = schritt(s, v, 1);
  return (
    <div className="lg-regler">
      <div className="prow">
        {name}
        <span className="stp">
          <button type="button" aria-label={`${s.name} weniger`} disabled={minus == null} onClick={() => minus != null && stelle(s, insDokument(s, minus))}>
            <Ic n="minus" s={18} />
          </button>
          <output aria-live="polite">{wertText(s, insDokument(s, v))}</output>
          <button type="button" aria-label={`${s.name} mehr`} disabled={plus == null} onClick={() => plus != null && stelle(s, insDokument(s, plus))}>
            <Ic n="plus" s={18} />
          </button>
        </span>
      </div>
      {s.von != null && s.bis != null ? (
        <div className="rng">
          <input
            type="range"
            min={s.von}
            max={s.bis}
            step={s.schritt ?? 1}
            value={v}
            aria-label={s.name}
            aria-valuetext={wertText(s, insDokument(s, v))}
            onChange={(e) => stelle(s, insDokument(s, Number(e.target.value)))}
          />
          <div className="skala">
            <span>{zahlDeutsch(s.von, nk)}</span>
            <span>{zahlDeutsch(s.bis, nk)}{s.einheit ? ` ${s.einheit}` : ''}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
