import { useEffect, useId, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Input } from '../../designsystem/components/forms/Input';
import { Modal } from '../../designsystem/components/shell/Modal';
import { api, type EnergiemanagementPerson, type EnergiemanagementPersonMitVerlauf, type EnergiemanagementZuordnung } from '../api';
import { benutzerApi } from '../benutzer';
import { VOKABULARE, WOERTER } from '../energiemanagement';
import * as E from '../energiemanagementPortal';
import { UEMS_ENTSCHIEDEN_VON, UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import { Begruendung, Formular, PersonAnlegenDialog, VerweisFelder } from './DokumentDialoge';
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

const ABBRECHEN = 'Abbrechen';

/** Ablehnung, Verantwortungs- und Grenz-Satz am Fuß jedes Dialogs (SP4) — ein Dialog ist eine eigene Fläche. */
function Fuss({ satz }: { satz: string | null }) {
  return (
    <>
      {satz && (
        <p className="vp-ez-fehler" role="alert" data-testid="energiemanagement-ablehnung">
          {satz}
        </p>
      )}
      <p className="vp-ez-grenze">{UEMS_VERANTWORTUNG}</p>
      <p className="vp-ez-grenze">{UEMS_NORMGRENZE}</p>
    </>
  );
}

const personOption = (p: EnergiemanagementPerson) => ({
  value: p.id,
  label: p.name,
  sub: `${p.funktion}${p.konto ? '' : ' · ohne Konto'}`,
});

/**
 * Aufgabe zuordnen (UEMS AP-19 IP-13, PA2): Aufgabe × Person × gilt ab, wahlfrei Vertretung, Beleg als Verweis und
 * Beschluss; „entschieden von“ ist eine Person im Energiemanagement und Pflicht außer bei „Leitung des Unternehmens“.
 * Nur anhängen — eine Übergabe ist „Zuordnung beenden“ plus eine neue Zuordnung ab dem Folgetag.
 */
export function AufgabeZuordnenDialog({
  aufgabe,
  ab,
  onClose,
  onZugeordnet,
}: {
  /** Vorbelegt aus der Zeile („keine Person festgelegt“ → zuordnen). */
  aufgabe: string | null;
  ab: string;
  onClose: () => void;
  onZugeordnet: (z: EnergiemanagementZuordnung) => void;
}) {
  const basis = `az-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState<E.ZuordnenEntwurf>({
    aufgabe: aufgabe ?? '', wortlaut: '', personId: '', giltAb: ab, vertretungId: '', entschiedenVon: '', begruendung: '',
    beleg: E.LEERER_VERWEIS, beschluss: '',
  });
  const [personen, setPersonen] = useState<EnergiemanagementPerson[] | null>(null);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [personDialog, setPersonDialog] = useState(false);
  const setze = (t: Partial<E.ZuordnenEntwurf>) => setE((alt) => ({ ...alt, ...t }));
  const laden = () =>
    api.energiemanagementPersonen().then(
      (r) => setPersonen(r.personen.filter((p) => p.zustand === 'aktiv')),
      (err) => setSatz(E.ablehnungSatz(err)),
    );
  useEffect(() => {
    void laden();
  }, []);
  const optionen = (personen ?? []).map(personOption);
  const leitung = e.aufgabe === 'unternehmensleitung';

  async function senden() {
    const r = E.zuordnenKoerper(e);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onZugeordnet(await api.energiemanagementAufgabeZuordnen(r.koerper));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open={!personDialog}
        onClose={onClose}
        title={E.KNOPF_ZUORDNEN}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {ABBRECHEN}
            </Button>
            <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="zuordnen-senden">
              {E.KNOPF_ZUORDNEN}
            </Button>
          </>
        }
      >
        <Formular id={`${basis}-form`} testid="zuordnen-dialog" onSubmit={() => void senden()}>
          <VpPicker
            id={`${basis}-aufgabe`}
            label="Aufgabe"
            options={VOKABULARE.aufgabe.map((a) => ({ value: a, label: WOERTER.aufgabe[a] }))}
            value={e.aufgabe || null}
            onChange={(a) => setze({ aufgabe: a })}
            placeholder="Aufgabe wählen"
            error={fehler.aufgabe ?? null}
          />
          {e.aufgabe === 'weitere' && (
            <Input id={`${basis}-wortlaut`} label="Welche Aufgabe" value={e.wortlaut} onChange={(ev) => setze({ wortlaut: ev.target.value })} error={fehler.wortlaut ?? null} />
          )}
          <VpPicker
            id={`${basis}-person`}
            label="Person"
            options={optionen}
            value={e.personId || null}
            onChange={(personId) => setze({ personId })}
            placeholder="Person wählen"
            loading={personen === null}
            hint="Eine Person im Energiemanagement, auch ohne Konto."
            error={fehler.personId ?? null}
          />
          <div className="vp-em-paar">
            <VpDatePicker label="gilt ab" value={e.giltAb || null} onChange={(giltAb) => setze({ giltAb })} error={fehler.giltAb ?? null} />
            <VpPicker
              id={`${basis}-vertretung`}
              label="Vertretung (wahlfrei)"
              options={[{ value: '', label: 'keine Vertretung' }, ...optionen.filter((o) => o.value !== e.personId)]}
              value={e.vertretungId}
              onChange={(vertretungId) => setze({ vertretungId })}
              loading={personen === null}
              error={fehler.vertretungId ?? null}
            />
          </div>
          <VpPicker
            id={`${basis}-entschieden`}
            label={leitung ? `${UEMS_ENTSCHIEDEN_VON} (wahlfrei)` : UEMS_ENTSCHIEDEN_VON}
            options={optionen}
            value={e.entschiedenVon || null}
            onChange={(entschiedenVon) => setze({ entschiedenVon })}
            placeholder="Person wählen"
            loading={personen === null}
            hint={leitung ? 'Die Leitung des Unternehmens braucht kein „entschieden von“.' : 'Wer die Aufgabe übertragen hat — meist die Leitung.'}
            error={fehler.entschiedenVon ?? null}
          />
          <Button variant="ghost" onClick={() => setPersonDialog(true)} data-testid="zuordnen-person-anlegen">
            {E.KNOPF_PERSON}
          </Button>
          <Begruendung id={`${basis}-begruendung`} wert={e.begruendung} setze={(begruendung) => setze({ begruendung })} fehler={fehler.begruendung} pflicht />
          <VerweisFelder basis={`${basis}-beleg`} titel="Beleg (wahlfrei), etwa die Bestellung" wert={e.beleg} setze={(beleg) => setze({ beleg })} mitFassung={false} fehler={fehler.beleg} />
          <Input
            id={`${basis}-beschluss`}
            label="Beschluss (wahlfrei)"
            value={e.beschluss}
            onChange={(ev) => setze({ beschluss: ev.target.value })}
            placeholder="etwa BR-2029-0001/B4"
            error={fehler.beschluss ?? null}
          />
          <Fuss satz={satz} />
        </Formular>
      </Modal>
      {personDialog && (
        <PersonAnlegenDialog
          leitung={false}
          ab={ab}
          onClose={() => setPersonDialog(false)}
          onAngelegt={(p) => {
            setPersonDialog(false);
            void laden().then(() => setE((alt) => ({ ...alt, personId: alt.personId || p.id })));
          }}
        />
      )}
    </>
  );
}

/** Zuordnung beenden (PA2): der letzte Tag zählt mit, Begründung Pflicht; die Zeile bleibt lesbar. */
export function ZuordnungBeendenDialog({
  zuordnung,
  ab,
  onClose,
  onBeendet,
}: {
  zuordnung: EnergiemanagementZuordnung;
  ab: string;
  onClose: () => void;
  onBeendet: (z: EnergiemanagementZuordnung) => void;
}) {
  const basis = `ab-${useId().replace(/:/g, '')}`;
  const [e, setE] = useState({ giltBis: ab, begruendung: '' });
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function senden() {
    const r = E.beendenKoerper(e, zuordnung.gilt_ab);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onBeendet(await api.energiemanagementAufgabeBeenden(zuordnung.id, r.koerper));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={E.KNOPF_BEENDEN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="beenden-senden">
            {E.KNOPF_BEENDEN}
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="beenden-dialog" onSubmit={() => void senden()}>
        <p className="vp-ez-satz">
          {zuordnung.wort}: {zuordnung.person.name} seit {E.tagText(zuordnung.gilt_ab)}.
        </p>
        <VpDatePicker label="letzter Tag" value={e.giltBis || null} onChange={(giltBis) => setE((alt) => ({ ...alt, giltBis }))} min={zuordnung.gilt_ab} error={fehler.giltBis ?? null} />
        <p className="vp-ez-leise">Wer übernimmt, bekommt danach eine neue Zuordnung ab dem Folgetag.</p>
        <Begruendung id={`${basis}-begruendung`} wert={e.begruendung} setze={(begruendung) => setE((alt) => ({ ...alt, begruendung }))} fehler={fehler.begruendung} pflicht />
        <Fuss satz={satz} />
      </Formular>
    </Modal>
  );
}

/**
 * Angaben einer Person ändern (PA1, PA5): der ganze Stand — ein Konto verknüpfen, wechseln oder lösen und „bis“
 * (beendet die Person endgültig) verlangen eine Begründung. Die Konten liest der Dialog aus der Benutzerverwaltung,
 * wenn sie lesbar ist; sonst bleibt das Konto, wie es ist.
 */
export function PersonAendernDialog({
  person,
  onClose,
  onGeaendert,
}: {
  person: EnergiemanagementPerson;
  onClose: () => void;
  onGeaendert: (p: EnergiemanagementPersonMitVerlauf) => void;
}) {
  const basis = `pa-${useId().replace(/:/g, '')}`;
  const bisher = person.konto?.sub ?? null;
  const [e, setE] = useState<E.PersonAendernEntwurf>({
    name: person.name, funktion: person.funktion, kuerzel: person.kuerzel ?? '', organisation: person.organisation ?? '',
    kontoSub: bisher ?? '', seit: person.seit ?? '', bis: '', begruendung: '',
  });
  const [konten, setKonten] = useState<{ value: string; label: string; sub?: string }[] | null>(null);
  const [fehler, setFehler] = useState<E.Feldfehler>({});
  const [satz, setSatz] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setze = (t: Partial<E.PersonAendernEntwurf>) => setE((alt) => ({ ...alt, ...t }));
  useEffect(() => {
    benutzerApi.liste().then(
      (liste) => setKonten(liste.map((b) => ({ value: b.sub, label: b.anzeigename, sub: b.email }))),
      () => setKonten([]),
    );
  }, []);
  const kontoOptionen = [
    { value: '', label: 'ohne Konto' },
    ...(konten ?? []),
    ...(bisher && !(konten ?? []).some((k) => k.value === bisher) ? [{ value: bisher, label: person.konto?.name ?? 'bisheriges Konto' }] : []),
  ];

  async function senden() {
    const r = E.personAendernKoerper(e, bisher);
    if ('fehler' in r) return setFehler(r.fehler ?? {});
    setFehler({});
    setBusy(true);
    setSatz(null);
    try {
      onGeaendert(await api.energiemanagementPersonAendern(person.id, r.koerper));
    } catch (err) {
      setSatz(E.ablehnungSatz(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={E.KNOPF_PERSON_AENDERN}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {ABBRECHEN}
          </Button>
          <Button type="submit" form={`${basis}-form`} disabled={busy} data-testid="person-aendern-senden">
            Speichern
          </Button>
        </>
      }
    >
      <Formular id={`${basis}-form`} testid="person-aendern-dialog" onSubmit={() => void senden()}>
        <Input id={`${basis}-name`} label="Name" value={e.name} onChange={(ev) => setze({ name: ev.target.value })} error={fehler.name ?? null} />
        <Input id={`${basis}-funktion`} label="Funktion" value={e.funktion} onChange={(ev) => setze({ funktion: ev.target.value })} error={fehler.funktion ?? null} />
        <div className="vp-em-paar">
          <Input id={`${basis}-kuerzel`} label="Kürzel (wahlfrei)" value={e.kuerzel} onChange={(ev) => setze({ kuerzel: ev.target.value })} error={fehler.kuerzel ?? null} />
          <Input id={`${basis}-organisation`} label="Organisation (wahlfrei)" value={e.organisation} onChange={(ev) => setze({ organisation: ev.target.value })} />
        </div>
        <VpPicker
          id={`${basis}-konto`}
          label="Konto"
          options={kontoOptionen}
          value={e.kontoSub}
          onChange={(kontoSub) => setze({ kontoSub })}
          loading={konten === null}
          hint="Wer sich anmeldet, braucht ein Konto; als „entschieden von“ genügt die Person."
        />
        <div className="vp-em-paar">
          <VpDatePicker label="seit (wahlfrei)" value={e.seit || null} onChange={(seit) => setze({ seit })} />
          <VpDatePicker label="bis (beendet die Person)" value={e.bis || null} onChange={(bis) => setze({ bis })} error={fehler.bis ?? null} />
        </div>
        <Begruendung
          id={`${basis}-begruendung`}
          wert={e.begruendung}
          setze={(begruendung) => setze({ begruendung })}
          fehler={fehler.begruendung}
          pflicht={(e.kontoSub || null) !== bisher || !!e.bis}
        />
        <Fuss satz={satz} />
      </Formular>
    </Modal>
  );
}
