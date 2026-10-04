import { useState } from 'react';
import { Recht } from './Recht';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { VpDatePicker } from './VpDatePicker';
import { api, ApiError } from '../api';
import {
  einordnungAus,
  einordnungSatz,
  faehigkeitFehlerText,
  type FaehigkeitAnfrage,
  type LadepunktAnsicht,
} from '../ladepunktErtraege';
import './LadepunktFaehigkeitDialog.css';

/** Der Satz, den der Dialog immer trägt: die Fähigkeit des Autos meldet die Wallbox, nie „nein“ vorab (BK-41). */
export const AUTO_PRUEFT_SATZ = 'Ob ein Auto zurückspeisen kann, prüft die Wallbox beim Anstecken.';

/**
 * **Was kann dieser Ladepunkt?** — der Installateur trägt in Anlage › Aufbau ein, ob der Ladepunkt nur lädt oder auch
 * zurückspeist, wohin (V2H/V2G), ob die Rückspeisung bei Netzeinspeisung stoppt, die höchste Rückspeiseleistung und ab
 * welchem Tag (MP-41a, BK-41 „in allen Varianten gleich“; Datenmodell und Regeln MP-31). Ein Umbau ab einem Tag, kein
 * Schalter: an dem Tag beginnt ein Rumpfmonat (A1 S. 102).
 */
export function LadepunktFaehigkeitDialog({
  siteId,
  ladepunkt,
  heute,
  onClose,
  onGespeichert,
}: {
  siteId: string;
  ladepunkt: LadepunktAnsicht;
  /** ISO-Tag von heute (Vorgabe für „Gilt ab“). */
  heute: string;
  onClose: () => void;
  onGespeichert: (neu: LadepunktAnsicht) => void;
}) {
  const f = ladepunkt.faehigkeit;
  const [bidirektional, setBidirektional] = useState(f.nutzbarkeit === 'bidirektional');
  const [v2h, setV2h] = useState(f.nutzbarkeit === 'bidirektional' ? f.v2h : true);
  const [v2g, setV2g] = useState(f.nutzbarkeit === 'bidirektional' ? f.v2g : false);
  const [unterbunden, setUnterbunden] = useState(f.rueckspeisung_bei_einspeisung_unterbunden);
  const [leistung, setLeistung] = useState(f.rueckspeiseleistung_kw != null ? String(f.rueckspeiseleistung_kw).replace('.', ',') : '');
  const [gueltigAb, setGueltigAb] = useState<string | null>(heute);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const anfrage = (): FaehigkeitAnfrage | string => {
    if (!gueltigAb) return 'Bitte geben Sie den Tag an, ab dem die Angabe gilt.';
    if (!bidirektional) {
      return {
        nutzbarkeit: 'unidirektional',
        v2h: false,
        v2g: false,
        rueckspeisung_bei_einspeisung_unterbunden: false,
        rueckspeiseleistung_kw: null,
        gueltig_ab: gueltigAb,
      };
    }
    if (!v2h && !v2g) return faehigkeitFehlerText('faehigkeit_ungueltig', 'betriebsweise');
    const roh = leistung.trim().replace(',', '.');
    const kw = roh === '' ? null : Number(roh);
    if (kw != null && (!Number.isFinite(kw) || kw <= 0 || kw > 1000)) {
      return faehigkeitFehlerText('faehigkeit_ungueltig', 'rueckspeiseleistung');
    }
    return {
      nutzbarkeit: 'bidirektional',
      v2h,
      v2g,
      rueckspeisung_bei_einspeisung_unterbunden: !v2g && unterbunden,
      rueckspeiseleistung_kw: kw,
      gueltig_ab: gueltigAb,
    };
  };

  const speichern = async () => {
    const a = anfrage();
    if (typeof a === 'string') {
      setFehler(a);
      return;
    }
    setBusy(true);
    setFehler(null);
    try {
      const neu = await api.ladepunktFaehigkeitSetzen(siteId, ladepunkt.komponente, a);
      onGespeichert(neu);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string; grund?: string } | undefined) : undefined;
      setFehler(faehigkeitFehlerText(body?.code, body?.grund));
    } finally {
      setBusy(false);
    }
  };

  const vorschau = einordnungAus({
    nutzbarkeit: bidirektional ? 'bidirektional' : 'unidirektional',
    v2h: bidirektional && v2h,
    v2g: bidirektional && v2g,
    rueckspeisung_bei_einspeisung_unterbunden: bidirektional && !v2g && unterbunden,
  });
  const z2 = ladepunkt.z2[0] ?? null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${ladepunkt.name} · Zurückspeisen`}
      icon={<Icon name="zap" size={20} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Recht aktion="geraet.einrichten">
            <Button onClick={() => void speichern()} disabled={busy}>
              Speichern
            </Button>
          </Recht>
        </>
      }
    >
      <div className="vp-form-stack vp-lpf">
        <div>
          <p className="vp-lpf-label" id="lpf-was">
            Was kann dieser Ladepunkt?
          </p>
          <div className="vp-seg vp-lpf-seg" role="radiogroup" aria-labelledby="lpf-was">
            {[
              { wert: false, text: 'Nur laden' },
              { wert: true, text: 'Laden und zurückspeisen' },
            ].map((o) => (
              <button
                key={o.text}
                type="button"
                role="radio"
                aria-checked={bidirektional === o.wert}
                className={bidirektional === o.wert ? 'active' : undefined}
                onClick={() => setBidirektional(o.wert)}
              >
                {o.text}
              </button>
            ))}
          </div>
        </div>

        {bidirektional && (
          <>
            <fieldset className="vp-lpf-wohin">
              <legend className="vp-lpf-label">Wohin?</legend>
              <label className="vp-lpf-check">
                <input type="checkbox" checked={v2h} onChange={(e) => setV2h(e.target.checked)} />
                <span>
                  <b>Ins Haus (V2H)</b>
                  <small>das Auto versorgt das Haus</small>
                </span>
              </label>
              <label className="vp-lpf-check">
                <input
                  type="checkbox"
                  checked={v2g}
                  onChange={(e) => {
                    setV2g(e.target.checked);
                    if (e.target.checked) setUnterbunden(false);
                  }}
                />
                <span>
                  <b>Ins Netz (V2G)</b>
                  <small>Überschuss geht ins Netz</small>
                </span>
              </label>
              <label className={`vp-lpf-check${v2g ? ' is-aus' : ''}`}>
                <input type="checkbox" checked={!v2g && unterbunden} disabled={v2g} onChange={(e) => setUnterbunden(e.target.checked)} />
                <span>
                  <b>Rückspeisen stoppen, sobald Strom ins Netz fließt</b>
                  <small>nur ohne V2G — dann zählt der Ladepunkt nicht wie ein Speicher (A1 S. 27, Fn. 22)</small>
                </span>
              </label>
            </fieldset>
            <Input
              label="Höchste Rückspeiseleistung (kW)"
              inputMode="decimal"
              value={leistung}
              onChange={(e) => setLeistung(e.target.value)}
              placeholder="nicht bekannt"
              hint="Leer lassen, wenn sie nicht bekannt ist."
            />
          </>
        )}

        <VpDatePicker
          label="Gilt ab"
          value={gueltigAb}
          onChange={setGueltigAb}
          hint="Ein Umbau ab einem Tag, kein Schalter: An diesem Tag beginnt ein Rumpfmonat (A1 S. 102)."
        />

        <div className={`vp-lpf-hinweis${vorschau === 'ladepunkt_der_festlegung' ? ' is-ok' : ''}`} data-einordnung={vorschau}>
          <Icon name={vorschau === 'ladepunkt_der_festlegung' ? 'check' : 'info'} size={18} />
          <span>
            <b>{einordnungSatz(vorschau)}</b>
            {vorschau === 'ladepunkt_der_festlegung' && z2 && (
              <> Zähler am Ladepunkt: Z2 „{z2.messstelle}“{z2.eichstatus ? ` · ${z2.eichstatus.replace(/_/g, ' ')}` : ''}{z2.eichfrist_bis ? ` bis ${z2.eichfrist_bis.slice(0, 4)}` : ''}{z2.urteil ? ` · ${z2.urteil.replace(/_/g, ' ')}` : ''}.</>
            )}
          </span>
        </div>
        {ladepunkt.befunde.length > 0 && (
          <ul className="vp-lpf-befunde" aria-label="Was VoltPilot dazu sieht">
            {ladepunkt.befunde.map((b) => (
              <li key={b.code + (b.messstelle ?? '')} className={`is-${b.schwere}`}>
                {b.satz} <small>({b.fundstelle})</small>
              </li>
            ))}
          </ul>
        )}
        <p className="vp-note">{AUTO_PRUEFT_SATZ}</p>
        {fehler && (
          <div className="vp-alert vp-alert-err" role="alert">
            {fehler}
          </div>
        )}
      </div>
    </Modal>
  );
}
