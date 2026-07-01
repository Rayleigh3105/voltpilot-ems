import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Badge } from '../../designsystem/components/core/Badge';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Input } from '../../designsystem/components/forms/Input';
import logoUrl from '../../designsystem/assets/voltpilot-logo.png';
import { currentUser, logout } from '../auth';
import { ApiError } from '../api';
import {
  adminApi,
  type AdminUser,
  type CreateSiteInput,
  type CreateTenantInput,
  type CreateUserInput,
  type Site,
  type Tenant,
} from './adminApi';

/**
 * Portal-Admin console (platform operators). Shown only when the logged-in user
 * carries the `platform-admin` realm role - see App.tsx. Portal-Users
 * (customers) never reach this; the backend also enforces it with 403.
 *
 * Kept self-contained under src/admin/ so the customer portal (App.tsx / Portal)
 * can evolve independently.
 */
export default function AdminApp() {
  const user = useMemo(() => currentUser(), []);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reloadTenants(selectId?: string) {
    setLoading(true);
    try {
      const t = await adminApi.listTenants();
      setTenants(t);
      setSelectedTenant((cur) => {
        const wanted = selectId ?? cur?.id ?? t[0]?.id ?? null;
        return t.find((x) => x.id === wanted) ?? null;
      });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reloadTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="vp-shell">
      <nav className="vp-nav">
        <div className="vp-container vp-nav-inner">
          <div className="vp-brand">
            <img src={logoUrl} alt="VoltPilot EMS" />
            <Badge variant="solid" title="Sie sind als Plattform-Administrator angemeldet">
              Admin-Konsole
            </Badge>
          </div>
          <div className="vp-nav-user">
            <div className="vp-nav-user-meta">
              <div className="vp-nav-user-name">{user.name}</div>
              {user.email && <div className="vp-nav-user-email">{user.email}</div>}
            </div>
            <Button variant="outline" size="sm" onClick={logout}>
              Abmelden
            </Button>
          </div>
        </div>
      </nav>

      <main className="vp-main">
        <div className="vp-container">
          <div className="vp-page-head">
            <h2>Plattform-Verwaltung</h2>
            <p>
              Mandanten und Kundenbenutzer plattformweit verwalten. Als Portal-Admin sind Sie{' '}
              <strong>nicht</strong> auf einen Mandanten beschränkt - Kundenkonten sehen nur ihren
              eigenen Mandanten.
            </p>
          </div>

          {error && <div className="vp-alert vp-alert-err">{error}</div>}

          <div className="vp-admin-grid">
            <TenantsPanel
              tenants={tenants}
              loading={loading}
              selected={selectedTenant}
              onSelect={setSelectedTenant}
              onCreated={(t) => reloadTenants(t.id)}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--vp-space-8)' }}>
              <SitesPanel tenant={selectedTenant} />
              <UsersPanel tenant={selectedTenant} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TenantsPanel({
  tenants,
  loading,
  selected,
  onSelect,
  onCreated,
}: {
  tenants: Tenant[];
  loading: boolean;
  selected: Tenant | null;
  onSelect: (t: Tenant) => void;
  onCreated: (t: Tenant) => void;
}) {
  return (
    <section className="vp-section" style={{ marginTop: 0 }}>
      <div className="vp-section-title">
        <IconTile category="industry" size={40}>
          ⌂
        </IconTile>
        <h3>Mandanten</h3>
        <Badge variant="tint">{tenants.length}</Badge>
      </div>

      {loading ? (
        <p className="vp-muted">Lade Mandanten…</p>
      ) : tenants.length === 0 ? (
        <p className="vp-muted">Noch keine Mandanten. Legen Sie unten den ersten an.</p>
      ) : (
        <div className="vp-grid vp-grid-sites">
          {tenants.map((t) => (
            <Card
              key={t.id}
              interactive
              accent="industry"
              className={`vp-selectable ${selected?.id === t.id ? 'vp-selected' : ''}`}
              onClick={() => onSelect(t)}
            >
              <h4 style={{ marginBottom: 8 }}>{t.name}</h4>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge variant="tint">{t.segment}</Badge>
                <Badge variant="tint">{t.plan}</Badge>
                <span className="vp-mono" title="Mandanten-ID (tenant_id)">
                  {t.id.slice(0, 8)}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateTenantForm onCreated={onCreated} />
    </section>
  );
}

function CreateTenantForm({ onCreated }: { onCreated: (t: Tenant) => void }) {
  const [name, setName] = useState('');
  const [segment, setSegment] = useState('CI');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const input: CreateTenantInput = { name: name.trim(), segment };
      const t = await adminApi.createTenant(input);
      setMsg({ ok: true, text: `Mandant "${t.name}" angelegt.` });
      setName('');
      onCreated(t);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? `Fehler: ${e.message}` : 'Anlegen fehlgeschlagen.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padding="lg" radius="lg" style={{ marginTop: 24 }}>
      <h4 style={{ marginBottom: 12 }}>Neuen Mandanten anlegen</h4>
      <div className="vp-field-row">
        <div style={{ flex: '1 1 240px' }}>
          <Input
            label="Name"
            placeholder="z. B. Stadtwerke Musterstadt"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor="tenant-segment" style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Segment
          </label>
          <select
            id="tenant-segment"
            className="vp-select"
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
          >
            <option value="CI">CI (Gewerbe/Industrie)</option>
            <option value="B2C">B2C (Privat)</option>
          </select>
        </div>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? 'Lege an…' : 'Mandant anlegen'}
        </Button>
      </div>
      {msg && <div className={`vp-alert ${msg.ok ? 'vp-alert-ok' : 'vp-alert-err'}`}>{msg.text}</div>}
    </Card>
  );
}

function SitesPanel({ tenant }: { tenant: Tenant | null }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!tenant) return;
    setLoading(true);
    setError(null);
    try {
      setSites(await adminApi.listSites(tenant.id));
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id]);

  if (!tenant) {
    return (
      <section className="vp-section" style={{ marginTop: 0 }}>
        <div className="vp-section-title">
          <IconTile category="home" size={40}>
            ⌂
          </IconTile>
          <h3>Standorte</h3>
        </div>
        <p className="vp-muted">Wählen Sie links einen Mandanten, um dessen Standorte zu verwalten.</p>
      </section>
    );
  }

  return (
    <section className="vp-section" style={{ marginTop: 0 }}>
      <div className="vp-section-title">
        <IconTile category="home" size={40}>
          ⌂
        </IconTile>
        <h3>Standorte</h3>
        <Badge variant="tint" title="Mandant">
          {tenant.name}
        </Badge>
      </div>

      <Card padding="lg" radius="lg">
        {error && <div className="vp-alert vp-alert-err">{error}</div>}
        {loading ? (
          <p className="vp-muted">Lade Standorte…</p>
        ) : sites.length === 0 ? (
          <p className="vp-muted">
            Noch keine Standorte für diesen Mandanten. Legen Sie unten den ersten an -
            danach kann der Kunde Geräte hineinbeanspruchen.
          </p>
        ) : (
          <table className="vp-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Gebotszone</th>
                <th>Koordinaten</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>
                    <Badge variant="tint">{s.biddingZone}</Badge>
                  </td>
                  <td className="vp-mono">
                    {s.latitude != null && s.longitude != null
                      ? `${s.latitude}, ${s.longitude}`
                      : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <CreateSiteForm tenant={tenant} onCreated={reload} />
      </Card>
    </section>
  );
}

function CreateSiteForm({ tenant, onCreated }: { tenant: Tenant; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [biddingZone, setBiddingZone] = useState('DE-LU');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function parseCoord(v: string): number | null | undefined {
    if (!v.trim()) return undefined;
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }

  async function submit() {
    if (!name.trim()) return;
    const lat = parseCoord(latitude);
    const lon = parseCoord(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      setMsg({ ok: false, text: 'Bitte gültige Koordinaten eingeben (oder leer lassen).' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const input: CreateSiteInput = {
        name: name.trim(),
        biddingZone,
        latitude: lat ?? null,
        longitude: lon ?? null,
      };
      const site = await adminApi.createSite(tenant.id, input);
      setMsg({ ok: true, text: `Standort "${site.name}" für ${tenant.name} angelegt.` });
      setName('');
      setLatitude('');
      setLongitude('');
      onCreated();
    } catch (e) {
      setMsg({
        ok: false,
        text:
          e instanceof ApiError && e.status === 400
            ? 'Ungültige Eingabe. Prüfen Sie Name und Koordinaten.'
            : e instanceof ApiError
              ? `Fehler: ${e.message}`
              : 'Anlegen fehlgeschlagen.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={{ marginBottom: 4 }}>Standort anlegen</h4>
      <p className="vp-note" style={{ marginBottom: 12 }}>
        Wird für den Mandanten {tenant.name} ({tenant.id.slice(0, 8)}) angelegt. Der Kunde
        sieht ihn sofort in seinem Portal und kann Geräte hineinbeanspruchen.
      </p>
      <div className="vp-admin-form">
        <Input label="Name *" placeholder="z. B. Werk Nord" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <label htmlFor={`admin-site-zone-${tenant.id}`} style={{ fontSize: '0.9rem', fontWeight: 600 }}>
            Gebotszone
          </label>
          <select
            id={`admin-site-zone-${tenant.id}`}
            className="vp-select"
            value={biddingZone}
            onChange={(e) => setBiddingZone(e.target.value)}
          >
            <option value="DE-LU">DE-LU (Deutschland/Luxemburg)</option>
            <option value="AT">AT (Österreich)</option>
            <option value="CH">CH (Schweiz)</option>
          </select>
        </div>
        <Input label="Breitengrad" placeholder="z. B. 52.52" value={latitude} onChange={(e) => setLatitude(e.target.value)} />
        <Input label="Längengrad" placeholder="z. B. 13.405" value={longitude} onChange={(e) => setLongitude(e.target.value)} />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button variant="primary" fullWidth onClick={submit} disabled={busy || !name.trim()}>
            {busy ? 'Lege an…' : 'Standort anlegen'}
          </Button>
        </div>
      </div>
      {msg && <div className={`vp-alert ${msg.ok ? 'vp-alert-ok' : 'vp-alert-err'}`}>{msg.text}</div>}
    </div>
  );
}

function UsersPanel({ tenant }: { tenant: Tenant | null }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (!tenant) return;
    setLoading(true);
    setError(null);
    try {
      setUsers(await adminApi.listUsers(tenant.id));
    } catch (e) {
      setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id]);

  if (!tenant) {
    return (
      <section className="vp-section" style={{ marginTop: 0 }}>
        <div className="vp-section-title">
          <IconTile category="primary" size={40}>
            ☺
          </IconTile>
          <h3>Kundenbenutzer</h3>
        </div>
        <p className="vp-muted">Wählen Sie links einen Mandanten, um dessen Benutzer zu verwalten.</p>
      </section>
    );
  }

  async function disable(u: AdminUser) {
    if (!tenant) return;
    try {
      await adminApi.disableUser(tenant.id, u.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? `Deaktivieren fehlgeschlagen: ${e.message}` : 'Fehler');
    }
  }

  return (
    <section className="vp-section" style={{ marginTop: 0 }}>
      <div className="vp-section-title">
        <IconTile category="primary" size={40}>
          ☺
        </IconTile>
        <h3>Kundenbenutzer</h3>
        <Badge variant="tint" title="Mandant">
          {tenant.name}
        </Badge>
      </div>

      <Card padding="lg" radius="lg">
        {error && <div className="vp-alert vp-alert-err">{error}</div>}
        {loading ? (
          <p className="vp-muted">Lade Benutzer…</p>
        ) : users.length === 0 ? (
          <p className="vp-muted">Noch keine Benutzer für diesen Mandanten.</p>
        ) : (
          <table className="vp-table">
            <thead>
              <tr>
                <th>Benutzername</th>
                <th>E-Mail</th>
                <th>Status</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="vp-mono">{u.username}</td>
                  <td>{u.email ?? '-'}</td>
                  <td>
                    <Badge variant={u.enabled ? 'gradient' : 'tint'}>
                      {u.enabled ? 'aktiv' : 'deaktiviert'}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {u.enabled && (
                      <Button variant="ghost" size="sm" onClick={() => disable(u)}>
                        Deaktivieren
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <CreateUserForm tenant={tenant} onCreated={reload} />
      </Card>
    </section>
  );
}

function CreateUserForm({ tenant, onCreated }: { tenant: Tenant; onCreated: () => void }) {
  const [form, setForm] = useState<CreateUserInput>({ username: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (k: keyof CreateUserInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    if (!form.username.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const u = await adminApi.createUser(tenant.id, {
        username: form.username.trim(),
        email: form.email?.trim() || undefined,
        firstName: form.firstName?.trim() || undefined,
        lastName: form.lastName?.trim() || undefined,
        password: form.password?.trim() || undefined,
        temporaryPassword: false,
      });
      setMsg({ ok: true, text: `Benutzer "${u.username}" für ${tenant.name} angelegt.` });
      setForm({ username: '', email: '', password: '', firstName: '', lastName: '' });
      onCreated();
    } catch (e) {
      const text =
        e instanceof ApiError && e.status === 409
          ? 'Benutzername oder E-Mail existiert bereits.'
          : e instanceof ApiError
            ? `Fehler: ${e.message}`
            : 'Anlegen fehlgeschlagen.';
      setMsg({ ok: false, text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h4 style={{ marginBottom: 4 }}>Kundenbenutzer anlegen</h4>
      <p className="vp-note" style={{ marginBottom: 12 }}>
        Wird in Keycloak mit dem Mandanten ({tenant.id.slice(0, 8)}) und der Kundenrolle
        angelegt - der Benutzer sieht nach der Anmeldung nur diesen Mandanten.
      </p>
      <div className="vp-admin-form">
        <Input label="Benutzername *" placeholder="z. B. kunde-01" value={form.username} onChange={set('username')} />
        <Input label="E-Mail" type="email" placeholder="kunde@example.com" value={form.email ?? ''} onChange={set('email')} />
        <Input label="Vorname" value={form.firstName ?? ''} onChange={set('firstName')} />
        <Input label="Nachname" value={form.lastName ?? ''} onChange={set('lastName')} />
        <Input
          label="Initiales Passwort"
          type="password"
          placeholder="mind. 6 Zeichen"
          value={form.password ?? ''}
          onChange={set('password')}
        />
        <div style={{ display: 'flex', alignItems: 'flex-end' }}>
          <Button variant="primary" fullWidth onClick={submit} disabled={busy || !form.username.trim()}>
            {busy ? 'Lege an…' : 'Benutzer anlegen'}
          </Button>
        </div>
      </div>
      {msg && <div className={`vp-alert ${msg.ok ? 'vp-alert-ok' : 'vp-alert-err'}`}>{msg.text}</div>}
    </div>
  );
}
