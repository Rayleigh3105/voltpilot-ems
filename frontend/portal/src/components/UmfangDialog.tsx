import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, ApiError, type BewertungUmfang, type EnergieTraeger, type Prozess } from '../api';
import {
  ABBRECHEN,
  anlagenText,
  heute,
  SPEICHERN,
  tag,
  TRAEGER_ALLE,
  UMFANG_TITEL,
  umfangAnfrage,
  umfangEntwurf,
  umfangOk,
  umfangPruefen,
  type UmfangEntwurf,
  type UmfangPruefung,
} from '../bewertung';
import { UEMS_NORMGRENZE } from '../glossar';
import type { VpOption } from '../picker/optionen';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

/**
 * Der Umfang der Bewertung (UEMS AP-16 IP-6, U1/U2): Standorte (Vorgabe alle), Träger (Vorgabe Strom; weitere „im
 * Umfang, ohne Anteil“), Ausschlüsse mit Pflicht-Begründung. Speichern = eine neue Fassung ab dem gewählten Tag; die
 * Route antwortet mit derselben Fassung, wenn sich nichts geändert hat. Die Anlagenzahl ist die der Route (nur y) —
 * einen Nenner in kWh gibt es hier nicht (IP-9).
 */
export function UmfangDialog({
  umfang,
  onClose,
  onGespeichert,
}: {
  umfang: BewertungUmfang;
  onClose: () => void;
  onGespeichert: (u: BewertungUmfang) => void;
}) {
  const basis = `bu-${useId().replace(/:/g, '')}`;
  const heuteTag = heute();
  const [entwurf, setEntwurf] = useState<UmfangEntwurf>(() => umfangEntwurf(umfang, heuteTag));
  const [zeigen, setZeigen] = useState<UmfangPruefung>({ ausschluesse: {} });
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prozesse, setProzesse] = useState<Prozess[]>([]);
  const setze = (teil: Partial<UmfangEntwurf>) => setEntwurf((e) => ({ ...e, ...teil }));

  useEffect(() => {
    let aktiv = true;
    api.prozesse(heuteTag).then((p) => aktiv && setProzesse(p.prozesse), () => undefined);
    return () => {
      aktiv = false;
    };
  }, [heuteTag]);

  // Ausschließen lässt sich eine Anlage eines gewählten Standorts oder ein Prozess.
  const ziele: VpOption[] = [
    ...umfang.standorte
      .filter((s) => entwurf.standortIds.includes(s.id))
      .flatMap((s) => s.anlagen_im_umfang.map((a) => ({ value: `anlage:${a.id}`, label: a.name, sub: s.name, group: 'anlage' }))),
    ...prozesse.map((p) => ({ value: `prozess:${p.id}`, label: p.name, sub: p.kennzeichen, group: 'prozess' })),
  ];

  const umschalten = <T,>(liste: T[], wert: T) => (liste.includes(wert) ? liste.filter((x) => x !== wert) : [...liste, wert]);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const p = umfangPruefen(entwurf);
    setZeigen(p);
    if (!umfangOk(p)) {
      const i = Object.keys(p.ausschluesse).map(Number)[0];
      const id = p.standorte ? `${basis}-standorte` : p.traeger ? `${basis}-traeger` : i !== undefined ? `${basis}-aus-grund-${i}` : null;
      const el = id ? document.getElementById(id) : null;
      (el?.querySelector('input') ?? el)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onGespeichert(await api.bewertungUmfangSpeichern(umfangAnfrage(entwurf)));
    } catch (e) {
      setSatz(
        e instanceof ApiError && e.status === 403
          ? 'Den Umfang legen Kundenadministratoren und Energiemanager fest.'
          : e instanceof ApiError && e.message
            ? e.message
            : 'Der Umfang konnte nicht gespeichert werden.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={UMFANG_TITEL}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="umfang-speichern">
            {SPEICHERN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="umfang-dialog">
        <p className="vp-bw-leise">
          {umfang.fassung === null
            ? 'Speichern legt Fassung 1 an. Vorgabe: alle Standorte, Träger Strom.'
            : `Heute gilt Fassung ${umfang.fassung} seit ${tag(umfang.gueltig_ab)}. Speichern legt eine neue Fassung an; die alte bleibt lesbar.`}
        </p>
        <fieldset className="vp-bw-gruppe" id={`${basis}-standorte`}>
          <legend>Standorte</legend>
          {umfang.standorte.map((s) => (
            <label key={s.id} className="vp-bw-wahl">
              <input
                type="checkbox"
                checked={entwurf.standortIds.includes(s.id)}
                onChange={() => setze({ standortIds: umschalten(entwurf.standortIds, s.id) })}
              />
              <span>{s.name}</span>
              <span className="vp-bw-leise">{anlagenText(s.anzahl_anlagen_im_umfang)}</span>
            </label>
          ))}
          {zeigen.standorte && (
            <p className="vp-bw-feldfehler" role="alert">
              {zeigen.standorte}
            </p>
          )}
        </fieldset>
        <fieldset className="vp-bw-gruppe" id={`${basis}-traeger`}>
          <legend>Träger</legend>
          {TRAEGER_ALLE.map((t) => (
            <label key={t} className="vp-bw-wahl">
              <input
                type="checkbox"
                checked={entwurf.traeger.includes(t)}
                onChange={() => setze({ traeger: umschalten<EnergieTraeger>(entwurf.traeger, t) })}
              />
              <span>{t}</span>
              <span className="vp-bw-leise">{t === 'Strom' ? 'mit Anteil' : 'im Umfang, ohne Anteil'}</span>
            </label>
          ))}
          {zeigen.traeger && (
            <p className="vp-bw-feldfehler" role="alert">
              {zeigen.traeger}
            </p>
          )}
        </fieldset>
        <fieldset className="vp-bw-gruppe" data-testid="umfang-ausschluesse-dialog">
          <legend>Ausschlüsse</legend>
          {entwurf.ausschluesse.length === 0 && <p className="vp-bw-leise">Keine — alles an den gewählten Standorten zählt.</p>}
          {entwurf.ausschluesse.map((a, i) => (
            <div key={i} className="vp-bw-einfluss">
              <VpPicker
                id={`${basis}-aus-ziel-${i}`}
                label="Was"
                options={ziele}
                groups={[
                  { key: 'anlage', label: 'Anlagen' },
                  { key: 'prozess', label: 'Prozesse' },
                ]}
                value={a.verweis ? `${a.art}:${a.verweis}` : null}
                onChange={(v) => {
                  const [art, verweis] = v.split(':') as [UmfangEntwurf['ausschluesse'][number]['art'], string];
                  setze({ ausschluesse: entwurf.ausschluesse.map((x, j) => (j === i ? { ...x, art, verweis } : x)) });
                }}
              />
              <Input
                id={`${basis}-aus-grund-${i}`}
                label="Begründung"
                value={a.begruendung}
                onChange={(e) =>
                  setze({ ausschluesse: entwurf.ausschluesse.map((x, j) => (j === i ? { ...x, begruendung: e.target.value } : x)) })
                }
                error={zeigen.ausschluesse[i]}
              />
              <Button variant="ghost" size="sm" onClick={() => setze({ ausschluesse: entwurf.ausschluesse.filter((_, j) => j !== i) })}>
                Entfernen
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            iconLeft={<Icon name="plus" size={16} />}
            onClick={() => setze({ ausschluesse: [...entwurf.ausschluesse, { art: 'anlage', verweis: '', begruendung: '' }] })}
          >
            Ausschluss hinzufügen
          </Button>
        </fieldset>
        <VpDatePicker
          label="Gültig ab"
          value={entwurf.gueltigAb}
          onChange={(v) => setze({ gueltigAb: v })}
          min={umfang.gueltig_ab}
          error={zeigen.gueltigAb}
        />
        <Input
          id={`${basis}-begruendung`}
          label="Anlass (freiwillig)"
          value={entwurf.begruendung}
          onChange={(e) => setze({ begruendung: e.target.value })}
          placeholder="z. B. Erstbewertung 2026"
        />
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
        <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}
