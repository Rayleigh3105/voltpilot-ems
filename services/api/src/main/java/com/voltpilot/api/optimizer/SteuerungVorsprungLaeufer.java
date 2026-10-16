package com.voltpilot.api.optimizer;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.repo.EarningsRepository;
import com.voltpilot.api.repo.SteuerungVorsprung;
import com.voltpilot.api.tenant.TenantContext;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
 * Der Takt des Vorsprung-Budgets (NS-2 A, Captain-Entscheid 15.10.2026): je
 * Kundenbereich unter {@link TenantContext} mit der LAUFZEITROLLE - wie
 * {@code UeberwachungsLaeufer}; nur die Liste der Kundenbereiche kommt über die
 * Admin-Rolle. Je Anlage rechnet er den Vorsprung mit Bestand
 * ({@link EarningsRepository#vorsprungStaende}, dieselben Zahlen wie die
 * Kachel) und legt ihn in {@code steuerung_vorsprung} ab, wo der Optimierer ihn
 * beim Einlesen liest ({@code inputs._vorsprung_stand}).
 *
 * <p>Der Stand gehört zum jüngsten gemessenen Tag: hat eine Anlage heute noch
 * keinen Eimer, gilt in der ersten Stunde nach Mitternacht der Vortag
 * ({@link #VORTAG_BIS}) - länger nutzt der Optimierer einen Stand ohnehin nicht
 * ({@code vorsprung.HOECHSTALTER}). Eine Anlage ohne Stand verliert ihre Zeile:
 * kein Budget, nie ein altes.
 *
 * <p>Takt 5 min (die Eimer sind 15 min, der Optimierer plant alle 15 min).
 * Schalter {@code voltpilot.steuerung-vorsprung.enabled} - Vorgabe AN
 * (Hausregel), im Testlauf AUS (surefire, {@code services/api/pom.xml}). Ob der
 * Optimierer die Zahlen NUTZT, entscheidet allein sein Schalter je Anlage
 * ({@code OPTIMIZER_VORSPRUNG_BUDGET_ANLAGEN}); die Zeilen selbst ändern keinen
 * Plan.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.steuerung-vorsprung.enabled", havingValue = "true",
        matchIfMissing = true)
public class SteuerungVorsprungLaeufer {

    private static final Logger log = LoggerFactory.getLogger(SteuerungVorsprungLaeufer.class);

    private static final ZoneId ZONE = ZoneId.of("Europe/Berlin");

    /** Bis so lange nach Mitternacht gilt der Vortag, solange heute kein Eimer gemessen ist. */
    static final Duration VORTAG_BIS = Duration.ofMinutes(60);

    private final JdbcTemplate adminJdbc;
    private final EarningsRepository earnings;
    private final SteuerungVorsprungRepository repository;

    /** Beendete Kundenbereiche lässt der Läufer aus; ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public SteuerungVorsprungLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            EarningsRepository earnings, SteuerungVorsprungRepository repository) {
        this.adminJdbc = adminJdbc;
        this.earnings = earnings;
        this.repository = repository;
    }

    @Scheduled(fixedDelayString = "${voltpilot.steuerung-vorsprung.interval-ms:300000}",
            initialDelayString = "${voltpilot.steuerung-vorsprung.initial-delay-ms:90000}")
    public void takt() {
        try {
            lauf(Instant.now());
        } catch (RuntimeException e) {
            log.warn("Vorsprung-Budget: Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche. Wirft nie je Kundenbereich; Rückgabe = geschriebene Zeilen. */
    public int lauf(Instant jetzt) {
        List<UUID> kundenbereiche =
                adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int geschrieben = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) {
                continue;
            }
            try {
                TenantContext.set(tenant);
                geschrieben += repository.schreibe(tenant, staende(earnings, jetzt), jetzt);
            } catch (RuntimeException e) {
                log.error("Vorsprung-Budget: Takt für Kundenbereich {} gescheitert, Zeilen unverändert: {}",
                        tenant, e.toString(), e);
            } finally {
                TenantContext.clear();
            }
        }
        return geschrieben;
    }

    /**
     * Je Anlage des Kundenbereichs der Stand des jüngsten gemessenen Tages:
     * heute, in der ersten Stunde nach Mitternacht sonst der Vortag.
     */
    public static Map<UUID, SteuerungVorsprung.Stand> staende(EarningsRepository earnings,
            Instant jetzt) {
        ZonedDateTime berlin = jetzt.atZone(ZONE);
        LocalDate heute = berlin.toLocalDate();
        Map<UUID, SteuerungVorsprung.Stand> result = new HashMap<>(earnings.vorsprungStaende(heute));
        if (Duration.between(heute.atStartOfDay(ZONE), berlin).compareTo(VORTAG_BIS) < 0) {
            earnings.vorsprungStaende(heute.minusDays(1)).forEach(result::putIfAbsent);
        }
        return result;
    }
}
