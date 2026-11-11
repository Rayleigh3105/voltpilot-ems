package com.voltpilot.api.web;

import com.voltpilot.api.web.dto.SichtbareListe;
import com.voltpilot.api.zugriff.TeilansichtDienst;

import com.voltpilot.api.control.ControlCertificationService;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.entities.EntityAutoComposer;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.entities.LeadDeviceService;
import com.voltpilot.api.geraete.BoxBefundSql;
import com.voltpilot.api.geraete.BoxLoesenAbgelehnt;
import com.voltpilot.api.geraete.BoxLoesenRegel;
import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import com.voltpilot.api.geraete.BoxLoesenRepository;
import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.provisioning.ProvisioningTopics;
import com.voltpilot.api.purge.DevicePurgeService;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.repo.ProvisionedDeviceRepository;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.tenant.AnfrageZeitgrenze;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BelegeImWeg;
import com.voltpilot.api.web.dto.DeviceClaimRequest;
import com.voltpilot.api.web.dto.DeviceDto;
import com.voltpilot.api.web.dto.UpdateDeviceRequest;
import com.voltpilot.api.zugriff.Recht;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Devices for the caller's tenant, and the claim endpoint. Claiming is a single
 * insert scoped to the tenant; RLS plus the global unique {@code external_ref}
 * index make cross-tenant claiming impossible.
 *
 * <p>AP-03 IP-12: Der Umschlag nennt die sichtbaren Einträge und mit
 * {@code teilansicht} den Umfang derselben Antwort. Der Standort-Zaun bleibt erhalten.
 */
@RestController
@RequestMapping("/api/v1/devices")
public class DeviceController {

    private final TeilansichtDienst teilansicht;

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(DeviceController.class);

    /** Sticker Geräte-IDs carry this prefix; only they are registry-gated. */
    static final String STICKER_PREFIX = "VP-";

    private final DeviceRepository devices;
    private final Geltungsbereich geltungsbereich;
    private final AssetRepository assets;
    private final ProvisionedDeviceRepository provisioned;
    private final DevicePurgeService purge;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final ObjectProvider<EnrollmentService> enrollment;
    private final ObjectProvider<EntityRegistryPublisher> entityRegistry;
    private final ObjectProvider<RolloutService> rollouts;
    private final EntityAutoComposer autoCompose;
    private final ControlCertificationService controlCertification;
    private final ObjectProvider<ChargingConfigPublisher> chargingConfig;
    private final com.voltpilot.api.repo.DeviceOverrideRepository deviceOverrides;
    private final CommandLogRepository commandLog;
    private final RechtPruefung rechte;
    private final BoxLoesenRepository boxLoesen;
    private LeadDeviceService leadDevices;

    @org.springframework.beans.factory.annotation.Autowired
    void leadDevices(LeadDeviceService service) {
        this.leadDevices = service;
    }

    /** Die Route des Verbindens für die Anfrage-Kennung (Anlage-Flow a1, Paket 2). */
    static final String ROUTE_VERBINDEN = "POST /api/v1/devices/claim";

    private AnfrageKennungen anfrageKennungen;

    @org.springframework.beans.factory.annotation.Autowired
    void anfrageKennungen(AnfrageKennungen kennungen) {
        this.anfrageKennungen = kennungen;
    }

    /** UEMS AP-15 §5.5: eine abgemeldete Mitglieds-Box scheidet aus der Gemeinsamen Steuerung aus. */
    private com.voltpilot.api.uems.GemeinsameSteuerungAusscheiden verbundAusscheiden;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void verbundAusscheiden(com.voltpilot.api.uems.GemeinsameSteuerungAusscheiden dienst) {
        this.verbundAusscheiden = dienst;
    }

    public DeviceController(DeviceRepository devices, Geltungsbereich geltungsbereich, RechtPruefung rechte,
            AssetRepository assets,
            ProvisionedDeviceRepository provisioned,
            DevicePurgeService purge,
            ObjectProvider<ProvisioningPublisher> provisioning,
            ObjectProvider<EnrollmentService> enrollment,
            ObjectProvider<EntityRegistryPublisher> entityRegistry,
            ObjectProvider<RolloutService> rollouts,
            EntityAutoComposer autoCompose,
            ControlCertificationService controlCertification,
            ObjectProvider<ChargingConfigPublisher> chargingConfig,
            com.voltpilot.api.repo.DeviceOverrideRepository deviceOverrides,
            CommandLogRepository commandLog, TeilansichtDienst teilansicht, BoxLoesenRepository boxLoesen) {
        this.devices = devices;
        this.teilansicht = teilansicht;
        this.geltungsbereich = geltungsbereich;
        this.rechte = rechte;
        this.assets = assets;
        this.provisioned = provisioned;
        this.purge = purge;
        this.provisioning = provisioning;
        this.enrollment = enrollment;
        this.entityRegistry = entityRegistry;
        this.rollouts = rollouts;
        this.autoCompose = autoCompose;
        this.controlCertification = controlCertification;
        this.chargingConfig = chargingConfig;
        this.deviceOverrides = deviceOverrides;
        this.commandLog = commandLog;
        this.boxLoesen = boxLoesen;
    }

    @GetMapping
    public SichtbareListe<DeviceDto> listDevices() {
        var liste = devices.findAll();
        var fuehrend = new java.util.HashMap<java.util.UUID, java.util.UUID>();
        if (leadDevices != null) {
            liste.stream().map(DeviceDto::siteId).distinct().forEach(site -> {
                java.util.UUID box = leadDevices.fuehrendeBox(site).box();
                if (box != null) fuehrend.put(site, box);
            });
        }
        return new SichtbareListe<>(liste.stream().map(d -> new DeviceDto(
                d.id(), d.siteId(), d.externalRef(), d.kind(), d.name(), d.status(),
                d.lastSeenAt(), d.createdAt(), d.lanHost(), d.lanSeenAt(), d.lanSource(),
                fuehrend.get(d.siteId()) == null ? null : d.id().equals(fuehrend.get(d.siteId())),
                d.anmeldung()))
                .toList(), teilansicht.jetzt());
    }

    @PostMapping("/claim")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.DIENST)
    @Transactional
    public ResponseEntity<?> claim(@Valid @RequestBody DeviceClaimRequest request,
            org.springframework.security.core.Authentication auth,
            @org.springframework.web.bind.annotation.RequestHeader(value = AnfrageKennungen.KOPF,
                    required = false) String anfrageKopf) {
        UUID tenantId = TenantContext.get();
        if (tenantId == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "No tenant in token");
        }
        // Anlage-Flow a1 (Paket 2): dieselbe Anfrage-Kennung wie an POST /sites und /standorte. Das
        // Verbinden war schon über die Kennung der Box idempotent; die Anfrage-Kennung gibt beim
        // Wiederholen nach einer verlorenen Antwort genau die erste Antwort zurück und lehnt dieselbe
        // Kennung mit einer anderen Box oder Anlage ab (422 anfrage_kennung_anders).
        String kennung = anfrageKennungen == null ? null : AnfrageKennungen.kennung(anfrageKopf);
        String fingerabdruck = kennung == null ? null : anfrageKennungen.fingerabdruck(request);
        if (kennung != null) {
            anfrageKennungen.sperren(ROUTE_VERBINDEN, kennung);
            Optional<AnfrageKennungen.Gemerkt> gemerkt = anfrageKennungen.gemerkt(ROUTE_VERBINDEN, kennung,
                    fingerabdruck);
            if (gemerkt.isPresent()) {
                return AnfrageKennungen.antwort(gemerkt.get());
            }
        }
        ResponseEntity<DeviceDto> antwort = verbinden(request, auth, tenantId);
        if (kennung != null) {
            anfrageKennungen.merken(ROUTE_VERBINDEN, kennung, fingerabdruck,
                    HttpStatus.valueOf(antwort.getStatusCode().value()), antwort.getBody());
        }
        return antwort;
    }

    private ResponseEntity<DeviceDto> verbinden(DeviceClaimRequest request,
            org.springframework.security.core.Authentication auth, UUID tenantId) {
        // The target site must belong to the caller's tenant (RLS-checked).
        if (!geltungsbereich.siteVisible(request.siteId())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found");
        }
        // Das Recht an der Zielanlage (UEMS AP-03 IP-6): der Interceptor kennt sie nicht, sie steht im Körper.
        rechte.pruefen("geraet.einrichten", RechtZiel.ANLAGE, request.siteId(),
                () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found"));
        String externalRef = canonicalExternalRef(request.externalRef());
        // Topic-safety gate (defense in depth, same rule as the enrollment
        // path): the ref is interpolated into the retained MQTT provisioning
        // topic, so '/', '+', '#' and over-long refs must never get that far -
        // reject them here instead of storing a device the broker cannot serve.
        if (!ProvisioningTopics.isValidRef(externalRef)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Ungültige Geräte-ID.");
        }
        // Idempotent within the tenant: re-entering a device the account already
        // connected (wizard restart, double submit) returns that device instead
        // of a conflict. RLS scopes the lookup, so a hit is always the caller's own.
        Optional<DeviceDto> existing = devices.findByExternalRef(externalRef);
        if (existing.isPresent()) {
            return ResponseEntity.ok(existing.get());
        }
        // Two ID formats are typo-gated so a mistyped ID fails fast (422)
        // instead of silently creating a ghost device that would "wait for first
        // data" forever:
        //   - Sticker IDs (VP-...) must exist in the manufacturing registry.
        //   - Self-generated edge refs (edge-...) must carry a valid check
        //     character (the format the shipping Edge-App shows on its :8484 web
        //     app). A single-character typo breaks the checksum (see EdgeRef).
        // A customer account (KONTO_benutzer) knows only these two forms: a free
        // ref from a customer is a typo of one of them ("k7m2xq3" without "edge-",
        // "edgek7m2xq3", "edge-k7m2xq1" with a "1" for an "l") and would become a
        // ghost device (Anlage-Flow a1, B4). Other free-form refs (dev seeds,
        // integrations) stay open to the platform and to service accounts.
        if (kundenkonto(auth) && !externalRef.startsWith(STICKER_PREFIX) && !EdgeRef.isValid(externalRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Unknown Geräte-ID '" + externalRef + "' - keine Kennung einer VoltPilot-Box");
        }
        String kind = request.kind();
        if (externalRef.startsWith(STICKER_PREFIX)) {
            Optional<String> provisionedKind = provisioned.findKind(externalRef);
            if (provisionedKind.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                        "Unknown Geräte-ID '" + externalRef + "' - not a provisioned device");
            }
            if (kind == null || kind.isBlank()) {
                kind = provisionedKind.get();
            }
        } else if (EdgeRef.isGeneratedFormat(externalRef) && !EdgeRef.isValid(externalRef)) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY,
                    "Unknown Geräte-ID '" + externalRef + "' - Prüfzeichen ungültig (Tippfehler?)");
        }
        com.voltpilot.api.uems.ProtokollAkteur akteur = com.voltpilot.api.uems.ProtokollAkteur.aus(auth).orElse(null);
        // Box verbinden S4 ("Andere Kennung", Vertrag Abschnitt 3.5): nur LESEN, nichts ändern -
        // schlägt das eigentliche Verbinden unten fehl (fremde Kennung 409, Tippfehler oben schon
        // 422), bleibt die zu ersetzende Box unberührt, weil bis hierher nichts geschrieben wurde.
        // box_loesen_protokoll_von_chk verlangt für geloest_art = 'kunde' einen Urheber (anders als
        // der Admin-Weg): ohne ProtokollAkteur (Servicekonto) gäbe es sonst erst beim Protokollieren
        // einen 500, NACH dem Lösen - hier, vor jeder Änderung, ist der klare Fehler billig.
        if (request.ersetzt() != null && akteur == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "Andere Kennung braucht eine angemeldete Person.");
        }
        BoxBefundSql.Zeile ersetzteZeile = request.ersetzt() == null ? null : ersetzteBoxPruefen(request.ersetzt());
        try {
            DeviceDto claimed = devices.claim(tenantId, request.siteId(), externalRef, kind, akteur);
            if (ersetzteZeile != null) {
                // Erst jetzt, nachdem die neue Kennung sicher verbunden ist: die alte Box lösen, als
                // wäre sie nie gewesen (BoxLoesenRegel, adminWeg = false; dieselbe Hygiene wie
                // BoxLoesenService.loesenGesperrt, aber geloest_art = "kunde").
                loeseErsetzteBox(ersetzteZeile, tenantId, akteur);
            }
            // Self-maintaining control path: if this claim leaves the site with
            // exactly one device and its battery asset is still unlinked, link
            // them - the battery is controlled by the inverter (this device), so
            // the optimizer can now publish the plan instead of only persisting
            // it. A multi-device site is left alone (the owner picks). Best-effort
            // and idempotent; a claim must never fail on the link bookkeeping.
            if (assets.autoLinkBatteryDevice(claimed.siteId())) {
                log.info("Auto-linked device {} (ref '{}') to the battery asset of site {}",
                        claimed.id(), claimed.externalRef(), claimed.siteId());
            }
            // Self-composing Anlagen-Modell: the claim is the moment the site
            // gains an unambiguous gateway, so this is the earliest point at
            // which its v2 entities CAN be composed - and the customer must
            // never have to ask anyone for it (the composition used to need a
            // platform-admin bootstrap or an api restart). Idempotent +
            // fail-soft; a broken composition never fails the claim.
            autoCompose.ensureComposed(claimed.siteId());
            if (ersetzteZeile != null && !ersetzteZeile.siteId().equals(claimed.siteId())) {
                // Die ersetzte Box gehörte einer anderen Anlage als die neue (seltener Fall, der
                // Assistent ersetzt meist innerhalb derselben Anlage): deren Speicher-Verknüpfung
                // heilt separat, dieselbe Selbst-Heilung wie nach jedem Lösen.
                if (assets.autoLinkBatteryDevice(ersetzteZeile.siteId())) {
                    log.info("Auto-linked remaining device of site {} to its battery asset after "
                            + "andere Kennung of {}", ersetzteZeile.siteId(), ersetzteZeile.deviceId());
                }
                autoCompose.ensureComposed(ersetzteZeile.siteId());
            }
            // Zero-touch onboarding: hand the waiting device its identity via the
            // retained provision/{ref}/config (best-effort; see ProvisioningPublisher).
            // The claim still succeeds if the broker is down, but a discarded
            // failure means the device only converges on its next hello retry -
            // so surface it as a WARN naming the device rather than swallowing it.
            provisioning.ifAvailable(p -> {
                if (!p.publishConfig(claimed.externalRef(), tenantId, claimed.siteId(), claimed.id())) {
                    log.warn("Claim of device {} (ref '{}') succeeded but the retained "
                            + "provisioning config did not go out - the device converges on its "
                            + "next hello via the ingest resolver", claimed.id(), claimed.externalRef());
                }
            });
            return ResponseEntity.status(HttpStatus.CREATED).body(claimed);
        } catch (DuplicateKeyException ex) {
            // external_ref already claimed by another tenant (which RLS hides above).
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Device '" + externalRef + "' is already claimed");
        }
    }

    /**
     * Box verbinden S4: der Befund UNTER der Sperre der zu ersetzenden Box, geprüft gegen dieselbe
     * {@link BoxLoesenRegel} wie der Admin-Weg - nur mit {@code adminWeg = false} (Vertrag Abschnitt
     * 3.5): ein abgeholter Schlüssel blockiert hier IMMER, anders als bei B2 = A. Eine fremde, schon
     * ausgebaute oder nicht vorhandene Geräte-ID ({@code ersetzt} ein gefälschter Pfad) ergibt
     * denselben Befund wie eine schon ausgebaute Box ({@code aktiv = false}) statt eine eigene 404 -
     * nie eine fremde Box lösen, nie verraten, ob die ID überhaupt existiert. Nichts wird geändert;
     * nur bei einer leeren Gründe-Liste holt der Aufrufer nach einer erfolgreichen neuen Kennung die
     * Box tatsächlich ab ({@link #loeseErsetzteBox}).
     */
    private BoxBefundSql.Zeile ersetzteBoxPruefen(UUID ersetzteId) {
        Optional<DeviceDto> vorab = devices.findById(ersetzteId);
        BoxBefundSql.Zeile zeile = null;
        if (vorab.isPresent()) {
            // Dasselbe Recht wie an der Zielanlage (oben): eine Standort-Rolle ohne Zugang zur
            // Anlage der zu ersetzenden Box darf sie nicht lösen, auch wenn RLS sie sieht.
            rechte.pruefen("geraet.einrichten", RechtZiel.ANLAGE, vorab.get().siteId(),
                    () -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Site not found"));
            devices.lockReference(vorab.get().externalRef());
            zeile = boxLoesen.zeileUnterSperre(ersetzteId).orElse(null);
        }
        BoxBefund befund = zeile == null
                ? new BoxBefund(false, null, null, null, false, null)
                : zeile.befund();
        List<String> gruende = BoxLoesenRegel.gruende(befund, false);
        if (!gruende.isEmpty()) {
            throw new BoxLoesenAbgelehnt(gruende, befund);
        }
        return zeile;
    }

    /**
     * Box verbinden S4: die ersetzte Box lösen, als wäre sie nie gewesen (B1 = A, {@code geloest_art
     * = "kunde"}, Anlass {@code andere_kennung}) - dieselbe Hygiene wie
     * {@code BoxLoesenService.loesenGesperrt}, nur ohne den admin-exklusiven Schlüssel-Entzug (B2 =
     * A), der hier nie greift: {@link #ersetzteBoxPruefen} hat {@code angemeldet} schon
     * ausgeschlossen. Läuft NACH dem erfolgreichen Claim der neuen Kennung (derselbe
     * {@code @Transactional}), damit ein scheiterndes Verbinden (409 fremde Kennung) die alte Box
     * unberührt lässt.
     */
    private void loeseErsetzteBox(BoxBefundSql.Zeile zeile, UUID tenantId,
            com.voltpilot.api.uems.ProtokollAkteur akteur) {
        UUID deviceId = zeile.deviceId();
        UUID siteId = zeile.siteId();
        if (verbundAusscheiden != null) {
            verbundAusscheiden.beimAusbau(deviceId, akteur);
        }
        commandLog.beimAusbauBeenden(deviceId);
        devices.ausDerTopologieLoesen(deviceId);
        provisioning.ifAvailable(p -> p.clearRetained(zeile.externalRef(), tenantId, siteId, deviceId));
        entityRegistry.ifAvailable(p -> p.clearRegistry(tenantId, siteId, deviceId));
        rollouts.ifAvailable(r -> r.onDeviceUnclaimed(tenantId, siteId, deviceId));
        controlCertification.onDeviceUnclaimed(tenantId, siteId, deviceId);
        chargingConfig.ifAvailable(p -> p.clear(tenantId, siteId, deviceId));
        deviceOverrides.clearSite(siteId);
        try {
            if (!devices.loesen(deviceId)) {
                throw new BoxLoesenAbgelehnt(List.of("verbund"), zeile.befund());
            }
        } catch (DataIntegrityViolationException ex) {
            // Die DB-Rückversicherung (ON DELETE RESTRICT, V20260913150000): nichts geändert.
            throw new BoxLoesenAbgelehnt(List.of("messwerte"), zeile.befund());
        }
        boxLoesen.protokollieren(new BoxLoesenRepository.Eintrag(tenantId, siteId, zeile.siteName(), deviceId,
                zeile.externalRef(), zeile.verbundenAm(), akteur == null ? null : akteur.sub(),
                akteur == null ? "VoltPilot" : akteur.name(), "kunde", "andere_kennung", null, zeile.befund()));
    }

    /**
     * Update a device's editable fields: TYPE and label (Bezeichnung) only.
     * The {@code external_ref} is the device's identity - MQTT topics and the
     * registry gate hang off it - and stays immutable. Es gibt bewusst keinen
     * Korrekturweg über Unclaim/Re-Claim: Historie, Befehle und Audit bleiben
     * an derselben Geräte-ID. RLS makes a foreign device a 404.
     */
    @PutMapping("/{deviceId}")
    @Recht(value = "geraet.einrichten", ziel = RechtZiel.DEVICE)
    public DeviceDto update(@PathVariable UUID deviceId,
            @Valid @RequestBody UpdateDeviceRequest request) {
        DeviceDto existing = devices.findById(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        String kind = request.kind() == null || request.kind().isBlank()
                ? existing.kind() : request.kind();
        return devices.update(deviceId, kind, request.nameOrNull())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
    }

    /**
     * Purge the recorded data of a device ("Datenaufzeichnungen löschen")
     * WITHOUT unclaiming it - refused with the list of Messstellen (409) when
     * the box carries Belege (UEMS AP-07 E8): raw telemetry goes, the site's rollups are rebuilt
     * without it, the writer refuses replayed old samples via the purge
     * watermark, and the device is told (retained {@code purge_data} command)
     * to wipe its local buffers. Claim/enrollment/config stay intact; new data
     * flows and charts normally afterwards. RLS makes a foreign device a 404.
     * Full design: {@link DevicePurgeService}.
     */
    @PostMapping("/{deviceId}/purge-data")
    @Recht(value = "aufzeichnungen.loeschen", ziel = RechtZiel.DEVICE)
    public com.voltpilot.api.web.dto.DevicePurgeResultDto purgeData(@PathVariable UUID deviceId) {
        // vp-db-zeitgrenze: DevicePurgeService rebuilt die Rollups der Anlage aus ihrer GANZEN
        // Roh-Historie neu (SeriesRepository#recomputeRollupsForSite) - bei einer lange laufenden
        // Anlage kann das realistisch an die 30-s-Anfrage-Zeitgrenze kommen oder sie überschreiten.
        // Ein Abbruch mitten im Rebuild wäre zwar transaktional sicher (Rollback), aber nutzlos: ein
        // Retry träfe dieselbe Dauer erneut. Ausgenommen statt asynchron gemacht, weil die Dienst-
        // eigene Sitzungssperre (DevicePurgeService) ohnehin nur einen Purge je Gerät gleichzeitig
        // zulässt - kein zusätzlicher Job-Status nötig.
        AnfrageZeitgrenze.ausnahme();
        DeviceDto device = devices.findById(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        DevicePurgeService.Result r = purge.purge(device);
        return new com.voltpilot.api.web.dto.DevicePurgeResultDto(
                r.deviceId(), r.purgedRows(), r.purgedBefore(), r.deviceNotified());
    }

    /**
     * Unclaim ("Gerät entfernen") = the box is AUSGEBAUT (UEMS AP-07 E8 / IP-11, AP-06 E7;
     * Captain 13.09.2026: beim Abmelden und beim Tausch geht kein Datenbestand verloren).
     * NOTHING recorded is deleted: the device row stays with its identity, and so do its raw
     * telemetry, OCPP recordings, additional measurements, events, measurement selection and
     * approvals - the history keeps naming the box that read it. What ends is the box's part in
     * operation: every live surface filters on {@code device.ausgebaut_am}, the box's open command
     * log periods end at their last evidence, the topology loses
     * its pointers to the box (what the FK {@code SET NULL} did when the row was deleted), and
     * the broker is cleaned as before - the retained {@code provision/{ref}/config} and schedule
     * topic are cleared (best-effort), so the physical device falls back to its watchdog
     * default. The sticker ref is claimable again (a new box, like before); it stays registered
     * in the manufacturing registry.
     */
    @DeleteMapping("/{deviceId}")
    @Recht(value = "komponente.loeschen", ziel = RechtZiel.DEVICE)
    @Transactional
    public ResponseEntity<Void> unclaim(@PathVariable UUID deviceId,
            org.springframework.security.core.Authentication auth) {
        UUID tenantId = TenantContext.get();
        DeviceDto device = devices.findById(deviceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found"));
        // Gemeinsame Steuerung (AP-15 §5.5): ist die Box Mitglied, scheidet sie aus und wartet auf die Bestätigung des
        // Betreibers, dass ihre Geräte vom Netz sind — bis dahin bekommt keine andere Box mehr. Ohne Verbund: nichts.
        if (verbundAusscheiden != null) {
            verbundAusscheiden.beimAusbau(deviceId, com.voltpilot.api.uems.ProtokollAkteur.aus(auth).orElse(null));
        }
        if (!devices.ausbauen(deviceId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found");
        }
        devices.ausDerTopologieLoesen(deviceId);
        // N2 (Konzept vp-plattform-admin-box-benutzer-konzept Abschnitt 5): dieselbe Selbst-Heilung
        // wie beim Verbinden (claim) - verliert eine Anlage mit zwei Boxen eine davon, bleibt sonst
        // der Speicher ohne Box ("Ihr Speicher ist keinem Gerät zugeordnet"), obwohl die verbleibende
        // Box ihn jetzt eindeutig steuern könnte. Best-effort und idempotent wie dort.
        if (assets.autoLinkBatteryDevice(device.siteId())) {
            log.info("Auto-linked remaining device of site {} to its battery asset after unclaiming {}",
                    device.siteId(), deviceId);
        }
        autoCompose.ensureComposed(device.siteId());
        // Die offenen Perioden des Befehlsverlaufs enden mit der Box: kein Herzschlag schlösse sie
        // mehr, und „läuft" wäre für immer falsch. Beendet, nicht gelöscht (UEMS AP-07 IP-11).
        commandLog.beimAusbauBeenden(deviceId);
        provisioning.ifAvailable(p ->
                p.clearRetained(device.externalRef(), tenantId, device.siteId(), device.id()));
        // v2 hygiene: the retained entity-registry slot ends with the box
        // (a re-claim mints a NEW device id, so the old subtree would otherwise
        // keep an orphaned retained push forever). Best-effort like the rest.
        entityRegistry.ifAvailable(p ->
                p.clearRegistry(tenantId, device.siteId(), device.id()));
        // First-boot enrollment counterpart: drop the device's broker ACL grant
        // so an issued mTLS certificate loses topic access (best-effort; CRL
        // revocation stays the operator-run cryptographic backstop).
        enrollment.ifAvailable(e -> e.onDeviceUnclaimed(device.id()));
        // OTA Stufe 2: die Update-Zuweisung stirbt mit dem Gerät. Ohne das
        // wartete auf dem Broker eine retained Anweisung an eine Identität,
        // die es nicht mehr gibt - dieselbe Hygiene wie beim retained
        // Provisionierungs-Config und beim Entity-Push, best-effort.
        rollouts.ifAvailable(r -> r.onDeviceUnclaimed(tenantId, device.siteId(), device.id()));
        // Und die Steuerungs-Freigabe: eine scharfgeschaltete Anlage, deren
        // Gerät niemandem mehr gehört, darf weder in der Liste stehen noch ein
        // retained Zertifizierungs-Dokument auf dem Broker liegen lassen -
        // dieselbe Hygiene wie eine Zeile darüber, best-effort.
        controlCertification.onDeviceUnclaimed(tenantId, device.siteId(), device.id());
        // Lastmanagement Stufe 3: dieselbe Hygiene für die Ladepunkt-Konfiguration.
        // Nur der retained Slot wird geleert, KEINE Zeile gelöscht - dieser
        // Aufruf läuft in der Transaktion des Unclaim auf dem @Primary-Pfad, und
        // ein Löschen von der BYPASSRLS-Verbindung aus liefe in genau die
        // Selbst-Blockade, die bei der Steuerungs-Freigabe dokumentiert ist.
        chargingConfig.ifAvailable(p ->
                p.clear(tenantId, device.siteId(), device.id()));
        // Steuerung Stufe 4: ein Handeingriff an einem Gerät, das niemandem mehr
        // gehört, ist keine Aussage mehr - und eine „Automatik pausieren"-Sperre
        // auf einer Anlage ohne Gerät hätte gar keine Wirkung mehr. Anders als
        // beim retained Slot oben ist DAS hier eine DB-Zeile auf dem @Primary-Pfad,
        // also derselben Verbindung wie das Unclaim - kein Selbst-Blockade-Risiko.
        deviceOverrides.clearSite(device.siteId());
        return ResponseEntity.noContent().build();
    }

    /**
     * The purge of a box whose series are Belege of Messstellen (UEMS AP-07 E8): 409 with the
     * list of those Messstellen - nothing was written.
     */
    @ExceptionHandler(BelegeImWeg.class)
    public ResponseEntity<java.util.Map<String, Object>> belegeImWeg(BelegeImWeg e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    /**
     * Box verbinden S4 ("Andere Kennung"): die zu ersetzende Box hat sich doch gemeldet (oder ihren
     * Schlüssel abgeholt) - 409 mit den Gründen und dem Befund, nichts geändert (Vertrag Abschnitt
     * 3.5, {@code 409 box_hat_sich_gemeldet}), wie {@code AdminGeraeteAkteController.abgelehnt}.
     */
    @ExceptionHandler(BoxLoesenAbgelehnt.class)
    public ResponseEntity<java.util.Map<String, Object>> andereKennungAbgelehnt(BoxLoesenAbgelehnt e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

    /** Ein Kundenkonto (UEMS AP-03 IP-3, Kontoart {@code benutzer}) - weder Plattform noch Servicekonto. */
    private static boolean kundenkonto(org.springframework.security.core.Authentication auth) {
        return Kundenkonto.ist(auth);
    }

    /**
     * Canonicalize a typed Geräte-ID so the same physical device never becomes
     * two rows and so the typo gates see a normalized form. Sticker IDs are
     * printed uppercase ({@code VP-1234-ABCD}) and self-generated edge refs are
     * lowercase ({@code edge-k7m2xq3}); both are case-folded to their canonical
     * form (a mobile keyboard's {@code autoCapitalize} must not matter). Other
     * free-form refs pass through untouched apart from trimming.
     */
    static String canonicalExternalRef(String raw) {
        String trimmed = raw.trim();
        if (trimmed.regionMatches(true, 0, STICKER_PREFIX, 0, STICKER_PREFIX.length())) {
            return trimmed.toUpperCase(Locale.ROOT);
        }
        if (trimmed.regionMatches(true, 0, EdgeRef.PREFIX, 0, EdgeRef.PREFIX.length())) {
            return trimmed.toLowerCase(Locale.ROOT);
        }
        return trimmed;
    }
    @org.springframework.web.bind.annotation.ExceptionHandler(com.voltpilot.api.uems.BoxKonflikt.class)
    public ResponseEntity<java.util.Map<String, String>> boxKonflikt(com.voltpilot.api.uems.BoxKonflikt e) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(e.koerper());
    }

}
