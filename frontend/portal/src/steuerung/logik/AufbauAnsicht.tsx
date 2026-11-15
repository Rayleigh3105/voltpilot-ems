/**
 * Die Ansicht „Aufbau“ (Steuerlogik Stufe 4, Bericht 12.3): die Logik als Abschnitte mit ihren Einträgen, jeder über
 * ein Formular anzulegen und zu ändern - für alle, die nicht schreiben wollen. Aufbau und Text sind derselbe Text:
 * eine Änderung hier steht sofort im Text und umgekehrt. Was kein Formular darstellen kann, bleibt Text und steht
 * lesbar da.
 */
import { useMemo, useState } from 'react';
import type { LogikMeldung, LogikQuellen } from '../../api';
import { Blatt } from '../Blatt';
import { Ic } from '../Ic';
import { aufbau, schreibeEintrag, type AbschnittDef, type Eintrag, type FormArt } from './aufbau';
import { CodeLesen } from './Code';
import { EintragBlatt } from './EintragBlatt';
import { TextFeld, type Marke } from './Felder';
import { lies, setze, verschiebe, entferne, type Pfad } from './text';

export interface AufbauAnsichtProps {
  text: string;
  darf: boolean;
  quellen: LogikQuellen | null;
  meldungen: LogikMeldung[];
  onText: (t: string) => void;
  zuText: (zeile: number) => void;
}

type Offen =
  | { art: 'eintrag'; form: FormArt; def: AbschnittDef; pfad: Pfad; schluessel: string | null; wert: unknown; titel: string; letzter: boolean }
  | { art: 'kopf' }
  | { art: 'text'; titel: string; zeilen: [number, number] | null };

type Obj = Record<string, unknown>;

/** Die Namen der Logik als Marken für Formeln. */
export function markenAus(js: Obj): Marke[] {
  const out: Marke[] = [];
  const name = (v: unknown, k: string) => (v && typeof v === 'object' && 'name' in (v as Obj) ? String((v as Obj).name) : k);
  for (const [k, v] of Object.entries((js.inputs ?? {}) as Obj)) out.push({ name: k, satz: name(v, k), gruppe: 'Eingänge' });
  for (const [k, v] of Object.entries((js.settings ?? {}) as Obj)) out.push({ name: k, satz: name(v, k), gruppe: 'Stellwerte' });
  for (const k of Object.keys((js.formulas ?? {}) as Obj)) out.push({ name: k, satz: k, gruppe: 'Abgeleitet' });
  for (const [k, v] of Object.entries((js.states ?? {}) as Obj)) out.push({ name: k, satz: name(v, k), gruppe: 'Zustände' });
  for (const [k, v] of Object.entries((js.devices ?? {}) as Obj)) {
    out.push({ name: `${k}.on`, satz: `${name(v, k)} läuft`, gruppe: 'Geräte' });
    out.push({ name: `${k}.power`, satz: `Leistung ${name(v, k)}`, gruppe: 'Geräte' });
  }
  for (const f of ['holds', 'unknown', 'known', 'time_window', 'if', 'since', 'running', 'min', 'max']) {
    out.push({ name: f, satz: f, gruppe: 'Funktionen' });
  }
  for (const w of ['and', 'or', 'not', 'clock']) out.push({ name: w, satz: w, gruppe: 'Wörter' });
  return out;
}

/** Die Meldungen, die in den Zeilen eines Eintrags stehen. */
function meldungenIn(meldungen: LogikMeldung[], zeilen: [number, number] | null): LogikMeldung[] {
  if (!zeilen) return [];
  return meldungen.filter((m) => m.zeile && m.zeile >= zeilen[0] && m.zeile <= zeilen[1]);
}

export function AufbauAnsicht({ text, darf, quellen, meldungen, onText, zuText }: AufbauAnsichtProps) {
  const [offen, setOffen] = useState<Offen | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const g = useMemo(() => lies(text), [text]);
  const namen = useMemo(() => {
    const n: Record<string, string> = {};
    for (const q of quellen?.quellen ?? []) n[q.source] = q.name;
    for (const d of quellen?.geraete ?? []) n[d.entity_id] = d.name;
    return n;
  }, [quellen]);

  if (!g.ok) {
    return (
      <div className="lk-abschnitte">
        <div className="lk-band fehler" role="status">
          <Ic n="alert" s={18} />
          <span>
            Der Text ist {g.zeile ? `an Zeile ${g.zeile} ` : ''}nicht lesbar: {g.fehler}. Sobald er wieder lesbar ist, zeigt
            der Aufbau ihn.
            {g.zeile ? (
              <span className="lk-band-knoepfe">
                <button type="button" className="tbtn" onClick={() => zuText(g.zeile ?? 1)}>Zum Text</button>
              </span>
            ) : null}
          </span>
        </div>
        <CodeLesen text={text} meldungen={g.zeile ? [{ art: 'fehler', text: g.fehler, zeile: g.zeile }] : []} label="Text der Logik" immer />
      </div>
    );
  }

  const a = aufbau(g, namen);
  const js = (g.doc.toJS() ?? {}) as Obj;
  const marken = markenAus(js);
  const vergeben = new Set<string>([
    ...Object.keys((js.inputs ?? {}) as Obj), ...Object.keys((js.settings ?? {}) as Obj),
    ...Object.keys((js.formulas ?? {}) as Obj), ...Object.keys((js.states ?? {}) as Obj), ...Object.keys((js.devices ?? {}) as Obj),
  ]);
  const geraete = Object.entries((js.devices ?? {}) as Obj).map(([kennung, v]) => ({
    kennung, name: String((v as Obj)?.name ?? kennung), entity: String((v as Obj)?.entity ?? ''),
  }));

  const aendere = (f: (t: string) => string) => {
    try {
      onText(f(text));
      setFehler(null);
      return true;
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Änderung ließ sich nicht schreiben.');
      return false;
    }
  };

  const oeffne = (def: AbschnittDef, e: Eintrag, i: number, anzahl: number) => {
    if (!darf || !e.form) {
      setOffen({ art: 'text', titel: e.titel || e.schluessel, zeilen: e.zeilen });
      return;
    }
    setOffen({ art: 'eintrag', form: e.form, def, pfad: e.pfad, schluessel: def.liste ? String(i) : e.schluessel, wert: e.wert, titel: e.titel || e.schluessel, letzter: i === anzahl - 1 });
  };

  const neu = (def: AbschnittDef, anzahl: number) => {
    // Ein Ausgang gehört einem Gerät: die Kennung ist die des Geräts, ohne Ausgang.
    if (def.id === 'outputs') {
      const frei = geraete.find((x) => !Object.keys((js.outputs ?? {}) as Obj).includes(x.kennung));
      if (!frei) {
        setFehler('Jedes Gerät hat schon einen Ausgang. Ein neues Gerät legen Sie unter „Geräte“ an.');
        return;
      }
      setOffen({ art: 'eintrag', form: 'ausgang', def, pfad: ['outputs', frei.kennung], schluessel: frei.kennung, wert: undefined, titel: `Ausgang für ${frei.name}`, letzter: false });
      return;
    }
    setOffen({
      art: 'eintrag', form: def.form, def, pfad: def.liste ? [def.id, anzahl] : [def.id], schluessel: def.liste ? String(anzahl) : null,
      wert: undefined, titel: `${def.neu} anlegen`, letzter: def.id === 'status',
    });
  };

  return (
    <div className="lk-abschnitte" style={{ display: 'grid', gap: 14 }}>
      {fehler ? <p className="stn-fehler" role="alert">{fehler}</p> : null}
      <section className="card lk-abschnitt" aria-label="Logik">
        <div className="lk-abschnitt-kopf">
          <h2>{a.name || 'Ohne Namen'}</h2>
          {darf ? <button type="button" className="tbtn" onClick={() => setOffen({ art: 'kopf' })}>Ändern</button> : null}
        </div>
        {a.beschreibung ? <p>{a.beschreibung}</p> : null}
      </section>

      {a.abschnitte.map(({ def, eintraege, nurText, zeilen }) => (
        <section className="card lk-abschnitt" key={def.id} aria-label={def.titel} data-abschnitt={def.id}>
          <div className="lk-abschnitt-kopf">
            <h2>
              {def.titel}
              {eintraege.length ? <small>{eintraege.length}</small> : null}
            </h2>
            {darf && !nurText ? (
              <button type="button" className="tbtn" onClick={(e) => { e.currentTarget.focus(); neu(def, eintraege.length); }}>
                <Ic n="plus" s={16} />
                {def.neu}
              </button>
            ) : null}
          </div>
          <p>{def.satz}</p>
          {nurText ? (
            <button type="button" className="lk-eintrag" onClick={() => zuText(zeilen?.[0] ?? 1)}>
              <span><b>{def.titel}</b><small className="lk-nurtext">im Text festgelegt</small></span>
              <Ic n="chevR" s={18} />
            </button>
          ) : eintraege.length === 0 ? (
            <p className="lk-leer">Noch nichts.</p>
          ) : (
            <ul className="lk-eintraege">
              {eintraege.map((e, i) => {
                const hier = meldungenIn(meldungen, e.zeilen);
                const schwer = hier.find((m) => m.art !== 'hinweis') ?? hier[0];
                const formelArt = def.id === 'formulas' || def.id === 'constraints';
                return (
                  <li key={e.pfad.join('.')}>
                    <div className="lk-reihe">
                      <button type="button" className="lk-eintrag" onClick={(ev) => { ev.currentTarget.focus(); oeffne(def, e, i, eintraege.length); }}
                        aria-label={`${def.neu} ${e.titel || e.schluessel}${schwer ? ': ' + schwer.text : ''}`}>
                        <span>
                          <b>{e.titel || e.schluessel}</b>
                          {e.form ? <small className={formelArt ? 'lk-formel-kurz' : undefined}>{e.unter}</small>
                            : <small className="lk-nurtext"><Ic n="list" s={13} />im Text festgelegt</small>}
                        </span>
                        <Ic n="chevR" s={18} />
                      </button>
                      {darf && def.id === 'status' ? (
                        <>
                          <button type="button" className="lk-pfeil" aria-label={`„${e.titel}“ nach oben`} disabled={i === 0}
                            onClick={() => aendere((t) => verschiebe(t, ['status'], i, -1))}><Ic n="up" s={16} /></button>
                          <button type="button" className="lk-pfeil" aria-label={`„${e.titel}“ nach unten`} disabled={i === eintraege.length - 1}
                            onClick={() => aendere((t) => verschiebe(t, ['status'], i, 1))}><Ic n="down" s={16} /></button>
                        </>
                      ) : null}
                    </div>
                    {schwer ? (
                      <p className={`lk-eintrag-meldung${schwer.art === 'hinweis' ? ' hinweis' : ''}`}>
                        <Ic n="alert" s={15} />
                        <span>{schwer.zeile ? `Zeile ${schwer.zeile}: ` : ''}{schwer.text}</span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}

      {a.sonst.length ? (
        <section className="card lk-abschnitt" aria-label="Im Text festgelegt">
          <div className="lk-abschnitt-kopf"><h2>Im Text festgelegt</h2></div>
          <p>Diese Teile zeigt der Aufbau nicht; sie bleiben, wie sie im Text stehen.</p>
          <ul className="lk-eintraege">
            {a.sonst.map((x) => (
              <li key={x.schluessel}>
                <button type="button" className="lk-eintrag" onClick={() => zuText(x.zeilen?.[0] ?? 1)}>
                  <span><b><code>{x.schluessel}</code></b><small>{x.zeilen ? `Zeile ${x.zeilen[0]} bis ${x.zeilen[1]}` : ''}</small></span>
                  <Ic n="chevR" s={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {offen?.art === 'eintrag' ? (
        <EintragBlatt
          art={offen.form}
          titel={offen.titel}
          schluessel={offen.schluessel}
          wert={offen.wert}
          vergeben={vergeben}
          marken={marken}
          quellen={quellen}
          geraete={geraete}
          letzterSatz={offen.letzter}
          onClose={() => setOffen(null)}
          onEntfernen={offen.wert === undefined ? undefined : () => {
            if (aendere((t) => entferne(t, offen.pfad))) setOffen(null);
          }}
          onSpeichern={(schluessel, wert) => {
            const pfad = offen.def.liste || offen.def.id === 'outputs' ? offen.pfad : [offen.def.id, schluessel];
            if (aendere((t) => schreibeEintrag(t, pfad, offen.form, offen.wert, wert))) setOffen(null);
          }}
        />
      ) : null}
      {offen?.art === 'kopf' ? (
        <KopfBlatt name={a.name} beschreibung={a.beschreibung} onClose={() => setOffen(null)}
          onSpeichern={(name, beschreibung) => {
            const ok = aendere((t) => {
              let n = setze(t, ['name'], name.trim() || 'Logik');
              n = beschreibung.trim() ? setze(n, ['description'], beschreibung.trim()) : entferne(n, ['description']);
              return n;
            });
            if (ok) setOffen(null);
          }} />
      ) : null}
      {offen?.art === 'text' ? (
        <Blatt symbol="list" titel={offen.titel} unter="im Text festgelegt" onClose={() => setOffen(null)}
          fuss={offen.zeilen ? <button type="button" className="btn" onClick={() => { setOffen(null); zuText(offen.zeilen?.[0] ?? 1); }}>Im Text zeigen</button> : null}>
          <CodeLesen text={offen.zeilen ? text.split('\n').slice(offen.zeilen[0] - 1, offen.zeilen[1]).join('\n') : ''} meldungen={meldungen}
            ab={offen.zeilen?.[0] ?? 1} label={offen.titel} immer />
        </Blatt>
      ) : null}
    </div>
  );
}

function KopfBlatt({ name, beschreibung, onClose, onSpeichern }: { name: string; beschreibung: string; onClose: () => void; onSpeichern: (n: string, b: string) => void }) {
  const [n, setN] = useState(name);
  const [b, setB] = useState(beschreibung);
  return (
    <Blatt symbol="sliders" titel="Name und Beschreibung" onClose={onClose}
      fuss={<button type="button" className="btn" onClick={() => onSpeichern(n, b)}><Ic n="check" s={18} />Übernehmen</button>}>
      <form className="lk-form" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); onSpeichern(n, b); }}>
        <TextFeld label="Name" wert={n} onWert={setN} hilfe="Höchstens 60 Zeichen." />
        <TextFeld label="Beschreibung" wert={b} onWert={setB} />
      </form>
    </Blatt>
  );
}
