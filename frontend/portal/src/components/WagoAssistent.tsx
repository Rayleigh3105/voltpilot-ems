import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import {
  api,
  type Device,
  type EdgeVersion,
  type ProbeAntwort,
  type UemsDatenquelle,
  type UemsDatenquellePruefergebnis,
  type WagoSollLesung,
} from '../api';
import { useRollen } from '../rollen';
import { useIsPhone } from '../useIsPhone';
import {
  WAGO_BOX_FAehIGKEIT,
  WAGO_VORLAGE,
  wagoKarteAusLesung,
  wagoKopfAnzeige,
  wagoSollAnzeige,
  wagoUrteilAusLesung,
  type WagoKarteEntwurf,
} from '../wagoAssistent';
import { AnlegenDialog } from './AnlegenDialog';
import { VpPicker } from './VpPicker';
import './WagoAssistent.css';

const SCHRITTE = ['Verbindung', 'Karten', 'Komponenten'] as const;
type Schritt = 1 | 2 | 3;

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
  const isPhone = useIsPhone();
  const rollen = useRollen();
  const [schritt, setSchritt] = useState<Schritt>(1);
  const [verbindung, setVerbindung] = useState<Verbindung>(START_VERBINDUNG);
  const [quelle, setQuelle] = useState<UemsDatenquelle | null>(null);
  const [zugewiesen, setZugewiesen] = useState(false);
  const [pruefung, setPruefung] = useState<UemsDatenquellePruefergebnis | null>(null);
  const [vorherigerHerzschlag, setVorherigerHerzschlag] = useState<number | null>(null);
  const [karten, setKarten] = useState<WagoKarteEntwurf[]>([]);
  const [werte, setWerte] = useState<Record<string, ProbeAntwort | null>>({});
  const [angelegt, setAngelegt] = useState(false);
  const [sollLesung, setSollLesung] = useState<WagoSollLesung | null>(null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const boxen = useMemo(() => {
    const faehig = new Set(versionen.filter((v) => v.capabilities?.includes(WAGO_BOX_FAehIGKEIT)).map((v) => v.deviceId));
    return geraete.filter((g) => g.kind === 'edge' && g.siteId === site.id && faehig.has(g.id));
  }, [geraete, versionen, site.id]);
  const boxId = verbindung.boxId || boxen[0]?.id || '';
  const kopf = wagoKopfAnzeige(pruefung, vorherigerHerzschlag);
  const soll = sollLesung ? wagoSollAnzeige(sollLesung) : null;
  const kopfErkannt = kopf?.art === 'ok' && kopf.kopf?.erkannt === true;
  const urteil = wagoUrteilAusLesung(kopf?.kopf ?? null, karten);
  const darfFertig = rollen.darf('geraet.einrichten', standortId) && rollen.darf('messstelle.quelle', standortId);

  const connection = (slot?: number) => ({
    ip: verbindung.host.trim(),
    port: Number(verbindung.port),
    mb_slave_id: Number(verbindung.unitId),
    base_address: Number(verbindung.basisadresse),
    function_code: verbindung.funktionscode,
    word_order: verbindung.wortfolge,
    ...(slot != null ? { slot } : {}),
  });

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
      // Der Kopf des Registerbilds (op wago_kopf) — ein Datentyp gehört nicht dazu, sein Aufbau ist fest.
      const neu = await api.datenquellePruefen(site.id, q.id, {
        device_id: boxId,
        op: 'wago_kopf',
        unit_id: Number(verbindung.unitId),
        register: Number(verbindung.basisadresse),
        register_kind: verbindung.funktionscode === '4' ? 'input' : 'holding',
        word_order: verbindung.wortfolge,
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
      const anzahl = kopf?.kopf?.kartenzahl ?? 0;
      const gelesen: Record<string, ProbeAntwort> = {};
      const erkannt: WagoKarteEntwurf[] = [];
      for (let index = 1; index <= anzahl; index += 1) {
        const antwort = await api.testComponentConnection(site.id, {
          templateRef: WAGO_VORLAGE, templateVersion: 1, role: 'consumer',
          connection: connection(index), deviceId: boxId,
        });
        const karte = wagoKarteAusLesung(index, antwort);
        gelesen[karte.id] = antwort;
        erkannt.push(karte);
      }
      setKarten(erkannt);
      setWerte(gelesen);
      setSchritt(2);
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
      for (const [index, karte] of karten.entries()) {
        gelesen[karte.id] = await api.testComponentConnection(site.id, {
          templateRef: WAGO_VORLAGE, templateVersion: 1, role: 'consumer',
          connection: connection(karte.steckplatz ?? index + 1), deviceId: boxId,
        });
      }
      setWerte(gelesen);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Werte konnten nicht gelesen werden.');
    } finally { setBusy(false); }
  }

  async function komponentenAnlegen() {
    if (!darfFertig) { setFehler(rollen.grund); return; }
    if (karten.some((k) => !k.messaufgabe.trim() || Number(k.wandlerPrimaer) <= 0 || Number(k.wandlerSekundaer) <= 0)) {
      setFehler('Ergänzen Sie bei jeder Karte Messaufgabe und beide Wandlerwerte.'); return;
    }
    setBusy(true); setFehler(null);
    try {
      // EIN Aufruf: die Karten-Komponenten und ihr Controller mit je einer Karte am Steckplatz
      // entstehen in einer Transaktion — ohne Karte gäbe es weder Registerbild noch Soll-Lesung.
      const steckplatzVon = (karte: WagoKarteEntwurf, index: number) => karte.steckplatz ?? index + 1;
      const anlage = await api.wagoKartenAnlegen(site.id, { karten: karten.map((karte, index) => ({
        steckplatz: steckplatzVon(karte, index),
        kartentyp: karte.typ ? Number(karte.typ.slice(4)) : null,
        komponente: {
          templateRef: WAGO_VORLAGE, templateVersion: 1, label: karte.messaufgabe.trim(), role: 'consumer',
          connection: connection(steckplatzVon(karte, index)), note: `Energiekarte an Steckplatz ${karte.steckplatz ?? 'unbekannt'}`,
        },
      })) });
      const komponenten = await api.siteComponents(site.id);
      const neu: Array<{ karte: WagoKarteEntwurf; entityId: string }> = [];
      for (const [index, karte] of karten.entries()) {
        const entityId = anlage.karten.find((k) => k.steckplatz === steckplatzVon(karte, index))?.entityId;
        const zeile = komponenten.components.find((c) => c.id === entityId);
        if (!zeile) throw new Error('Die neu angelegte Energiekarte wurde nicht zurückgegeben.');
        await api.wagoKarteEintragen(site.id, zeile.id, {
          expectedRevision: zeile.definitionVersion,
          anwenderskalierung: null,
          register35: null,
        });
        neu.push({ karte, entityId: zeile.id });
      }
      const gueltigAb = minuteJetzt();
      for (const { karte, entityId } of neu) {
        await api.geraetEinstellungEintragen(anlage.geraetId, {
          entity_id: entityId, kanal: null, art: 'wandler_strom',
          wert: { primaer_a: Number(karte.wandlerPrimaer), sekundaer_a: Number(karte.wandlerSekundaer) },
          anwendung: karte.wandlerAnwendung, gueltig_ab: gueltigAb,
          tatsaechlich_ab: null, begruendung: null,
        });
      }
      setAngelegt(true);
      // Das Soll des Registerbilds liest die Box selbst — ohne Eingabe. Scheitert es, bleiben die
      // Komponenten angelegt; das Soll ist dann „nicht gelesen“ und die Box prüft es nicht.
      try {
        setSollLesung(await api.wagoSollLesen(anlage.geraetId, { deviceId: boxId }));
      } catch {
        setSollLesung(null);
      }
    } catch (e) {
      setFehler(e instanceof Error ? e.message : 'Die Komponenten konnten nicht angelegt werden.');
    } finally { setBusy(false); }
  }

  let rumpf: ReactNode;
  if (schritt === 1) {
    rumpf = <section className="vp-wago-schritt" data-schritt="datenquelle">
      <h3>Verbindung zur WAGO-Steuerung prüfen</h3>
      <p className="vp-wago-hinweis">Der Test liest den Kopf des Registerbilds und je Energiekarte Steckplatz, Kartentyp und Variante — keinen Messwert.</p>
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
        {kopf.karten.length > 0 && <ul className="vp-wago-kopf-karten" aria-label="Gelesene Energiekarten">
          {kopf.karten.map((z) => <li key={z}>{z}</li>)}</ul>}
      </div>}
    </section>;
  } else if (schritt === 2) {
    rumpf = <section className="vp-wago-schritt" data-schritt="karten">
      <h3>Ausgelesene Energiekarten ergänzen</h3>
      <p className="vp-wago-hinweis">Steckplatz und Typ kommen von der Box. Für die 750-494 sind Messwert-Tabelle und Skalierungsfaktor nicht belegt.</p>
      <div className={`vp-wago-urteil ist-${urteil.ergebnis}`} role="status">
        <strong>{urteil.titel}</strong><span>{urteil.satz}</span>{urteil.ausweg && <span>{urteil.ausweg}</span>}
      </div>
      <ul className="vp-wago-karten">{karten.map((karte, index) => <li key={karte.id}>
        <div className="vp-wago-kartenkopf"><strong>{`Karte ${index + 1}`}</strong><span>{`Steckplatz ${karte.steckplatz ?? 'unbekannt'} · ${karte.typ ?? 'Typ unbekannt'}`}</span></div>
        <div className="vp-wago-felder">
          <Input label="Was misst die Karte?" value={karte.messaufgabe} placeholder="Zum Beispiel Zuleitung Halle 2" onChange={(e) => aendereKarte(karte.id, { messaufgabe: e.target.value })} />
          <div className="vp-wago-wandler">
            <Input label="Wandler Primärwert in A" inputMode="decimal" value={karte.wandlerPrimaer} onChange={(e) => aendereKarte(karte.id, { wandlerPrimaer: e.target.value })} />
            <Input label="Wandler Sekundärwert in A" inputMode="decimal" value={karte.wandlerSekundaer} onChange={(e) => aendereKarte(karte.id, { wandlerSekundaer: e.target.value })} />
          </div>
          <VpPicker label="Wo wird der Wandlerwert umgerechnet?" value={karte.wandlerAnwendung} options={[{ value: 'dokumentiert', label: 'Schon in der Karte' }, { value: 'angewendet', label: 'Durch VoltPilot' }]}
            onChange={(wert) => aendereKarte(karte.id, { wandlerAnwendung: wert as WagoKarteEntwurf['wandlerAnwendung'] })} />
        </div>
      </li>)}</ul>
    </section>;
  } else {
    rumpf = <section className="vp-wago-schritt" data-schritt="komponenten">
      <h3>Werte prüfen und Komponenten anlegen</h3>
      <p className="vp-wago-hinweis">Die Werte kommen jetzt von der gewählten Box. Unbekannt ist keine Null; unplausible Werte bleiben sichtbar.</p>
      <ul className="vp-wago-werte">{karten.map((karte) => {
        const gelesen = echteWerte(werte[karte.id] ?? null);
        return <li key={karte.id}><strong>{`${karte.messaufgabe} · Steckplatz ${karte.steckplatz ?? 'unbekannt'}`}</strong>
          {!werte[karte.id] ? <span>Noch nicht gelesen</span> : gelesen.length ? <ul>{gelesen.map((w) => <li key={w}>{w}</li>)}</ul> : <span>Kein Messwert in der Antwort</span>}
        </li>;
      })}</ul>
      {!angelegt ? <div className="vp-wago-aktionen">
        <Button variant="outline" onClick={() => void liesEchteWerte()} disabled={busy}>{busy ? 'Werte werden gelesen …' : 'Echte Werte lesen'}</Button>
        <Button onClick={() => void komponentenAnlegen()} disabled={busy || Object.keys(werte).length !== karten.length}>{busy ? 'Wird angelegt …' : 'Komponenten anlegen'}</Button>
      </div> : <div className="vp-wago-fertig" role="status"><strong>Komponenten angelegt</strong><span>Die Messstellen-Vorschlagsliste kann jetzt aus den neuen Messwerten Vorschläge bilden.</span></div>}
      {angelegt && soll && <div className={`vp-wago-soll${soll.abweichend ? ' vp-wago-soll-abweichend' : ''}`} data-testid="wago-soll">
        <strong>{soll.titel}</strong>
        <span>{soll.satz}</span>
        <ul>{soll.zeilen.map((z) => <li key={z}>{z}</li>)}</ul>
      </div>}
    </section>;
  }

  const zurueck = schritt > 1 && !angelegt ? () => setSchritt((schritt - 1) as Schritt) : null;
  let weiter: ReactNode = null;
  if (schritt === 1) weiter = <Button onClick={() => void weiterAusDatenquelle()} disabled={!kopfErkannt || busy}>{busy ? 'Karten werden gelesen …' : isPhone ? 'Karten lesen' : 'Karten auslesen und weiter'}</Button>;
  else if (schritt === 2) weiter = <Button onClick={() => setSchritt(3)} disabled={karten.length === 0}>Weiter</Button>;
  else if (angelegt) weiter = <Button onClick={onMessstellen}>{isPhone ? 'Zu den Messstellen' : 'Zur Messstellen-Vorschlagsliste'}</Button>;
  const footer = <>{zurueck ? <Button variant="ghost" onClick={zurueck}>Zurück</Button> : <Button variant="ghost" onClick={onClose}>Abbrechen</Button>}{weiter}</>;

  return <AnlegenDialog titel={isPhone ? 'WAGO anbinden' : `WAGO-Steuerung an ${site.name} anbinden`}
    schritte={[...SCHRITTE]} aktiv={schritt} onClose={onClose} onBack={zurueck} footer={footer}>
    {rumpf}
    {fehler && <p className="vp-wago-fehler" role="alert" tabIndex={-1}>{fehler}</p>}
  </AnlegenDialog>;
}
