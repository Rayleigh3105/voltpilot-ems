import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type MessmittelAngaben } from '../api';
import { UEMS_MESSMITTEL, UEMS_NICHT_ERHOBEN, UEMS_NORMGRENZE } from '../glossar';
import {
  blattZeilen,
  herstellerZeilen,
  eintragAus,
  entwurfAus,
  messmittelAblehnung,
  messmittelLesbar,
  PRUEFUNGSART_OPTIONEN,
  pruefsummeKurz,
  pruefsummeLokal,
  type MessmittelEntwurf,
} from '../uemsMessmittel';
import { Recht } from './Recht';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';
import './MessmittelBlatt.css';

/**
 * Das MESSMITTEL-BLATT je Gerät (UEMS AP-16 IP-18, §5.4, R8, G1–G4): was über dieses Messmittel am Einbau erhoben ist —
 * Klasse, Prüfung, „gültig bis“ mit „abgelaufen seit“, Beleg als Verweis mit Prüfsumme und je Wandler-Fassung die
 * Klasse. Was fehlt, steht wörtlich als „nicht erhoben“ (G3); nie ein Vorgabewert, nie eine Genauigkeit der Messkette.
 *
 * ⚠ G4: die Katalog-Angabe „laut Hersteller“ (IP-16, `laut_hersteller`) steht GETRENNT unter den Einbau-Angaben, mit
 * Fundstelle und Quellen-Prüfsumme — nie verrechnet, nie als Ersatz einer fehlenden Einbau-Angabe. Ohne Katalog-Angabe
 * steht der Abschnitt nicht da.
 * ⚠ Lesen über `messwerte.ansehen` (die Route); eintragen nur mit `messmittel.angaben` am Standort der Seite
 * (`RechteStandort`, wie die übrigen Hebel der Geräteseite; die Route prüft den Zaun über die Anlage). Ohne
 * Antwort (Fehler, 404) oder ohne lesbare Angabe (keine `wandler`-Liste) steht GAR NICHTS — dieselbe Regel wie
 * Einstellungen und Protokoll der Geräteseite.
 */
export function MessmittelBlatt({ geraetId, heute }: { geraetId: string; heute?: string }) {
  const [angaben, setAngaben] = useState<MessmittelAngaben | null>(null);
  const [offen, setOffen] = useState(false);
  const [notiz, setNotiz] = useState<string | null>(null);

  useEffect(() => {
    let aktiv = true;
    setAngaben(null);
    api.geraetMessmittel(geraetId).then(
      (a) => aktiv && setAngaben(messmittelLesbar(a) ? a : null),
      () => aktiv && setAngaben(null),
    );
    return () => {
      aktiv = false;
    };
  }, [geraetId]);

  if (!angaben) return null;
  const tag = heute ?? new Date().toISOString().slice(0, 10);
  const zeilen = blattZeilen(angaben, tag);
  const hersteller = herstellerZeilen(angaben);

  return (
    <section className="vp-rahmen-block vp-mm" data-testid="messmittel-blatt" aria-labelledby="vp-mm-titel">
      <h3 id="vp-mm-titel">
        <Icon name="shield" size={14} />
        {UEMS_MESSMITTEL}
      </h3>
      <p className="vp-mm-kopf">
        <span>
          Am Einbau erhoben · <b>{angaben.einbau_kennzeichen}</b>
        </span>
        {angaben.zustand === 'nicht_erhoben' && <Badge variant="off">{UEMS_NICHT_ERHOBEN}</Badge>}
      </p>
      <dl className="vp-mm-zeilen">
        {zeilen.map((z) => (
          <div key={z.schluessel} className={z.offen ? 'vp-mm-zeile is-offen' : 'vp-mm-zeile'} data-testid={`messmittel-${z.schluessel.split('-')[0]}`}>
            <dt>{z.label}</dt>
            <dd>
              <span>{z.wert}</span>
              {z.hinweis && <span className={z.hinweis.startsWith('abgelaufen') ? 'vp-mm-hinweis is-abgelaufen' : 'vp-mm-hinweis'}>{z.hinweis}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {hersteller.length > 0 && (
        <>
          <h4 className="vp-mm-unter">Laut Hersteller (Katalog)</h4>
          <dl className="vp-mm-zeilen" data-testid="messmittel-hersteller">
            {hersteller.map((z) => (
              <div key={z.schluessel} className={z.offen ? 'vp-mm-zeile is-offen' : 'vp-mm-zeile'}>
                <dt>{z.label}</dt>
                <dd>
                  <span>{z.wert}</span>
                  {z.hinweis && <span className="vp-mm-hinweis">{z.hinweis}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="vp-mm-leise">Eine Genauigkeit der Messkette wird nicht gerechnet — jede Angabe steht einzeln.</p>
      <div className="vp-mm-fuss">
        <Recht aktion="messmittel.angaben">
          <Button variant="ghost" size="sm" iconLeft={<Icon name="pencil" size={14} />} onClick={() => setOffen(true)} data-testid="messmittel-eintragen">
            Angaben eintragen
          </Button>
        </Recht>
      </div>
      {notiz && (
        <p className="vp-mm-notiz" role="status">
          {notiz}
        </p>
      )}
      <p className="vp-mm-grenze">{UEMS_NORMGRENZE}</p>
      {offen && (
        <MessmittelDialog
          angaben={angaben}
          onClose={() => setOffen(false)}
          onGespeichert={(a) => {
            setAngaben(a);
            setOffen(false);
            setNotiz('Die Angaben sind eingetragen und stehen im Protokoll dieses Geräts.');
          }}
        />
      )}
    </section>
  );
}

/**
 * Der Dialog „Messmittel eintragen“ (§5.4 Nr. 1): Klasse, Prüfungsart, Datum, gültig bis; Beleg mit
 * Bezeichnung, Ablage und „Datei wählen“ → die SHA-256 entsteht HIER im Browser, gesendet wird nur sie (G2).
 */
export function MessmittelDialog({
  angaben,
  onClose,
  onGespeichert,
}: {
  angaben: MessmittelAngaben;
  onClose: () => void;
  onGespeichert: (a: MessmittelAngaben) => void;
}) {
  const basis = `mm-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<MessmittelEntwurf>(() => entwurfAus(angaben));
  const [dateiName, setDateiName] = useState<string | null>(null);
  const [rechnet, setRechnet] = useState(false);
  const [feldFehler, setFeldFehler] = useState<{ feld: string; satz: string } | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (teil: Partial<MessmittelEntwurf>) => setE((alt) => ({ ...alt, ...teil }));

  async function dateiGewaehlt(liste: FileList | null) {
    const datei = liste?.[0];
    if (!datei) return;
    setRechnet(true);
    try {
      const sha = await pruefsummeLokal(datei);
      setDateiName(datei.name);
      setze({ belegSha256: sha, belegBezeichnung: e.belegBezeichnung || datei.name });
    } finally {
      setRechnet(false);
    }
  }

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const r = eintragAus(e, angaben);
    if ('fehler' in r) {
      setFeldFehler(r.fehler);
      return;
    }
    setFeldFehler(null);
    setBusy(true);
    setSatz(null);
    try {
      onGespeichert(await api.geraetMessmittelEintragen(angaben.geraet_id, r.eintrag));
    } catch (err) {
      setSatz(messmittelAblehnung(err));
    } finally {
      setBusy(false);
    }
  }

  const fehlerAn = (feld: string) => (feldFehler?.feld === feld ? feldFehler.satz : undefined);

  return (
    <Modal
      open
      onClose={onClose}
      title="Messmittel eintragen"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy || rechnet} data-testid="messmittel-speichern">
            Eintragen
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-mm-form" noValidate onSubmit={(ev) => void senden(ev)} data-testid="messmittel-dialog">
        <p className="vp-mm-leise">
          {angaben.kennzeichen} · Einbau {angaben.einbau_kennzeichen}. Leere Felder bleiben „{UEMS_NICHT_ERHOBEN}“ — nichts wird geschätzt.
        </p>
        <Input id={`${basis}-klasse`} label="Genauigkeitsklasse" value={e.klasse} onChange={(ev) => setze({ klasse: ev.target.value })} placeholder="etwa B (MID) oder 1" />
        <VpPicker id={`${basis}-art`} label="Prüfungsart" options={PRUEFUNGSART_OPTIONEN} value={e.pruefungsart} onChange={(v) => setze({ pruefungsart: v as MessmittelEntwurf['pruefungsart'] })} />
        <div className="vp-mm-paar">
          <VpDatePicker label="Geprüft am" value={e.pruefungAm} onChange={(v) => setze({ pruefungAm: v })} />
          <VpDatePicker label="Gültig bis" value={e.gueltigBis} onChange={(v) => setze({ gueltigBis: v })} min={e.pruefungAm || undefined} error={fehlerAn('gueltig_bis')} />
        </div>
        <fieldset className="vp-mm-beleg">
          <legend>Beleg</legend>
          <p className="vp-mm-leise">
            Ein Beleg ist ein Verweis: Bezeichnung, wo er bei Ihnen liegt, und seine Prüfsumme. Die Datei wird nicht hochgeladen — das Portal bildet die Prüfsumme auf Ihrem Gerät.
          </p>
          <Input id={`${basis}-bez`} label="Bezeichnung" value={e.belegBezeichnung} onChange={(ev) => setze({ belegBezeichnung: ev.target.value })} error={fehlerAn('beleg_bezeichnung')} />
          <Input id={`${basis}-ablage`} label="Ablage bei Ihnen" value={e.belegAblage} onChange={(ev) => setze({ belegAblage: ev.target.value })} placeholder="etwa Ordner Netzrechnung" />
          <label className="vp-mm-datei" htmlFor={`${basis}-datei`}>
            <span className="vp-mm-datei-knopf">
              <Icon name="file-text" size={14} />
              Datei wählen
            </span>
            <input id={`${basis}-datei`} type="file" onChange={(ev) => void dateiGewaehlt(ev.target.files)} data-testid="messmittel-datei" />
          </label>
          <p className="vp-mm-summe" data-testid="messmittel-pruefsumme" aria-live="polite">
            {rechnet
              ? 'Prüfsumme wird auf Ihrem Gerät gebildet …'
              : e.belegSha256
                ? `Prüfsumme ${pruefsummeKurz(e.belegSha256)}${dateiName ? ` aus „${dateiName}“ — die Datei bleibt auf Ihrem Gerät.` : ' (eingetragen)'}`
                : 'Noch keine Datei gewählt.'}
          </p>
          {fehlerAn('beleg_datei') && (
            <p className="vp-alert vp-alert-err" role="alert">
              {fehlerAn('beleg_datei')}
            </p>
          )}
        </fieldset>
        {angaben.wandler.map((w) => (
          <Input
            key={w.fassung}
            id={`${basis}-w-${w.fassung}`}
            label={`Klasse ${w.art === 'wandler_strom' ? 'Stromwandler' : 'Spannungswandler'} (ab ${w.gueltig_ab.slice(8, 10)}.${w.gueltig_ab.slice(5, 7)}.${w.gueltig_ab.slice(0, 4)})`}
            value={e.wandler[w.fassung] ?? ''}
            onChange={(ev) => setze({ wandler: { ...e.wandler, [w.fassung]: ev.target.value } })}
          />
        ))}
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
      </form>
    </Modal>
  );
}
