import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import { Input } from '../../../designsystem/components/forms/Input';
import {
  api,
  ApiError,
  type Device,
  type UemsBetreiberblatt,
  type UemsGemeinsameSteuerungBefund,
  type UemsSprungprobe,
} from '../../api';
import {
  ablehnungSaetze,
  auslegungSaetze,
  bilanzSatz,
  boxSpalten,
  DANACH,
  fehltSaetze,
  i1Liste,
  kopfZeile,
  protokollZeilen,
  sprungEingabe,
  sprungprobeGrund,
  vorbehaltSatz,
  zeit,
  zweischrittLage,
  type BoxSpalte,
  type Zelle,
} from '../../adminGemeinsameSteuerung';
import type { GemeinsameSteuerungDaten } from '../../components/GemeinsameSteuerungKarte';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { VpPicker } from '../../components/VpPicker';
import { boxNamen } from '../../gemeinsameSteuerungFlaeche';
import './GemeinsameSteuerungBetreiberBlatt.css';

type Handgriff =
  | { was: 'scharfschalten' }
  | { was: 'anhalten' }
  | { was: 'fortsetzen' }
  | { was: 'bestaetigen'; box: string }
  | { was: 'vomNetz'; box: string }
  | { was: 'sprungprobe'; box: string };

/**
 * UEMS AP-15 IP-24 — das Betreiber-Blatt „Gemeinsame Steuerung“ (§5.3/§5.4). NUR hinter `showTechnicalLayer()`
 * (Plattform-Rolle); Kopf mit Stufe, Epoche und allem, was fehlt (auch `nachweis_fehlt`), je Box eine Spalte
 * nebeneinander, darunter Auslegung, Bilanz, Vorbehalt und die Sprungprobe-Protokolle. Die Handgriffe (I4) fragen
 * nach und sagen, was danach gilt; der Zielstand steht erst, wenn die api ihn meldet.
 */
export function GemeinsameSteuerungBetreiberBlatt({
  siteId,
  siteDevices,
  daten,
  jetzt,
}: {
  siteId: string;
  siteDevices: readonly Device[];
  daten: GemeinsameSteuerungDaten;
  /** Für Aufnahmen und Tests; sonst die Uhr. */
  jetzt?: Date;
}) {
  const { zustand, einrichten, neuLaden } = daten;
  const [blatt, setBlatt] = useState<UemsBetreiberblatt | null>(null);
  const [lesefehler, setLesefehler] = useState(false);
  const [tick, setTick] = useState(0);
  const [offen, setOffen] = useState<Handgriff | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string[]>([]);
  const [abgelehnt, setAbgelehnt] = useState<UemsGemeinsameSteuerungBefund[]>([]);
  const [art, setArt] = useState<UemsSprungprobe['art']>('erzeugung_senken');
  const [sprung, setSprung] = useState('30');
  const [sprungFehler, setSprungFehler] = useState<string | null>(null);

  useEffect(() => {
    let aus = false;
    api.gemeinsameSteuerungBlatt(siteId).then(
      (b) => { if (!aus) { setBlatt(b); setLesefehler(false); } },
      () => { if (!aus) { setBlatt(null); setLesefehler(true); } },
    );
    return () => { aus = true; };
  }, [siteId, tick]);

  const neu = useCallback(() => { setTick((t) => t + 1); neuLaden(); }, [neuLaden]);
  const uhr = jetzt ?? new Date();
  const namen = useMemo(() => boxNamen(siteDevices, einrichten), [siteDevices, einrichten]);
  const spalten = boxSpalten(blatt, einrichten, namen, uhr);
  const zwei = zweischrittLage(blatt, namen);
  const i1 = i1Liste(zustand, namen, abgelehnt);
  const protokoll = protokollZeilen(blatt, namen);
  const z = zustand?.zustand;
  const vomBetreiber = z === 'angehalten' && zustand?.naechster_schritt === 'vom_betreiber_angehalten';

  async function ausfuehren(h: Handgriff) {
    if (busy) return;
    let kw: number | null = null;
    if (h.was === 'sprungprobe') {
      const e = sprungEingabe(sprung);
      setSprungFehler(e.fehler);
      if (e.kw == null) return;
      kw = e.kw;
    }
    setBusy(true);
    setFehler([]);
    try {
      if (h.was === 'scharfschalten' || h.was === 'fortsetzen') await api.gemeinsameSteuerungBetreiber(siteId, h.was);
      else if (h.was === 'anhalten') await api.gemeinsameSteuerungSchritt(siteId, 'anhalten');
      else if (h.was === 'bestaetigen') await api.gemeinsameSteuerungBestaetigen(siteId, h.box);
      else if (h.was === 'vomNetz') await api.gemeinsameSteuerungVomNetz(siteId, h.box);
      else await api.gemeinsameSteuerungSprungprobe(siteId, { box_id: h.box, art, sprung_kw: kw! });
      setAbgelehnt([]);
      setOffen(null);
    } catch (e) {
      const body = e instanceof ApiError ? e.body : undefined;
      setFehler(ablehnungSaetze(body ?? { message: e instanceof Error ? e.message : undefined }, namen));
      setAbgelehnt(((body ?? {}) as { fehlt?: UemsGemeinsameSteuerungBefund[] }).fehlt ?? []);
      setOffen(null);
    } finally {
      setBusy(false);
      neu();
    }
  }

  const dialog = offen ? dialogText(offen, namen) : null;

  return (
    <section className="vp-gsb" data-testid="betreiber-blatt" aria-label="Betreiber-Blatt Gemeinsame Steuerung">
      <header className="vp-gsb-kopf">
        <h3>Gemeinsame Steuerung · Betreiber-Blatt</h3>
        <p className="vp-gsb-nur">Nur für VoltPilot sichtbar.</p>
        <p className="vp-gsb-stufe" data-testid="gsb-kopf">{kopfZeile(zustand)}</p>
      </header>

      <p className={`vp-gsb-zweischritt vp-gsb-${zwei.art}`} data-testid="gsb-zweischritt" data-art={zwei.art} role="status">
        {zwei.text}
      </p>

      {fehltSaetze(zustand, namen).length > 0 && (
        <div className="vp-gsb-fehlt">
          <h4>Fehlt zum nächsten Schritt</h4>
          <ul data-testid="gsb-fehlt">
            {fehltSaetze(zustand, namen).map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      )}

      {lesefehler && <p className="vp-gsb-fehler" role="alert">Das Blatt ist gerade nicht lesbar — keine Box-Werte.</p>}

      {spalten.length > 0 && (
        <div className="vp-gsb-tabelle" role="region" aria-label="Boxen nebeneinander" tabIndex={0}>
          <table data-testid="gsb-spalten">
            <thead>
              <tr>
                <th scope="col">Box</th>
                {spalten.map((s) => <th scope="col" key={s.boxId} data-box={s.boxId}>Box {s.name}<small>{s.rolle}</small></th>)}
              </tr>
            </thead>
            <tbody>
              <Reihe titel="Erreichbar" zeile="erreichbar" spalten={spalten} zelle={(s) => s.erreichbar} />
              <Reihe titel="Fähigkeit Anteil" zeile="faehigkeit" spalten={spalten} zelle={(s) => s.faehigkeit} />
              <Reihe titel="Fähigkeit Sprungprobe" zeile="faehigkeit-sprungprobe" spalten={spalten} zelle={(s) => s.faehigkeitSprungprobe} />
              <tr data-zeile="geraete">
                <th scope="row">Geräte · Rückfall</th>
                {spalten.map((s) => (
                  <td key={s.boxId} data-box={s.boxId}>
                    {s.geraete.length === 0 ? <span className="vp-gsb-unbekannt">keine erklärt</span> : (
                      <ul className="vp-gsb-geraete">{s.geraete.map((g, i) => <li key={i} className={g.unbekannt ? 'vp-gsb-unbekannt' : undefined}>{g.text}</li>)}</ul>
                    )}
                  </td>
                ))}
              </tr>
              <Reihe titel="Messpunkt · Alter" zeile="messpunkt" spalten={spalten} zelle={(s) => s.messpunkt} />
              <Reihe titel="Wächter Einspeisung" zeile="waechter-einspeisung" spalten={spalten} zelle={(s) => s.waechter.einspeisung} />
              <Reihe titel="Wächter Bezug" zeile="waechter-bezug" spalten={spalten} zelle={(s) => s.waechter.bezug} />
              <Reihe titel="plan_id veröffentlicht" zeile="plan-veroeffentlicht" spalten={spalten} zelle={(s) => s.plan.veroeffentlicht} />
              <Reihe titel="plan_id angenommen" zeile="plan-angenommen" spalten={spalten} zelle={(s) => s.plan.angenommen} />
              <Reihe titel="Anteile gesendet" zeile="revision-gesendet" spalten={spalten} zelle={(s) => s.revision.gesendet} />
              <Reihe titel="Anteile quittiert" zeile="revision-quittiert" spalten={spalten} zelle={(s) => s.revision.quittiert} />
              <Reihe titel="Wirksam Einspeisung" zeile="wirksam-einspeisung" spalten={spalten} zelle={(s) => s.wirksam.einspeisung} />
              <Reihe titel="Wirksam Bezug" zeile="wirksam-bezug" spalten={spalten} zelle={(s) => s.wirksam.bezug} />
              <Reihe titel="davon Reserve andere Verbraucher" zeile="wirksam-reserve" spalten={spalten} zelle={(s) => s.wirksam.reserve} />
              {spalten.some((s) => s.ungeregelt != null) && (
                <Reihe titel="Ungeregeltes hinter dem Abgang (erklärt)" zeile="ungeregelt-abgang" spalten={spalten}
                  zelle={(s) => s.ungeregelt ?? { text: 'keins', unbekannt: true }} />
              )}
              <Reihe titel="Verlust gestern" zeile="verlust-gestern" spalten={spalten} zelle={(s) => s.verlustGestern} />
            </tbody>
          </table>
        </div>
      )}

      {spalten.length > 0 && (
        <ul className="vp-gsb-handgriffe" aria-label="Handgriffe je Box" data-testid="gsb-handgriffe">
          {spalten.map((s) => {
            const b = blatt!.boxen.find((x) => x.box_id === s.boxId)!;
            const grund = sprungprobeGrund(zustand, b, namen);
            const mitglied = zustand?.mitglieder?.find((m) => m.box_id === s.boxId);
            const bestaetigen = (zustand?.epoche ?? 0) > 0 && mitglied != null && !mitglied.bestaetigt_am;
            const scheidetAus = b.ausscheiden ?? mitglied?.ausscheiden ?? null;
            return (
              <li key={s.boxId} data-box={s.boxId}>
                <span className="vp-gsb-box">Box {s.name}</span>
                {grund
                  ? <span className="vp-gsb-grund" data-testid="gsb-sprung-grund">Sprungprobe: {grund}</span>
                  : <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSprungFehler(null); setOffen({ was: 'sprungprobe', box: s.boxId }); }}>Sprungprobe auslösen</Button>}
                {bestaetigen && <Button size="sm" variant="outline" disabled={busy} onClick={() => setOffen({ was: 'bestaetigen', box: s.boxId })}>Mitglied bestätigen</Button>}
                {mitglied?.bestaetigt_am && <span className="vp-gsb-klein">Mitglied bestätigt {zeit(mitglied.bestaetigt_am)}</span>}
                {scheidetAus && (
                  <span className="vp-gsb-klein" data-testid="gsb-scheidet-aus">
                    {scheidetAus.wartet_auf === 'voltpilot' ? 'Scheidet aus · abgemeldet, wartet auf VoltPilot' : 'Scheidet aus · wartet auf ihre Quittung'}
                  </span>
                )}
                {scheidetAus && !scheidetAus.vom_netz_bestaetigt_am && <Button size="sm" variant="outline" disabled={busy} onClick={() => setOffen({ was: 'vomNetz', box: s.boxId })}>Geräte sind vom Netz - bestätigen</Button>}
              </li>
            );
          })}
        </ul>
      )}

      {fehler.length > 0 && (
        <ul className="vp-gsb-fehler" role="alert" data-testid="gsb-abgelehnt">
          {fehler.map((t) => <li key={t}>{t}</li>)}
        </ul>
      )}

      {(z === 'beobachtet' || z === 'geprueft' || z === 'erklaert') && (
        <div className="vp-gsb-i1">
          <h4>Scharfschalten verlangt (I1)</h4>
          <ul data-testid="gsb-i1">
            {i1.map((p) => (
              <li key={p.schluessel} data-stand={p.stand} data-punkt={p.schluessel}>
                <span className="vp-gsb-marke" aria-hidden="true">{p.stand === 'erfuellt' ? '✓' : '○'}</span>
                <span>
                  {p.text} — <b>{p.stand === 'erfuellt' ? 'erfüllt' : 'offen'}</b>
                  {p.woerter.map((w) => <small key={w} className="vp-gsb-wort">{w}</small>)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="vp-gsb-aktionen">
        {(z === 'beobachtet' || z === 'geprueft') && (
          <Button variant="primary" disabled={busy} onClick={() => setOffen({ was: 'scharfschalten' })}>Scharfschalten</Button>
        )}
        {z === 'anteile_aktiv' && <Button variant="outline" disabled={busy} onClick={() => setOffen({ was: 'anhalten' })}>Als Betreiber anhalten</Button>}
        {z === 'angehalten' && <Button variant="primary" disabled={busy} onClick={() => setOffen({ was: 'fortsetzen' })}>Als Betreiber fortsetzen</Button>}
        {/* Quittungen kommen von den Boxen — das Blatt liest neu, statt einen Stand vorwegzunehmen. */}
        <Button variant="ghost" disabled={busy} onClick={neu}>Neu lesen</Button>
      </div>
      {vomBetreiber && <p className="vp-gsb-klein" data-testid="gsb-vom-betreiber">Vom Betreiber angehalten — der Kunde kann nicht selbst fortsetzen.</p>}

      <div className="vp-gsb-darunter">
        <div data-testid="gsb-auslegung">
          <h4>Auslegung</h4>
          <ul>{auslegungSaetze(einrichten).map((t) => <li key={t}>{t}</li>)}</ul>
        </div>
        <div data-testid="gsb-bilanz">
          <h4>Verbund-Bilanz</h4>
          <p>{bilanzSatz(zustand)}</p>
          <p className="vp-gsb-klein">{vorbehaltSatz(zustand)}</p>
        </div>
      </div>

      <div className="vp-gsb-protokoll">
        <h4>Sprungprobe-Protokolle</h4>
        {protokoll.length === 0 ? <p className="vp-gsb-klein" data-testid="gsb-kein-protokoll">Noch keine Sprungprobe.</p> : (
          <div className="vp-gsb-tabelle" role="region" aria-label="Sprungprobe-Protokolle" tabIndex={0}>
            <table data-testid="gsb-protokoll">
              <thead><tr><th scope="col">Wann</th><th scope="col">Box</th><th scope="col">Art</th><th scope="col">Sprung</th><th scope="col">Urteil</th><th scope="col">Abweichung je Sprung</th></tr></thead>
              <tbody>
                {protokoll.map((p) => (
                  <tr key={p.probeId} data-urteil={p.bestanden ? 'bestanden' : 'offen'}>
                    <td>{p.wann}</td><td>Box {p.box}</td><td>{p.art}</td><td>{p.sprung}</td>
                    <td className={p.bestanden ? 'vp-gsb-ok' : 'vp-gsb-warnung'}>{p.urteil}{p.gilt ? ' · gilt' : ''}</td>
                    <td>{p.abweichung}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={offen != null}
        title={dialog?.titel ?? ''}
        intro={dialog?.intro ?? ''}
        consequences={dialog?.danach ?? []}
        confirmLabel={busy ? 'Wird ausgeführt …' : dialog?.knopf ?? 'Ausführen'}
        busy={busy}
        onConfirm={() => { if (offen) void ausfuehren(offen); }}
        onCancel={() => setOffen(null)}
        extra={offen?.was === 'sprungprobe' ? (
          <div className="vp-gsb-form">
            <VpPicker label="Art" value={art} onChange={(v) => setArt(v as UemsSprungprobe['art'])}
              options={[{ value: 'erzeugung_senken', label: 'Erzeugung senken' }, { value: 'verbrauch_senken', label: 'Verbrauch senken' }]} />
            <Input label="Sprung (kW, höchstens 50)" inputMode="decimal" value={sprung} error={sprungFehler ?? undefined}
              onChange={(ev: ChangeEvent<HTMLInputElement>) => setSprung(ev.target.value)} />
          </div>
        ) : offen?.was === 'scharfschalten' ? (
          <ul className="vp-gsb-i1-kurz" data-testid="gsb-i1-dialog">
            {i1.map((p) => <li key={p.schluessel} data-stand={p.stand}>{p.stand === 'erfuellt' ? '✓' : '○'} {p.text}</li>)}
          </ul>
        ) : undefined}
      />
    </section>
  );
}

function Reihe({ titel, zeile, spalten, zelle }: { titel: string; zeile: string; spalten: BoxSpalte[]; zelle: (s: BoxSpalte) => Zelle }) {
  return (
    <tr data-zeile={zeile}>
      <th scope="row">{titel}</th>
      {spalten.map((s) => {
        const c = zelle(s);
        const klasse = c.warnung ? 'vp-gsb-warnung' : c.unbekannt ? 'vp-gsb-unbekannt' : undefined;
        return <td key={s.boxId} data-box={s.boxId} className={klasse} data-warnung={c.warnung ? 'ja' : undefined}>{c.text}</td>;
      })}
    </tr>
  );
}

function dialogText(h: Handgriff, namen: ReadonlyMap<string, string>): { titel: string; intro: string; danach: string[]; knopf: string } {
  const box = 'box' in h ? namen.get(h.box) ?? 'ohne Namen' : '';
  switch (h.was) {
    case 'sprungprobe':
      return { titel: `Sprungprobe an Box ${box} auslösen`, intro: 'Ein Handgriff an einer laufenden Anlage. Danach gilt:', danach: [...DANACH.sprungprobe], knopf: 'Sprungprobe auslösen' };
    case 'scharfschalten':
      return { titel: 'Gemeinsame Steuerung scharfschalten', intro: 'Die api prüft jede Bedingung aus I1 selbst. Danach gilt:', danach: [...DANACH.scharfschalten], knopf: 'Scharfschalten' };
    case 'anhalten':
      return { titel: 'Als Betreiber anhalten', intro: 'Danach gilt:', danach: [...DANACH.anhalten], knopf: 'Anhalten' };
    case 'fortsetzen':
      return { titel: 'Als Betreiber fortsetzen', intro: 'Danach gilt:', danach: [...DANACH.fortsetzen], knopf: 'Fortsetzen' };
    case 'bestaetigen':
      return { titel: `Mitglied Box ${box} bestätigen`, intro: 'Danach gilt:', danach: [...DANACH.bestaetigen], knopf: 'Bestätigen' };
    case 'vomNetz':
      return { titel: `Geräte der Box ${box} sind vom Netz`, intro: 'Danach gilt:', danach: [...DANACH.vomNetz], knopf: 'Geräte sind vom Netz - bestätigen' };
  }
}
