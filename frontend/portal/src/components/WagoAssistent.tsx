import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  type Device,
  type EdgeVersion,
  type ProbeAntwort,
  type UemsDatenquelle,
  type UemsDatenquellePruefergebnis,
} from '../api';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import {
  WAGO_BOGEN_GRUPPEN,
  WAGO_BOX_FAehIGKEIT,
  WAGO_VORLAGE,
  bogenLesen,
  bogenSpeichern,
  neueWagoKarte,
  wagoBogenAuswerten,
  wagoKopfAnzeige,
  type WagoAntworten,
  type WagoFrage,
  type WagoKarteEntwurf,
} from '../wagoAssistent';
import { AnlegenDialog } from './AnlegenDialog';
import { VpPicker } from './VpPicker';
import './WagoAssistent.css';

const SCHRITTE = ['Bogen', 'Datenquelle', 'Gerät', 'Karten', 'Komponenten'] as const;
type Schritt = 1 | 2 | 3 | 4 | 5;

interface Verbindung {
  name: string;
  host: string;
  port: string;
  netz: string;
  unitId: string;
  basisadresse: string;
  funktionscode: '3' | '4';
  wortfolge: 'big' | 'little';
  boxId: string;
}

const START_VERBINDUNG: Verbindung = {
  name: 'WAGO-Steuerung', host: '', port: '502', netz: '', unitId: '1', basisadresse: '0',
  funktionscode: '3', wortfolge: 'big', boxId: '',
};

interface GeraetEntwurf { seriennummer: string; firmware: string; programm: string }

function minuteJetzt(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return d.toISOString();
}

function kopfHerzschlag(p: UemsDatenquellePruefergebnis | null): number | null {
  const antwort = p?.antwort as { results?: Array<{ wago_kopf?: { herzschlag?: number } }> } | null;
  return antwort?.results?.find((r) => r.wago_kopf)?.wago_kopf?.herzschlag ?? null;
}

function echteWerte(antwort: ProbeAntwort | null): string[] {
  const reading = antwort?.results?.flatMap((r) => r.reading ? [r.reading] : []) ?? [];
  return reading.flatMap((r) => Object.entries(r).flatMap(([name, wert]) =>
    typeof wert === 'number' ? [`${name}: ${wert.toLocaleString('de-DE')}`] : []));
}

export function WagoAssistent({
  site,
  standortId,
  geraete,
  versionen,
  onClose,
  onMessstellen,
}: {
  site: { id: string; name: string };
  standortId: string;
  geraete: readonly Device[];
  versionen: readonly EdgeVersion[];
  onClose: () => void;
  onMessstellen: () => void;
}) {
  const basis = `vp-wago-${useId().replace(/:/g, '')}`;
  const isPhone = useIsPhone();
  const rollen = useRollen();
  const [schritt, setSchritt] = useState<Schritt>(1);
  const [antworten, setAntworten] = useState<WagoAntworten>(() =>
    bogenLesen(typeof window === 'undefined' ? null : window.localStorage, site.id));
  const [gespeichert, setGespeichert] = useState(false);
  const [verbindung, setVerbindung] = useState<Verbindung>(START_VERBINDUNG);
  const [quelle, setQuelle] = useState<UemsDatenquelle | null>(null);
  const [zugewiesen, setZugewiesen] = useState(false);
  const [pruefung, setPruefung] = useState<UemsDatenquellePruefergebnis | null>(null);
  const [vorherigerHerzschlag, setVorherigerHerzschlag] = useState<number | null>(null);
  const [geraet, setGeraet] = useState<GeraetEntwurf>({ seriennummer: '', firmware: '', programm: '' });
  const [karten, setKarten] = useState<WagoKarteEntwurf[]>(() => [neueWagoKarte(1)]);
  const [werte, setWerte] = useState<Record<string, ProbeAntwort | null>>({});
  const [angelegt, setAngelegt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const boxen = useMemo(() => {
    const faehig = new Set(versionen.filter((v) => v.capabilities?.includes(WAGO_BOX_FAehIGKEIT)).map((v) => v.deviceId));
    return geraete.filter((g) => g.kind === 'edge' && g.siteId === site.id && faehig.has(g.id));
  }, [geraete, versionen, site.id]);
  const boxId = verbindung.boxId || boxen[0]?.id || '';
  const urteil = wagoBogenAuswerten(antworten);
  const kopf = wagoKopfAnzeige(pruefung, vorherigerHerzschlag);
  const kopfErkannt = kopf?.art === 'ok' && kopf.kopf?.erkannt === true;
  const darfFertig = rollen.darf('geraet.einrichten', standortId) && rollen.darf('messstelle.quelle', standortId);

  const connection = (karte?: WagoKarteEntwurf) => ({
    ip: verbindung.host.trim(),
    port: Number(verbindung.port),
    mb_slave_id: Number(verbindung.unitId),
    base_address: Number(verbindung.basisadresse),
    function_code: verbindung.funktionscode,
    word_order: verbindung.wortfolge,
    ...(karte ? { slot: Number(karte.steckplatz) } : {}),
  });

  function aendereAntwort(code: WagoFrage, wert: string) {
    setGespeichert(false);
    setAntworten((a) => ({ ...a, [code]: wert }));
  }

  function speichereBogen() {
    setGespeichert(bogenSpeichern(window.localStorage, site.id, antworten));
  }

  function verbindungFehler(): string | null {
    if (!verbindung.name.trim()) return 'Geben Sie der Datenquelle einen Namen.';
    if (!verbindung.host.trim()) return 'Geben Sie die Adresse der Steuerung ein.';
    if (!boxId) return 'Für diese Anlage ist keine passende VoltPilot-Box verfügbar.';
    for (const [wert, name, min, max] of [
      [verbindung.port, 'Port', 1, 65535],
      [verbindung.unitId, 'Geräte-ID', 0, 255],
      [verbindung.basisadresse, 'Basisadresse', 0, 65535],
    ] as const) {
      const zahl = Number(wert);
      if (!Number.isInteger(zahl) || zahl < min || zahl > max) return `${name} ist keine gültige ganze Zahl.`;
    }
    return null;
  }

  async function kopfPruefen() {
    const grund = verbindungFehler();
    if (grund) { setFehler(grund); return; }
    setBusy(true); setFehler(null);
    try {
      const q = quelle ?? await api.datenquelleAnlegen(site.id, {
        name: verbindung.name.trim(), protokoll: 'modbus_tcp',
        adresse: `${verbindung.host.trim()}:${Number(verbindung.port)}`,
        geraete_ids: [Number(verbindung.unitId)], netz: verbindung.netz.trim(),
        mehrere_leser: false, steuerquelle: false, kadenz_s: 60, device_id: boxId,
      });
      setQuelle(q);
      const alt = kopfHerzschlag(pruefung);
      const neu = await api.datenquellePruefen(site.id, q.id, {
        device_id: boxId,
        unit_id: Number(verbindung.unitId),
        register: Number(verbindung.basisadresse),
        register_kind: verbindung.funktionscode === '4' ? 'input' : 'holding',
        data_type: 'uint16', word_order: verbindung.wortfolge,
      });
      setVorherigerHerzschlag(alt);
      setPruefung(neu);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Der Kopf konnte nicht geprüft werden.');
    } finally { setBusy(false); }
  }

  async function weiterAusDatenquelle() {
    if (!quelle || !kopfErkannt || !boxId) return;
    setBusy(true); setFehler(null);
    try {
      if (!zugewiesen) {
        await api.datenquelleZuweisen(site.id, quelle.id, { device_id: boxId });
        setZugewiesen(true);
      }
      setSchritt(3);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Datenquelle konnte nicht zugewiesen werden.');
    } finally { setBusy(false); }
  }

  function aendereKarte(id: string, neu: Partial<WagoKarteEntwurf>) {
    setWerte({}); setAngelegt(false);
    setKarten((alle) => alle.map((k) => k.id === id ? { ...k, ...neu } : k));
  }

  async function liesEchteWerte() {
    setBusy(true); setFehler(null); setWerte({});
    try {
      const gelesen: Record<string, ProbeAntwort> = {};
      for (const karte of karten) {
        gelesen[karte.id] = await api.testComponentConnection(site.id, {
          templateRef: WAGO_VORLAGE, templateVersion: 1, role: 'consumer',
          connection: connection(karte), deviceId: boxId,
        });
      }
      setWerte(gelesen);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Werte konnten nicht gelesen werden.');
    } finally { setBusy(false); }
  }

  async function komponentenAnlegen() {
    if (!darfFertig) { setFehler(rollen.grund); return; }
    setBusy(true); setFehler(null);
    try {
      const vorher = await api.siteComponents(site.id);
      const bekannt = new Set(vorher.components.map((c) => c.id));
      const neu: Array<{ karte: WagoKarteEntwurf; entityId: string }> = [];
      for (const karte of karten) {
        const nachher = await api.createComponent(site.id, {
          templateRef: WAGO_VORLAGE, templateVersion: 1, label: karte.name.trim(), role: 'consumer',
          connection: connection(karte), note: `Energiekarte an Steckplatz ${karte.steckplatz}`,
        });
        const zeile = nachher.components.find((c) => !bekannt.has(c.id));
        if (!zeile) throw new Error('Die neu angelegte Energiekarte wurde nicht zurückgegeben.');
        bekannt.add(zeile.id);
        await api.wagoKarteEintragen(site.id, zeile.id, {
          expected_revision: zeile.definitionVersion,
          anwenderskalierung: karte.anwenderskalierung === '' ? null : karte.anwenderskalierung === 'ja',
          register35: karte.register35.trim() === '' ? null : Number(karte.register35),
        });
        neu.push({ karte, entityId: zeile.id });
      }
      const einbauten = await api.uemsGeraete(site.id);
      const controller = einbauten.geraete.find((g) => g.komponenten.some((k) => k.entity_id === neu[0]?.entityId));
      if (!controller) throw new Error('Die Energiekarten sind noch keinem Gerät zugeordnet.');
      await api.wagoGeraetEintragen(controller.id, {
        seriennummer: geraet.seriennummer.trim() || null,
        firmware: geraet.firmware.trim() || null,
        anwendung: geraet.programm.trim() || null,
      });
      const gueltigAb = minuteJetzt();
      for (const { karte, entityId } of neu) {
        if (!karte.wandlerPrimaer.trim() || !karte.wandlerSekundaer.trim()) continue;
        await api.geraetEinstellungEintragen(controller.id, {
          entity_id: entityId, kanal: null, art: 'wandler_strom',
          wert: { primaer_a: Number(karte.wandlerPrimaer), sekundaer_a: Number(karte.wandlerSekundaer) },
          anwendung: karte.wandlerAnwendung, gueltig_ab: gueltigAb,
          tatsaechlich_ab: null, begruendung: null,
        });
      }
      setAngelegt(true);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Komponenten konnten nicht angelegt werden.');
    } finally { setBusy(false); }
  }

  let rumpf: ReactNode;
  if (schritt === 1) {
    rumpf = <section className="vp-wago-schritt" data-schritt="bogen">
      <h3>Was ist am Schaltschrank vorhanden?</h3>
      <p className="vp-wago-hinweis">„Weiß nicht“ bleibt eine Prüfaufgabe. Tragen Sie nur ein, was Sie abgelesen haben.</p>
      <div className={`vp-wago-urteil ist-${urteil.ergebnis}`} role="status">
        <strong>{urteil.titel}</strong><span>{urteil.satz}</span>{urteil.ausweg && <span>{urteil.ausweg}</span>}
      </div>
      {WAGO_BOGEN_GRUPPEN.map((gruppe, index) => <details key={gruppe.code} className="vp-wago-bogengruppe" open={index === 0}>
        <summary>{`${gruppe.code} · ${gruppe.titel}`}</summary>
        <div className="vp-wago-fragen">
          {gruppe.fragen.map(([code, frage]) => <label key={code} htmlFor={`${basis}-${code}`}>
            <span><strong>{code}</strong>{` ${frage}`}</span>
            <textarea id={`${basis}-${code}`} value={antworten[code]} rows={2}
              placeholder="Antwort oder „weiß nicht“" onChange={(e) => aendereAntwort(code, e.target.value)} />
          </label>)}
        </div>
      </details>)}
      <div className="vp-wago-zwischenstand">
        <Button variant="outline" onClick={speichereBogen}>Bogen speichern</Button>
        {gespeichert && <span role="status">Zwischenstand gespeichert.</span>}
      </div>
    </section>;
  } else if (schritt === 2) {
    rumpf = <section className="vp-wago-schritt" data-schritt="datenquelle">
      <h3>Wie erreicht die Box die Steuerung?</h3>
      <p className="vp-wago-hinweis">Der Test liest nur den Kopf des Registerbilds, keine Energiekarte und keinen Messwert.</p>
      <div className="vp-wago-felder">
        <Input label="Name" value={verbindung.name} onChange={(e) => setVerbindung((v) => ({ ...v, name: e.target.value }))} />
        <Input label="Adresse" value={verbindung.host} placeholder="192.168.20.10" onChange={(e) => setVerbindung((v) => ({ ...v, host: e.target.value }))} />
        <Input label="Port" inputMode="numeric" value={verbindung.port} onChange={(e) => setVerbindung((v) => ({ ...v, port: e.target.value }))} />
        <Input label="Netzlage" value={verbindung.netz} placeholder="VLAN 20 „Produktion“" onChange={(e) => setVerbindung((v) => ({ ...v, netz: e.target.value }))} />
        <Input label="Geräte-ID" inputMode="numeric" value={verbindung.unitId} onChange={(e) => setVerbindung((v) => ({ ...v, unitId: e.target.value }))} />
        <Input label="Basisadresse" inputMode="numeric" value={verbindung.basisadresse} onChange={(e) => setVerbindung((v) => ({ ...v, basisadresse: e.target.value }))} />
        <VpPicker label="Funktionscode" value={verbindung.funktionscode} options={[{ value: '3', label: '3 · Halteregister' }, { value: '4', label: '4 · Eingangsregister' }]}
          onChange={(wert) => setVerbindung((v) => ({ ...v, funktionscode: wert as '3' | '4' }))} />
        <VpPicker label="Wortfolge" value={verbindung.wortfolge} options={[{ value: 'big', label: 'Höheres Wort zuerst' }, { value: 'little', label: 'Niedrigeres Wort zuerst' }]}
          onChange={(wert) => setVerbindung((v) => ({ ...v, wortfolge: wert as 'big' | 'little' }))} />
        <VpPicker label="Zuständige Box" value={boxId} options={boxen.map((b) => ({ value: b.id, label: b.name ?? b.externalRef }))}
          onChange={(wert) => setVerbindung((v) => ({ ...v, boxId: wert }))} />
      </div>
      <div><Button variant="outline" onClick={() => void kopfPruefen()} disabled={busy}>{busy ? 'Kopf wird geprüft …' : pruefung ? 'Kopf erneut prüfen' : 'Kopf prüfen'}</Button></div>
      {quelle && <p className="vp-wago-zwischenstand">{`${quelle.kennzeichen} ist als Entwurf angelegt.`}</p>}
      {kopf && <div className={`vp-wago-kopf ist-${kopf.art}`} role="status"><strong>{kopf.titel}</strong>
        {kopf.details.length > 0 && <ul>{kopf.details.map((d) => <li key={d}>{d}</li>)}</ul>}
      </div>}
    </section>;
  } else if (schritt === 3) {
    rumpf = <section className="vp-wago-schritt" data-schritt="geraet">
      <h3>Welche Steuerung antwortet?</h3>
      <p className="vp-wago-hinweis">Schreiben Sie Typenschild und Web-Oberfläche ab. Eine leere Angabe bleibt unbekannt.</p>
      <div className="vp-wago-felder">
        <Input label="Seriennummer" value={geraet.seriennummer} onChange={(e) => setGeraet((g) => ({ ...g, seriennummer: e.target.value }))} />
        <Input label="Firmware" value={geraet.firmware} onChange={(e) => setGeraet((g) => ({ ...g, firmware: e.target.value }))} />
        <Input label="Name des Programms" value={geraet.programm} onChange={(e) => setGeraet((g) => ({ ...g, programm: e.target.value }))} />
      </div>
    </section>;
  } else if (schritt === 4) {
    rumpf = <section className="vp-wago-schritt" data-schritt="karten">
      <h3>Welche Energiekarten stecken in der Steuerung?</h3>
      <p className="vp-wago-hinweis">Für die 750-494 sind Messwert-Tabelle und Skalierungsfaktor nicht belegt. Ein fehlender Wert bleibt „zu erheben“.</p>
      <ul className="vp-wago-karten">{karten.map((karte, index) => <li key={karte.id}>
        <div className="vp-wago-kartenkopf"><strong>{`Karte ${index + 1}`}</strong>{karten.length > 1 && <Button variant="ghost" size="sm" onClick={() => setKarten((a) => a.filter((k) => k.id !== karte.id))}>Entfernen</Button>}</div>
        <div className="vp-wago-felder">
          <Input label="Steckplatz" inputMode="numeric" value={karte.steckplatz} onChange={(e) => aendereKarte(karte.id, { steckplatz: e.target.value })} />
          <VpPicker label="Kartentyp" value={karte.typ} options={[{ value: '750-494', label: '750-494' }, { value: '750-495', label: '750-495' }]}
            onChange={(wert) => aendereKarte(karte.id, { typ: wert as WagoKarteEntwurf['typ'] })} />
          <Input label="Name" value={karte.name} onChange={(e) => aendereKarte(karte.id, { name: e.target.value })} />
          <Input label="Wandler Primärwert in A" inputMode="decimal" value={karte.wandlerPrimaer} placeholder="zu erheben" onChange={(e) => aendereKarte(karte.id, { wandlerPrimaer: e.target.value })} />
          <Input label="Wandler Sekundärwert in A" inputMode="decimal" value={karte.wandlerSekundaer} placeholder="zu erheben" onChange={(e) => aendereKarte(karte.id, { wandlerSekundaer: e.target.value })} />
          <VpPicker label="Wandlerwert" value={karte.wandlerAnwendung} options={[{ value: 'dokumentiert', label: 'Im Gerät eingestellt — dokumentiert' }, { value: 'angewendet', label: 'Von VoltPilot angewendet' }]}
            onChange={(wert) => aendereKarte(karte.id, { wandlerAnwendung: wert as WagoKarteEntwurf['wandlerAnwendung'] })} />
          <VpPicker label="Anwenderskalierung" value={karte.anwenderskalierung} options={[{ value: '', label: 'Zu erheben' }, { value: 'ja', label: 'In der Karte eingeschaltet' }, { value: 'nein', label: 'In der Karte ausgeschaltet' }]}
            onChange={(wert) => aendereKarte(karte.id, { anwenderskalierung: wert as WagoKarteEntwurf['anwenderskalierung'] })} />
          <Input label="Register 35" inputMode="numeric" value={karte.register35} placeholder="zu erheben" onChange={(e) => aendereKarte(karte.id, { register35: e.target.value })} />
        </div>
      </li>)}</ul>
      <div><Button variant="outline" onClick={() => setKarten((a) => [...a, neueWagoKarte(a.length + 1)])}>Energiekarte hinzufügen</Button></div>
    </section>;
  } else {
    rumpf = <section className="vp-wago-schritt" data-schritt="komponenten">
      <h3>Werte prüfen und Komponenten anlegen</h3>
      <p className="vp-wago-hinweis">Die Werte kommen jetzt von der gewählten Box. Unbekannt ist keine Null; unplausible Werte bleiben sichtbar.</p>
      <ul className="vp-wago-werte">{karten.map((karte) => {
        const gelesen = echteWerte(werte[karte.id] ?? null);
        return <li key={karte.id}><strong>{`${karte.name} · Steckplatz ${karte.steckplatz}`}</strong>
          {!werte[karte.id] ? <span>Noch nicht gelesen</span> : gelesen.length ? <ul>{gelesen.map((w) => <li key={w}>{w}</li>)}</ul> : <span>Kein Messwert in der Antwort</span>}
        </li>;
      })}</ul>
      {!angelegt ? <div className="vp-wago-aktionen">
        <Button variant="outline" onClick={() => void liesEchteWerte()} disabled={busy}>{busy ? 'Werte werden gelesen …' : 'Echte Werte lesen'}</Button>
        <Button onClick={() => void komponentenAnlegen()} disabled={busy || Object.keys(werte).length !== karten.length}>{busy ? 'Wird angelegt …' : 'Komponenten anlegen'}</Button>
      </div> : <div className="vp-wago-fertig" role="status"><strong>Komponenten angelegt</strong><span>Die Messstellen-Vorschlagsliste kann jetzt aus den neuen Messwerten Vorschläge bilden.</span></div>}
    </section>;
  }

  const zurueck = schritt > 1 && !angelegt ? () => setSchritt((schritt - 1) as Schritt) : null;
  let weiter: ReactNode = null;
  if (schritt === 1) weiter = <Button onClick={() => { speichereBogen(); setSchritt(2); }}>Weiter</Button>;
  else if (schritt === 2) weiter = <Button onClick={() => void weiterAusDatenquelle()} disabled={!kopfErkannt || busy}>Weiter</Button>;
  else if (schritt < 5) weiter = <Button onClick={() => setSchritt((schritt + 1) as Schritt)}>Weiter</Button>;
  else if (angelegt) weiter = <Button onClick={onMessstellen}>{isPhone ? 'Zu den Messstellen' : 'Zur Messstellen-Vorschlagsliste'}</Button>;
  const footer = <>{zurueck ? <Button variant="ghost" onClick={zurueck}>Zurück</Button> : <Button variant="ghost" onClick={onClose}>Abbrechen</Button>}{weiter}</>;

  return <AnlegenDialog titel={isPhone ? 'WAGO anbinden' : `WAGO-Steuerung an ${site.name} anbinden`}
    schritte={[...SCHRITTE]} aktiv={schritt} onClose={onClose} onBack={zurueck} footer={footer}>
    {rumpf}
    {fehler && <p className="vp-wago-fehler" role="alert" tabIndex={-1}>{fehler}</p>}
  </AnlegenDialog>;
}
