/**
 * Aus Home Assistant übernehmen (Steuerlogik Stufe 6, E8 = A): die hochgeladenen Dateien übersetzt der Logik-Dienst;
 * hier ordnet man die Geräte und Messwerte von Home Assistant denen dieser Anlage zu, liest, was nicht übersetzbar
 * ist und wo die Logik sich anders verhält, und übernimmt den Text als Entwurf. Danach geht es weiter wie bei jeder
 * Logik: prüfen, als Fassung speichern, mitlaufen lassen, vorlegen.
 */
import { useEffect, useRef, useState } from 'react';
import type { HaDatei, LogikAusHomeAssistant } from '../../api';
import { api } from '../../apiVoll';
import { Blatt } from '../Blatt';
import { Ic } from '../Ic';
import { CodeLesen } from './Code';
import { AuswahlFeld } from './Felder';
import { fehlendeDateien, hinweisMeldungen, liesDateien, lueckeArt, lueckeFrage, notiz, offen, optionen, ortText, stand } from './homeassistant';

/** So lange nach der letzten Zuordnung fragt das Blatt den Dienst. */
const WARTE_MS = 250;

function grund(e: unknown, sonst: string): string {
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' && m ? m : sonst;
}

/** Ein Knopf, der Dateien wählen lässt und sie gelesen weitergibt. */
export function HaDateiWahl({ label, klasse = 'btn sek', onGelesen }: { label: string; klasse?: string; onGelesen: (d: HaDatei[]) => void }) {
  const feld = useRef<HTMLInputElement>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  return (
    <>
      <input ref={feld} type="file" multiple accept=".yaml,.yml" hidden aria-label="Dateien von Home Assistant"
        onChange={(e) => {
          const liste = Array.from(e.target.files ?? []);
          e.target.value = '';
          void liesDateien(liste).then((g) => {
            setFehler(g.fehler);
            if (!g.fehler) onGelesen(g.dateien);
          });
        }} />
      <button type="button" className={klasse} onClick={() => feld.current?.click()}>
        <Ic n="upload" s={18} />{label}
      </button>
      {fehler ? <p className="stn-fehler" role="alert">{fehler}</p> : null}
    </>
  );
}

export function HomeAssistantBlatt({ siteId, dateien, neu, onClose, onUebernehmen }: {
  siteId: string;
  dateien: HaDatei[];
  neu: boolean;
  onClose: () => void;
  onUebernehmen: (text: string, notiz: string) => void;
}) {
  const [zuordnung, setZuordnung] = useState<Record<string, { wert: string; name?: string }>>({});
  const [antwort, setAntwort] = useState<{ fuer: string; e: LogikAusHomeAssistant } | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [textOffen, setTextOffen] = useState(false);
  const schluessel = JSON.stringify(zuordnung);
  const laufend = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      laufend.current?.abort();
      const ab = new AbortController();
      laufend.current = ab;
      api.logikHomeAssistant(siteId, dateien, zuordnung, ab.signal)
        .then((e) => { if (!ab.signal.aborted) { setAntwort({ fuer: schluessel, e }); setFehler(null); } })
        .catch((e) => { if (!ab.signal.aborted) setFehler(grund(e, 'Der Logik-Dienst ist gerade nicht erreichbar.')); });
    }, WARTE_MS);
    return () => window.clearTimeout(t);
    // `schluessel` fasst die Zuordnung zusammen; die Antwort gilt genau für sie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, dateien, schluessel]);
  useEffect(() => () => laufend.current?.abort(), []);

  const e = antwort?.e ?? null;
  const aktuell = antwort?.fuer === schluessel;
  const s = e ? stand(e) : null;
  const fehlend = e ? fehlendeDateien(e) : [];
  const kannUebernehmen = !!e && aktuell && e.vollstaendig;

  return (
    <Blatt
      titel="Aus Home Assistant"
      unter={dateien.map((d) => d.name).join(' · ')}
      symbol="upload"
      voll
      breit
      onClose={onClose}
      fuss={
        <>
          <button type="button" className="btn sek" onClick={onClose}>Abbrechen</button>
          <button type="button" className="btn" disabled={!kannUebernehmen}
            onClick={() => e && onUebernehmen(e.text, notiz(e))}>
            <Ic n="check" s={18} />
            {neu ? 'Als neue Logik übernehmen' : 'Als Entwurf übernehmen'}
          </button>
        </>
      }
    >
      <div className="lk-ha">
        {fehler ? <div className="konflikt" role="alert"><Ic n="alert" s={18} /><span>{fehler}</span></div> : null}
        {!e && !fehler ? <div className="vp-skeleton" style={{ height: 220, borderRadius: 14 }} aria-label="Wird übersetzt …" /> : null}
        {e && s ? (
          <>
            <span className={`lk-pruefung ${s.art === 'ok' ? 'ok' : s.art === 'fehler' ? 'fehler' : 'laeuft'}`} role="status">
              <Ic n={s.art === 'ok' ? 'check' : s.art === 'fehler' ? 'alert' : 'clock'} s={18} />
              <span>{aktuell ? s.satz : 'Wird übersetzt …'}</span>
            </span>
            {fehlend.length ? (
              <p className="leise">Ohne {fehlend.join(' und ')} fehlt, was dort steht; meist gehören alle drei Dateien dazu.</p>
            ) : null}

            {e.nicht_uebersetzt.length ? (
              <div className="blk" role="region" aria-label="Nicht übersetzbar">
                <h3>Nicht übersetzbar</h3>
                <p className="leise">Solange eine Stelle nicht übersetzbar ist, entsteht keine Logik. Ändern Sie sie in Home Assistant und laden Sie die Dateien neu.</p>
                <ul className="lk-ha-stellen">
                  {e.nicht_uebersetzt.map((x, i) => (
                    <li key={i}>
                      <b>{ortText(x.ort)}</b>
                      {x.was ? <code>{x.was}</code> : null}
                      <span>{x.grund}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {e.luecken.length ? (
              <div className="blk" role="region" aria-label="Zuordnen">
                <h3>Zuordnen<span className="meta">{e.luecken.length - offen(e).length} von {e.luecken.length}</span></h3>
                <p className="leise">Ordnen Sie jedem Gerät und Messwert aus Home Assistant das passende dieser Anlage zu.</p>
                <div className="lk-ha-luecken">
                  {e.luecken.map((l) => {
                    const frage = lueckeFrage(l);
                    return (
                      <div className="lk-ha-luecke" key={l.kennung}>
                        <AuswahlFeld label={l.name} wert={l.wert || null} optionen={optionen(l)}
                          platzhalter={l.kandidaten.length ? (frage ?? 'Bitte zuordnen …') : 'Die Anlage hat nichts Passendes'}
                          onWert={(w) => {
                            const k = l.kandidaten.find((x) => x.wert === w);
                            setZuordnung({ ...zuordnung, [l.kennung]: { wert: w, name: k?.name } });
                          }}
                          hilfe={<>
                            {frage && l.wert ? <>{frage} </> : null}
                            {lueckeArt(l)}{l.vorgeschlagen ? ', vorgeschlagen' : ''}
                            <code className="lk-ha-entity">{l.entities.join(', ')}</code>
                          </>} />
                        {l.fehler ? <small className="fehler" role="alert">{l.fehler}</small> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {e.hinweise.length ? (
              <div className="blk" role="region" aria-label="Hinweise">
                <h3>Wo sie sich anders verhält<span className="meta">{e.hinweise.length}</span></h3>
                <p className="leise">Diese Hinweise stehen auch als Kommentar im Text, an der Stelle, die sie betreffen.</p>
                <ul className="lk-meldungen">
                  {e.hinweise.map((h, i) => (
                    <li key={i}>
                      <button type="button" className="hinweis" disabled>
                        <Ic n="info" s={16} /><b>{h.ort.datei.replace(/\.yaml$/, '')}:{h.ort.zeile}</b><span>{h.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {e.text ? (
              <div className="blk" role="region" aria-label="Die Logik als Text">
                <h3>Die Logik als Text
                  <button type="button" className="tbtn" aria-expanded={textOffen} onClick={() => setTextOffen(!textOffen)}>
                    {textOffen ? 'Verbergen' : 'Zeigen'}
                  </button>
                </h3>
                {textOffen ? <CodeLesen text={e.text} meldungen={hinweisMeldungen(e)} label="Übersetzter Text" immer /> : null}
              </div>
            ) : null}

            {e.nicht_uebernommen.length ? (
              <div className="blk" role="region" aria-label="Nicht übernommen">
                <h3>Nicht übernommen</h3>
                <ul className="lk-ha-stellen leise">
                  {e.nicht_uebernommen.map((x, i) => (
                    <li key={i}><b>{ortText(x.ort)}</b>{x.was ? <code>{x.was}</code> : null}<span>{x.grund}</span></li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="leise lk-ha-schutz"><Ic n="shield" s={16} />Die Dateien werden nur übersetzt, nicht gespeichert.</p>
          </>
        ) : null}
      </div>
    </Blatt>
  );
}
