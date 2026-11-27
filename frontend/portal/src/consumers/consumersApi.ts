/**
 * API client for the steuerbare-Verbraucher surface (Increment 1). Reuses the
 * shared `request` (so the shell's X-Tenant-Id switcher applies for an admin
 * acting in a customer page, like entitiesApi/optimizerApi). Every route is
 * tenant-scoped by RLS - a foreign site is 404.
 */
import { request } from '../api';
import type {
  Consumer,
  ConsumerOptions,
  ConsumerPolicyDocument,
  ConsumerPolicyVersion,
} from './types';
import type { IoModulZustandDto } from './ioZustand';
import { merkeSpur, pruefeSpuren, spurKlick, spurMeldeweg } from './schaltspur';

/** Das Ergebnis eines Schaltens: `state` ist der ZURÜCKGELESENE Zustand. */
export interface IoAusgangSchaltErgebnis {
  ok: boolean;
  channel: number;
  state: boolean | null;
  message: string;
}

export interface CreateConsumerBody {
  type: string;
  name?: string;
  /** Optional seit P8: die SG-Ready-Wärmepumpe kommt ohne Nennleistung aus. */
  ratedPowerKw?: number;
  controlKind?: string;
  levelsKw?: number[];
  minPowerKw?: number;
  resolutionKw?: number;
  powerRangesKw?: number[][];
  storageRelation?: string;
  defaultGridEnergyPolicy?: string;
  allowStorageDischarge?: boolean;
  failsafe?: string;
  edgeSourceId?: string;
  /** Relais-Ausgang eines I/O-Moduls - schließt `edgeSourceId` aus. */
  ioEntityId?: string;
  ioChannel?: number;
}

export interface PatchConsumerBody {
  name?: string;
  ratedPowerKw?: number;
  controlKind?: string;
  levelsKw?: number[];
  minPowerKw?: number;
  resolutionKw?: number;
  powerRangesKw?: number[][];
  storageRelation?: string;
  defaultGridEnergyPolicy?: string;
  allowStorageDischarge?: boolean;
  failsafe?: string;
  enabled?: boolean;
  expectedVersion?: number;
}

const base = (siteId: string) => `/api/v1/sites/${siteId}/consumers`;

/**
 * The activate/resume outcome envelope (the flows-activation pattern):
 * `activated:false` + `reason`/`message` is an HONEST refusal, not a transport
 * error - the German `message` is customer copy.
 */
export interface PolicyActivationOutcome {
  activated: boolean;
  reason: string | null;
  message: string;
  published: boolean;
  policyVersion: number | null;
}

/** The stop half (deactivate/pause): flag-independent, always available. */
export interface PolicyStopOutcome {
  published: boolean;
  message: string;
}

export const consumersApi = {
  options: (siteId: string) =>
    request<ConsumerOptions>(`/api/v1/sites/${siteId}/consumer-options`),
  list: (siteId: string) => request<Consumer[]>(base(siteId)),
  /** Einen freien Ausgang dauerhaft ein- oder ausschalten (bleibt, bis erneut geschaltet wird). */
  ioAusgangSchalten: (siteId: string, entityId: string, channel: number, on: boolean) =>
    request<IoAusgangSchaltErgebnis>(
      `/api/v1/sites/${siteId}/io-modules/${entityId}/outputs/${channel}`,
      { method: 'PUT', body: JSON.stringify({ on }) },
    ),
  /** Die zuletzt gemeldeten Ein-/Ausgänge eines I/O-Moduls samt Zuordnung. */
  ioModulZustand: (siteId: string, entityId: string) =>
    request<IoModulZustandDto>(`/api/v1/sites/${siteId}/io-modules/${entityId}/zustand`),
  /**
   * Edge-reported live states (Inkrement 3, D9). An empty list is the honest
   * no-evidence state - the surface then renders exactly like before.
   */
  status: (siteId: string) =>
    request<import('./status').ConsumerRuntimeStatus[]>(
      `/api/v1/sites/${siteId}/consumer-status`).then((liste) => {
      // Schaltspur (vp-schalten-3s): jede frische Rückmeldung prüft die offenen Handeingriffe der Anlage.
      pruefeSpuren(siteId, liste);
      return liste;
    }),
  get: (siteId: string, id: string) => request<Consumer>(`${base(siteId)}/${id}`),
  create: (siteId: string, body: CreateConsumerBody) =>
    request<Consumer>(base(siteId), { method: 'POST', body: JSON.stringify(body) }),
  patch: (siteId: string, id: string, body: PatchConsumerBody) =>
    request<Consumer>(`${base(siteId)}/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  remove: (siteId: string, id: string) =>
    request<void>(`${base(siteId)}/${id}`, { method: 'DELETE' }),
  /** The latest policy, or null when none authored yet (endpoint answers 204). */
  getPolicy: async (siteId: string, id: string): Promise<ConsumerPolicyVersion | null> =>
    (await request<ConsumerPolicyVersion | undefined>(`${base(siteId)}/${id}/policy`)) ?? null,
  savePolicy: (siteId: string, id: string, document: ConsumerPolicyDocument) =>
    request<ConsumerPolicyVersion>(`${base(siteId)}/${id}/policy`, {
      method: 'PUT',
      body: JSON.stringify({ document }),
    }),
  /** Activate the latest saved draft (§11 atomic: validate → compile → rollout). */
  activatePolicy: (siteId: string, id: string) =>
    request<PolicyActivationOutcome>(`${base(siteId)}/${id}/policy/activate`, { method: 'POST' }),
  /** Retire the active rule + retract the generated automation (flag-independent). */
  deactivatePolicy: (siteId: string, id: string) =>
    request<PolicyStopOutcome>(`${base(siteId)}/${id}/policy/deactivate`, { method: 'POST' }),
  /** Pause: the device failsafe takes over; the rule stays stored (flag-independent). */
  pause: (siteId: string, id: string) =>
    request<PolicyStopOutcome>(`${base(siteId)}/${id}/pause`, { method: 'POST' }),
  /** Resume after a pause: re-enable + re-deploy the stored artifact. */
  resume: (siteId: string, id: string) =>
    request<PolicyActivationOutcome>(`${base(siteId)}/${id}/resume`, { method: 'POST' }),

  // -- fulfilment ledger + manual override (Inkrement 5) -------------------

  /** The fulfilment ledger of one consumer (§9.4): Ist derived from telemetry. */
  fulfillment: (siteId: string, id: string) =>
    request<import('./fulfillment').ConsumerFulfilment>(`${base(siteId)}/${id}/fulfillment`),
  /** Every ACTIVE (unexpired) manual override of the site's consumers. */
  overrides: (siteId: string) =>
    request<import('./fulfillment').ManualOverride[]>(
      `/api/v1/sites/${siteId}/consumer-overrides`),
  /** "Jetzt starten"/"Jetzt stoppen" (§14.13): a TTL-bound intervention. */
  startOverride: (
    siteId: string,
    id: string,
    body: {
      action: 'start' | 'stop';
      durationMinutes?: number;
      setpointKw?: number;
      stufe?: number;
      /** Heizstab, Handeingriff je Phase: die Kanäle der gewählten Ausgänge (heizstab-shelly.md). */
      ausgaenge?: number[];
    },
  ) => {
    const klick = spurKlick();
    return request<ConsumerOverrideOutcome>(`${base(siteId)}/${id}/override`, {
      method: 'POST',
      body: JSON.stringify(body),
    }).then((out) => {
      merkeSpur(siteId, id, out?.spur, {
        art: body.action,
        ausgaenge: out?.phasenGenau ? body.ausgaenge ?? null : null,
      }, klick);
      return out;
    });
  },
  /** "Automatik fortsetzen": end the manual intervention now. */
  clearOverride: (siteId: string, id: string) => {
    const klick = spurKlick();
    return request<ConsumerOverrideOutcome>(`${base(siteId)}/${id}/override`, { method: 'DELETE' })
      .then((out) => {
        merkeSpur(siteId, id, out?.spur, { art: 'zurueck' }, klick);
        return out;
      });
  },
  /** Die jüngsten Schaltspuren eines Verbrauchers - nur Plattform-Administration (Technik & Diagnose). */
  schaltspuren: (siteId: string, id: string) =>
    request<SchaltSpur[]>(`/api/v1/admin/sites/${siteId}/consumers/${id}/schaltspuren`),
};

// Die Portal-Zeiten einer Schaltspur gehen über dieselbe Anfrage-Schicht (Mandant, Kundenbereich, Token).
spurMeldeweg((siteId, entityId, spur, zeiten) =>
  request<void>(`${base(siteId)}/${entityId}/schaltspuren/${spur}/portal`, {
    method: 'POST',
    body: JSON.stringify(zeiten),
  }));

/**
 * Eine Schaltspur (`docs/contracts/v2/schaltspur.md`). `box*` in der Uhr der Box, alles übrige in der der API;
 * die Portal-Zeiten in Millisekunden ab dem Klick. `null` = dieser Schritt fand nicht statt oder ist nicht gemeldet.
 */
export interface SchaltSpur {
  id: string;
  deviceId: string | null;
  requestId: string;
  art: 'start' | 'stop' | 'zurueck';
  kommando: string | null;
  wert: number | null;
  ausgaenge: number[] | null;
  apiEingang: string;
  gesendet: string | null;
  zustellung: string | null;
  ersteMeldung: string | null;
  boxEmpfangen: string | null;
  boxEntschieden: string | null;
  boxGeschrieben: string | null;
  boxZurueckgelesen: string | null;
  boxGemeldet: string | null;
  boxUrteil: string | null;
  gehalten: string | null;
  grund: string | null;
  bestaetigt: string | null;
  ergebnis: 'offen' | 'bestaetigt' | 'gehalten' | 'abweichung' | 'ersetzt';
  portalAntwortMs: number | null;
  portalSichtbarMs: number | null;
}

/** The override start/stop/resume outcome (honest `pushed` while the flag is off). */
export interface ConsumerOverrideOutcome {
  applied: boolean;
  pushed: boolean;
  kind: string;
  endsAt: string | null;
  effectivePowerKw: number | null;
  gridImportPossible: boolean;
  ttlCapped: boolean;
  message: string;
  /** Nur bei einer Phasen-Wahl: ob die Box genau diese Phasen schaltet (`heizstab_phasen`). */
  phasenGenau?: boolean;
  /** Die Schaltspur dieses Eingriffs (vp-schalten-3s); fehlt, wenn die API keine anlegen konnte. */
  spur?: string;
}
