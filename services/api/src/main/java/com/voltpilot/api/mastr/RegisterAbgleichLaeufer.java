package com.voltpilot.api.mastr;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.repo.RegisterEinheitRepository;
import com.voltpilot.api.repo.RegisterEinheitRepository.FaelligeEinheit;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * S2 Hintergrund-Abgleich (vp-mastr-mehrere-einheiten-konzept Abschnitt 5.4):
 * re-reads a confirmed unit's register layer and checks for new siblings at
 * its Lokation, suggesting any not yet known (E5 - suggested once, never
 * silently adopted: {@link RegisterEinheitRepository#suggestUnit} leaves the
 * confirmed layer NULL, so nothing computes from a suggestion until the
 * customer confirms it, S3).
 *
 * <p><b>Default OFF, unlike the other Kundenbereich-Läufer in this
 * codebase.</b> Every other {@code @Scheduled} runner here only ever touches
 * this database and defaults to ON in production; this one calls the LIVE
 * Marktstammdatenregister for every confirmed unit of every tenant. Starting
 * that automatically the moment this ships - before the captain has decided
 * whether the keyless public backend should carry that load, and before a
 * Webdienst key is hinterlegt (N6, report vp-mastr-mehrere-einheiten-konzept)
 * - would be a product decision this PR does not make. An operator turns it
 * on explicitly ({@code voltpilot.mastr.register-abgleich.enabled=true}):
 * {@code matchIfMissing} stays at its default (false), so the bean does not
 * even exist without that flag - no surefire override is needed to keep
 * tests from calling the live register.
 *
 * <p>Rate limit ("höchstens eine Abfrage je Sekunde", Abschnitt 5.4): one
 * confirmed unit re-checked at a time, paced by {@link #PAUSE} between them -
 * simpler and more auditable than threading a token bucket through {@link
 * PlantRegistryClient}, and conservative enough at this scale (one unit's
 * full re-check, including its Lokation siblings, is already several calls).
 *
 * <p>Same shape as {@code VorgabenLaeufer}/{@code FunktionBestandLaeufer}:
 * the tenant list comes from the admin pool, every read/write of a tenant's
 * own data runs under {@link TenantContext} through the RLS-scoped {@link
 * RegisterEinheitRepository} - never the admin pool itself.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.mastr.register-abgleich.enabled", havingValue = "true")
public class RegisterAbgleichLaeufer {

    private static final Logger log = LoggerFactory.getLogger(RegisterAbgleichLaeufer.class);

    /** Re-check cadence per unit: the register rarely changes faster than this. */
    static final Duration ABRUF_ALTER = Duration.ofDays(14);
    static final Duration PAUSE = Duration.ofSeconds(1);
    static final int EINHEITEN_JE_TAKT = 10;

    private final JdbcTemplate adminJdbc;
    private final RegisterEinheitRepository einheiten;
    private final PlantRegistryClient registry;

    /** Beendete Kundenbereiche lässt der Läufer aus; ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public RegisterAbgleichLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            RegisterEinheitRepository einheiten, PlantRegistryClient registry) {
        this.adminJdbc = adminJdbc;
        this.einheiten = einheiten;
        this.registry = registry;
    }

    @Scheduled(fixedDelayString = "${voltpilot.mastr.register-abgleich.interval-ms:3600000}",
            initialDelayString = "${voltpilot.mastr.register-abgleich.initial-delay-ms:300000}")
    public void takt() {
        try {
            lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("Register-Abgleich: Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche. Wirft nie je Einheit; Rückgabe = neu vorgeschlagene Einheiten. */
    public int lauf(Instant jetzt) {
        List<UUID> kundenbereiche =
                adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int vorgeschlagen = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) {
                continue;
            }
            try {
                TenantContext.set(tenant);
                for (FaelligeEinheit f : einheiten.findStaleConfirmed(jetzt.minus(ABRUF_ALTER), EINHEITEN_JE_TAKT)) {
                    try {
                        vorgeschlagen += einheit(tenant, f, jetzt);
                        pause();
                    } catch (RuntimeException | RegistryLookupException e) {
                        log.warn("Register-Abgleich: Einheit {} im Kundenbereich {} gescheitert: {}",
                                f.registryUnitId(), tenant, e.toString());
                    }
                }
            } catch (RuntimeException e) {
                log.error("Register-Abgleich: Kundenbereich {} gescheitert: {}", tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return vorgeschlagen;
    }

    /** One unit: re-read its register layer, then check for new siblings at its Lokation. */
    int einheit(UUID tenant, FaelligeEinheit f, Instant jetzt) throws RegistryLookupException {
        MastrUnit unit = registry.fetchUnit(f.registryUnitId());
        einheiten.updateRegisterLayer(f.siteId(), f.registryUnitId(),
                "speicher".equals(f.art()) ? null : unit.grossPowerKw(),
                unit.commissionedOn(), unit.moduleCount(), jetzt);
        if (unit.locationNumber() == null) {
            return 0;
        }
        List<String> known = einheiten.knownUnitNumbers(f.siteId());
        int vorgeschlagen = 0;
        for (MastrUnit sibling : registry.fetchUnitsAtLocation(unit.locationNumber())) {
            if (known.contains(sibling.unitNumber())) {
                continue;
            }
            boolean neu = einheiten.suggestUnit(tenant, f.siteId(),
                    sibling.kind() == MastrUnit.Kind.STORAGE ? "speicher" : "pv", "mastr",
                    sibling.unitNumber(), sibling.grossPowerKw(), sibling.commissionedOn(), jetzt);
            if (neu) {
                vorgeschlagen++;
                log.info("Register-Abgleich: neue Einheit {} an der Lokation von {} vorgeschlagen "
                        + "(Kundenbereich {})", sibling.unitNumber(), f.registryUnitId(), tenant);
            }
        }
        return vorgeschlagen;
    }

    private void pause() {
        try {
            Thread.sleep(PAUSE.toMillis());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
