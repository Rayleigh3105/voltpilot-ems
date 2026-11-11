import { UnterstuetzungAdmin } from './UnterstuetzungAdmin';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../../designsystem/components/core/Badge';
import { Button } from '../../../designsystem/components/core/Button';
import { Card } from '../../../designsystem/components/core/Card';
import { Icon } from '../../../designsystem/components/core/Icon';
import { IconTile } from '../../../designsystem/components/core/IconTile';
import { Input } from '../../../designsystem/components/forms/Input';
import { Modal } from '../../../designsystem/components/shell/Modal';
import { VpPicker } from '../../components/VpPicker';
import { StartpasswortAnzeige } from '../../components/StartpasswortAnzeige';
import { AufklapperKarte } from '../../components/AufklapperKarte';
import { benutzerApi, benutzerFehler, KUNDENROLLEN, unternehmensrolle, type BenutzerAnlage, type BenutzerEintrag } from '../../benutzer';
import { ROLLE_BESCHREIBUNG } from '../../components/BenutzerEinladen';
import { ApiError, ablehnungCode, api, neueAnfrageKennung, type SelbstauskunftKundenbereichBeendet, type Site } from '../../api';
import {
  anlagenBoxenZeilen,
  datumDe,
  fristAbgelaufen,
  kundenZahlenText,
  kundenZustand,
  personenListe,
  type AnlageBoxZeile,
  type KundenPerson,
} from '../../admin/kundenakte';
import { fleetApi } from '../../admin/fleetApi';
import type { AdminFleetSite } from '../../admin/fleetApi';
import {
  adminApi,
  type AdminUser,
  type KundeLoeschbarkeit,
  type Tenant,
  type TenantOffboardingReport,
} from '../../admin/adminApi';
import { KundeLoeschenDialog } from './KundeLoeschenDialog';
import { CreateSiteDrawer } from '../../components/CreateSiteDrawer';
import { DangerZone } from '../../components/DangerZone';
import { EmptyState, ErrorState, TableSkeleton, TextSkeleton } from '../../components/States';
import { AdminPageHead } from './AdminPageHead';
import { BoxLoesenDialog } from './BoxLoesenDialog';
import { EditUserDrawer, ResetPasswordDialog } from './UserDrawers';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RowMenu } from '../../components/RowMenu';
import './Mandanten.css';
import { geraeteAkteHash, mandantAusHash, mandantHash, type PageId } from '../../nav';

/**
 * Plattform → Benutzer (Admin-Umbau Scheibe S5, Konzept `vp-adminview-konzept-k1`
 * §4.5/§4.7, E5 = A): die Kundenliste und die Kundenakte. Beide bleiben hier -
 * der PageId `mandanten` und dem Dateinamen - die Route steht seit S1 unter
 * `#/plattform/benutzer[/{tenantId}]` (siehe {@link mandantHash}).
 *
 * Die Kundenakte zeigt Konto UND Rolle einer Person in EINER Liste
 * (`../../admin/kundenakte` fügt die zwei vorhandenen Antworten zusammen -
 * kein neuer Endpoint); Anlagen, Boxen, Zugriff und Vertrag sind Einstiege
 * bzw. Karten in derselben Seite statt eines eigenen Fensters.
 */
export function MandantenPage({
  tenants,
  onReloadTenants,
  onJumpToTenant,
  tenantsLoaded = true,
  tenantsError = false,
}: {
  tenants: Tenant[];
  onReloadTenants: (selectId?: string) => void;
  onJumpToTenant: (tenantId: string, page: PageId) => void;
  /**
   * false = die Mandantenliste ist noch nicht geladen. „Fehlend ist keine
   * Null": der Leer-Zustand „Noch keine Mandanten" erscheint erst NACH einer
   * erfolgreichen Antwort, davor steht ein Tabellen-Skelett.
   */
  tenantsLoaded?: boolean;
  /**
   * true = der letzte Mandanten-Abruf ist gescheitert. Dann KEIN Endlos-Skelett,
   * sondern ein ehrlicher Fehler-Zustand mit „Erneut laden", das den
   * Mandanten-Abruf WIRKLICH wiederholt (Review SOLLTE-3).
   */
  tenantsError?: boolean;
}) {
  // Der geöffnete Kunde ist eine eigene Seite mit Adresse (`#/plattform/benutzer/<id>`),
  // kein Dialog: Personen, Anlagen, Zugriff und Vertrag brauchen Platz.
  const [detailId, setDetailId] = useState<string | null>(() => mandantAusHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setDetailId(mandantAusHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const detail = detailId ? tenants.find((t) => t.id === detailId) ?? null : null;

  function oeffne(t: Tenant) {
    setDetailId(t.id);
    window.location.hash = mandantHash(t.id);
    window.scrollTo?.({ top: 0 });
  }
  function zurueck() {
    const zuletzt = detailId;
    setDetailId(null);
    window.location.hash = mandantHash(null);
    // Zurück auf die Zeile, aus der man kam (Tastatur und Bildschirmleser verlieren den Ort nicht).
    requestAnimationFrame(() => {
      if (zuletzt) document.querySelector<HTMLElement>(`[data-mandant="${zuletzt.replace(/["\\]/g, '')}"]`)?.focus();
    });
  }

  if (detailId) {
    if (detail) {
      return (
        <KundenaktePage
          key={detail.id}
          tenant={detail}
          onClose={zurueck}
          onJumpToTenant={onJumpToTenant}
          onChanged={(t) => onReloadTenants(t?.id)}
          onDeleted={() => {
            zurueck();
            onReloadTenants();
          }}
        />
      );
    }
    return (
      <>
        <ZurueckZuMandanten onClick={zurueck} />
        <Card padding="lg" radius="lg">
          {tenantsError ? (
            <ErrorState message="Die Mandantenliste ließ sich gerade nicht laden. Bitte versuchen Sie es erneut." onRetry={() => onReloadTenants()} />
          ) : !tenantsLoaded ? (
            <TextSkeleton lines={4} />
          ) : (
            <EmptyState icon="building" category="industry" title="Kunde nicht gefunden" description="Diesen Kunden gibt es nicht (mehr)." action={<Button variant="outline" onClick={zurueck}>Alle Kunden</Button>} />
          )}
        </Card>
      </>
    );
  }

  return (
    <KundenlisteSeite
      tenants={tenants}
      tenantsLoaded={tenantsLoaded}
      tenantsError={tenantsError}
      onReloadTenants={onReloadTenants}
      onOeffnen={oeffne}
    />
  );
}

/**
 * Kundenliste (§4.5): Kunden mit Personenzahl, Anlagen und Boxen, Zustand; die
 * Suche findet Kunden UND Personen - über die schon geladenen Konten UND
 * serverseitig über ALLE Kunden (`adminApi.personensuche`, Lücke L6). „Neuer
 * Kunde" fügt eine Eingabezeile ein, kein Fenster (E1 = A).
 */
function KundenlisteSeite({
  tenants,
  tenantsLoaded,
  tenantsError,
  onReloadTenants,
  onOeffnen,
}: {
  tenants: Tenant[];
  tenantsLoaded: boolean;
  tenantsError: boolean;
  onReloadTenants: (selectId?: string) => void;
  onOeffnen: (t: Tenant) => void;
}) {
  const [neuOffen, setNeuOffen] = useState(false);
  const [suche, setSuche] = useState('');
  const [fleet, setFleet] = useState<AdminFleetSite[] | null>(null);
  const [unterstuetzungBis, setUnterstuetzungBis] = useState<Record<string, string> | null>(null);
  // Je Mandant: `undefined` = noch nicht geladen, sonst das Ergebnis (oder `'fehler'`).
  const [konten, setKonten] = useState<Record<string, AdminUser[] | 'fehler'>>({});
  const [vertragsende, setVertragsende] = useState<Record<string, SelbstauskunftKundenbereichBeendet | null | 'fehler'>>({});
  // vp-kunde-sofort-loeschen: EIN Abruf für alle Zeilen - „sofort löschbar" (Badge) und das Zeilen-Menü.
  const [loeschbarkeit, setLoeschbarkeit] = useState<Record<string, KundeLoeschbarkeit>>({});
  const [loeschenTenant, setLoeschenTenant] = useState<Tenant | null>(null);
  const [geloeschtMeldung, setGeloeschtMeldung] = useState<string | null>(null);
  // L6 (S6): serverseitige Personensuche über ALLE Kunden ergänzt die lokale
  // Suche über die schon geladenen `konten` - findet so auch Personen eines
  // Mandanten, dessen Kontoliste noch nicht geladen ist.
  const [sucheTenantIds, setSucheTenantIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void fleetApi.fleet().then((f) => {
      setFleet(f.sites);
      setUnterstuetzungBis(f.unterstuetzungBis ?? null);
    }).catch(() => { setFleet([]); setUnterstuetzungBis(null); });
  }, []);

  useEffect(() => {
    void adminApi.kundenLoeschbarkeit()
      .then((liste) => setLoeschbarkeit(Object.fromEntries(liste.map((l) => [l.tenantId, l]))))
      .catch(() => setLoeschbarkeit({}));
    // Nach jedem Nachladen der Liste (etwa nach einem Löschen) frisch.
  }, [tenants]);

  // Personenzahl und Vertragsende kommen bis zur Lesemodell-Scheibe S6 (L6) aus
  // den VORHANDENEN Einzel-Antworten je Mandant - bewusst N Aufrufe statt eines
  // neuen Endpoints, jeder füllt seine Zeile unabhängig (kein Warten auf alle).
  useEffect(() => {
    for (const t of tenants) {
      if (!(t.id in konten)) {
        void adminApi.listUsers(t.id)
          .then((u) => setKonten((k) => ({ ...k, [t.id]: u })))
          .catch(() => setKonten((k) => ({ ...k, [t.id]: 'fehler' })));
      }
      if (!(t.id in vertragsende)) {
        void api.selbstauskunft(t.id)
          .then((s) => setVertragsende((v) => ({ ...v, [t.id]: s.kundenbereich?.beendet ?? null })))
          .catch(() => setVertragsende((v) => ({ ...v, [t.id]: 'fehler' })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants]);

  useEffect(() => {
    const q = suche.trim();
    if (q === '') { setSucheTenantIds(new Set()); return; }
    let live = true;
    const t = window.setTimeout(() => {
      void adminApi.personensuche(q)
        .then((treffer) => { if (live) setSucheTenantIds(new Set(treffer.map((p) => p.tenantId).filter((id): id is string => id != null))); })
        .catch(() => { if (live) setSucheTenantIds(new Set()); });
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [suche]);

  const zeilen = useMemo(() => tenants.map((t) => {
    const anlagen = fleet?.filter((s) => s.tenantId === t.id) ?? null;
    const boxen = anlagen?.reduce((sum, s) => sum + s.deviceCount, 0) ?? null;
    const bis = unterstuetzungBis?.[t.id] ?? null;
    const vende = vertragsende[t.id];
    return {
      tenant: t,
      anzahlAnlagen: anlagen?.length ?? null,
      anzahlBoxen: boxen,
      anzahlPersonen: konten[t.id] === 'fehler' ? null : konten[t.id]?.length ?? undefined,
      sofortLoeschbar: loeschbarkeit[t.id]?.sofortLoeschbar === true,
      zustand: vende === 'fehler'
        ? null
        : kundenZustand(vende, bis ? new Date(bis).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) : null,
            loeschbarkeit[t.id]?.sofortLoeschbar === true),
    };
  }), [tenants, fleet, unterstuetzungBis, konten, vertragsende, loeschbarkeit]);

  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase();
    if (!q) return zeilen;
    return zeilen.filter(({ tenant }) => {
      if (tenant.name.toLowerCase().includes(q)) return true;
      if (sucheTenantIds.has(tenant.id)) return true;
      const liste = konten[tenant.id];
      return Array.isArray(liste) && liste.some((u) =>
        u.username.toLowerCase().includes(q)
        || (u.email ?? '').toLowerCase().includes(q)
        || [u.firstName, u.lastName].filter(Boolean).join(' ').toLowerCase().includes(q));
    });
  }, [zeilen, suche, konten, sucheTenantIds]);

  const personenGesamt = Object.values(konten).reduce((sum, k) => sum + (Array.isArray(k) ? k.length : 0), 0);

  const addButton = (
    <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setNeuOffen(true)}>
      Neuer Kunde
    </Button>
  );

  return (
    <>
      <AdminPageHead
        icon="building"
        category="industry"
        title="Benutzer"
        description={
          tenants.length > 0
            ? `${tenants.length} Kunden · ${personenGesamt} Personen`
            : 'Eine Zeile öffnet die Kundenakte - Personen, Anlagen, Zugriff und Vertrag.'
        }
        actions={addButton}
      />

      {geloeschtMeldung && (
        <div className="vp-alert vp-alert-ok" role="status" style={{ marginBottom: 'var(--vp-space-4)' }}>
          {geloeschtMeldung}
        </div>
      )}

      {!neuOffen && (
        <Input
          type="search"
          aria-label="Kunde oder Person suchen"
          placeholder="Kunde oder Person suchen …"
          value={suche}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSuche(e.target.value)}
          style={{ marginBottom: 'var(--vp-space-4)', maxWidth: '24rem' }}
        />
      )}

      {tenantsError && tenants.length === 0 ? (
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Die Mandantenliste ließ sich gerade nicht laden. Bitte versuchen Sie es erneut."
            onRetry={() => onReloadTenants()}
          />
        </Card>
      ) : !tenantsLoaded && tenants.length === 0 ? (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <TableSkeleton rows={4} cols={5} />
        </Card>
      ) : tenants.length === 0 && !neuOffen ? (
        <Card padding="lg" radius="lg">
          <EmptyState
            icon="building"
            category="industry"
            title="Noch keine Kunden"
            description="Legen Sie den ersten Kunden an, um Personen und Anlagen auf der Plattform zu verwalten."
            action={addButton}
          />
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <table className="vp-table responsive vp-zeilen vp-kundenliste">
            <thead>
              <tr>
                <th>Kunde</th>
                <th>Personen</th>
                <th>Anlagen</th>
                <th>Boxen</th>
                <th>Zustand</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {neuOffen && (
                <NeuerKundeZeile
                  tenants={tenants}
                  onAbbrechen={() => setNeuOffen(false)}
                  onAngelegt={(t) => {
                    setNeuOffen(false);
                    onReloadTenants(t.id);
                  }}
                />
              )}
              {gefiltert.map((z) => (
                <tr key={z.tenant.id} className="clickable" onClick={() => onOeffnen(z.tenant)}>
                  <td data-label="Kunde" data-zeile="haupt">
                    <span className="vp-kundenliste-name">
                      <b>{z.tenant.name}</b>
                      <Badge variant="tint">{segmentLabel(z.tenant.segment)}</Badge>
                    </span>
                  </td>
                  {/* Am Telefon stehen die drei Zahlen als EINE Zeile unter dem Namen statt drei Etikett-Zeilen. */}
                  <td className="vp-zeilen-telefon" data-zeile="neben">{kundenZahlenText(z)}</td>
                  <td data-label="Personen" data-zeile="breit">{z.anzahlPersonen ?? <span className="vp-muted">…</span>}</td>
                  <td data-label="Anlagen" data-zeile="breit">{z.anzahlAnlagen ?? <span className="vp-muted">…</span>}</td>
                  <td data-label="Boxen" data-zeile="breit">{z.anzahlBoxen ?? <span className="vp-muted">…</span>}</td>
                  <td data-label="Zustand" data-zeile="marke">
                    {z.zustand ? <Badge variant={z.zustand.ton} dot>{z.zustand.text}</Badge> : <span className="vp-muted">…</span>}
                  </td>
                  <td data-label="" data-zeile="aktion" style={{ textAlign: 'right' }}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    {/* Zeilen-Menü nur, wenn der Server „sofort löschbar" meldet (vp-kunde-sofort-loeschen). */}
                    {z.sofortLoeschbar && (
                      <RowMenu
                        label={`Weitere Aktionen für ${z.tenant.name}`}
                        items={[{
                          label: 'Kunde endgültig löschen …', icon: 'trash', danger: true,
                          onClick: () => setLoeschenTenant(z.tenant),
                        }]}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Details zu ${z.tenant.name}`}
                      data-mandant={z.tenant.id}
                      onClick={() => onOeffnen(z.tenant)}
                    >
                      <span className="vp-zeilen-nur-breit">Details</span> <Icon name="chevron-right" size={16} />
                    </Button>
                  </td>
                </tr>
              ))}
              {gefiltert.length === 0 && tenants.length > 0 && (
                <tr>
                  <td colSpan={6} className="vp-muted" style={{ textAlign: 'center', padding: 'var(--vp-space-5)' }}>
                    Kein Kunde und keine Person passt zu „{suche}".
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      {loeschenTenant && (
        <KundeLoeschenDialog
          open
          tenantId={loeschenTenant.id}
          tenantName={loeschenTenant.name}
          onClose={() => setLoeschenTenant(null)}
          onGeloescht={(report) => {
            setLoeschenTenant(null);
            setGeloeschtMeldung(`Der Kunde „${report.tenantName}" wurde vollständig entfernt`
              + (report.freigegebeneBoxen.length > 0
                ? `; die Box${report.freigegebeneBoxen.length === 1 ? '' : 'en'} ${report.freigegebeneBoxen.join(', ')} `
                  + (report.freigegebeneBoxen.length === 1 ? 'ist' : 'sind') + ' wieder anmeldbar.'
                : '.'));
            onReloadTenants();
          }}
        />
      )}
    </>
  );
}

/**
 * Die Eingabezeile „Neuer Kunde" - inline in der Liste statt eines Fensters (E1 = A).
 *
 * Doppelter Kunde (Befund vp-kundenakte-fremde-personen, Punkt 5): je Formular EINE Anfrage-Kennung
 * (B3) - ein Doppelklick oder das Wiederholen nach einem Netzfehler legt nie zweimal an. Ein Name,
 * den es schon gibt, warnt vor dem Anlegen (Namen sind bewusst nicht eindeutig - zwei Privatkunden
 * dürfen gleich heißen - aber ein Versehen soll sich nicht wie in der Live-Liste verdoppeln).
 */
function NeuerKundeZeile({
  tenants,
  onAbbrechen,
  onAngelegt,
}: {
  tenants: Tenant[];
  onAbbrechen: () => void;
  onAngelegt: (t: Tenant) => void;
}) {
  const [name, setName] = useState('');
  const [segment, setSegment] = useState('CI');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kennung] = useState(() => neueAnfrageKennung());
  const laeuft = useRef(false);

  const gleicherName = useMemo(() => {
    const n = name.trim().toLowerCase();
    return n !== '' && tenants.some((t) => t.name.trim().toLowerCase() === n);
  }, [name, tenants]);

  async function anlegen() {
    if (!name.trim() || laeuft.current) return;
    laeuft.current = true;
    setBusy(true);
    setError(null);
    try {
      const t = await adminApi.createTenant({ name: name.trim(), segment }, kennung);
      onAngelegt(t);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'Ein Kunde mit diesem Namen existiert bereits.'
          : 'Der Kunde konnte nicht angelegt werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      laeuft.current = false;
      setBusy(false);
    }
  }

  return (
    <tr className="vp-kunden-neu-zeile">
      <td colSpan={2}>
        <Input
          aria-label="Name des neuen Kunden"
          placeholder="z. B. Stadtwerke Musterstadt"
          value={name}
          autoFocus
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          // Bei gleichem Namen legt nur der ausdrückliche Knopf „Trotzdem anlegen" an -
          // ein blindes Enter soll die Warnung nicht überspringen.
          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && !gleicherName) void anlegen(); if (e.key === 'Escape') onAbbrechen(); }}
        />
        {gleicherName && (
          <p className="vp-note" role="status" style={{ margin: 'var(--vp-space-2) 0 0' }}>
            Einen Kunden mit diesem Namen gibt es schon. Zwei Kunden dürfen gleich heißen -
            prüfen Sie aber, ob Sie nicht den vorhandenen meinen.
          </p>
        )}
      </td>
      <td colSpan={2}>
        <VpPicker
          id="neuer-kunde-segment"
          ariaLabel="Segment"
          options={[
            { value: 'CI', label: segmentLabel('CI') },
            { value: 'B2C', label: segmentLabel('B2C') },
          ]}
          value={segment}
          onChange={setSegment}
        />
      </td>
      <td colSpan={2} style={{ textAlign: 'right' }}>
        <Button variant="ghost" size="sm" onClick={onAbbrechen} disabled={busy}>Abbrechen</Button>{' '}
        <Button variant="primary" size="sm" onClick={() => void anlegen()} disabled={busy || !name.trim()}>
          {busy ? 'Wird angelegt…' : gleicherName ? 'Trotzdem anlegen' : 'Anlegen'}
        </Button>
      </td>
      {error && (
        <td colSpan={6} className="vp-alert vp-alert-err" style={{ marginTop: 'var(--vp-space-2)' }}>{error}</td>
      )}
    </tr>
  );
}

function KundenaktePage({
  tenant,
  onClose,
  onJumpToTenant,
  onChanged,
  onDeleted,
}: {
  tenant: Tenant;
  onClose: () => void;
  onJumpToTenant: (tenantId: string, page: PageId) => void;
  onChanged: (tenant?: Tenant) => void;
  onDeleted: () => void;
}) {
  const [konten, setKonten] = useState<AdminUser[] | null>(null);
  const [eintraege, setEintraege] = useState<BenutzerEintrag[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [fleetSites, setFleetSites] = useState<AdminFleetSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Load failure kept distinct from action errors (and the loading `null`), so a
  // failed load shows a retryable ErrorState instead of permanent skeletons.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [neuerAdminOffen, setNeuerAdminOffen] = useState(false);
  const [passwort, setPasswort] = useState<string | null>(null);
  // P2: „Person hinzufügen" - weitere Personen, nicht nur die erste (W4 fällt).
  const [personHinzufuegenOffen, setPersonHinzufuegenOffen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  // N6: der Admin vergibt jetzt selbst ein neues Startpasswort (vorher nur der Kundenadministrator).
  const [resetPasswordUser, setResetPasswordUser] = useState<AdminUser | null>(null);
  // `user` ist `null` für eine Person OHNE Konto (nur UEMS-Eintrag): ihr Löschen räumt den Eintrag
  // über denselben Server-Weg ab (Spiegel + Protokoll), ein Konto gibt es nicht mehr zu entfernen.
  const [confirmUser, setConfirmUser] = useState<{ user: AdminUser | null; sub: string; name: string; kind: 'disable' | 'delete' } | null>(null);
  const [siteDrawer, setSiteDrawer] = useState(false);
  // Punkt 7 (Befund vp-kundenakte-fremde-personen): „Vom Kunden lösen" direkt aus der Karte
  // „Anlagen und Boxen" - derselbe Dialog wie in der Geräteakte, der Befund kommt vom Server.
  const [loesenBox, setLoesenBox] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [report, setReport] = useState<TenantOffboardingReport | null>(null);
  // Vertragsende I (N1): `undefined` = noch nicht gelesen, `null` = aktiv.
  const [vertragsende, setVertragsende] = useState<SelbstauskunftKundenbereichBeendet | null | undefined>(undefined);
  const [vertragDialog, setVertragDialog] = useState<'beenden' | 'wiederaufnehmen' | null>(null);
  const [vertragBusy, setVertragBusy] = useState(false);
  const [vertragError, setVertragError] = useState<string | null>(null);
  // vp-kunde-sofort-loeschen: das Server-Urteil „sofort löschbar" (KundeDatenBestand) - speist das
  // Badge, das Kopf-Menü, die Vertrag-Karte und die Gefahrenzone. `undefined` = noch nicht gelesen.
  const [loeschbarkeit, setLoeschbarkeit] = useState<KundeLoeschbarkeit | undefined>(undefined);
  const [loeschenDialog, setLoeschenDialog] = useState(false);

  async function reload() {
    setError(null);
    setLoadError(null);
    try {
      const [k, e, s, f, selbst] = await Promise.all([
        adminApi.listUsers(tenant.id),
        benutzerApi.liste(tenant.id),
        adminApi.listSites(tenant.id),
        fleetApi.fleet(),
        api.selbstauskunft(tenant.id),
      ]);
      setKonten(k);
      setEintraege(e);
      setSites(s);
      setFleetSites(f.sites.filter((fs) => fs.tenantId === tenant.id));
      setVertragsende(selbst.kundenbereich?.beendet ?? null);
    } catch (e) {
      setLoadError(
        e instanceof ApiError ? e.message : 'Die Kundendaten konnten nicht geladen werden.',
      );
    }
    // Getrennt vom Pflicht-Laden: ohne das Urteil bleibt die Akte voll benutzbar,
    // nur Badge-Zusatz und Sofort-Weg fehlen dann.
    try {
      setLoeschbarkeit(await adminApi.kundeLoeschbarkeit(tenant.id));
    } catch {
      setLoeschbarkeit(undefined);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function disable(u: AdminUser) {
    try {
      await adminApi.disableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Deaktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  /**
   * Der Löschweg der stillgelegten Benutzer-Seite, wörtlich übernommen - inkl.
   * der Selbst-Sperre des Servers (409: das eigene Konto ist nicht löschbar).
   * `sub` statt `AdminUser`: auch eine Person OHNE Konto (nur UEMS-Eintrag,
   * etwa nach einem halb gescheiterten Entfernen) ist darüber löschbar.
   * Eine 409 MIT `code` trägt den echten Grund im Körper (etwa
   * `kundenbereich_beendet`) - der Satz des Servers, nicht „eigenes Konto";
   * nur die code-lose Selbst-Sperre behält ihren Satz (ihr Körper trägt keinen).
   */
  async function remove(sub: string) {
    try {
      await adminApi.deleteUser(tenant.id, sub);
      await reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? (ablehnungCode(e) ? e.message : 'Sie können Ihr eigenes Konto nicht löschen.')
          : e instanceof ApiError
            ? `Löschen fehlgeschlagen: ${e.message}`
            : 'Fehler',
      );
    }
  }

  async function enable(u: AdminUser) {
    try {
      await adminApi.enableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Aktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  async function ersterAdminAnlegen(form: { username: string; email: string; firstName: string; lastName: string }) {
    setError(null);
    try {
      const u = await adminApi.createUser(tenant.id, {
        username: form.username.trim(),
        email: form.email.trim(),
        firstName: form.firstName.trim() || undefined,
        lastName: form.lastName.trim() || undefined,
      });
      setPasswort(u.startpasswort);
      await reload();
    } catch (e) {
      throw new Error(benutzerFehler(e));
    }
  }

  /** P2: „Person hinzufügen" - die WEITERE Person (nicht die erste), mit Rolle und Standorten. */
  async function personHinzufuegen(anlage: BenutzerAnlage) {
    const angelegt = await adminApi.createPerson(tenant.id, anlage);
    await reload();
    return angelegt;
  }

  async function offboard() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      setReport(await adminApi.deleteTenant(tenant.id, tenant.name));
    } catch (e) {
      setDeleteError(
        e instanceof ApiError && e.status === 502
          ? 'Die Benutzerverwaltung ist gerade nicht erreichbar - es wurde nichts gelöscht. Bitte versuchen Sie es später erneut.'
          : e instanceof ApiError
            ? `Löschen fehlgeschlagen: ${e.message}`
            : 'Löschen fehlgeschlagen. Es wurde nichts gelöscht.',
      );
    } finally {
      setDeleteBusy(false);
    }
  }

  async function beenden(auftrag: string, begruendung: string, fristTage: number) {
    setVertragBusy(true);
    setVertragError(null);
    try {
      await adminApi.beendenMandant(tenant.id, { auftrag, begruendung, confirmName: tenant.name, fristTage });
      const selbst = await api.selbstauskunft(tenant.id);
      setVertragsende(selbst.kundenbereich?.beendet ?? null);
      setVertragDialog(null);
    } catch (e) {
      setVertragError(e instanceof ApiError ? `Beenden fehlgeschlagen: ${e.message}` : 'Fehler');
    } finally {
      setVertragBusy(false);
    }
  }

  async function wiederaufnehmen(auftrag: string, begruendung: string) {
    setVertragBusy(true);
    setVertragError(null);
    try {
      await adminApi.wiederaufnehmenMandant(tenant.id, { auftrag, begruendung });
      const selbst = await api.selbstauskunft(tenant.id);
      setVertragsende(selbst.kundenbereich?.beendet ?? null);
      setVertragDialog(null);
    } catch (e) {
      setVertragError(e instanceof ApiError ? `Wiederaufnehmen fehlgeschlagen: ${e.message}` : 'Fehler');
    } finally {
      setVertragBusy(false);
    }
  }

  // Offboarding done: show the report instead of the (now gone) tenant data.
  if (report) {
    return (
      <>
        <ZurueckZuMandanten onClick={onDeleted} />
        <AdminPageHead icon="trash" category="industry" title={`Kunde gelöscht: ${report.tenantName}`} />
        <Card padding="lg" radius="lg">
          <div className="vp-alert vp-alert-ok" style={{ marginTop: 0 }}>
            Der Kunde „{report.tenantName}" wurde vollständig entfernt.
          </div>
          <table className="vp-table" style={{ marginTop: 'var(--vp-space-4)' }}>
            <tbody>
              <tr>
                <th scope="row">Anlagen</th>
                <td>{report.deletedSites}</td>
              </tr>
              <tr>
                <th scope="row">Geräte</th>
                <td>{report.deletedDevices}</td>
              </tr>
              <tr>
                <th scope="row">Messpunkte</th>
                <td>{report.deletedTelemetryRows}</td>
              </tr>
              <tr>
                <th scope="row">Gelöschte Benutzer</th>
                <td>{report.deletedUsers.length > 0 ? report.deletedUsers.join(', ') : '-'}</td>
              </tr>
              {report.freigegebeneBoxen?.length > 0 && (
                <tr>
                  <th scope="row">Freigegebene Boxen</th>
                  <td>{report.freigegebeneBoxen.join(', ')} - wieder anmeldbar</td>
                </tr>
              )}
            </tbody>
          </table>
          {report.failedUsers.length > 0 && (
            <div className="vp-alert vp-alert-err">
              Diese Benutzerkonten konnten nicht gelöscht werden und brauchen manuelle
              Nacharbeit: <b>{report.failedUsers.join(', ')}</b>
            </div>
          )}
          <div style={{ marginTop: 'var(--vp-space-4)' }}>
            <Button variant="primary" onClick={onDeleted}>Zu den Kunden</Button>
          </div>
        </Card>
      </>
    );
  }

  const personen: KundenPerson[] | null = konten && eintraege ? personenListe(konten, eintraege) : null;
  const anlagenZeilen: AnlageBoxZeile[] | null = sites && fleetSites ? anlagenBoxenZeilen(sites, fleetSites) : null;
  // Die Zustand-Zeile im Kopf zeigt vorerst nur das Vertragsende; die laufende
  // Unterstützung steht gleich darunter in der Karte „Zugriff" selbst.
  const zustand = kundenZustand(vertragsende, null, loeschbarkeit?.sofortLoeschbar === true);

  const wieDerKundeEsSieht = (
    <Button variant="outline" onClick={() => onJumpToTenant(tenant.id, 'uebersicht')} iconLeft={<Icon name="eye" size={16} />}>
      Wie der Kunde es sieht
    </Button>
  );

  return (
    <>
      <section className="vp-mandant-seite vp-kundenakte" aria-label={tenant.name}>
        <ZurueckZuMandanten onClick={onClose} />

        {/* Kopf: Name, darunter Segment + Zustand und die Stammzeile; die zwei Knöpfe stehen
            am Telefon in EINER Reihe unter dem Namen statt ihn auf 26 px zusammenzudrücken. */}
        <div className="vp-kundenakte-kopf">
          <IconTile category="industry" size={48} className="vp-kundenakte-symbol">
            <Icon name="building" size={24} />
          </IconTile>
          <div className="vp-kundenakte-kopf-mitte">
            {editing ? (
              <TenantEditForm
                tenant={tenant}
                onCancel={() => setEditing(false)}
                onSaved={(t) => {
                  setEditing(false);
                  onChanged(t);
                }}
              />
            ) : (
              <>
                <h1>{tenant.name}</h1>
                <p className="vp-kundenakte-marken">
                  <Badge variant="tint">{segmentLabel(tenant.segment)}</Badge>
                  {vertragsende === undefined ? null : <Badge variant={zustand.ton} dot>{zustand.text}</Badge>}
                </p>
                <p className="vp-kundenakte-unter">
                  {tenant.betriebsart == null ? 'Automatisch' : betriebsartLabel(tenant.betriebsart)}
                  {' · Tarif '}{tenant.plan.toUpperCase()}
                  {' · seit '}{datumKurz(tenant.createdAt)}
                </p>
              </>
            )}
          </div>
          <div className="vp-kundenakte-kopf-rechts">
            {wieDerKundeEsSieht}
            {!editing && (
              <Button variant="ghost" aria-label="Bearbeiten" iconLeft={<Icon name="pencil" size={16} />} onClick={() => setEditing(true)}>
                {/* Am Telefon nur der Stift: beide Knöpfe passen so in eine Reihe. */}
                <span className="vp-zeilen-nur-breit">Bearbeiten</span>
              </Button>
            )}
            {/* Kopf-Menü (vp-kunde-sofort-loeschen): der Löschweg ist immer erreichbar - der Dialog
                erklärt bei einem Kunden mit Daten ruhig, warum er bleibt (nie ein toter Knopf). */}
            {!editing && (
              <RowMenu
                label={`Weitere Aktionen für ${tenant.name}`}
                items={[{
                  label: 'Kunde endgültig löschen …', icon: 'trash', danger: true,
                  onClick: () => setLoeschenDialog(true),
                }]}
              />
            )}
          </div>
        </div>

        {error && <div className="vp-alert vp-alert-err" role="alert">{error}</div>}

        <div className="vp-kundenakte-spalten">
          <Card padding="lg" radius="lg" className="vp-mandant-karte vp-kundenakte-personen">
            <div className="vp-section-head">
              <h2>Personen {personen ? `(${personen.length})` : ''}</h2>
              {personen != null && personen.length > 0 && !personHinzufuegenOffen && !vertragsende && (
                <span className="actions">
                  <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />}
                    onClick={() => setPersonHinzufuegenOffen(true)}>
                    Person hinzufügen
                  </Button>
                </span>
              )}
            </div>
            {loadError ? (
              <ErrorState message={loadError} onRetry={() => void reload()} />
            ) : personen == null ? (
              <TextSkeleton lines={3} />
            ) : personen.length === 0 && !neuerAdminOffen ? (
              <>
                <p className="vp-muted">Noch keine Person für diesen Kunden.</p>
                {!vertragsende && (
                  <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setNeuerAdminOffen(true)}>
                    Ersten Kundenadministrator anlegen
                  </Button>
                )}
              </>
            ) : (
              <table className="vp-table responsive vp-zeilen">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Rolle</th>
                    <th>Konto</th>
                    <th aria-label="Aktionen" />
                  </tr>
                </thead>
                <tbody>
                  {personen.map((p) => (
                    <tr key={p.key}>
                      <td data-label="Person" data-zeile="haupt">
                        <b>{p.name}</b>
                        {/* Ohne Anzeigenamen IST der Name die E-Mail - dann nicht zweimal. */}
                        {p.email && p.email !== p.name && <span className="vp-muted vp-person-mail">{mailMitUmbruch(p.email)}</span>}
                      </td>
                      <td data-label="Rolle" data-zeile="neben">{p.rollenText}</td>
                      <td data-label="Konto" data-zeile="marke">
                        <Badge variant={p.ton} dot>{p.zustandText}</Badge>
                      </td>
                      <td data-label="" data-zeile="aktion" style={{ textAlign: 'right' }}>
                        {/* Beendeter Kunde: jeder Schreibweg außer „Deaktivieren" würde sicher mit 409
                            scheitern (KundenbereichEndeFilter) - also gibt es die Knöpfe gar nicht erst;
                            der Hinweis unter der Tabelle sagt, dass Personen mit dem Kunden gehen. */}
                        {p.konto && vertragsende ? (
                          p.konto.enabled ? (
                            <RowMenu
                              label={`Aktionen für ${p.konto.username}`}
                              items={[
                                { label: 'Deaktivieren', icon: 'x', onClick: () => setConfirmUser({ user: p.konto!, sub: p.konto!.id, name: p.konto!.username, kind: 'disable' }) },
                              ]}
                            />
                          ) : null
                        ) : p.konto ? (
                          <RowMenu
                            label={`Aktionen für ${p.konto.username}`}
                            items={[
                              { label: 'Bearbeiten', icon: 'pencil', onClick: () => setEditUser(p.konto!) },
                              { label: 'Neues Startpasswort', icon: 'refresh-cw', onClick: () => setResetPasswordUser(p.konto!) },
                              p.konto.enabled
                                ? { label: 'Deaktivieren', icon: 'x', onClick: () => setConfirmUser({ user: p.konto!, sub: p.konto!.id, name: p.konto!.username, kind: 'disable' }) }
                                : { label: 'Aktivieren', icon: 'check', onClick: () => enable(p.konto!) },
                              { label: 'Löschen', icon: 'trash', danger: true, onClick: () => setConfirmUser({ user: p.konto!, sub: p.konto!.id, name: p.konto!.username, kind: 'delete' }) },
                            ]}
                          />
                        ) : p.eintrag && !vertragsende ? (
                          // Person OHNE Konto (nur UEMS-Eintrag, eine halb gescheiterte Entfernung):
                          // vorher gab es hier GAR keine Handlung, der Eintrag stand für immer in der
                          // Akte. Löschen räumt ihn mit Protokoll ab wie jede andere Personen-Aktion.
                          <RowMenu
                            label={`Aktionen für ${p.name}`}
                            items={[
                              { label: 'Löschen', icon: 'trash', danger: true, onClick: () => setConfirmUser({ user: null, sub: p.eintrag!.sub, name: p.name, kind: 'delete' }) },
                            ]}
                          />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {personen != null && personen.length > 0 && vertragsende && (
              <p className="vp-muted vp-text-sm" role="note">
                Der Vertrag ist beendet: Personen werden hier nicht mehr einzeln gelöscht oder geändert -
                sie gehen erst mit dem Kunden. Deaktivieren bleibt möglich.
              </p>
            )}
            {neuerAdminOffen && (
              <ErsterAdminFormular
                tenantName={tenant.name}
                passwort={passwort}
                onAbbrechen={() => { setNeuerAdminOffen(false); setPasswort(null); }}
                onAnlegen={ersterAdminAnlegen}
                onFertig={() => { setNeuerAdminOffen(false); setPasswort(null); }}
              />
            )}
            {personHinzufuegenOffen && (
              <PersonHinzufuegenFormular
                sites={sites ?? []}
                onAbbrechen={() => setPersonHinzufuegenOffen(false)}
                onAnlegen={personHinzufuegen}
                onFertig={() => setPersonHinzufuegenOffen(false)}
              />
            )}
          </Card>

          <div className="vp-kundenakte-nebenspalte">
            <AufklapperKarte icon="cpu" titel="Anlagen und Boxen" className="vp-mandant-karte"
              urteil={anlagenZeilen ? `${anlagenZeilen.length} Anlage${anlagenZeilen.length === 1 ? '' : 'n'}` : undefined}
              aktionen={
                <Button variant="ghost" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setSiteDrawer(true)}>
                  Anlage anlegen
                </Button>
              }>
              {loadError ? null : anlagenZeilen == null ? (
                <TextSkeleton lines={3} />
              ) : anlagenZeilen.length === 0 ? (
                <p className="vp-muted">Noch keine Anlagen - der Kunde kann erst danach Geräte verbinden.</p>
              ) : (
                <ul className="vp-kundenakte-liste">
                  {anlagenZeilen.map((z) => (
                    <li key={z.siteId}>
                      <span className="vp-kundenakte-liste-haupt">
                        <b>{z.siteName}</b>
                      </span>
                      {/* B4 = A: je Box „online"/„nie gemeldet" statt nur einer Summe; eine nie
                          gemeldete Box führt in die Geräteakte. Punkt 7 (Befund vp-kundenakte-
                          fremde-personen): „Vom Kunden lösen …" steht sichtbar AN der Box - der
                          Dialog holt den Befund vom Server und erklärt bei einer gemeldeten Box,
                          warum sie nicht lösbar ist (nie ein toter Knopf). */}
                      {z.boxen.length > 1 ? (
                        <span className="vp-kundenakte-boxen">
                          {z.boxen.map((b) => (
                            <span key={b.deviceId} className="vp-kundenakte-box">
                              {b.nieGemeldet ? (
                                <a href={geraeteAkteHash(b.externalRef)}
                                  className="vp-kundenakte-box-link" title={b.label}>
                                  <Badge variant={b.ton} dot>{b.text}</Badge>
                                </a>
                              ) : (
                                <Badge variant={b.ton} dot>{b.text}</Badge>
                              )}
                              <button type="button" className="vp-linklike"
                                onClick={() => setLoesenBox(b.externalRef)}>
                                Vom Kunden lösen …
                              </button>
                            </span>
                          ))}
                        </span>
                      ) : z.boxen.length === 1 ? (
                        <span className="vp-kundenakte-box">
                          {z.boxen[0].nieGemeldet ? (
                            <a href={geraeteAkteHash(z.boxen[0].externalRef)} className="vp-kundenakte-box-link">
                              <Badge variant={z.boxen[0].ton} dot>{z.boxen[0].text}</Badge>
                            </a>
                          ) : (
                            <Badge variant={z.ton} dot>{z.unterzeile}</Badge>
                          )}
                          <button type="button" className="vp-linklike"
                            onClick={() => setLoesenBox(z.boxen[0].externalRef)}>
                            Vom Kunden lösen …
                          </button>
                        </span>
                      ) : (
                        <Badge variant={z.ton} dot>{z.unterzeile}</Badge>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </AufklapperKarte>

            <UnterstuetzungAdmin tenantId={tenant.id} name={tenant.name} />

            <AufklapperKarte icon="file-text" titel="Vertrag" className="vp-mandant-karte"
              urteil={vertragsende === undefined ? undefined : vertragsende ? 'beendet' : 'aktiv'}>
              {vertragsende === undefined ? (
                <TextSkeleton lines={1} />
              ) : vertragsende ? (
                <>
                  <div className="vp-alert vp-alert-info" style={{ marginTop: 0 }}>
                    {loeschbarkeit?.sofortLoeschbar
                      ? <>Der Vertrag ist am {datumDe(vertragsende.beendet_am)} beendet. Der Kunde hat
                          keinen Datenbestand und kann sofort endgültig gelöscht werden - ohne Frist.</>
                      : <>Der Vertrag ist am {datumDe(vertragsende.beendet_am)} beendet. Die Daten lassen sich
                          nur noch lesen; gelöscht werden sie frühestens am{' '}
                          {datumDe(vertragsende.loeschung_fruehestens)}.</>}
                  </div>
                  {vertragError && <div className="vp-alert vp-alert-err">{vertragError}</div>}
                  <span className="vp-vertrag-aktionen">
                    <Button variant="outline" size="sm" onClick={() => setVertragDialog('wiederaufnehmen')}>
                      Wiederaufnehmen
                    </Button>
                    {loeschbarkeit?.sofortLoeschbar && (
                      <Button variant="outline" size="sm" onClick={() => setLoeschenDialog(true)}>
                        Kunde endgültig löschen …
                      </Button>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <p className="vp-muted" style={{ marginTop: 0 }}>
                    {loeschbarkeit?.sofortLoeschbar
                      ? <>Ein aktiver Vertrag kann beendet werden - mit Frist, danach wiederaufnehmbar.
                          Dieser Kunde hat keinen Datenbestand und kann auch sofort endgültig gelöscht
                          werden.</>
                      : <>Ein aktiver Vertrag kann beendet werden - mit Frist, danach wiederaufnehmbar.
                          Gelöscht wird ein Kunde erst nach Ablauf der Frist, in der Gefahrenzone unten.</>}
                  </p>
                  {vertragError && <div className="vp-alert vp-alert-err">{vertragError}</div>}
                  <span className="vp-vertrag-aktionen">
                    <Button variant="outline" size="sm" onClick={() => setVertragDialog('beenden')}>
                      Kundenbereich beenden …
                    </Button>
                    {loeschbarkeit?.sofortLoeschbar && (
                      <Button variant="outline" size="sm" onClick={() => setLoeschenDialog(true)}>
                        Kunde endgültig löschen …
                      </Button>
                    )}
                  </span>
                </>
              )}
            </AufklapperKarte>
          </div>
        </div>

        <DangerZone
          actionLabel="Mandant löschen (Offboarding)"
          description="Offboarding entfernt den Kunden mit allen Daten und Zugängen - die endgültigste Aktion auf der Plattform."
          consequences={[
            `Alle Anlagen (${sites?.length ?? '…'}) und Geräte des Kunden`,
            'Alle Messdaten, Prognosen und Fahrpläne',
            `Alle Benutzerkonten (${konten?.length ?? '…'}) - die Personen können sich nicht mehr anmelden`,
            `Der Kunde „${tenant.name}" selbst`,
          ]}
          confirmLabel="Kunden endgültig löschen"
          typeToConfirm={tenant.name}
          busy={deleteBusy}
          error={deleteError}
          disabledReason={
            // Sofort löschbar (Server-Urteil, vp-kunde-sofort-loeschen): kein Grund sperrt mehr.
            loeschbarkeit?.sofortLoeschbar
              ? null
              : vertragsende === undefined
                ? null
                : vertragsende === null
                  ? 'Gelöscht werden kann ein Kunde mit Daten erst, nachdem der Vertrag beendet wurde und die Frist abgelaufen ist.'
                  : !fristAbgelaufen(vertragsende.loeschung_fruehestens)
                    ? `Die Frist läuft noch bis ${datumDe(vertragsende.loeschung_fruehestens)} - vorher kann nicht gelöscht werden.`
                    : null
          }
          onConfirm={() => void offboard()}
        />
      </section>

      <VertragsendeDialog
        kind={vertragDialog}
        tenantName={tenant.name}
        busy={vertragBusy}
        onClose={() => setVertragDialog(null)}
        onBeenden={(a, b, f) => void beenden(a, b, f)}
        onWiederaufnehmen={(a, b) => void wiederaufnehmen(a, b)}
      />

      {loeschenDialog && (
        <KundeLoeschenDialog
          open
          tenantId={tenant.id}
          tenantName={tenant.name}
          onClose={() => setLoeschenDialog(false)}
          onGeloescht={(r) => {
            setLoeschenDialog(false);
            setReport(r);
          }}
        />
      )}

      {editUser && (
        <EditUserDrawer
          key={editUser.id}
          tenant={tenant}
          user={editUser}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            setEditUser(null);
            void reload();
          }}
        />
      )}
      {resetPasswordUser && (
        <ResetPasswordDialog
          key={resetPasswordUser.id}
          tenant={tenant}
          user={resetPasswordUser}
          onClose={() => setResetPasswordUser(null)}
        />
      )}
      {/* Die zwei Rückfragen im HAUS-MUSTER statt eines nativen `confirm`:
          sie stehen in einem Drawer, der schon eine Folgenliste kennt
          (`DangerZone` darunter), und ein System-Popup daneben wäre die
          schwächste Rückfrage der Fläche. */}
      <ConfirmDialog
        open={confirmUser != null}
        tone="danger"
        title={
          confirmUser?.kind !== 'delete' ? 'Benutzer deaktivieren?'
            : confirmUser.user ? 'Benutzer löschen?' : 'Person löschen?'
        }
        intro={
          confirmUser?.kind !== 'delete'
            ? `„${confirmUser?.name}" kann sich danach nicht mehr anmelden.`
            : confirmUser.user
              ? `Das Konto „${confirmUser.name}" wird endgültig entfernt.`
              : `„${confirmUser.name}" wird aus diesem Kundenbereich entfernt - ein Konto dazu gibt es nicht mehr.`
        }
        consequences={
          confirmUser?.kind === 'delete'
            ? [
                confirmUser.user
                  ? 'Der Zugang wird dauerhaft gelöscht - das lässt sich nicht rückgängig machen.'
                  : 'Der Eintrag und seine Rollen enden dauerhaft - das lässt sich nicht rückgängig machen.',
                'Die Anlagen und Daten des Kunden bleiben unberührt.',
                'Ein neuer Zugang für dieselbe Person ist jederzeit wieder anlegbar.',
              ]
            : [
                'Die Anmeldung wird gesperrt; laufende Sitzungen enden beim nächsten Aufruf.',
                'Das Konto bleibt bestehen - Aktivieren stellt den Zugang sofort wieder her.',
                'Die Anlagen und Daten des Kunden bleiben unberührt.',
              ]
        }
        confirmLabel={confirmUser?.kind === 'delete' ? (confirmUser.user ? 'Benutzer löschen' : 'Person löschen') : 'Deaktivieren'}
        onCancel={() => setConfirmUser(null)}
        onConfirm={() => {
          const c = confirmUser;
          setConfirmUser(null);
          if (!c) return;
          void (c.kind === 'delete' ? remove(c.sub) : c.user ? disable(c.user) : undefined);
        }}
      />
      <CreateSiteDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onCreate={(input) => adminApi.createSite(tenant.id, input)}
        onCreated={() => void reload()}
        contextNote={`Wird für den Kunden ${tenant.name} (${tenant.id.slice(0, 8)}) angelegt. Der Kunde sieht sie sofort in seinem Portal.`}
      />
      {loesenBox != null && (
        <BoxLoesenDialog
          open
          boxRef={loesenBox}
          jetzt={new Date()}
          onClose={() => setLoesenBox(null)}
          onGeloescht={() => {
            setLoesenBox(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

/**
 * Das Formular „Ersten Kundenadministrator anlegen" - IN der Personen-Karte
 * statt eines Fensters (E1 = A, Interaktionsregel 2: „ein Formular, das sich
 * in der Karte öffnet").
 */
function ErsterAdminFormular({
  tenantName,
  passwort,
  onAbbrechen,
  onAnlegen,
  onFertig,
}: {
  tenantName: string;
  passwort: string | null;
  onAbbrechen: () => void;
  onAnlegen: (form: { username: string; email: string; firstName: string; lastName: string }) => Promise<void>;
  onFertig: () => void;
}) {
  const [form, setForm] = useState({ username: '', email: '', firstName: '', lastName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.username.trim() || !form.email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAnlegen(form);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler');
    } finally {
      setBusy(false);
    }
  }

  if (passwort) {
    return (
      <div className="vp-form-stack" style={{ marginTop: 'var(--vp-space-4)' }}>
        <StartpasswortAnzeige passwort={passwort} />
        <Button variant="primary" onClick={onFertig}>Fertig</Button>
      </div>
    );
  }

  return (
    <div className="vp-form-stack" style={{ marginTop: 'var(--vp-space-4)' }}>
      <p className="vp-note" style={{ marginTop: 0 }}>
        Der erste Kundenadministrator wird für <b>{tenantName}</b> angelegt. Weitere Personen lädt diese Person selbst ein.
      </p>
      <Input label="Benutzername *" placeholder="z. B. kunde-01" value={form.username} onChange={set('username')} />
      <Input label="E-Mail" type="email" placeholder="kunde@example.com" value={form.email} onChange={set('email')} />
      <Input label="Vorname" value={form.firstName} onChange={set('firstName')} />
      <Input label="Nachname" value={form.lastName} onChange={set('lastName')} />
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)' }}>
        <Button variant="ghost" size="sm" onClick={onAbbrechen} disabled={busy}>Abbrechen</Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy || !form.username.trim() || !form.email.trim()}>
          {busy ? 'Wird angelegt…' : 'Kundenadministrator anlegen'}
        </Button>
      </div>
    </div>
  );
}

/** Einen Anmeldenamen aus der E-Mail vorschlagen (N4: nur a-z, 0-9, Punkt, Bindestrich, Unterstrich). */
function anmeldenameAusEmail(email: string): string {
  return email.split('@')[0]?.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') ?? '';
}

/**
 * P2: „Person hinzufügen" - die WEITERE Person (nicht die erste, W4 fällt) IN der Personen-Karte
 * (E1 = A): Rolle und Standorte wie der Kundenadministrator, der Anmeldename wird aus der E-Mail
 * vorgeschlagen und lässt sich mit „Ändern" anpassen (§4.3 des Konzept-Berichts).
 */
function PersonHinzufuegenFormular({
  sites,
  onAbbrechen,
  onAnlegen,
  onFertig,
}: {
  sites: Site[];
  onAbbrechen: () => void;
  onAnlegen: (anlage: BenutzerAnlage) => Promise<{ startpasswort: string }>;
  onFertig: () => void;
}) {
  const [email, setEmail] = useState('');
  const [vorname, setVorname] = useState('');
  const [nachname, setNachname] = useState('');
  const [anmeldenameOffen, setAnmeldenameOffen] = useState(false);
  const [anmeldename, setAnmeldename] = useState('');
  const [rolle, setRolle] = useState('leser');
  const [standorte, setStandorte] = useState<string[]>([]);
  const [passwort, setPasswort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jeStandort = !unternehmensrolle(rolle);
  const vorschlag = anmeldenameAusEmail(email);
  const effektiverAnmeldename = anmeldenameOffen ? anmeldename.trim() : vorschlag;

  async function submit() {
    if (!email.trim() || !effektiverAnmeldename) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onAnlegen({
        username: effektiverAnmeldename,
        email: email.trim(),
        vorname: vorname.trim() || undefined,
        nachname: nachname.trim() || undefined,
        rolle,
        standorte: jeStandort ? (sites.length === 1 ? [sites[0].id] : standorte) : [],
      });
      setPasswort(result.startpasswort);
    } catch (e) {
      setError(benutzerFehler(e));
    } finally {
      setBusy(false);
    }
  }

  if (passwort) {
    return (
      <div className="vp-form-stack" style={{ marginTop: 'var(--vp-space-4)' }}>
        <StartpasswortAnzeige passwort={passwort} />
        <Button variant="primary" onClick={onFertig}>Fertig</Button>
      </div>
    );
  }

  return (
    <div className="vp-form-stack" style={{ marginTop: 'var(--vp-space-4)' }}>
      <h3 style={{ margin: 0 }}>Neue Person</h3>
      <div style={{ display: 'flex', gap: 'var(--vp-space-3)' }}>
        <Input label="Vorname" value={vorname} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVorname(e.target.value)} />
        <Input label="Nachname" value={nachname} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNachname(e.target.value)} />
      </div>
      <Input label="E-Mail" type="email" value={email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} />
      {anmeldenameOffen ? (
        <Input label="Anmeldename" value={anmeldename} autoComplete="off" spellCheck={false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAnmeldename(e.target.value)}
          hint="a-z, 0-9, Punkt, Bindestrich, Unterstrich; 3 bis 64 Zeichen." />
      ) : (
        vorschlag && (
          <p className="vp-note" style={{ margin: 0 }}>
            Anmelden mit <b className="vp-mono">{vorschlag}</b> oder der E-Mail
            <button type="button" className="vp-linklike" onClick={() => { setAnmeldename(vorschlag); setAnmeldenameOffen(true); }} style={{ marginLeft: 'var(--vp-space-2)' }}>
              Ändern
            </button>
          </p>
        )
      )}
      <VpPicker id="person-hinzufuegen-rolle" label="Rolle" value={rolle}
        options={KUNDENROLLEN.map((r) => ({ ...r, sub: ROLLE_BESCHREIBUNG[r.value] }))}
        onChange={(v) => { setRolle(v); setStandorte([]); }} />
      <p className="vp-note" style={{ margin: 0 }}>
        {ROLLE_BESCHREIBUNG[rolle]}
        {jeStandort && sites.length === 1 ? ` Gilt für „${sites[0].name}".` : ''}
      </p>
      {jeStandort && sites.length > 1 && (
        <VpPicker id="person-hinzufuegen-standorte" label="Standorte" values={standorte}
          options={sites.map((s) => ({ value: s.id, label: s.name }))}
          onChangeMany={setStandorte} />
      )}
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)' }}>
        <Button variant="ghost" size="sm" onClick={onAbbrechen} disabled={busy}>Abbrechen</Button>
        <Button variant="primary" size="sm" onClick={() => void submit()}
          disabled={busy || !email.trim() || !effektiverAnmeldename || (jeStandort && sites.length > 1 && standorte.length === 0)}>
          {busy ? 'Wird angelegt…' : 'Person anlegen'}
        </Button>
      </div>
    </div>
  );
}

/** Inline edit form of the tenant header: name + segment + Betriebsart (U0, E1 = A). */
function TenantEditForm({
  tenant,
  onCancel,
  onSaved,
}: {
  tenant: Tenant;
  onCancel: () => void;
  onSaved: (updated: Tenant) => void;
}) {
  const [name, setName] = useState(tenant.name);
  const [segment, setSegment] = useState(tenant.segment);
  // '' = Automatisch (no override stored; the segment derives the shell).
  const [betriebsart, setBetriebsart] = useState(tenant.betriebsart ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await adminApi.updateTenant(tenant.id, {
        name: name.trim(),
        segment,
        betriebsart: betriebsart === '' ? null : (betriebsart as 'endkunde' | 'betreiber'),
      });
      onSaved(updated);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? 'Ungültige Eingabe. Bitte prüfen Sie Name, Segment und Betriebsart.'
          : 'Die Änderungen konnten nicht gespeichert werden. Bitte versuchen Sie es erneut.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: 'var(--vp-space-5)' }}>
      <div className="vp-form-stack">
        <Input
          label="Name *"
          value={name}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <VpPicker
          id="edit-tenant-segment"
          label="Segment"
          options={[
            { value: 'CI', label: segmentLabel('CI') },
            { value: 'B2C', label: segmentLabel('B2C') },
          ]}
          value={segment}
          onChange={setSegment}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <VpPicker
            id="edit-tenant-betriebsart"
            label="Betriebsart (Navigation des Kunden)"
            options={[
              { value: '', label: 'Automatisch (nach Anzahl Anlagen)' },
              { value: 'endkunde', label: 'Endkunde (Cockpit für die eigene Anlage)' },
              { value: 'betreiber', label: 'Betreiber (Flotten-/Portfolio-Ansicht)' },
            ]}
            value={betriebsart}
            onChange={setBetriebsart}
          />
          <p className="vp-muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            Bestimmt die Navigation des Kundenportals. Automatisch heißt: ab
            zwei Anlagen die Flotten-Ansicht, sonst das Cockpit - das Segment
            wird dafür ausdrücklich NICHT herangezogen.
          </p>
        </div>
      </div>
      {error && <div className="vp-alert vp-alert-err">{error}</div>}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', justifyContent: 'flex-end', marginTop: 'var(--vp-space-4)' }}>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Abbrechen
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Wird gespeichert…' : 'Änderungen speichern'}
        </Button>
      </div>
    </div>
  );
}

/** Eine E-Mail bricht am „@“ um statt mitten im Wort (am Telefon: „person3@“ / „ahrenberg.example.test“). */
function mailMitUmbruch(mail: string) {
  const at = mail.indexOf('@');
  return at < 0 ? mail : <>{mail.slice(0, at + 1)}<wbr />{mail.slice(at + 1)}</>;
}

function ZurueckZuMandanten({ onClick }: { onClick: () => void }) {
  return (
    <div className="vp-mandant-zurueck">
      <Button variant="ghost" size="sm" iconLeft={<Icon name="chevron-left" size={16} />} onClick={onClick}>
        Alle Kunden
      </Button>
    </div>
  );
}

function segmentLabel(segment: string): string {
  if (segment === 'CI') return 'Gewerbe & Industrie';
  if (segment === 'B2C') return 'Privat';
  return segment;
}

/** German label of an explicitly set U0 shell frame. */
function betriebsartLabel(betriebsart: string): string {
  if (betriebsart === 'endkunde') return 'Endkunde';
  if (betriebsart === 'betreiber') return 'Betreiber';
  return betriebsart;
}

/** `createdAt` ist ein Zeitstempel (ISO); hier reicht der Kalendertag. */
function datumKurz(iso: string): string {
  return new Date(iso).toLocaleDateString('de-DE', { month: '2-digit', year: 'numeric' });
}

/**
 * Vertragsende I (N1): EIN Dialog für beide Übergänge - „beenden" trägt
 * zusätzlich die Frist und das Namens-Eintippen (dieselbe Bestätigungsform
 * wie die Gefahrenzone), „wiederaufnehmen" nur Auftrag und Begründung.
 */
function VertragsendeDialog({
  kind,
  tenantName,
  busy,
  onClose,
  onBeenden,
  onWiederaufnehmen,
}: {
  kind: 'beenden' | 'wiederaufnehmen' | null;
  tenantName: string;
  busy: boolean;
  onClose: () => void;
  onBeenden: (auftrag: string, begruendung: string, fristTage: number) => void;
  onWiederaufnehmen: (auftrag: string, begruendung: string) => void;
}) {
  const [auftrag, setAuftrag] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [fristTage, setFristTage] = useState('90');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (kind) {
      setAuftrag('');
      setBegruendung('');
      setFristTage('90');
      setTyped('');
    }
  }, [kind]);

  const beenden = kind === 'beenden';
  const frist = Number.parseInt(fristTage, 10);
  const blocked =
    !auftrag.trim() || !begruendung.trim() || (beenden && (typed.trim() !== tenantName || !Number.isFinite(frist) || frist < 1));

  return (
    <Modal
      open={kind != null}
      onClose={onClose}
      title={beenden ? `Vertrag beenden: ${tenantName}` : `Vertrag wiederaufnehmen: ${tenantName}`}
    >
      <p className="vp-note" style={{ marginTop: 0 }}>
        {beenden
          ? 'Ab dem Beenden kann der Kunde seine Daten nur noch lesen; gelöscht werden sie frühestens nach der Frist.'
          : 'Der Kunde kehrt in den aktiven Zustand zurück - derselbe Kundenbereich, kein neuer.'}
      </p>
      <Input label="Auftrag" value={auftrag} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAuftrag(e.target.value)} />
      <Input
        label="Begründung"
        value={begruendung}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBegruendung(e.target.value)}
      />
      {beenden && (
        <>
          <Input
            label="Frist in Tagen"
            type="number"
            min={1}
            max={3650}
            value={fristTage}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFristTage(e.target.value)}
          />
          <Input
            label={`Zur Bestätigung „${tenantName}" eintippen`}
            placeholder={tenantName}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTyped(e.target.value)}
          />
        </>
      )}
      <div style={{ display: 'flex', gap: 'var(--vp-space-2)', justifyContent: 'flex-end', marginTop: 'var(--vp-space-4)' }}>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Abbrechen
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || blocked}
          onClick={() =>
            beenden ? onBeenden(auftrag.trim(), begruendung.trim(), frist) : onWiederaufnehmen(auftrag.trim(), begruendung.trim())
          }
        >
          {busy ? 'Wird gespeichert…' : beenden ? 'Vertrag beenden' : 'Wiederaufnehmen'}
        </Button>
      </div>
    </Modal>
  );
}
