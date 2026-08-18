import {
  request,
  type CertSource,
  type CreateSiteInput,
  type PlatformCertVerdict,
  type Site,
} from '../api';
import type { DeviceApply, DeviceTrust, EdgeUpdates } from '../adminEdgeUpdates';
import type { AdminVorlage } from '../adminVorlagen';
import type { FlottenAnlage } from '../adminKomponentenFlotte';
import type { ModellWahlZustand } from '../prognose';

export type { CreateSiteInput, Site } from '../api';

/**
 * Platform-admin API client (tenants + customer users). Every call goes to
 * /api/v1/admin/** which the backend gates with hasRole('platform-admin'), so a
 * customer token gets 403 - the UI only reveals this surface to Portal-Admins,
 * but the backend is the real boundary.
 */

export interface Tenant {
  id: string;
  name: string;
  segment: string;
  plan: string;
  /** U0 shell-frame override; null = automatic (derived from the site count). */
  betriebsart: 'endkunde' | 'betreiber' | null;
  /** The resolved frame the shell keys on: the override, else null = unknown. */
  betriebsartEffective: 'endkunde' | 'betreiber' | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enabled: boolean;
  tenantId: string | null;
}

export interface CreateTenantInput {
  name: string;
  segment?: string;
}

export interface CreateUserInput {
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  temporaryPassword?: boolean;
}

export interface ResetPasswordInput {
  password: string;
  temporary?: boolean;
}

export interface ProvisionedDevice {
  externalRef: string;
  kind: string;
  note: string | null;
  provisionedAt: string;
  claimed: boolean;
  claimedByTenant: string | null;
}

/**
 * Ein Gerät, das sich gemeldet hat (CSR hochgeladen) und auf keinen Claim
 * trifft — die andere Hälfte des Tippfehler-Fensters: das Gerät „hat seinen
 * Teil getan", der Kunde hat eine andere Referenz getippt, und bis hierher war
 * dieser Zustand auf BEIDEN Seiten unsichtbar.
 *
 * `everIssued` unterscheidet „nie beansprucht" von „war beansprucht und wurde
 * getrennt" (ein Zertifikat wurde schon einmal ausgestellt).
 *
 * Mandantenlos per Konstruktion — ein Enrollment kennt keinen Mandanten.
 */
export interface PendingEnrollment {
  externalRef: string;
  deviceInfo: string | null;
  csrUpdatedAt: string;
  everIssued: boolean;
  issuedAt: string | null;
}

/**
 * Ein steuerbarer Gerätetyp mit seinem plattformweiten Freigabe-Stand
 * (Inkrement 5 / D11). `certificationStatus` ist ein Katalog-Fakt
 * (`certified` | `in_certification` | `simulator_only` | `not_certified`);
 * `certifiedAt`/`certificationNotes` sind optional, `connectedCount` die
 * flottenweite Zahl der verbundenen Geräte dieses Typs.
 */
export interface ConsumerDeviceType {
  type: string;
  label: string;
  certificationStatus: string;
  certifiedAt: string | null;
  certificationNotes: string | null;
  connectedCount: number;
}

/**
 * Eine Zeile des Geräte-Inventars: die VEREINIGUNG von Aufkleber-Registry und
 * echter Flotte, verbunden über die Referenz.
 *
 * Genau eine der beiden Hälften darf fehlen, und welche, sagt die Zeile:
 * `deviceId === null` ist eine gedruckte, noch nicht verbundene ID;
 * `provisioned === false` ist ein verbundenes Gerät, dessen Referenz nie aus
 * der Aufkleber-Registry kam (der Normalfall der Bestandsflotte).
 *
 * `state` ist `null`, solange die Zeile noch kein Gerät IST - über eine ID, die
 * sich nie gemeldet hat, ist nichts abzuleiten.
 */
export interface AdminDeviceRow {
  deviceId: string | null;
  externalRef: string;
  label: string | null;
  siteId: string | null;
  siteName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  kind: string | null;
  ist: string | null;
  soll: string | null;
  sollSeq: number | null;
  channel: string | null;
  pinned: boolean;
  state: string | null;
  reason: string | null;
  blocker: string | null;
  lastSeenAt: string | null;
  reportedAt: string | null;
  provisioned: boolean;
  note: string | null;
  provisionedAt: string | null;
  trust?: DeviceTrust | null;
  /** Der Portal-Apply-Block - dieselbe Struktur wie in der Flotten-Zeile. */
  apply?: DeviceApply | null;
}

export interface ProvisionDeviceInput {
  externalRef: string;
  kind?: string;
  note?: string;
}

export interface UpdateTenantInput {
  name: string;
  segment?: string;
  /**
   * U0 shell-frame override, full representation: 'endkunde'/'betreiber' set
   * it, null/omitted clears it back to the automatic segment-derived default.
   */
  betriebsart?: 'endkunde' | 'betreiber' | null;
}

export interface UpdateUserInput {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

/** Report of what the tenant offboarding removed (DB transactional, Keycloak best-effort). */
export interface TenantOffboardingReport {
  tenantId: string;
  tenantName: string;
  deletedSites: number;
  deletedDevices: number;
  deletedTelemetryRows: number;
  deletedUsers: string[];
  /** Keycloak logins that could not be deleted - need manual cleanup. */
  failedUsers: string[];
}

/**
 * Ein Eintrag im PLATTFORM-Register der steuerungs-zertifizierten
 * Wechselrichter-Modelle. Geschlüsselt auf `brand`+`model`, nicht auf die
 * Registerfamilie: eine Familie deckt mehrere Baureihen ab, ein
 * Prüfstandslauf genau eine.
 */
export interface ControlCertification {
  brand: string;
  model: string;
  family: string;
  /** Die Steuerfläche, auf der der Lauf lief - null = keine Aussage. */
  controlPath: 'remote' | 'tou' | null;
  /**
   * Die belegte SCHREIB-Vorzeichenkonvention. ⚠ null und false sind
   * verschieden: null heißt „der Prüfstand hat die Frage nicht beantwortet"
   * (das Gerät prüft dann nichts), false heißt „er hat sie beantwortet".
   */
  invertControlSign: boolean | null;
  certifiedAt: string;
  /**
   * Die Firmware als KLARTEXT - ausdrücklich kein Maschinen-Tor: die Box liest
   * keine Firmware-Version aus dem Wechselrichter, ein Firmware-Fenster wäre
   * eine Zusage, die niemand prüfen kann.
   */
  firmwareNote: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string;
}

export interface CertifyControlModelInput {
  brand: string;
  model: string;
  family: string;
  controlPath?: 'remote' | 'tou' | null;
  invertControlSign?: boolean | null;
  certifiedAt?: string | null;
  firmwareNote?: string | null;
  note?: string | null;
}

/**
 * Eine Anlage als Kandidat für die Scharfschaltung, mit der GEMELDETEN Wahrheit
 * ihres Geräts. `platformCertVerdict === null` heißt „das Gerät hat nichts
 * gemeldet" (ältere Version, oder es hat das Cloud-Dokument nie gesehen) - nie
 * „nicht zertifiziert".
 */
export interface ControlCandidate {
  deviceId: string;
  tenantId: string;
  siteId: string;
  siteName: string;
  tenantName: string;
  externalRef: string;
  activated: boolean;
  platformCertVerdict: PlatformCertVerdict | null;
  platformCertModel: string | null;
  certSource: CertSource | null;
  activatedAt: string | null;
  activatedBy: string | null;
}

/** Eine Anlage, deren Batterie-Steuerung bewusst scharfgeschaltet wurde. */
export interface ControlActivation {
  deviceId: string;
  tenantId: string;
  siteId: string;
  siteName: string;
  tenantName: string;
  externalRef: string;
  activatedAt: string;
  activatedBy: string;
  note: string | null;
}

/**
 * Die Eingabe einer geprüften Vorlagen-Fassung. KEIN `templateRef` - der
 * Schlüssel wird serverseitig aus Marke + Modell abgeleitet und ist opak.
 */
export interface SaveComponentTemplateInput {
  brand: string;
  brandLabel: string;
  model: string;
  modelLabel: string;
  family?: string | null;
  familyLabel?: string | null;
  communication: string;
  communicationLabel?: string | null;
  transportSchema: unknown[];
  /** ABSENT lassen, wenn die Vorlage es nicht erklärt - `[]` lehnt der Server ab. */
  channels?: unknown[];
  writes?: unknown[];
  ratedKw?: number | null;
  controlTier?: number;
  certificationStatus: string;
  certificationNote?: string | null;
  note?: string | null;
}

export const adminApi = {
  listTenants: () => request<Tenant[]>('/api/v1/admin/tenants'),

  createTenant: (input: CreateTenantInput) =>
    request<Tenant>('/api/v1/admin/tenants', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateTenant: (tenantId: string, input: UpdateTenantInput) =>
    request<Tenant>(`/api/v1/admin/tenants/${tenantId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  // Type-to-confirm offboarding: confirmName must equal the tenant's exact
  // name or the backend refuses (400) before touching anything.
  deleteTenant: (tenantId: string, confirmName: string) =>
    request<TenantOffboardingReport>(`/api/v1/admin/tenants/${tenantId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ confirmName }),
    }),

  listUsers: (tenantId: string) =>
    request<AdminUser[]>(`/api/v1/admin/tenants/${tenantId}/users`),

  createUser: (tenantId: string, input: CreateUserInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateUser: (tenantId: string, userId: string, input: UpdateUserInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  disableUser: (tenantId: string, userId: string) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/disable`, {
      method: 'POST',
    }),

  enableUser: (tenantId: string, userId: string) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/enable`, {
      method: 'POST',
    }),

  deleteUser: (tenantId: string, userId: string) =>
    request<void>(`/api/v1/admin/tenants/${tenantId}/users/${userId}`, {
      method: 'DELETE',
    }),

  // Support lever: no SMTP means no self-service reset, so support sets a new
  // (default temporary) password here; any brute-force lockout is lifted too.
  resetPassword: (tenantId: string, userId: string, input: ResetPasswordInput) =>
    request<AdminUser>(`/api/v1/admin/tenants/${tenantId}/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listSites: (tenantId: string) =>
    request<Site[]>(`/api/v1/admin/tenants/${tenantId}/sites`),

  createSite: (tenantId: string, input: CreateSiteInput) =>
    request<Site>(`/api/v1/admin/tenants/${tenantId}/sites`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listProvisionedDevices: () =>
    request<ProvisionedDevice[]>('/api/v1/admin/provisioned-devices'),

  /**
   * Geräte, die sich gemeldet haben, aber auf keinen Claim treffen. Cross-tenant
   * per Konstruktion (ein Enrollment kennt keinen Mandanten), deshalb ohne
   * Mandanten-Argument.
   */
  listPendingEnrollments: () =>
    request<PendingEnrollment[]>('/api/v1/admin/enrollments/pending'),

  /**
   * Die steuerbaren Gerätetypen mit ihrem plattformweiten Freigabe-Stand
   * (Inkrement 5 / D11). Wahrheitsquelle ist der entitytypes-Katalog; die Liste
   * ist read-only (kein Schalter) und cross-tenant (Zertifizierung gilt je Typ,
   * nicht je Mandant).
   */
  consumerDeviceTypes: () =>
    request<ConsumerDeviceType[]>('/api/v1/admin/consumer-device-types'),

  // ── Steuerungs-Freigabe: das Plattform-Register + die Scharfschaltung ──
  //
  // Cross-tenant und mandantenlos (eine Modell-Freigabe gilt je PRODUKT, eine
  // Scharfschaltung je Anlage) - deshalb ohne den X-Tenant-Id-Umschalter.

  controlCertifications: () =>
    request<ControlCertification[]>('/api/v1/admin/control-certifications'),

  certifyControlModel: (input: CertifyControlModelInput) =>
    request<ControlCertification>('/api/v1/admin/control-certifications', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  revokeControlModel: (brand: string, model: string) =>
    request<void>(
      `/api/v1/admin/control-certifications?brand=${encodeURIComponent(brand)}&model=${encodeURIComponent(model)}`,
      { method: 'DELETE' },
    ),

  controlActivations: () =>
    request<ControlActivation[]>('/api/v1/admin/control-activations'),

  /**
   * Jede Anlage als Kandidat für den EINEN Klick - samt dem, was ihr GERÄT über
   * sein Modell gemeldet hat (`platformCertVerdict`). Null dort heißt „sie hat
   * nichts gemeldet", nie „nicht zertifiziert".
   */
  controlCandidates: () =>
    request<ControlCandidate[]>('/api/v1/admin/control-candidates'),

  /** „Steuerung aktivieren" - der EINE bewusste Klick je Anlage. */
  activateControl: (deviceId: string, note?: string) =>
    request<ControlActivation>(`/api/v1/admin/devices/${deviceId}/control-activation`, {
      method: 'POST',
      body: JSON.stringify({ note: note ?? null }),
    }),

  deactivateControl: (deviceId: string) =>
    request<void>(`/api/v1/admin/devices/${deviceId}/control-activation`, { method: 'DELETE' }),

  provisionDevice: (input: ProvisionDeviceInput) =>
    request<ProvisionedDevice>('/api/v1/admin/provisioned-devices', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // 409 while a customer's claim references the ID (unclaim the device first).
  deleteProvisionedDevice: (externalRef: string) =>
    request<void>(`/api/v1/admin/provisioned-devices/${encodeURIComponent(externalRef)}`, {
      method: 'DELETE',
    }),

  // ── OTA Stufe 2 „Verteilen" ─────────────────────────────────────────────
  //
  // Alle Schreibwege sind platform-admin-gefenced; die Ehrlichkeits- und
  // Freigabe-REGELN stehen server-seitig (RolloutStates/BakeGate) - das Portal
  // rendert sie, es entscheidet nichts nach.

  /** Alles, was die Seite „Edge-Updates" zeigt, in EINEM Aufruf. */
  edgeUpdates: () => request<EdgeUpdates>('/api/v1/admin/edge-updates'),

  /**
   * Das INVENTAR aller Geräte über den ganzen Lebenszyklus (Seite „Geräte") -
   * die Vereinigung von Aufkleber-Registry und echter Flotte. Bis zum
   * Konsolidierungs-Umbau kannte die Registry-Seite die realen Bestandsboxen
   * (selbst generierte `edge-`Referenzen) gar nicht.
   */
  listDevices: () =>
    request<{ devices: AdminDeviceRow[] }>('/api/v1/admin/devices')
      .then((r) => r.devices),

  /** Rollout aus einem SIGNIERTEN Register-Eintrag starten (409 sonst). */
  createRollout: (input: {
    releaseSeq: number;
    channel?: string;
    waves: { name: string; devices: string[] }[];
    /**
     * OTA Stufe 4: die Wellen-AUTOMATIK. ABSENT = Hand-Vorschub, und das
     * bleibt die Vorgabe (D4) - der Server liest ein fehlendes Feld genauso.
     */
    autoAdvance?: boolean;
  }) =>
    request<{ rolloutId: string }>('/api/v1/admin/rollouts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Nächste Welle - der Server verweigert sie (409), solange das Bake offen ist. */
  promoteRollout: (rolloutId: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/promote`, { method: 'POST' }),

  /**
   * Den Wellen-Vorschub umschalten (Stufe 4). Lockert nichts: dasselbe
   * Bake-Kriterium, derselbe Auto-Halt, derselbe endgültige Not-Aus.
   */
  setAutoAdvance: (rolloutId: string, enabled: boolean) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/auto-advance`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  pauseRollout: (rolloutId: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/pause`, { method: 'POST' }),

  resumeRollout: (rolloutId: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/resume`, { method: 'POST' }),

  /** Not-Aus. Endgültig: „weitermachen" ist ein neuer, bewusster Rollout. */
  haltRollout: (rolloutId: string, reason?: string) =>
    request<void>(`/api/v1/admin/rollouts/${rolloutId}/halt`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? 'Von Hand eingefroren.' }),
    }),

  /** Einzelgerät: Release + Kanal + Pin setzen. */
  setUpdateTarget: (deviceId: string, input: {
    releaseSeq: number;
    channel?: string;
    pinned?: boolean;
  }) =>
    request<void>(`/api/v1/admin/devices/${deviceId}/update-target`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Zuweisung zurücknehmen (Zeile UND retained Nachricht). */
  revertUpdateTarget: (deviceId: string) =>
    request<void>(`/api/v1/admin/devices/${deviceId}/update-target/revert`, {
      method: 'POST',
    }),

  /**
   * Die EINMALIGE Freigabe zum Anwenden (Portal-Apply).
   *
   * Sie ist wörtlich die Freigabe, die der Betreiber bisher an der
   * Geräteseite der Box hinter dem Geräte-Passwort erteilt hat - nur der
   * Transport ist ein anderer. Sie gilt für EIN Release und EINEN Vorgang und
   * verfällt nach 15 Minuten; angewandt wird sie vom Gerät, das jedes weitere
   * Tor unverändert durchläuft.
   */
  requestApply: (deviceId: string) =>
    request<void>(`/api/v1/admin/devices/${deviceId}/apply`, { method: 'POST' }),

  // ── Einheitsmodell Stufe 6: Vorlagen-Verwaltung + Komponenten-Flotte ──────
  // Bewusst mandantenlos: das Vorlagen-Register ist global (eine Aussage über
  // ein PRODUKT), und die Flotten-Sicht spannt über alle Mandanten. Der
  // X-Tenant-Id-Umschalter gilt hier also nicht - der Zaun ist die Rolle.

  /** ALLE Fassungen aller Vorlagen, inklusive der zurückgezogenen. */
  listComponentTemplates: () =>
    request<AdminVorlage[]>('/api/v1/admin/component-templates'),

  /** Eine NEUE geprüfte Vorlage (Fassung 1). Der Schlüssel wird abgeleitet. */
  createComponentTemplate: (input: SaveComponentTemplateInput) =>
    request<AdminVorlage>('/api/v1/admin/component-templates', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** Eine neue FASSUNG - die alte bleibt abrufbar. */
  addComponentTemplateVersion: (templateRef: string, input: SaveComponentTemplateInput) =>
    request<AdminVorlage>(
      `/api/v1/admin/component-templates/${encodeURIComponent(templateRef)}/versions`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  /** Aus der Auswahl nehmen bzw. wieder freigeben - nie ein Löschen. */
  setComponentTemplateWithdrawn: (templateRef: string, version: number, withdrawn: boolean) =>
    request<AdminVorlage>(
      `/api/v1/admin/component-templates/${encodeURIComponent(templateRef)}/versions/${version}/` +
        (withdrawn ? 'withdraw' : 'restore'),
      { method: 'POST' },
    ),

  /** Die Komponenten-Welt der ganzen Flotte, read-only. */
  componentFleet: () =>
    request<{ sites: FlottenAnlage[] }>('/api/v1/admin/component-fleet').then((r) => r.sites),

  /**
   * Der Prognose-Schalter: welches Modell je Prognoseart plant, woher die Wahl
   * kommt, und die Umstellungs-Historie. PLATTFORMWEIT, nicht je Anlage.
   */
  forecastModels: () => request<ModellWahlZustand>('/api/v1/admin/forecast-models'),

  /**
   * „Kandidat übernehmen" - ab dem nächsten Planungslauf plant dieses Modell.
   * Der Rückweg ist derselbe Aufruf in die Gegenrichtung; die Umstellung wird
   * append-only protokolliert (von->zu, wer, wann).
   */
  promoteForecastModel: (kind: 'load' | 'pv', model: string) =>
    request<ModellWahlZustand>('/api/v1/admin/forecast-models', {
      method: 'POST',
      body: JSON.stringify({ kind, model }),
    }),
};
