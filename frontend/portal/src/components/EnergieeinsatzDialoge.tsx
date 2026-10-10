import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type Bezugsgroesse, type EnergieTraeger, type Energieeinsatz, type EnergieeinsatzVorschlag, type Prozess } from '../api';
import { benutzerApi, type BenutzerEintrag } from '../benutzer';
import {
  ABBRECHEN,
  ablehnung,
  ANLEGEN_KNOPF,
  ANLEGEN_TITEL,
  BEARBEITEN_TITEL,
  BEENDEN_KNOPF,
  BEENDEN_SATZ,
  BEENDEN_TITEL,
  bezugsgroesseOptionen,
  EINFLUSS_ARTEN,
  einflussAnfrage,
  einflussEntwurf,
  EINFLUSSGROESSEN,
  einsatzAnfrage,
  einsatzOk,
  einsatzPruefen,
  heute,
  leererEntwurf,
  namensVorschlag,
  neuerEinfluss,
  PROZESS,
  PROZESS_GRUPPEN,
  prozessOptionen,
  SPEICHERN,
  tag,
  TRAEGER,
  TRAEGER_ALLE,
  VERANTWORTLICH,
  verantwortlichOptionen,
  VERBRAUCHER,
  VERSUCHEN,
  type EinflussEntwurf,
  type EinsatzEntwurf,
  type EinsatzPruefung,
} from '../bewertung';
import { UEMS_NORMGRENZE } from '../glossar';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

/**
 * Die Dialoge eines Energieeinsatzes (UEMS AP-16 IP-6): anlegen, bearbeiten, beenden. Anlegen und Bearbeiten teilen
 * ein Formular; Prozess und Träger stehen nur beim Anlegen (sie SIND die Identität des Einsatzes). Beim Bearbeiten geht
 * nur, was sich geändert hat, an seine Route — jede Änderung steht danach mit Akteur im Protokoll.
 *
 * Die Kataloge (Prozesse, Vorschläge, Benutzer, Bezugsgrößen) liest nur der offene Dialog; kein Cache. Eine Ablehnung
 * der Route steht als Satz im Dialog (B1: „zweiter laufender Einsatz“ nennt den laufenden).
 */

interface Kataloge {
  prozesse: Prozess[];
  vorschlaege: EnergieeinsatzVorschlag[];
  /** `null` = die Benutzerliste ist für dieses Konto nicht lesbar — dann kein Picker, sondern ein Satz. */
  benutzer: BenutzerEintrag[] | null;
  bezugsgroessen: Bezugsgroesse[];
}

function useKataloge(mitProzessen: boolean) {
  const [daten, setDaten] = useState<Kataloge | null>(null);
  const [fehler, setFehler] = useState(false);
  const [versuch, setVersuch] = useState(0);
  useEffect(() => {
    let aktiv = true;
    setFehler(false);
    Promise.all([
      mitProzessen ? api.prozesse().then((p) => p.prozesse) : Promise.resolve([] as Prozess[]),
      mitProzessen ? api.energieeinsatzVorschlaege().then((v) => v.vorschlaege) : Promise.resolve([] as EnergieeinsatzVorschlag[]),
      benutzerApi.liste().catch(() => null),
      api.bezugsgroessen().then((b) => b.bezugsgroessen, () => [] as Bezugsgroesse[]),
    ]).then(
      ([prozesse, vorschlaege, benutzer, bezugsgroessen]) => aktiv && setDaten({ prozesse, vorschlaege, benutzer, bezugsgroessen }),
      () => aktiv && setFehler(true),
    );
    return () => {
      aktiv = false;
    };
  }, [mitProzessen, versuch]);
  return { daten, fehler, erneut: () => setVersuch((v) => v + 1) };
}

function Einflussgroessen({
  basis,
  einfluesse,
  setze,
  bezugsgroessen,
  fehler,
}: {
  basis: string;
  einfluesse: EinflussEntwurf[];
  setze: (e: EinflussEntwurf[]) => void;
  bezugsgroessen: Bezugsgroesse[];
  fehler: Record<number, string>;
}) {
  const optionen = bezugsgroesseOptionen(bezugsgroessen);
  const aendere = (i: number, teil: Partial<EinflussEntwurf>) => setze(einfluesse.map((e, j) => (j === i ? { ...e, ...teil } : e)));
  return (
    <fieldset className="vp-bw-gruppe" data-testid="einsatz-einfluesse">
      <legend>{EINFLUSSGROESSEN}</legend>
      <p className="vp-bw-leise">Was den Verbrauch treibt: eine Bezugsgröße aus Ihren Daten oder ein Wortlaut.</p>
      {einfluesse.map((e, i) => (
        <div key={i} className="vp-bw-einfluss">
          <VpPicker
            id={`${basis}-einfluss-art-${i}`}
            label="Art"
            options={EINFLUSS_ARTEN.map((a) => ({ value: a.wert, label: a.label }))}
            value={e.art}
            onChange={(v) => aendere(i, { art: v as EinflussEntwurf['art'] })}
          />
          <div className="vp-bw-schalter" role="radiogroup" aria-label="Quelle der Einflussgröße">
            {(['bezugsgroesse', 'wortlaut'] as const).map((q) => (
              <label key={q} className={e.quelle === q ? 'is-gewaehlt' : ''}>
                <input type="radio" name={`${basis}-quelle-${i}`} checked={e.quelle === q} onChange={() => aendere(i, { quelle: q })} />
                {q === 'bezugsgroesse' ? 'Bezugsgröße' : 'Wortlaut'}
              </label>
            ))}
          </div>
          {e.quelle === 'bezugsgroesse' ? (
            <VpPicker
              id={`${basis}-einfluss-bg-${i}`}
              label="Bezugsgröße"
              options={optionen}
              value={e.bezugsgroesseId}
              onChange={(v) => aendere(i, { bezugsgroesseId: v })}
              placeholder={optionen.length === 0 ? 'Noch keine Bezugsgröße angelegt' : 'Bezugsgröße wählen'}
              error={fehler[i]}
            />
          ) : (
            <Input
              id={`${basis}-einfluss-text-${i}`}
              label="Wortlaut"
              value={e.wortlaut}
              onChange={(ev) => aendere(i, { wortlaut: ev.target.value })}
              placeholder="z. B. Außentemperatur"
              error={fehler[i]}
            />
          )}
          <Button variant="ghost" size="sm" onClick={() => setze(einfluesse.filter((_, j) => j !== i))} aria-label={`Einflussgröße ${i + 1} entfernen`}>
            Entfernen
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setze([...einfluesse, neuerEinfluss()])} data-testid="einfluss-plus">
        Einflussgröße hinzufügen
      </Button>
    </fieldset>
  );
}

function Formular({
  basis,
  entwurf,
  setze,
  daten,
  einsaetze,
  zeigen,
  mitProzess,
}: {
  basis: string;
  entwurf: EinsatzEntwurf;
  setze: (teil: Partial<EinsatzEntwurf>) => void;
  daten: Kataloge;
  einsaetze: readonly Energieeinsatz[];
  zeigen: EinsatzPruefung;
  mitProzess: boolean;
}) {
  const prozesse = prozessOptionen(daten.prozesse, daten.vorschlaege, einsaetze, entwurf.traeger);
  return (
    <>
      {mitProzess && (
        <>
          <VpPicker
            id={`${basis}-prozess`}
            label={PROZESS}
            options={prozesse}
            groups={PROZESS_GRUPPEN}
            value={entwurf.prozessId}
            onChange={(v) => {
              const p = daten.prozesse.find((x) => x.id === v);
              setze({ prozessId: v, ...(entwurf.name.trim() ? {} : { name: namensVorschlag(p, entwurf.traeger) }) });
            }}
            placeholder={prozesse.length === 0 ? 'Noch kein Prozess angelegt' : 'Prozess wählen'}
            hint="Die Messstellen des Einsatzes sind die des Prozesses."
            error={zeigen.prozess}
          />
          <VpPicker
            id={`${basis}-traeger`}
            label={TRAEGER}
            options={TRAEGER_ALLE.map((t) => ({ value: t, label: t, sub: t === 'Strom' ? null : 'im Umfang, ohne Anteil' }))}
            value={entwurf.traeger}
            onChange={(v) => setze({ traeger: v as EnergieTraeger })}
          />
        </>
      )}
      <Input id={`${basis}-name`} label="Name" value={entwurf.name} onChange={(e) => setze({ name: e.target.value })} error={zeigen.name} />
      <Input
        id={`${basis}-verbraucher`}
        label={VERBRAUCHER}
        value={entwurf.verbraucher}
        onChange={(e) => setze({ verbraucher: e.target.value })}
        placeholder="z. B. Spritzgießmaschinen 1–6 mit Temperiergeräten"
        hint="Im Wortlaut — welche Geräte und Anlagen der Einsatz umfasst."
      />
      {daten.benutzer === null ? (
        <p className="vp-bw-leise">Die Personen Ihres Kundenbereichs sind gerade nicht abrufbar — Verantwortlich bleibt, wie es ist.</p>
      ) : (
        <VpPicker
          id={`${basis}-verantwortlich`}
          label={VERANTWORTLICH}
          options={[{ value: '', label: 'noch niemand' }, ...verantwortlichOptionen(daten.benutzer)]}
          value={entwurf.verantwortlichSub ?? ''}
          onChange={(v) => setze({ verantwortlichSub: v || null })}
          hint="Eine Zuständigkeit, kein Recht: die Person darf dadurch nicht mehr als vorher."
        />
      )}
      <Einflussgroessen
        basis={basis}
        einfluesse={entwurf.einfluesse}
        setze={(einfluesse) => setze({ einfluesse })}
        bezugsgroessen={daten.bezugsgroessen}
        fehler={zeigen.einfluesse}
      />
    </>
  );
}

const ersterFehler = (basis: string, p: EinsatzPruefung) => {
  const i = Object.keys(p.einfluesse).map(Number)[0];
  const id = p.prozess ? `${basis}-prozess` : p.name ? `${basis}-name` : i !== undefined ? `${basis}-einfluss-bg-${i}` : null;
  if (!id) return;
  const el = document.getElementById(id) ?? document.getElementById(`${basis}-einfluss-text-${i}`);
  (el?.querySelector('button, input') as HTMLElement | null ?? el)?.focus();
};

export function EnergieeinsatzAnlegenDialog({
  einsaetze,
  onClose,
  onAngelegt,
}: {
  einsaetze: readonly Energieeinsatz[];
  onClose: () => void;
  onAngelegt: (e: Energieeinsatz) => void;
}) {
  const basis = `ea-${useId().replace(/:/g, '')}`;
  const { daten, fehler, erneut } = useKataloge(true);
  const [entwurf, setEntwurf] = useState<EinsatzEntwurf>(leererEntwurf);
  const [zeigen, setZeigen] = useState<EinsatzPruefung>({ einfluesse: {} });
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (teil: Partial<EinsatzEntwurf>) => setEntwurf((e) => ({ ...e, ...teil }));

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const p = einsatzPruefen(entwurf);
    setZeigen(p);
    if (!einsatzOk(p)) return ersterFehler(basis, p);
    setBusy(true);
    setSatz(null);
    try {
      onAngelegt(await api.energieeinsatzAnlegen(einsatzAnfrage(entwurf)));
    } catch (e) {
      const prozess = daten?.prozesse.find((x) => x.id === entwurf.prozessId);
      setSatz(ablehnung(e, { prozess, traeger: entwurf.traeger, einsaetze }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={ANLEGEN_TITEL}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy || !daten} data-testid="einsatz-anlegen-senden">
            {ANLEGEN_KNOPF}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="einsatz-anlegen">
        {fehler ? (
          <div className="vp-alert vp-alert-err" role="alert">
            <span>Prozesse und Personen konnten nicht geladen werden.</span>
            <Button variant="outline" size="sm" onClick={erneut}>
              {VERSUCHEN}
            </Button>
          </div>
        ) : !daten ? (
          <p className="vp-bw-leise" aria-busy="true">
            Lädt …
          </p>
        ) : (
          <Formular basis={basis} entwurf={entwurf} setze={setze} daten={daten} einsaetze={einsaetze} zeigen={zeigen} mitProzess />
        )}
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert" data-testid="einsatz-ablehnung">
            {satz}
          </p>
        )}
        <p className="vp-bw-grenze">{UEMS_NORMGRENZE}</p>
      </form>
    </Modal>
  );
}

export function EnergieeinsatzBearbeitenDialog({
  einsatz,
  onClose,
  onGespeichert,
}: {
  einsatz: Energieeinsatz;
  onClose: () => void;
  onGespeichert: (e: Energieeinsatz) => void;
}) {
  const basis = `eb-${useId().replace(/:/g, '')}`;
  const { daten, fehler, erneut } = useKataloge(false);
  const start = useRef<EinsatzEntwurf>({
    ...leererEntwurf(),
    prozessId: einsatz.prozess.id,
    traeger: einsatz.traeger,
    name: einsatz.name,
    verbraucher: einsatz.verbraucher_wortlaut ?? '',
    verantwortlichSub: einsatz.verantwortlich.sub ?? null,
    einfluesse: einsatz.einflussgroessen.map(einflussEntwurf),
  });
  const [entwurf, setEntwurf] = useState<EinsatzEntwurf>(start.current);
  const [zeigen, setZeigen] = useState<EinsatzPruefung>({ einfluesse: {} });
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (teil: Partial<EinsatzEntwurf>) => setEntwurf((e) => ({ ...e, ...teil }));

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    const p = einsatzPruefen(entwurf, false);
    setZeigen(p);
    if (!einsatzOk(p)) return ersterFehler(basis, p);
    const a = start.current;
    setBusy(true);
    setSatz(null);
    try {
      let e = einsatz;
      if (entwurf.name.trim() !== a.name || entwurf.verbraucher.trim() !== a.verbraucher)
        e = await api.energieeinsatzBearbeiten(einsatz.id, {
          name: entwurf.name.trim(),
          wortlaut: einsatz.wortlaut ?? null,
          verbraucher_wortlaut: entwurf.verbraucher.trim() || null,
        });
      if (daten?.benutzer !== null && entwurf.verantwortlichSub !== a.verantwortlichSub)
        e = await api.energieeinsatzVerantwortlicher(einsatz.id, entwurf.verantwortlichSub);
      if (JSON.stringify(entwurf.einfluesse.map(einflussAnfrage)) !== JSON.stringify(a.einfluesse.map(einflussAnfrage)))
        e = await api.energieeinsatzEinflussgroessen(einsatz.id, entwurf.einfluesse.map(einflussAnfrage));
      onGespeichert(e);
    } catch (err) {
      setSatz(ablehnung(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={BEARBEITEN_TITEL}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy || !daten}>
            {SPEICHERN}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="einsatz-bearbeiten">
        <p className="vp-bw-leise">
          {einsatz.kennzeichen} · {PROZESS} {einsatz.prozess.kennzeichen} {einsatz.prozess.name} · {einsatz.traeger} — Prozess und Träger bleiben; für einen
          anderen beenden Sie diesen Einsatz und legen einen neuen an.
        </p>
        {fehler ? (
          <div className="vp-alert vp-alert-err" role="alert">
            <span>Personen und Bezugsgrößen konnten nicht geladen werden.</span>
            <Button variant="outline" size="sm" onClick={erneut}>
              {VERSUCHEN}
            </Button>
          </div>
        ) : !daten ? (
          <p className="vp-bw-leise" aria-busy="true">
            Lädt …
          </p>
        ) : (
          <Formular basis={basis} entwurf={entwurf} setze={setze} daten={daten} einsaetze={[]} zeigen={zeigen} mitProzess={false} />
        )}
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function EnergieeinsatzBeendenDialog({
  einsatz,
  onClose,
  onBeendet,
}: {
  einsatz: Energieeinsatz;
  onClose: () => void;
  onBeendet: (e: Energieeinsatz) => void;
}) {
  const basis = `eq-${useId().replace(/:/g, '')}`;
  const [grund, setGrund] = useState('');
  const [bis, setBis] = useState(heute());
  const [zeigen, setZeigen] = useState<string | null>(null);
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden(ev: FormEvent) {
    ev.preventDefault();
    if (!grund.trim()) {
      setZeigen('Bitte geben Sie einen Grund an.');
      document.getElementById(`${basis}-grund`)?.focus();
      return;
    }
    setBusy(true);
    setSatz(null);
    try {
      onBeendet(await api.energieeinsatzBeenden(einsatz.id, { grund: grund.trim(), gueltig_bis: bis }));
    } catch (e) {
      setSatz(ablehnung(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={BEENDEN_TITEL}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy}>
            {BEENDEN_KNOPF}
          </Button>
        </>
      }
    >
      <form id={`${basis}-form`} className="vp-bw-form" noValidate onSubmit={(e) => void senden(e)} data-testid="einsatz-beenden">
        <p className="vp-bw-leise">
          {einsatz.kennzeichen} {einsatz.name} läuft seit {tag(einsatz.gueltig_ab)}. {BEENDEN_SATZ}
        </p>
        <Input id={`${basis}-grund`} label="Grund" value={grund} onChange={(e) => setGrund(e.target.value)} error={zeigen} />
        <VpDatePicker label="Letzter Tag" value={bis} onChange={setBis} min={einsatz.gueltig_ab} />
        {satz && (
          <p className="vp-alert vp-alert-err" role="alert">
            {satz}
          </p>
        )}
      </form>
    </Modal>
  );
}
