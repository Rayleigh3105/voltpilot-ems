import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Switch } from '../../designsystem/components/forms/Switch';
import {
  api,
  type Anlagensteuerung,
  type AnlagensteuerungListe,
  type DirektvermarkterKanal,
  type Device,
  type Einspeisemanagement,
  type NetzVermarktung,
  type UemsDatenquelle,
  type UemsDatenquellePruefergebnis,
} from '../api';
import {
  ANLAGENART_TEXT,
  ERZEUGER_ALARM_VORLAGEN,
  HERZSCHLAG_ABSTAND_MS,
  START_ANSCHLUSS,
  alarmAnfrage,
  alarmVorschlag,
  anlagenartAus,
  anlegenAnfrage,
  anschlussFehler,
  boxUpdateUrteil,
  einheitenAusKopf,
  einheitenFehler,
  erzeugerKopfAus,
  kopfUrteil,
  namenAnfrage,
  netzAusKopf,
  netzbetreiberHinweis,
  netzFehler,
  quellenSchluessel,
  type AnlagenartWort,
  type Anschluss,
  type EinheitArtWort,
  type EinheitEntwurf,
  type KopfUrteil,
  type NetzEntwurf,
} from '../anlagensteuerungAssistent';
import {
  EINHEIT_ART_WORT,
  EINSPEISEMANAGEMENT_OPTIONEN,
  KANAL_OPTIONEN,
  direktvermarkterWert,
  einspeisemanagementWert,
} from '../anlagensteuerung';
import { anlagensteuerungApi } from '../anlagensteuerungApi';
import { anlagensteuerungGeraetId } from '../geraetAdresse';
import { anschlussGespeichert } from '../glossar';
import { geraetSeiteHash, komponenteHash } from '../nav';
import { ueberwachungApi } from '../ueberwachungApi';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import { AnlegenDialog } from './AnlegenDialog';
import { VpPicker } from './VpPicker';
import './AnlagensteuerungAssistent.css';

/**
 * UEMS EZ-15 „Anlege-Schritt Steuerung verbinden“ (Konzept „Erzeuger am Wago-Modbus-Server“ §4.11, EW-14 A):
 * Aufbau › Gerät hinzufügen › „Anlagensteuerung (SPS mit VoltPilot-Bild)“. Vier Schritte nach dem Muster des
 * WAGO-Assistenten: Anschluss mit Kopfprüfung über die Probe `erzeuger_kopf`, Einheiten benennen, Netz und
 * Vermarktung, Abschluss mit Alarm-Vorschlag. Angelegt wird erst im letzten Schritt - über die EZ-6-Route in
 * EINER Transaktion (Gerät, Komponente, Registerbild-Fassung, Einheiten), danach die Namen aus dem Bild und die
 * gewählten Alarme. Die Regeln stehen in `anlagensteuerungAssistent.ts`; hier wird nur gerendert und gerufen.
 */

const SCHRITTE = ['Anschluss', 'Einheiten', 'Netz & Vermarktung', 'Abschluss'] as const;
type Schritt = 1 | 2 | 3 | 4;

interface AlarmErgebnis {
  name: string;
  ok: boolean;
  text: string | null;
}

interface Ergebnis {
  steuerung: Anlagensteuerung;
  hinweise: string[];
  namenFehler: string | null;
  alarme: AlarmErgebnis[];
}

const warte = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function fehlerText(e: unknown, sonst: string): string {
  return e instanceof Error && e.message ? e.message : sonst;
}

export function AnlagensteuerungAssistent({
  site,
  boxen,
  onClose,
  onFertig,
  herzschlagAbstandMs = HERZSCHLAG_ABSTAND_MS,
}: {
  site: { id: string; name: string };
  /** Die VoltPilot-Boxen der Anlage. */
  boxen: readonly Device[];
  onClose: () => void;
  /** Nach dem Anlegen: `ziel` ist die Geräteseite der Steuerung (EZ-10), ohne Box ihre Zeile im Aufbau. */
  onFertig: (info: { entityId: string; titel: string; ziel: string }) => void;
  /** Abstand der zwei Herzschlag-Lesungen; Tests setzen 0. */
  herzschlagAbstandMs?: number;
}) {
  const isPhone = useIsPhone();
  const rollen = useRollen();
  const darfEinrichten = rollen.darf('geraet.einrichten') && rollen.darf('datenquelle.bearbeiten')
    && rollen.darf('datenquelle.zustaendigkeit');
  const darfAlarme = rollen.darf('ueberwachung.verwalten');

  const [schritt, setSchritt] = useState<Schritt>(1);
  const [einrichtung, setEinrichtung] = useState<AnlagensteuerungListe['einrichtung'] | null>(null);
  const [gespeichert, setGespeichert] = useState<NetzVermarktung | null>(null);
  const [anschluss, setAnschluss] = useState<Anschluss>(START_ANSCHLUSS);
  const [quelle, setQuelle] = useState<UemsDatenquelle | null>(null);
  const [quelleFuer, setQuelleFuer] = useState<string | null>(null);
  const [zugewiesenAn, setZugewiesenAn] = useState<string | null>(null);
  const [erste, setErste] = useState<UemsDatenquellePruefergebnis | null>(null);
  const [zweite, setZweite] = useState<UemsDatenquellePruefergebnis | null>(null);
  const [vorab, setVorab] = useState<KopfUrteil | null>(null);
  const [anlagenart, setAnlagenart] = useState<AnlagenartWort | ''>('');
  // Für welche gelesene Steuerung die Schritte 2-4 vorbelegt sind; eine andere setzt sie neu.
  const [vorbelegtFuer, setVorbelegtFuer] = useState<string | null>(null);
  const [einheiten, setEinheiten] = useState<EinheitEntwurf[]>([]);
  const [netz, setNetz] = useState<NetzEntwurf | null>(null);
  const [alarmWahl, setAlarmWahl] = useState<Record<string, boolean> | null>(null);
  const [bezeichnung, setBezeichnung] = useState('Anlagensteuerung');
  const [hersteller, setHersteller] = useState('');
  const [typ, setTyp] = useState('');
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  // Welche Box das Erzeuger-Bild lesen kann und was an der Anlage schon gepflegt ist - fail-soft: ohne die
  // Auskunft prüft die Box selbst (eine ältere antwortet ehrlich „not_supported“).
  useEffect(() => {
    let aktiv = true;
    api.anlagensteuerungen(site.id).then((l) => aktiv && setEinrichtung(l?.einrichtung ?? null), () => undefined);
    api.netzVermarktung(site.id).then((n) => aktiv && setGespeichert(n), () => undefined);
    return () => {
      aktiv = false;
    };
  }, [site.id]);

  const faehig = useMemo(() => new Set((einrichtung?.boxen ?? []).filter((b) => b.faehig).map((b) => b.device_id)),
    [einrichtung]);
  const boxOptionen = useMemo(() => [...boxen]
    .sort((a, b) => Number(faehig.has(b.id)) - Number(faehig.has(a.id)))
    .map((b) => ({
      value: b.id,
      label: `${b.name ?? b.externalRef}${einrichtung && !faehig.has(b.id) ? ' · Update nötig' : ''}`,
    })), [boxen, faehig, einrichtung]);
  const boxId = anschluss.boxId || boxOptionen[0]?.value || '';
  const urteil = vorab ?? kopfUrteil(erste, zweite);
  const kopf = urteil?.art === 'erkannt' ? urteil.kopf : null;
  // Am Telefon steht das Ergebnis unter den Feldern: nach jeder Prüfung rückt es ins Bild.
  const urteilRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (erste || vorab) urteilRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [erste, zweite, vorab]);
  const setze = (neu: Partial<Anschluss>) => {
    setAnschluss((a) => ({ ...a, ...neu }));
    setErste(null); setZweite(null); setVorab(null);
  };
  // Der Anschluss heißt wie das Gerät (Konzept „Ein Gerät, ein Eintrag“, GE-6) — nicht fest „Anlagensteuerung“.
  const steuerungsName = bezeichnung.trim() || 'Anlagensteuerung';
  const quelleDaten = (name: string) => ({
    name, protokoll: 'modbus_tcp',
    adresse: `${anschluss.host.trim()}:${Number(anschluss.port)}`,
    geraete_ids: [Number(anschluss.unitId)], netz: anschluss.netz.trim(),
    mehrere_leser: false, steuerquelle: false, kadenz_s: 5,
  });

  async function pruefeEinmal(q: UemsDatenquelle): Promise<UemsDatenquellePruefergebnis> {
    return api.datenquellePruefen(site.id, q.id, {
      device_id: boxId,
      op: 'erzeuger_kopf',
      unit_id: Number(anschluss.unitId),
      register: Number(anschluss.basisadresse),
      register_kind: anschluss.funktionscode === '4' ? 'input' : 'holding',
      word_order: anschluss.wortfolge,
    });
  }

  async function kopfPruefen() {
    const grund = anschlussFehler({ ...anschluss, boxId });
    if (grund) { setFehler(grund); return; }
    setFehler(null); setErste(null); setZweite(null); setVorab(null);
    if (einrichtung && !faehig.has(boxId)) { setVorab(boxUpdateUrteil()); return; }
    setBusy('Kopf wird gelesen …');
    try {
      const daten = quelleDaten(quelle?.name ?? steuerungsName);
      const schluessel = quellenSchluessel(anschluss);
      let q = quelle;
      if (!q) {
        q = await api.datenquelleAnlegen(site.id, { ...daten, device_id: boxId });
      } else if (quelleFuer !== schluessel) {
        // Adresse, Port, Unit-ID oder Netzlage geändert: die Entwurfs-Quelle zieht nach, nie eine zweite.
        q = await api.datenquelleBearbeiten(site.id, q.id, daten);
      }
      setQuelle(q); setQuelleFuer(schluessel);
      const p1 = await pruefeEinmal(q);
      setErste(p1);
      if (erzeugerKopfAus(p1)?.erkannt) {
        // Der Herzschlag zählt +1 je Sekunde: erst die zweite Lesung zeigt, ob das Programm läuft.
        setBusy('Herzschlag wird ein zweites Mal gelesen …');
        await warte(herzschlagAbstandMs);
        setZweite(await pruefeEinmal(q));
      }
    } catch (e) {
      setFehler(fehlerText(e, 'Der Kopf konnte nicht geprüft werden.'));
    } finally { setBusy(null); }
  }

  async function weiterAusAnschluss() {
    if (!quelle || !kopf) return;
    setBusy('Box wird zugewiesen …'); setFehler(null);
    try {
      if (zugewiesenAn !== boxId) {
        await api.datenquelleZuweisen(site.id, quelle.id, { device_id: boxId });
        setZugewiesenAn(boxId);
      }
      const fuer = JSON.stringify([kopf.steuerung_id, kopf.te_anzahl, kopf.anlagenart, kopf.einheiten,
        kopf.netzbetreiber_name, kopf.direktvermarkter_name]);
      if (fuer !== vorbelegtFuer) {
        setEinheiten(einheitenAusKopf(kopf));
        setAnlagenart(anlagenartAus(kopf.anlagenart) ?? '');
        setNetz(netzAusKopf(kopf, gespeichert));
        setAlarmWahl(null);
        setVorbelegtFuer(fuer);
      }
      setSchritt(2);
    } catch (e) {
      setFehler(fehlerText(e, 'Die Box konnte dem Anschluss nicht zugewiesen werden.'));
    } finally { setBusy(null); }
  }

  function aendereEinheit(teNr: number, neu: Partial<EinheitEntwurf>) {
    setEinheiten((alle) => alle.map((e) => e.teNr === teNr ? { ...e, ...neu } : e));
  }

  function aendereNetz(neu: Partial<NetzEntwurf>) {
    setNetz((n) => n ? { ...n, ...neu } : n);
  }

  function weiterAusEinheiten() {
    const liste = [...einheitenFehler(einheiten), ...(anlagenart ? [] : ['Wählen Sie die Anlagenart.'])];
    if (liste.length) { setFehler(liste.join(' ')); return; }
    setFehler(null); setSchritt(3);
  }

  function weiterAusNetz() {
    if (!netz) return;
    const liste = netzFehler(netz, einheiten);
    if (liste.length) { setFehler(liste.join(' ')); return; }
    setFehler(null);
    if (!alarmWahl) {
      setAlarmWahl(Object.fromEntries(ERZEUGER_ALARM_VORLAGEN.map((v) => [v.wertart, alarmVorschlag(v, netz).an])));
    }
    setSchritt(4);
  }

  async function anlegen() {
    if (!quelle || !kopf || !netz || !anlagenart) return;
    if (!darfEinrichten) { setFehler(rollen.grund); return; }
    setBusy('Wird angelegt …'); setFehler(null);
    try {
      if ((quelle.name ?? steuerungsName) !== steuerungsName) {
        // Umbenannt in Schritt 4: der Anschluss zieht den Namen nach, Weg und Box bleiben.
        setQuelle(await api.datenquelleBearbeiten(site.id, quelle.id, quelleDaten(steuerungsName)));
      }
      const steuerung = await anlagensteuerungApi.anlegen(site.id, anlegenAnfrage({
        dataSourceId: quelle.id, anschluss: { ...anschluss, boxId }, kopf, anlagenart, bezeichnung, hersteller, typ,
        einheiten, netz,
      }));
      // Danach Namen und Alarme: scheitert eines, bleibt die Steuerung angelegt und der Grund steht da.
      let hinweise: string[] = [];
      let namenFehler: string | null = null;
      const namen = namenAnfrage(kopf);
      if (namen) {
        try {
          hinweise = (await anlagensteuerungApi.namen(steuerung.geraet_id, namen)).hinweise.map((h) => h.text);
        } catch (e) {
          namenFehler = fehlerText(e, 'Die Namen aus dem Bild wurden nicht übernommen.');
        }
      }
      const alarme: AlarmErgebnis[] = [];
      if (darfAlarme) {
        for (const v of ERZEUGER_ALARM_VORLAGEN.filter((x) => alarmWahl?.[x.wertart])) {
          try {
            await ueberwachungApi.anlegen(alarmAnfrage(v, site.id));
            alarme.push({ name: v.name, ok: true, text: null });
          } catch (e) {
            alarme.push({ name: v.name, ok: false, text: fehlerText(e, 'nicht angelegt') });
          }
        }
      }
      setErgebnis({ steuerung, hinweise, namenFehler, alarme });
    } catch (e) {
      setFehler(fehlerText(e, 'Die Anlagensteuerung konnte nicht angelegt werden.'));
    } finally { setBusy(null); }
  }

  const titel = isPhone ? 'Anlagensteuerung verbinden' : `Anlagensteuerung an ${site.name} verbinden`;

  if (!darfEinrichten) {
    return <AnlegenDialog titel={titel} schritte={[...SCHRITTE]} aktiv={1} onClose={onClose}
      footer={<Button variant="ghost" onClick={onClose}>Schließen</Button>}>
      <section className="vp-anst-schritt" data-schritt="recht">
        <p className="vp-anst-kasten ist-fehler" role="status">
          <strong>Keine Berechtigung</strong>
          <span>Eine Anlagensteuerung verbinden dürfen Kundenadministrator, Bearbeiter des Standorts und ein
            Unterstützer mit der Freigabe „einrichten“ (zum Beispiel VoltPilot).</span>
          <span>{rollen.grund}</span>
        </p>
      </section>
    </AnlegenDialog>;
  }

  let rumpf: ReactNode;
  if (schritt === 1) {
    rumpf = <section className="vp-anst-schritt" data-schritt="anschluss">
      <p className="vp-anst-hinweis">Die Box liest den Kopf des VoltPilot-Registerbilds - Signatur, Version, Einheiten,
        Herzschlag und Namen. Keinen Messwert.</p>
      <div className="vp-anst-felder">
        <Input label="Adresse" value={anschluss.host} placeholder="192.168.4.165" onChange={(e) => setze({ host: e.target.value })} />
        <Input label="Port" inputMode="numeric" value={anschluss.port} onChange={(e) => setze({ port: e.target.value })} />
        <Input label="Netzlage" value={anschluss.netz} placeholder="VLAN 20 „Anlage“" onChange={(e) => setze({ netz: e.target.value })} />
        <Input label="Unit-ID" inputMode="numeric" value={anschluss.unitId} onChange={(e) => setze({ unitId: e.target.value })} />
        <Input label="Basisadresse" inputMode="numeric" value={anschluss.basisadresse} onChange={(e) => setze({ basisadresse: e.target.value })} />
        <VpPicker label="Funktionscode" value={anschluss.funktionscode}
          options={[{ value: '4', label: '4 · Eingangsregister' }, { value: '3', label: '3 · Halteregister' }]}
          onChange={(wert) => setze({ funktionscode: wert as '3' | '4' })} />
        <VpPicker label="Wortfolge" value={anschluss.wortfolge}
          options={[{ value: 'big', label: 'Höherwertiges Wort zuerst' }, { value: 'little', label: 'Niederwertiges Wort zuerst' }]}
          onChange={(wert) => setze({ wortfolge: wert as 'big' | 'little' })} />
        <VpPicker label="Zuständige Box" value={boxId} options={boxOptionen}
          onChange={(wert) => setze({ boxId: wert })} />
      </div>
      <div className="vp-anst-aktionen">
        <Button variant="outline" onClick={() => void kopfPruefen()} disabled={busy != null}>
          {busy ?? (urteil ? 'Kopf erneut prüfen' : 'Kopf prüfen')}
        </Button>
      </div>
      {quelle && <p className="vp-anst-hinweis">{anschlussGespeichert(quelle.kennzeichen, 'Anlegen')}</p>}
      {urteil && <div ref={urteilRef} className={`vp-anst-kasten ist-${urteil.art}`} role="status" data-testid="anst-kopf">
        <strong>{urteil.art === 'erkannt' ? `✓ ${urteil.titel}` : urteil.titel}</strong>
        {urteil.satz && <span>{urteil.satz}</span>}
        {urteil.details.length > 0 && <ul>{urteil.details.map((d) => <li key={d}>{d}</li>)}</ul>}
      </div>}
    </section>;
  } else if (schritt === 2) {
    rumpf = <section className="vp-anst-schritt" data-schritt="einheiten">
      {kopf && anlagenartAus(kopf.anlagenart)
        ? <p className="vp-anst-hinweis">{`Anlagenart ${ANLAGENART_TEXT[anlagenartAus(kopf.anlagenart)!]} (aus dem Bild)`}</p>
        : <VpPicker label="Anlagenart" value={anlagenart || null}
          options={(Object.keys(ANLAGENART_TEXT) as AnlagenartWort[]).map((a) => ({ value: a, label: ANLAGENART_TEXT[a] }))}
          onChange={(wert) => setAnlagenart(wert as AnlagenartWort)} />}
      <h3>Einheiten aus dem Bild</h3>
      <ul className="vp-anst-einheiten">{einheiten.map((e) => <li key={e.teNr}>
        <div className="vp-anst-einheit-kopf">
          <strong>{`Einheit ${e.teNr}`}</strong>
          <span>{e.art ? EINHEIT_ART_WORT[e.art] : 'Art nicht gemeldet'}</span>
        </div>
        <div className="vp-anst-felder">
          <Input label="Name" value={e.bezeichnung} onChange={(ev) => aendereEinheit(e.teNr, { bezeichnung: ev.target.value })} />
          <Input label={e.typBild ? 'Typ (aus dem Bild)' : 'Typ'} value={e.typ} placeholder="Hersteller und Typ"
            onChange={(ev) => aendereEinheit(e.teNr, { typ: ev.target.value })} />
          <Input label={e.nennAusBild ? 'Nennleistung in kW (aus dem Bild)' : 'Nennleistung in kW'} inputMode="decimal"
            value={e.nennKw} onChange={(ev) => aendereEinheit(e.teNr, { nennKw: ev.target.value })} />
          {!e.artAusBild && <VpPicker label="Art" value={e.art}
            options={(Object.keys(EINHEIT_ART_WORT) as EinheitArtWort[]).map((a) => ({ value: a, label: EINHEIT_ART_WORT[a] }))}
            onChange={(wert) => aendereEinheit(e.teNr, { art: wert as EinheitArtWort })} />}
        </div>
      </li>)}</ul>
    </section>;
  } else if (schritt === 3 && netz) {
    const hinweis = netzbetreiberHinweis(kopf?.netzbetreiber_name, gespeichert?.netzbetreiber);
    rumpf = <section className="vp-anst-schritt" data-schritt="netz">
      <h3>Netzbetreiber</h3>
      <dl className="vp-anst-werte">
        <div><dt>Netzbetreiber (aus dem Bild)</dt><dd>{kopf?.netzbetreiber_name?.trim() || 'nicht genannt'}</dd></div>
        <div><dt>Am Netzanschluss</dt><dd>{gespeichert?.netzbetreiber ?? 'nicht eingetragen'}</dd></div>
      </dl>
      {hinweis && <p className="vp-anst-kasten ist-hinweis" role="note">{hinweis}</p>}
      {netz.gepflegt && gespeichert ? <div className="vp-anst-kasten" role="status">
        <strong>An der Anlage schon gepflegt</strong>
        <span>{`Einspeisemanagement: ${einspeisemanagementWert(gespeichert)} · Direktvermarkter: ${direktvermarkterWert(gespeichert)}`}</span>
        <span>Dieser Schritt ändert es nicht; ändern kann es der Kundenadministrator an der Anlage.</span>
      </div> : <>
        <div className="vp-anst-felder">
          <VpPicker label="Einspeisemanagement" value={netz.einspeisemanagement || null}
            options={EINSPEISEMANAGEMENT_OPTIONEN}
            onChange={(wert) => aendereNetz({ einspeisemanagement: wert as Einspeisemanagement })} />
          {netz.einspeisemanagement === 'statisch' && <Input label="Feste Grenze in %" inputMode="decimal" value={netz.prozent}
            placeholder="70" onChange={(e) => aendereNetz({ prozent: e.target.value })} />}
        </div>
        {netz.einspeisemanagement === 'stufen' && <fieldset className="vp-anst-stufen">
          <legend>Bedeutung der Rundsteuer-Stufen</legend>
          {netz.stufen.map((s, i) => <Input key={s.stufe} label={`Stufe ${s.stufe} in %`} inputMode="decimal" value={s.prozent}
            onChange={(e) => aendereNetz({ stufen: netz.stufen.map((x, j) => j === i ? { ...x, prozent: e.target.value } : x) })} />)}
        </fieldset>}
        <h3>Direktvermarkter</h3>
        <div className="vp-anst-felder">
          <Input label={kopf?.direktvermarkter_name ? 'Direktvermarkter (aus dem Bild)' : 'Direktvermarkter'}
            value={netz.direktvermarkter} placeholder="leer = keiner"
            onChange={(e) => aendereNetz({ direktvermarkter: e.target.value })} />
          <VpPicker label="Weg der Vorgaben" value={netz.kanal || null} options={KANAL_OPTIONEN}
            onChange={(wert) => aendereNetz({ kanal: wert as DirektvermarkterKanal })} />
        </div>
      </>}
      <h3>MaStR-Nummer je Einheit</h3>
      <div className="vp-anst-felder">
        {einheiten.map((e) => <Input key={e.teNr} label={`${e.bezeichnung || `Einheit ${e.teNr}`} · SEE-Nummer`}
          value={e.see} placeholder="SEE912345678901" onChange={(ev) => aendereEinheit(e.teNr, { see: ev.target.value })} />)}
      </div>
    </section>;
  } else if (ergebnis) {
    rumpf = <section className="vp-anst-schritt" data-schritt="fertig">
      <div className="vp-anst-kasten ist-erkannt" role="status">
        <strong>Anlagensteuerung angelegt</strong>
        <span>{`${ergebnis.steuerung.kennzeichen} · ${ergebnis.steuerung.bezeichnung ?? 'Anlagensteuerung'} mit `
          + `${ergebnis.steuerung.einheiten.length === 1 ? '1 Einheit' : `${ergebnis.steuerung.einheiten.length} Einheiten`}. `
          + 'Die zuständige Box liest das Bild alle 5 s; die ersten Werte stehen da, sobald sie ankommen.'}</span>
      </div>
      {ergebnis.hinweise.map((h) => <p key={h} className="vp-anst-kasten ist-hinweis" role="note">{h}</p>)}
      {ergebnis.namenFehler && <p className="vp-anst-kasten ist-hinweis" role="note">{`Namen aus dem Bild: ${ergebnis.namenFehler}`}</p>}
      {ergebnis.alarme.length > 0 && <ul className="vp-anst-liste" aria-label="Alarme">
        {ergebnis.alarme.map((a) => <li key={a.name}>{a.ok ? `✓ ${a.name} angelegt` : `${a.name}: ${a.text}`}</li>)}
      </ul>}
    </section>;
  } else {
    rumpf = <section className="vp-anst-schritt" data-schritt="abschluss">
      <div className="vp-anst-felder">
        <Input label="Name der Steuerung" value={bezeichnung} onChange={(e) => setBezeichnung(e.target.value)} />
        <Input label="Hersteller" value={hersteller} placeholder="WAGO" onChange={(e) => setHersteller(e.target.value)} />
        <Input label="Typ" value={typ} placeholder="PFC200 750-8212" onChange={(e) => setTyp(e.target.value)} />
      </div>
      <h3>Alarme vorschlagen</h3>
      {!darfAlarme && <p className="vp-anst-hinweis">Alarme legt an, wer Überwachungen verwalten darf (Kundenadministrator,
        Energiemanager, Bearbeiter). Dieser Vorschlag wird darum nicht angelegt; der Kunde findet die Vorlagen unter Meldungen.</p>}
      <ul className="vp-anst-alarme">{ERZEUGER_ALARM_VORLAGEN.map((v) => {
        const vorschlag = netz ? alarmVorschlag(v, netz) : { an: true, grund: null };
        return <li key={v.wertart}>
          <Switch checked={darfAlarme && !!alarmWahl?.[v.wertart]} disabled={!darfAlarme || busy != null}
            label={<span className="vp-anst-alarm-text"><b>{v.name}</b><small>{v.satz}</small>
              {vorschlag.grund && <small>{`Vorschlag aus: ${vorschlag.grund}.`}</small>}</span>}
            onChange={(e) => setAlarmWahl((w) => ({ ...(w ?? {}), [v.wertart]: e.target.checked }))} />
        </li>;
      })}</ul>
      {darfAlarme && <p className="vp-anst-hinweis">Gemeldet an: Kundenadministrator.</p>}
      <p className="vp-anst-hinweis">{`Angelegt werden: das Gerät „${steuerungsName}“ mit seinem Anschluss `
        + `(Modbus TCP ${quelle?.adresse ?? ''} · Kennung ${quelle?.kennzeichen ?? ''}), die Registerbild-Fassung (Soll für den Abgleich), `
        + `${einheiten.length === 1 ? '1 Einheit' : `${einheiten.length} Einheiten`} und die Komponente.`}</p>
    </section>;
  }

  const zurueck = schritt > 1 && !ergebnis && busy == null ? () => { setFehler(null); setSchritt((schritt - 1) as Schritt); } : null;
  let weiter: ReactNode;
  if (schritt === 1) weiter = <Button onClick={() => void weiterAusAnschluss()} disabled={!kopf || busy != null}>Weiter</Button>;
  else if (schritt === 2) weiter = <Button onClick={weiterAusEinheiten}>Weiter</Button>;
  else if (schritt === 3) weiter = <Button onClick={weiterAusNetz}>Weiter</Button>;
  else if (ergebnis) {
    const ref = boxen.find((b) => b.id === boxId)?.externalRef;
    const entityId = ergebnis.steuerung.entity_id;
    weiter = <Button onClick={() => onFertig({ entityId, titel: ergebnis.steuerung.bezeichnung ?? 'Anlagensteuerung',
      ziel: ref ? geraetSeiteHash(site.id, ref, anlagensteuerungGeraetId(entityId)) : komponenteHash(site.id, entityId) })}>
      Zur Geräteseite</Button>;
  } else weiter = <Button onClick={() => void anlegen()} disabled={busy != null}>{busy ?? 'Anlegen'}</Button>;
  const footer = <>{zurueck ? <Button variant="ghost" onClick={zurueck}>Zurück</Button>
    : <Button variant="ghost" onClick={onClose}>{ergebnis ? 'Schließen' : 'Abbrechen'}</Button>}{weiter}</>;

  return <AnlegenDialog titel={titel} schritte={[...SCHRITTE]} aktiv={schritt} onClose={onClose} onBack={zurueck}
    footer={footer}>
    {rumpf}
    {fehler && <p className="vp-anst-fehler" role="alert" tabIndex={-1}>{fehler}</p>}
  </AnlegenDialog>;
}
