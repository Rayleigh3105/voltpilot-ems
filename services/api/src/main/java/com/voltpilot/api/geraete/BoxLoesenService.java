package com.voltpilot.api.geraete;

import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.control.ControlCertificationService;
import com.voltpilot.api.entities.EntityAutoComposer;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.geraete.BoxLoesenRegel.BoxBefund;
import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.GemeinsameSteuerungAusscheiden;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Der Dienst „Verbindung lösen" (Konzept vp-plattform-admin-box-benutzer-konzept, Teil 1, Abschnitt
 * 3.3): B1 = A löscht die Verknüpfung, als wäre sie nie gewesen; B2 = A lässt den Admin auch eine Box
 * lösen, die ihren Schlüssel schon abgeholt hat. Nur der Plattform-Weg ({@code geloest_art =
 * 'plattform'}) - der Kunden-Weg (Box verbinden S4, Vertrag Abschnitt 3.5) baut in einer eigenen
 * Aufgabe auf {@link BoxLoesenRegel} und {@link DeviceRepository#loesen} auf.
 *
 * <p><b>Mandantentrennung</b> (kein Mandantensprung, keine Kundenrechte durch die Hintertür): der
 * Erst-Befund kommt aus {@link AdminBoxLoesenRepository} (BYPASSRLS, über jeden Mandanten, da der
 * Admin den Mandanten einer Referenz noch nicht kennt); die eigentliche Löschung läuft mit GESETZTEM
 * {@link TenantContext} über die normale RLS-gezäunte Rolle - Muster {@code BenutzerService.erster}.
 */
@Service
public class BoxLoesenService {

    private static final Logger log = LoggerFactory.getLogger(BoxLoesenService.class);

    /** Geschlossenes Vokabular, DB-CHECK box_loesen_protokoll_anlass_chk (V20261110090000). */
    private static final Set<String> ANLAESSE =
            Set.of("falsche_kennung", "fremder_kunde", "doppelt_verbunden", "anderer_anlass");

    private final AdminBoxLoesenRepository admin;
    private final BoxLoesenRepository repo;
    private final DeviceRepository devices;
    private final AssetRepository assets;
    private final EntityAutoComposer autoCompose;
    private final ControlCertificationService controlCertification;
    private final DeviceOverrideRepository deviceOverrides;
    private final CommandLogRepository commandLog;
    private final ObjectProvider<EnrollmentService> enrollment;
    private final ObjectProvider<ProvisioningPublisher> provisioning;
    private final ObjectProvider<EntityRegistryPublisher> entityRegistry;
    private final ObjectProvider<RolloutService> rollouts;
    private final ObjectProvider<ChargingConfigPublisher> chargingConfig;
    private final ObjectProvider<GemeinsameSteuerungAusscheiden> verbundAusscheiden;
    private final TransactionTemplate tx;

    public BoxLoesenService(AdminBoxLoesenRepository admin, BoxLoesenRepository repo, DeviceRepository devices,
            AssetRepository assets, EntityAutoComposer autoCompose, ControlCertificationService controlCertification,
            DeviceOverrideRepository deviceOverrides, CommandLogRepository commandLog,
            ObjectProvider<EnrollmentService> enrollment, ObjectProvider<ProvisioningPublisher> provisioning,
            ObjectProvider<EntityRegistryPublisher> entityRegistry, ObjectProvider<RolloutService> rollouts,
            ObjectProvider<ChargingConfigPublisher> chargingConfig,
            ObjectProvider<GemeinsameSteuerungAusscheiden> verbundAusscheiden,
            PlatformTransactionManager transactions) {
        this.admin = admin;
        this.repo = repo;
        this.devices = devices;
        this.assets = assets;
        this.autoCompose = autoCompose;
        this.controlCertification = controlCertification;
        this.deviceOverrides = deviceOverrides;
        this.commandLog = commandLog;
        this.enrollment = enrollment;
        this.provisioning = provisioning;
        this.entityRegistry = entityRegistry;
        this.rollouts = rollouts;
        this.chargingConfig = chargingConfig;
        this.verbundAusscheiden = verbundAusscheiden;
        this.tx = new TransactionTemplate(transactions);
    }

    /** Der Befund für die Akte (GET) - informativ, vor jedem Sperren. */
    public BoxBefundSql.Zeile befund(String externalRef) {
        return admin.befund(externalRef).orElseThrow(() -> unbekannt(externalRef));
    }

    public record Ergebnis(String externalRef, String anlass) {
    }

    /**
     * Lösen (POST). {@code akteur} ist IMMER die Platform-Admin-Person (B1-B4 betreffen nur diesen
     * Weg); der künftige Kunden-Weg (S4) ruft {@link BoxLoesenRegel} und
     * {@link DeviceRepository#loesen} selbst, mit {@code adminWeg = false}.
     */
    public Ergebnis loesen(String externalRef, String anlass, String anlassText, ProtokollAkteur akteur) {
        if (!ANLAESSE.contains(anlass)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bitte wählen Sie einen Anlass.");
        }
        boolean brauchtText = "anderer_anlass".equals(anlass);
        if (brauchtText == (anlassText == null || anlassText.isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    brauchtText ? "Bitte beschreiben Sie den Anlass." : "Ein Text gilt nur bei 'Anderer Anlass …'.");
        }
        BoxBefundSql.Zeile vorab = admin.befund(externalRef).orElseThrow(() -> unbekannt(externalRef));
        UUID vorherigerMandant = TenantContext.get();
        try {
            TenantContext.set(vorab.tenantId());
            tx.executeWithoutResult(status -> loesenGesperrt(vorab, anlass, anlassText, akteur));
            return new Ergebnis(externalRef, anlass);
        } finally {
            if (vorherigerMandant == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorherigerMandant);
            }
        }
    }

    private void loesenGesperrt(BoxBefundSql.Zeile vorab, String anlass, String anlassText,
            ProtokollAkteur akteur) {
        devices.lockReference(vorab.externalRef());
        BoxBefund befund = repo.befundUnterSperre(vorab.deviceId());
        List<String> gruende = BoxLoesenRegel.gruende(befund, true);
        if (!gruende.isEmpty()) {
            throw new BoxLoesenAbgelehnt(gruende, befund);
        }
        if (befund.schluesselAbgeholtAm() != null) {
            EnrollmentService svc = enrollment.getIfAvailable();
            boolean bestaetigt = svc != null && svc.blockSucceededDevice(vorab.externalRef(), vorab.deviceId());
            if (!bestaetigt) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Der Zugang der Box konnte nicht bestätigt entzogen werden - bitte erneut versuchen.");
            }
        }
        UUID tenantId = vorab.tenantId();
        UUID siteId = vorab.siteId();
        UUID deviceId = vorab.deviceId();
        GemeinsameSteuerungAusscheiden ausscheiden = verbundAusscheiden.getIfAvailable();
        if (ausscheiden != null) {
            ausscheiden.beimAusbau(deviceId, akteur);
        }
        commandLog.beimAusbauBeenden(deviceId);
        devices.ausDerTopologieLoesen(deviceId);
        provisioning.ifAvailable(p -> p.clearRetained(vorab.externalRef(), tenantId, siteId, deviceId));
        entityRegistry.ifAvailable(p -> p.clearRegistry(tenantId, siteId, deviceId));
        rollouts.ifAvailable(r -> r.onDeviceUnclaimed(tenantId, siteId, deviceId));
        controlCertification.onDeviceUnclaimed(tenantId, siteId, deviceId);
        chargingConfig.ifAvailable(p -> p.clear(tenantId, siteId, deviceId));
        deviceOverrides.clearSite(siteId);
        // Anlage heilen wie nach einem Verbinden (Abschnitt 3.3 Punkt 5): die verbleibende einzige
        // Box führt und steuert den Speicher; best-effort und idempotent wie beim Claim.
        if (assets.autoLinkBatteryDevice(siteId)) {
            log.info("Auto-linked remaining device of site {} to its battery asset after loesen of {}",
                    siteId, deviceId);
        }
        autoCompose.ensureComposed(siteId);
        try {
            if (!devices.loesen(deviceId)) {
                throw new BoxLoesenAbgelehnt(List.of("verbund"), befund);
            }
        } catch (DataIntegrityViolationException ex) {
            // Die DB-Rückversicherung (ON DELETE RESTRICT, V20260913150000): eine Tabelle, die die
            // Anwendungs-Regel nicht geprüft hat, trägt doch eine Zeile. Nichts geändert.
            throw new BoxLoesenAbgelehnt(List.of("messwerte"), befund);
        }
        repo.protokollieren(new BoxLoesenRepository.Eintrag(tenantId, siteId, vorab.siteName(), deviceId,
                vorab.externalRef(), vorab.verbundenAm(), akteur == null ? null : akteur.sub(),
                akteur == null ? "VoltPilot" : akteur.name(), "plattform", anlass, anlassText, befund));
    }

    private static ResponseStatusException unbekannt(String externalRef) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Unbekannte Referenz: " + externalRef);
    }
}
