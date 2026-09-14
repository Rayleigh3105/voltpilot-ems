package com.voltpilot.api.interventions;

import com.voltpilot.api.consumers.ConsumerOverridePublisher;
import com.voltpilot.api.entities.EntityRegistryRepository;
import com.voltpilot.api.entities.EntityRegistryService;
import com.voltpilot.api.repo.DeviceOverrideRepository;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.RuheRegel;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * B6: ein Handeingriff, der LÄNGER dauert als die 4-h-Kappe des Arbiters (D-5),
 * wird cloud-seitig ERNEUERT statt den Vertrag zu dehnen (Konzept §3.7 B6).
 *
 * <p>Der Takt sendet den laufenden Wunsch neu aus, solange sein {@code ends_at}
 * in der Zukunft liegt, und räumt abgelaufene Zeilen weg. <b>Er erfindet nie
 * eine Verlängerung:</b> die Frist steht in der Zeile, und ist sie vorbei,
 * verfällt der Wunsch auf dem Gerät von SELBST - der Takt muss dafür nicht
 * einmal laufen. Das ist die Failsafe-Richtung, die D-7 verlangt.
 *
 * <p><b>Die Ruhe bis zum Start (R0, UEMS AP-01 IP-4) wird ebenfalls erneuert</b>, aber aus
 * einem anderen Grund: sie selbst hat KEIN Ende. Nur eine ÄLTERE Box, die
 * {@code automation_paused_until_revoked} überliest, ruht bis zum rollierenden Ende des
 * Registry-Pushs (jetzt + 4 h) - der Takt pusht die Registry darum nach 3 h erneut
 * ({@link RuheRegel#erneuernFaellig}). Fällt der Takt aus, läuft die ältere Box nach 4 h
 * wieder; die neue Box ruht weiter bis auf Widerruf.
 *
 * <p>⚠ Er liest über die BYPASSRLS-Rolle (er hat keinen Mandanten-Kontext) und
 * setzt für jedes Aussenden den Mandanten der ZEILE - der Publisher stempelt
 * ihn auf das Topic. Ein Fehlschlag wird protokolliert und beim nächsten Takt
 * erneut versucht; er wirft nie.
 *
 * <p>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF abgeschaltet
 * (surefire-Systemeigenschaft) und in Produktion an ({@code matchIfMissing}) -
 * die dokumentierte Falle mit den zwischengespeicherten Testkontexten und den
 * gestoppten Testcontainern.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.interventions.renewal-enabled",
        havingValue = "true", matchIfMissing = true)
public class DeviceOverrideRenewalRunner {

    private static final Logger log = LoggerFactory.getLogger(DeviceOverrideRenewalRunner.class);

    private final DeviceOverrideRepository overrides;
    private final EntityRegistryRepository entities;
    private final JdbcTemplate adminJdbc;
    private final ObjectProvider<ConsumerOverridePublisher> publisher;
    private final ObjectProvider<EntityRegistryService> registry;

    public DeviceOverrideRenewalRunner(DeviceOverrideRepository overrides,
            EntityRegistryRepository entities,
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            ObjectProvider<ConsumerOverridePublisher> publisher,
            ObjectProvider<EntityRegistryService> registry) {
        this.overrides = overrides;
        this.entities = entities;
        this.adminJdbc = adminJdbc;
        this.publisher = publisher;
        this.registry = registry;
    }

    /** Alle 10 Minuten - deutlich häufiger als die 3-h-Auffrischung nötig macht. */
    @Scheduled(fixedDelayString = "${voltpilot.interventions.renewal-interval-ms:600000}",
            initialDelayString = "${voltpilot.interventions.renewal-initial-delay-ms:120000}")
    public void renew() {
        try {
            renewOnce(Instant.now());
        } catch (RuntimeException e) {
            log.warn("Handeingriff-Erneuerung übersprungen: {}", e.toString());
        }
    }

    /** Ein Durchlauf - package-private, damit der Test ihn ohne Takt fahren kann. */
    int renewOnce(Instant now) {
        int sent = 0;
        List<DeviceOverrideRepository.Renewal> due =
                overrides.dueForRenewal(adminJdbc, now.minus(Handeingriff.ERNEUERN_NACH));
        for (DeviceOverrideRepository.Renewal row : due) {
            if (row.entityId() == null) {
                // Die Anlagen-Pause reist im RETAINED Registry-Push - sie braucht
                // kein erneutes Aussenden, nur den Stempel, damit sie nicht bei
                // jedem Takt erneut auftaucht.
                overrides.markRenewed(adminJdbc, row.id());
                continue;
            }
            if (resend(row, now)) {
                overrides.markRenewed(adminJdbc, row.id());
                sent++;
            }
        }
        int ruhe = 0;
        for (DeviceOverrideRepository.RuheErneuerung row : overrides.ruheZuErneuern(adminJdbc, now)) {
            if (pushRuhe(row)) {
                overrides.markRenewed(adminJdbc, row.id());
                ruhe++;
            }
        }
        int purged = overrides.purgeExpired(adminJdbc);
        if (sent > 0 || purged > 0 || ruhe > 0) {
            log.info("Handeingriffe: {} erneuert, {} abgelaufene entfernt, {} Ruhe neu gesendet",
                    sent, purged, ruhe);
        }
        return sent + ruhe;
    }

    /** Die Registry der Anlage neu pushen - im Mandanten-Kontext der ZEILE (RLS). */
    private boolean pushRuhe(DeviceOverrideRepository.RuheErneuerung row) {
        EntityRegistryService svc = registry.getIfAvailable();
        if (svc == null) {
            return false;
        }
        UUID previous = TenantContext.get();
        try {
            TenantContext.set(row.tenantId());
            EntityRegistryService.PushOutcome outcome = svc.pushRegistryBestEffort(row.siteId());
            if (!outcome.published()) {
                log.warn("Ruhe {} nicht neu gesendet: {}", row.id(), outcome.reason());
            }
            return outcome.published();
        } catch (RuntimeException e) {
            log.warn("Ruhe {} nicht neu gesendet: {}", row.id(), e.toString());
            return false;
        } finally {
            if (previous == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(previous);
            }
        }
    }

    private boolean resend(DeviceOverrideRepository.Renewal row, Instant now) {
        ConsumerOverridePublisher pub = publisher.getIfAvailable();
        if (pub == null) {
            return false;
        }
        UUID device = gatewayFor(row.tenantId(), row.siteId());
        if (device == null) {
            log.warn("Handeingriff {} nicht erneuert: kein Gerät für Anlage {}", row.id(),
                    row.siteId());
            return false;
        }
        return pub.publishOverride(row.tenantId(), row.siteId(), device, row.entityId(), null,
                row.targetValue(), Handeingriff.ttlSekunden(row.endsAt(), now), now);
    }

    /** Das Gerät der Anlage - gelesen im Mandanten-Kontext der ZEILE (RLS). */
    private UUID gatewayFor(UUID tenantId, UUID siteId) {
        UUID previous = TenantContext.get();
        try {
            TenantContext.set(tenantId);
            EntityRegistryRepository.BatteryAsset asset = entities.batteryAsset(siteId);
            return asset == null ? null : asset.deviceId();
        } finally {
            if (previous == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(previous);
            }
        }
    }
}
