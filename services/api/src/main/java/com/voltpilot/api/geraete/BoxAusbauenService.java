package com.voltpilot.api.geraete;

import com.voltpilot.api.chargers.ChargingConfigPublisher;
import com.voltpilot.api.control.ControlCertificationService;
import com.voltpilot.api.entities.EntityAutoComposer;
import com.voltpilot.api.entities.EntityRegistryPublisher;
import com.voltpilot.api.enrollment.EnrollmentService;
import com.voltpilot.api.ota.RolloutService;
import com.voltpilot.api.provisioning.ProvisioningPublisher;
import com.voltpilot.api.repo.AssetRepository;
import com.voltpilot.api.repo.CommandLogRepository;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.repo.DeviceRepository;
import com.voltpilot.api.uems.GemeinsameSteuerungAusscheiden;
import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.DeviceDto;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * "Gerät entfernen" / Box ausbauen (UEMS AP-07 E8, AP-06 E7; Captain 13.09.2026: beim Abmelden und
 * beim Tausch geht kein Datenbestand verloren) - EINE Umsetzung, zwei Einstiege (vp-admin-box-
 * ausbauen): der Kunde selbst ({@code DeviceController#unclaim}, DELETE /api/v1/devices/{id}) und,
 * neu, der Plattform-Admin ohne Mandantensprung ({@code BoxAusbauenAdminService}, POST
 * /api/v1/admin/geraete/{ref}/ausbauen). Diese Klasse war vorher der Rumpf von
 * {@code DeviceController#unclaim}; ihr Verhalten ist unverändert - nur der Aufrufer entscheidet
 * jetzt, WEM die Box gehört (Kunde über den Request-Tenant, Admin über den Befund der Referenz).
 *
 * <p>Rein mechanisch: der Aufrufer muss den {@link com.voltpilot.api.tenant.TenantContext} schon
 * GESETZT haben (RLS-gezäunte App-Rolle) und {@code device} unter dieser RLS gefunden haben - diese
 * Klasse prüft keinen Mandanten selbst. Der 409-Wächter "liest noch Datenquellen oder hat geplante
 * Zuständigkeiten" ({@code DeviceRepository#ausbauen}, {@link com.voltpilot.api.uems.BoxKonflikt
 * box_hat_zustaendigkeiten}) gilt für beide Einstiege gleich.
 */
@Service
public class BoxAusbauenService {

    private static final Logger log = LoggerFactory.getLogger(BoxAusbauenService.class);

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

    public BoxAusbauenService(DeviceRepository devices, AssetRepository assets, EntityAutoComposer autoCompose,
            ControlCertificationService controlCertification, DeviceOverrideRepository deviceOverrides,
            CommandLogRepository commandLog, ObjectProvider<EnrollmentService> enrollment,
            ObjectProvider<ProvisioningPublisher> provisioning, ObjectProvider<EntityRegistryPublisher> entityRegistry,
            ObjectProvider<RolloutService> rollouts, ObjectProvider<ChargingConfigPublisher> chargingConfig,
            ObjectProvider<GemeinsameSteuerungAusscheiden> verbundAusscheiden) {
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
    }

    /**
     * Baut {@code device} aus - läuft in der Transaktion des Aufrufers, unter gesetztem
     * {@code TenantContext}. 404, wenn die Box inzwischen (RLS oder {@code ausgebaut_am}) verschwunden
     * ist; 409 {@code box_hat_zustaendigkeiten}, solange sie noch Datenquellen liest oder geplante
     * Zuständigkeiten hat ({@code DeviceRepository#ausbauen}) - nichts geändert.
     */
    public void ausbauen(DeviceDto device, UUID tenantId, ProtokollAkteur akteur) {
        UUID deviceId = device.id();
        UUID siteId = device.siteId();
        GemeinsameSteuerungAusscheiden ausscheiden = verbundAusscheiden.getIfAvailable();
        if (ausscheiden != null) {
            ausscheiden.beimAusbau(deviceId, akteur);
        }
        if (!devices.ausbauen(deviceId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Device not found");
        }
        devices.ausDerTopologieLoesen(deviceId);
        // N2 (Konzept vp-plattform-admin-box-benutzer-konzept Abschnitt 5): dieselbe Selbst-Heilung
        // wie beim Verbinden (claim) - verliert eine Anlage mit zwei Boxen eine davon, bleibt sonst
        // der Speicher ohne Box ("Ihr Speicher ist keinem Gerät zugeordnet"), obwohl die verbleibende
        // Box ihn jetzt eindeutig steuern könnte. Best-effort und idempotent wie dort.
        if (assets.autoLinkBatteryDevice(siteId)) {
            log.info("Auto-linked remaining device of site {} to its battery asset after unclaiming {}",
                    siteId, deviceId);
        }
        autoCompose.ensureComposed(siteId);
        // Die offenen Perioden des Befehlsverlaufs enden mit der Box: kein Herzschlag schlösse sie
        // mehr, und „läuft" wäre für immer falsch. Beendet, nicht gelöscht (UEMS AP-07 IP-11).
        commandLog.beimAusbauBeenden(deviceId);
        provisioning.ifAvailable(p -> p.clearRetained(device.externalRef(), tenantId, siteId, deviceId));
        // v2 hygiene: the retained entity-registry slot ends with the box
        // (a re-claim mints a NEW device id, so the old subtree would otherwise
        // keep an orphaned retained push forever). Best-effort like the rest.
        entityRegistry.ifAvailable(p -> p.clearRegistry(tenantId, siteId, deviceId));
        // First-boot enrollment counterpart: drop the device's broker ACL grant
        // so an issued mTLS certificate loses topic access (best-effort; CRL
        // revocation stays the operator-run cryptographic backstop).
        enrollment.ifAvailable(e -> e.onDeviceUnclaimed(deviceId));
        // OTA Stufe 2: die Update-Zuweisung stirbt mit dem Gerät. Ohne das
        // wartete auf dem Broker eine retained Anweisung an eine Identität,
        // die es nicht mehr gibt - dieselbe Hygiene wie beim retained
        // Provisionierungs-Config und beim Entity-Push, best-effort.
        rollouts.ifAvailable(r -> r.onDeviceUnclaimed(tenantId, siteId, deviceId));
        // Und die Steuerungs-Freigabe: eine scharfgeschaltete Anlage, deren
        // Gerät niemandem mehr gehört, darf weder in der Liste stehen noch ein
        // retained Zertifizierungs-Dokument auf dem Broker liegen lassen -
        // dieselbe Hygiene wie eine Zeile darüber, best-effort.
        controlCertification.onDeviceUnclaimed(tenantId, siteId, deviceId);
        // Lastmanagement Stufe 3: dieselbe Hygiene für die Ladepunkt-Konfiguration.
        // Nur der retained Slot wird geleert, KEINE Zeile gelöscht - dieser
        // Aufruf läuft in der Transaktion des Unclaim auf dem @Primary-Pfad, und
        // ein Löschen von der BYPASSRLS-Verbindung aus liefe in genau die
        // Selbst-Blockade, die bei der Steuerungs-Freigabe dokumentiert ist.
        chargingConfig.ifAvailable(p -> p.clear(tenantId, siteId, deviceId));
        // Steuerung Stufe 4: ein Handeingriff an einem Gerät, das niemandem mehr
        // gehört, ist keine Aussage mehr - und eine „Automatik pausieren"-Sperre
        // auf einer Anlage ohne Gerät hätte gar keine Wirkung mehr. Anders als
        // beim retained Slot oben ist DAS hier eine DB-Zeile auf dem @Primary-Pfad,
        // also derselben Verbindung wie das Unclaim - kein Selbst-Blockade-Risiko.
        deviceOverrides.clearSite(siteId);
    }
}
