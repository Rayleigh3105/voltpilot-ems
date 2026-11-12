package com.voltpilot.api.web;

import com.voltpilot.api.admin.AdminAnfrageKennungen;
import com.voltpilot.api.admin.AdminBenutzerService;
import com.voltpilot.api.admin.KeycloakAdminClient;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakAdminException;
import com.voltpilot.api.admin.KeycloakAdminClient.KeycloakUser;
import com.voltpilot.api.geraete.BoxLoesenAbgelehnt;
import com.voltpilot.api.geraete.BoxLoesenService;
import com.voltpilot.api.kundenbereich.KundenbereichLoeschung;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.AdminEnrollmentRepository;
import com.voltpilot.api.repo.AdminProvisionedDeviceRepository;
import com.voltpilot.api.repo.AdminSiteRepository;
import com.voltpilot.api.repo.TenantRepository;
import com.voltpilot.api.repo.TenantRepository.OffboardCounts;
import com.voltpilot.api.repo.TenantRepository.TenantDevice;
import com.voltpilot.api.web.dto.AdminUserDto;
import com.voltpilot.api.web.dto.CreateSiteRequest;
import com.voltpilot.api.web.dto.CreateTenantRequest;
import com.voltpilot.api.web.dto.CreateUserRequest;
import com.voltpilot.api.web.dto.DeleteTenantRequest;
import com.voltpilot.api.web.dto.PendingEnrollmentDto;
import com.voltpilot.api.web.dto.ProvisionDeviceRequest;
import com.voltpilot.api.web.dto.ProvisionedDeviceDto;
import com.voltpilot.api.web.dto.SiteDto;
import com.voltpilot.api.web.dto.TenantDto;
import com.voltpilot.api.web.dto.TenantOffboardingReportDto;
import com.voltpilot.api.web.dto.TenantOffboardingCleanupDto;
import com.voltpilot.api.web.dto.UpdateTenantRequest;
import com.voltpilot.api.web.dto.UpdateUserRequest;
import com.voltpilot.api.benutzer.BenutzerService;
import com.voltpilot.api.uems.ProtokollAkteur;
import org.springframework.security.core.Authentication;
import jakarta.validation.Valid;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Platform-admin API: manage tenants and customer users across the whole
 * platform. Every method is gated by {@code hasRole('platform-admin')}, so a
 * Portal-User (customer, tenant-scoped) calling any of these gets HTTP 403 -
 * the backend, not the UI, is the boundary between operators and customers.
 *
 * <p>Tenants are read/written through the {@code voltpilot_admin} BYPASSRLS
 * datasource ({@link TenantRepository}); users are provisioned in Keycloak
 * ({@link KeycloakAdminClient}) with the {@code tenant_id} attribute + customer
 * role, so the existing OIDC + RLS spine isolates them exactly like the seeded
 * demo tenants. Customer data endpoints (sites/telemetry) stay RLS-scoped and
 * untouched.
 */
@RestController
@RequestMapping("/api/v1/admin")
@PreAuthorize("hasRole('platform-admin')")
public class AdminController {

    private static final Logger log = LoggerFactory.getLogger(AdminController.class);

    private final TenantRepository tenants;
    private final AdminSiteRepository sites;
    private final AdminProvisionedDeviceRepository provisionedDevices;
    private final AdminEnrollmentRepository enrollments;
    private final KeycloakAdminClient keycloak;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final BenutzerService benutzer;
    private final AdminBenutzerService adminBenutzer;
    private final KundenbereichLoeschung loeschung;
    private final BoxLoesenService boxLoesen;
    private final AdminAnfrageKennungen anfrageKennungen;
    private final AnfrageKennungen fingerabdrucke;

    public AdminController(TenantRepository tenants, AdminSiteRepository sites,
            AdminProvisionedDeviceRepository provisionedDevices,
            AdminEnrollmentRepository enrollments, KeycloakAdminClient keycloak,
            ObjectProvider<ProvisioningPublisher> provisioning, BenutzerService benutzer,
            AdminBenutzerService adminBenutzer, KundenbereichLoeschung loeschung, BoxLoesenService boxLoesen,
            AdminAnfrageKennungen anfrageKennungen, AnfrageKennungen fingerabdrucke) {
        this.tenants = tenants;
        this.sites = sites;
        this.provisionedDevices = provisionedDevices;
        this.enrollments = enrollments;
        this.keycloak = keycloak;
        this.provisioning = provisioning;
        this.benutzer = benutzer;
        this.adminBenutzer = adminBenutzer;
        this.loeschung = loeschung;
        this.boxLoesen = boxLoesen;
        this.anfrageKennungen = anfrageKennungen;
        this.fingerabdrucke = fingerabdrucke;
    }

    // ---- tenants -------------------------------------------------------------

    /** Die Route der Anfrage-Kennung beim Anlegen (Tabelle {@code admin_anfrage_kennung}). */
    static final String ROUTE_KUNDE_ANLEGEN = "POST /api/v1/admin/tenants";

    @GetMapping("/tenants")
    public List<TenantDto> listTenants() {
        return tenants.findAll();
    }

    /**
     * Befund vp-kundenakte-fremde-personen (Punkt 5, doppelter Kunde): dieselbe Anfrage-Kennung legt
     * nie ein zweites Mal an - ein Doppelklick oder das Wiederholen nach einem Netzfehler bekommt den
     * Kunden der ersten Antwort zurück. {@code tenant.name} bleibt bewusst nicht eindeutig (zwei
     * Privatkunden dürfen gleich heißen); das Portal warnt zusätzlich vor einem gleichen Namen.
     */
    @PostMapping("/tenants")
    public ResponseEntity<?> createTenant(@Valid @RequestBody CreateTenantRequest request,
            @RequestHeader(value = AnfrageKennungen.KOPF, required = false) String anfrageKopf,
            @AuthenticationPrincipal Jwt caller) {
        String kennung = AnfrageKennungen.kennung(anfrageKopf);
        if (kennung == null) {
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(tenants.create(request.name(), request.segmentOrDefault()));
        }
        return anfrageKennungen.einmal(caller.getSubject(), ROUTE_KUNDE_ANLEGEN, kennung,
                fingerabdrucke.fingerabdruck(request), HttpStatus.CREATED,
                () -> tenants.create(request.name(), request.segmentOrDefault()));
    }

    /** Update a tenant's master data (name/segment/betriebsart - U0 shell frame). */
    @PutMapping("/tenants/{tenantId}")
    public TenantDto updateTenant(@PathVariable UUID tenantId,
            @Valid @RequestBody UpdateTenantRequest request) {
        TenantDto updated = tenants.update(tenantId, request.name().trim(),
                request.segmentOrDefault(), request.betriebsartOrNull());
        if (updated == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
        return updated;
    }

    /**
     * Offboard a tenant - the most destructive action on the platform, so it is
     * type-to-confirm: the body must carry the tenant's EXACT name or nothing
     * happens (400). The database cascade (sites, devices, assets, all series
     * data, the tenant row) runs in ONE transaction, AFTER all accounts have been
     * disabled through the shared account path. Failed final deletions leave disabled
     * accounts and are reported/logged; the cleanup route can repeat them without a tenant row.
     *
     * <p>UEMS AP-20 IP-18 (E10 = A, BT4, BT5): only a tenant in the state „beendet" whose period has run out
     * ({@code 409 kundenbereich_nicht_beendet} / {@code 409 frist_laeuft}, checked BEFORE any account is blocked and
     * again under the row lock in the teardown); the same transaction writes the deletion record
     * {@code mandant_loeschnachweis} without the customer's personal data ({@link KundenbereichLoeschung}).
     */
    @PostMapping("/tenants/{tenantId}/delete")
    public TenantOffboardingReportDto deleteTenant(@PathVariable UUID tenantId,
            @Valid @RequestBody DeleteTenantRequest request, Authentication auth) {
        TenantDto tenant = tenants.findById(tenantId);
        if (tenant == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
        if (!tenant.name().equals(request.confirmName().trim())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "confirmName does not match the tenant name");
        }
        KundenbereichLoeschung.Anlass anlass = loeschung.pruefen(tenantId);
        ProtokollAkteur akteur = ProtokollAkteur.aus(auth)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED));
        KundenbereichLoeschung.Wache wache = loeschung.wache(tenantId, akteur);

        // Collected BEFORE the cascade: afterwards the rows are gone.
        List<TenantDevice> devices = tenants.devicesOfTenant(tenantId);
        List<KeycloakUser> users;
        try {
            users = new ArrayList<>(adminBenutzer.offboardingSperren(tenantId));
        } catch (RuntimeException ex) {
            log.warn("Offboarding tenant {}: account blocking failed; database retained", tenantId);
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Konten konnten nicht vollständig gesperrt werden.");
        }

        // Sofort-Weg (vp-kunde-sofort-loeschen): nie gemeldete Boxen VOR dem Abbau über den Dienst
        // „Vom Kunden lösen" freigeben - Broker, Zugang, Registry, Rollouts, Zertifizierung räumen wie
        // beim Lösen von Hand, die Kennung ist sofort wieder anmeldbar. Eine Box, die sich doch gemeldet
        // hat, lehnt dort mit 409 ab, bevor der Abbau beginnt (die Konten sind dann schon gesperrt -
        // derselbe wiederholbare Zwischenstand wie bei einem DB-Fehler). Ausgebaute Boxen gehen über die
        // Kaskade. Der Frist-Weg bleibt unverändert (Kaskade wie bisher).
        List<String> freigegeben = new ArrayList<>();
        if (anlass == KundenbereichLoeschung.Anlass.SOFORT_KEINE_DATEN) {
            for (TenantDevice device : devices) {
                if (boxLoesen.beimKundenLoeschen(device.externalRef(), akteur)) {
                    freigegeben.add(device.externalRef());
                }
            }
        }

        OffboardCounts counts;
        try {
            counts = tenants.offboard(tenantId, () -> {
                // Close the gap between the blocking commit and the teardown transaction:
                // a concurrent account enable/create must not leave an enabled orphan.
                List<KeycloakUser> current = adminBenutzer.offboardingResteSperren(tenantId);
                users.clear();
                users.addAll(current);
            }, wache);
        } catch (KundenbereichLoeschung.Verweigert ex) {
            log.warn("Offboarding tenant {}: refused under the row lock ({}); accounts remain disabled", tenantId,
                    ex.getMessage());
            throw ex;
        } catch (RuntimeException ex) {
            // vp-kunde-loeschen-500: die EINE Transaktion ist zurückgerollt - nichts ist gelöscht, nur die
            // Konten bleiben gesperrt, der Weg ist wiederholbar. Der Fehler gehört mit Stack ins Log (vorher
            // ging er ohne unter) und als ehrlicher Satz ans Portal - ein 500 ist kein „Server nicht
            // erreichbar" (Muster G6/m4 in api.ts: ein deutsches message-Feld ersetzt den Pauschalsatz).
            log.error("Offboarding tenant {}: database removal failed; accounts remain disabled; retry offboarding",
                    tenantId, ex);
            throw new LoeschzugFehlgeschlagen();
        }

        // Broker cleanup (best-effort): clear each device's retained
        // provisioning config + schedule so the hardware falls back to its
        // watchdog default and the refs become claimable again.
        provisioning.ifAvailable(p -> devices.forEach(d -> {
            try {
                p.clearRetained(d.externalRef(), tenantId, d.siteId(), d.id());
            } catch (RuntimeException ex) {
                log.warn("Offboarding tenant {}: retained cleanup failed for device {}", tenantId, d.id());
            }
        }));

        TenantOffboardingCleanupDto cleanup = deleteOffboardingUsers(tenantId, users);
        log.info("Offboarded tenant {} ('{}'): {} sites, {} devices, {} telemetry rows, "
                + "{} users deleted, {} disabled users pending cleanup", tenantId, tenant.name(),
                counts.sites(), counts.devices(), counts.telemetryRows(),
                cleanup.deletedUsers().size(), cleanup.failedUsers().size());
        KundenbereichLoeschung.Nachweis nachweis = wache.nachweis();
        log.info("Offboarded tenant {}: deletion record {}, {} tables with remaining rows", tenantId,
                nachweis.kennzeichen(), nachweis.verblieben().size());
        return new TenantOffboardingReportDto(tenantId, tenant.name(), counts.sites(),
                counts.devices() + freigegeben.size(), counts.telemetryRows(), cleanup.deletedUsers(),
                cleanup.failedUsers(), nachweis.anlass().wert(), List.copyOf(freigegeben),
                new TenantOffboardingReportDto.Loeschnachweis(nachweis.kennzeichen(), nachweis.geloeschtAm(),
                        nachweis.zaehlungen(), nachweis.verblieben(), nachweis.abzugSha256()));
    }

    /** IP-18: the delete route's refusal in the form of the UEMS refusals ({@code code}, {@code message}, facts). */
    @ExceptionHandler(KundenbereichLoeschung.Verweigert.class)
    public ResponseEntity<Map<String, Object>> loeschenVerweigert(KundenbereichLoeschung.Verweigert ex) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(ex.koerper());
    }

    /** Der Löschzug scheiterte und wurde ganz zurückgerollt; die Konten bleiben gesperrt (vp-kunde-loeschen-500). */
    static final class LoeschzugFehlgeschlagen extends RuntimeException {
    }

    /** Ein 500 des Löschwegs sagt dem Portal, was wirklich geschah - statt „Server nicht erreichbar". */
    @ExceptionHandler(LoeschzugFehlgeschlagen.class)
    public ResponseEntity<Map<String, Object>> loeschenFehlgeschlagen(LoeschzugFehlgeschlagen ex) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                "code", "loeschen_fehlgeschlagen",
                "message", "Beim Löschen ist ein Fehler aufgetreten - es wurde nichts gelöscht."
                        + " Die Konten des Kunden bleiben gesperrt; bitte versuchen Sie es erneut."));
    }

    /** Sofort-Weg: eine Box hat sich zwischen Prüfung und Freigabe doch gemeldet - dieselbe 409 wie beim Lösen. */
    @ExceptionHandler(BoxLoesenAbgelehnt.class)
    public ResponseEntity<Map<String, Object>> boxLoesenAbgelehnt(BoxLoesenAbgelehnt ex) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(ex.koerper());
    }

    /** Only the platform may repeat cleanup, and only after the tenant's data has been removed. */
    @PostMapping("/tenants/{tenantId}/offboarding/cleanup")
    public TenantOffboardingCleanupDto cleanupTenantUsers(@PathVariable UUID tenantId) {
        if (tenants.findById(tenantId) != null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Mandant ist noch vorhanden.");
        }
        List<KeycloakUser> users;
        try {
            // Also covers legacy orphans and a crash after DB commit but before final deletion.
            users = adminBenutzer.offboardingResteSperren(tenantId);
        } catch (RuntimeException ex) {
            log.warn("Offboarding tenant {}: cleanup blocking failed; no accounts deleted", tenantId);
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Konten konnten nicht vollständig gesperrt werden.");
        }
        return deleteOffboardingUsers(tenantId, users);
    }

    private TenantOffboardingCleanupDto deleteOffboardingUsers(UUID tenantId, List<KeycloakUser> users) {
        List<String> deletedUsers = new ArrayList<>();
        List<String> failedUsers = new ArrayList<>();
        for (KeycloakUser user : users) {
            try {
                keycloak.deleteUser(user.id());
                deletedUsers.add(user.username());
            } catch (RuntimeException ex) {
                if (ex instanceof KeycloakAdminException kc && kc.status() == 404) {
                    deletedUsers.add(user.username()); // Another retry already removed it.
                    continue;
                }
                log.warn("Offboarding tenant {}: disabled Keycloak user {} pending cleanup", tenantId, user.id());
                failedUsers.add(user.username());
            }
        }
        log.info("Offboarding cleanup tenant {}: {} deleted, {} disabled users pending cleanup",
                tenantId, deletedUsers.size(), failedUsers.size());
        return new TenantOffboardingCleanupDto(tenantId, deletedUsers, failedUsers);
    }

    // ---- sites (cross-tenant) ------------------------------------------------

    @GetMapping("/tenants/{tenantId}/sites")
    public List<SiteDto> listSites(@PathVariable UUID tenantId) {
        requireTenant(tenantId);
        return sites.findByTenant(tenantId);
    }

    @PostMapping("/tenants/{tenantId}/sites")
    public ResponseEntity<SiteDto> createSite(@PathVariable UUID tenantId,
            @Valid @RequestBody CreateSiteRequest request) {
        requireTenant(tenantId);
        SiteDto created = sites.create(tenantId, request.name().trim(),
                request.biddingZoneOrDefault(), request.latitude(), request.longitude(),
                request.plantKindOrDefault(), request.anzulegenderWertCtKwh(),
                request.tarifArtOrDefault(), request.tarifParamOrNull(), request.netzladenErlaubt(),
                request.maxFeedInKw());
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    // ---- provisioned devices (manufacturing registry) -------------------------

    @GetMapping("/provisioned-devices")
    public List<ProvisionedDeviceDto> listProvisionedDevices() {
        return provisionedDevices.findAll();
    }

    /**
     * Register a manufactured sticker Geräte-ID so a customer can claim it.
     * Idempotent: re-registering (a re-run manufacturing batch) returns 200 with
     * the existing entry instead of an error.
     */
    @PostMapping("/provisioned-devices")
    public ResponseEntity<ProvisionedDeviceDto> provisionDevice(
            @Valid @RequestBody ProvisionDeviceRequest request) {
        String externalRef = DeviceController.canonicalExternalRef(request.externalRef());
        if (!externalRef.startsWith(DeviceController.STICKER_PREFIX)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Geräte-ID must use the sticker format (prefix "
                            + DeviceController.STICKER_PREFIX + ")");
        }
        String note = request.note() == null || request.note().isBlank()
                ? null : request.note().trim();
        return provisionedDevices.insertIfAbsent(externalRef, request.kindOrDefault(), note)
                .map(created -> ResponseEntity.status(HttpStatus.CREATED).body(created))
                .orElseGet(() -> ResponseEntity.ok(provisionedDevices.find(externalRef).orElseThrow()));
    }

    // ---- enrollments (enrolled-but-unclaimed devices) ------------------------

    /**
     * Enrolled-but-unclaimed devices: a device uploaded a CSR and is polling for
     * its certificate, but no matching {@code device} row exists (the ref was
     * never claimed, or was unclaimed after issuance). This is the operator's
     * window onto the mistyped-reference dead-end - a device that "did its part"
     * while the customer typed a different ref, otherwise invisible on both
     * sides. Read-only; the device-facing poll stays opaque (no enumeration).
     */
    @GetMapping("/enrollments/pending")
    public List<PendingEnrollmentDto> listPendingEnrollments() {
        return enrollments.findPending();
    }

    /**
     * Remove a dead enrollment from the Geräte-Liste: a mistyped reference
     * that never got claimed, or a box that was once issued a certificate and
     * is now disconnected without a re-claim. 404 if the ref is unknown or a
     * customer claimed it in the meantime - the operator's list can be a few
     * seconds stale.
     */
    @DeleteMapping("/enrollments/pending/{externalRef}")
    public ResponseEntity<Void> deletePendingEnrollment(@PathVariable String externalRef) {
        String canonical = DeviceController.canonicalExternalRef(externalRef);
        if (!enrollments.delete(canonical)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND,
                    "Enrollment '" + canonical + "' not found or claimed by a customer");
        }
        return ResponseEntity.noContent().build();
    }

    /**
     * Personensuche über ALLE Kunden (Lücke L6, Adminview-Konzept Abschnitt
     * 3.4/4.5): die Suche im Raum Benutzer findet damit Personen SERVERSEITIG
     * statt nur über die geladenen Listen eines einzelnen Mandanten.
     * Keycloaks eigene realmweite {@code search} deckt das in einem Aufruf ab
     * ({@link KeycloakAdminClient#searchUsers}); jedes Konto trägt sein
     * {@code tenantId} (oder {@code null} für ein Konto ohne das Attribut).
     * Eine leere oder fehlende Suche liefert eine leere Liste, nie den ganzen
     * Realm.
     */
    @GetMapping("/personen")
    public List<AdminUserDto> personensuche(@RequestParam(required = false) String suche) {
        if (suche == null || suche.isBlank()) {
            return List.of();
        }
        try {
            return keycloak.searchUsers(suche).stream().map(AdminController::toDto).toList();
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    // ---- customer users ------------------------------------------------------

    @GetMapping("/tenants/{tenantId}/users")
    public List<AdminUserDto> listUsers(@PathVariable UUID tenantId) {
        requireTenant(tenantId);
        try {
            return keycloak.listUsersForTenant(tenantId).stream().map(AdminController::toDto).toList();
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    @PostMapping("/tenants/{tenantId}/users")
    public ResponseEntity<BenutzerService.Angelegt> createUser(@PathVariable UUID tenantId,
            @Valid @RequestBody CreateUserRequest request, Authentication auth) {
        requireTenant(tenantId);
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(org.springframework.http.CacheControl.noStore())
                .body(benutzer.erster(tenantId, new BenutzerService.Anlage(request.username(), request.email(),
                        request.firstName(), request.lastName(), null, List.of(), null),
                        ProtokollAkteur.aus(auth).orElseThrow()));
    }

    /**
     * Update a customer user's profile - name, email, and (P3) the username. Keycloak UND der UEMS-Spiegel
     * ({@code benutzer.anzeigename}/{@code email}, P1/N1) ändern sich in EINER Transaktion, mit Protokoll
     * {@code konto_geaendert} ({@link AdminBenutzerService#profilAendern}).
     */
    @PutMapping("/tenants/{tenantId}/users/{userId}")
    public AdminUserDto updateUser(@PathVariable UUID tenantId, @PathVariable String userId,
            @Valid @RequestBody UpdateUserRequest request) {
        requireTenant(tenantId);
        try {
            return toDto(adminBenutzer.profilAendern(tenantId, userId, request.username(), request.email(),
                    request.firstName(), request.lastName()));
        } catch (KeycloakAdminException ex) {
            // N5: ein Anmeldename-Konflikt (P3) trägt einen genaueren Code (anmeldename_vergeben) - den
            // lässt die globale Antwort (BenutzerFehlerAntwort) durch statt ihn hier zu verlieren.
            if (ex.code() != null) {
                throw ex;
            }
            throw toResponse(ex);
        }
    }

    @PostMapping("/tenants/{tenantId}/users/{userId}/disable")
    public AdminUserDto disableUser(@PathVariable UUID tenantId, @PathVariable String userId,
            @AuthenticationPrincipal Jwt caller) {
        requireNotSelf(caller, userId, "deaktivieren");
        requireTenant(tenantId);
        try {
            return toDto(adminBenutzer.sperren(tenantId, userId));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    /** Re-enable a disabled user (the counterpart to disable). */
    @PostMapping("/tenants/{tenantId}/users/{userId}/enable")
    public AdminUserDto enableUser(@PathVariable UUID tenantId, @PathVariable String userId) {
        requireTenant(tenantId);
        try {
            return toDto(adminBenutzer.aktivieren(tenantId, userId));
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    /** Permanently delete a customer user's login. */
    @DeleteMapping("/tenants/{tenantId}/users/{userId}")
    public ResponseEntity<Void> deleteUser(@PathVariable UUID tenantId,
            @PathVariable String userId, @AuthenticationPrincipal Jwt caller) {
        requireNotSelf(caller, userId, "löschen");
        requireTenant(tenantId);
        try {
            adminBenutzer.entfernen(tenantId, userId);
            return ResponseEntity.noContent().build();
        } catch (KeycloakAdminException ex) {
            throw toResponse(ex);
        }
    }

    /**
     * N6: der Plattform-Admin vergibt ein neues Startpasswort - der Live-Login nennt „Support" als Weg bei
     * vergessenem Passwort, aber vor N6 gab es für den Admin selbst keinen (403, nur im Mandantensprung über
     * die Kundenseite). Derselbe Weg wie der Kundenadministrator ({@link BenutzerService#neuVergeben}).
     */
    @PostMapping("/tenants/{tenantId}/users/{userId}/reset-password")
    public BenutzerService.Angelegt resetPassword(@PathVariable UUID tenantId, @PathVariable String userId) {
        requireTenant(tenantId);
        return adminBenutzer.neuesStartpasswort(tenantId, userId);
    }

    /**
     * P2: „Person hinzufügen" - weitere Personen eines Kundenbereichs, nicht nur die erste (W4 fällt,
     * `rechte-matrix.json` „benutzer.verwalten"). Rolle und Standorte wie der Kundenadministrator; das
     * Zugriffsprotokoll des Kunden zeigt den Urheber VoltPilot-Betrieb ({@link ProtokollAkteur}).
     */
    @PostMapping("/tenants/{tenantId}/personen")
    public ResponseEntity<BenutzerService.Angelegt> person(@PathVariable UUID tenantId,
            @RequestBody BenutzerService.Anlage request) {
        requireTenant(tenantId);
        return ResponseEntity.status(HttpStatus.CREATED).cacheControl(org.springframework.http.CacheControl.noStore())
                .body(adminBenutzer.person(tenantId, request));
    }

    /**
     * Remove a wrongly registered sticker Geräte-ID from the manufacturing
     * registry. Refused (409) while a customer's claim references it - the
     * device must be unclaimed first, so the registry can never contradict a
     * live device.
     */
    @DeleteMapping("/provisioned-devices/{externalRef}")
    public ResponseEntity<Void> deleteProvisionedDevice(@PathVariable String externalRef) {
        String canonical = DeviceController.canonicalExternalRef(externalRef);
        ProvisionedDeviceDto entry = provisionedDevices.find(canonical)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "Provisioned device not found"));
        if (entry.claimed()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Geräte-ID '" + canonical + "' is claimed by a customer - unclaim the device first");
        }
        provisionedDevices.delete(canonical);
        return ResponseEntity.noContent().build();
    }

    // ---- helpers -------------------------------------------------------------

    /**
     * An admin must never disable or delete their OWN account - the platform
     * would lose its operator. Compared against the token's {@code sub} BEFORE
     * any tenant check, so the guard also fires when the admin addresses
     * themselves through an arbitrary tenant path.
     */
    private static void requireNotSelf(Jwt caller, String userId, String verb) {
        if (caller != null && userId.equals(caller.getSubject())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Sie können Ihr eigenes Konto nicht " + verb + ".");
        }
    }

    private void requireTenant(UUID tenantId) {
        if (!tenants.existsById(tenantId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Tenant not found");
        }
    }

    private static AdminUserDto toDto(KeycloakUser u) {
        return new AdminUserDto(u.id(), u.username(), u.email(), u.firstName(), u.lastName(),
                u.enabled(), u.tenantId());
    }

    private static ResponseStatusException toResponse(KeycloakAdminException ex) {
        HttpStatusCode status = HttpStatusCode.valueOf(
                ex.status() >= 400 && ex.status() < 600 ? ex.status() : 502);
        // Safe to pass through: KeycloakAdminException messages are FIXED
        // strings by contract - raw upstream Keycloak bodies stay in the
        // KeycloakAdminClient server log, never in the exception message.
        return new ResponseStatusException(status, ex.getMessage());
    }
}
