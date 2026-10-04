package com.voltpilot.api.mispel;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.metrics.UemsLaeuferMelder;
import com.voltpilot.api.mispel.PauschalVormerkungService.Ergebnis;
import com.voltpilot.api.mispel.PauschalVormerkungService.Umsetzung;
import com.voltpilot.api.tenant.TenantContext;
import java.time.LocalDate;
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
 * Die Pauschal-Vormerkung wird eine Fassung (MiSpeL MP-27b, Vertrag {@code mispel-foerderweg.md} § 5a): sobald VoltPilot
 * den Tag der Pauschaloption in {@code voltpilot.mispel.pauschaloption-ab} einträgt (E7 = B; Tenor S. 3 Ziff. 9b), wird
 * jede stehende Vormerkung zum ersten Monatsersten danach eine Fassung „Marktprämie mit Pauschaloption“ — über
 * {@link PauschalVormerkungService#umsetzen}, je Anlage in einer eigenen Transaktion. Das erste Jahr in der
 * Pauschaloption ist damit ein Rumpfjahr ab diesem Monatsersten (A2 S. 52–55, Abschn. 9).
 *
 * <p>Ohne Tag tut der Läufer nichts. Stündlich statt einmal im Monat: eingeschaltet wird mit einem Deploy zu
 * beliebiger Stunde, und vormerken lässt sich nur der nächste Monatserste (Vertrag § 5) — ein Takt am Monatsende
 * verlöre sonst einen Monat. Jeder weitere Takt ist still (die Vormerkung steht dann nicht mehr), und nach einem
 * Ausfall holt er nach. Eine Anlage, die scheitert, hält die anderen nicht auf.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-Systemeigenschaft) und in PRODUKTION AN
 * ({@code application.yml}, {@code matchIfMissing}); wer ihn prüft, ruft {@link #lauf()} selbst. Er wirft nie.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.mispel.pauschal-vormerkung.enabled", havingValue = "true",
        matchIfMissing = true)
public class PauschalVormerkungLaeufer {

    private static final Logger log = LoggerFactory.getLogger(PauschalVormerkungLaeufer.class);

    private final JdbcTemplate adminJdbc;
    private final PauschalVormerkungService dienst;

    /** Der Betriebs-Melder (Läufer {@code mispel_pauschal_vormerkung}); ohne Spring der stumme. */
    private UemsLaeuferMelder melder = UemsLaeuferMelder.STUMM;

    @Autowired(required = false)
    void melder(UemsLaeuferMelder melder) {
        this.melder = melder;
    }

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public PauschalVormerkungLaeufer(@Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            PauschalVormerkungService dienst) {
        this.adminJdbc = adminJdbc;
        this.dienst = dienst;
    }

    @Scheduled(cron = "${voltpilot.mispel.pauschal-vormerkung.cron:0 5 * * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int n = lauf();
            melder.gelaufen(UemsLaeuferMelder.MISPEL_PAUSCHAL_VORMERKUNG);
            if (n > 0) {
                log.info("Pauschal-Vormerkung: {} Anlage(n) zum {} in die Pauschaloption eingetragen", n, dienst.ziel());
            }
        } catch (RuntimeException e) {
            melder.fehler(UemsLaeuferMelder.MISPEL_PAUSCHAL_VORMERKUNG);
            log.warn("Pauschal-Vormerkung übersprungen: {}", e.toString());
        }
    }

    /**
     * Ein Takt über alle Kundenbereiche; gibt die Zahl der Anlagen zurück, deren Vormerkung eine Fassung wurde oder mit
     * der schon eingetragenen Pauschaloption verknüpft ist. Wirft nie je Anlage.
     */
    public int lauf() {
        LocalDate ziel = dienst.ziel();
        if (ziel == null) {
            return 0; // kein Tag (E7 = B) oder er liegt hinter dem nächsten Monatsersten
        }
        List<UUID> kundenbereiche = adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        int umgesetzt = 0;
        int wartend = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            try {
                TenantContext.set(tenant);
                for (UUID anlage : dienst.anlagenMitVormerkung()) {
                    try {
                        Ergebnis e = dienst.umsetzen(anlage);
                        if (e.umsetzung() == Umsetzung.UMGESETZT || e.umsetzung() == Umsetzung.VERKNUEPFT) {
                            umgesetzt++;
                            log.info("Pauschal-Vormerkung der Anlage {}: Fassung {} ab {} ({}){}", anlage, e.fassung(),
                                    e.gueltigAb(), e.umsetzung(), e.rumpfjahr() ? ", erstes Jahr Rumpfjahr bis "
                                            + e.rumpfjahrBis() + " (A2 S. 53)" : "");
                        } else if (e.umsetzung() == Umsetzung.WARTET_EINVERSTAENDNIS) {
                            wartend++;
                        }
                    } catch (RuntimeException e) {
                        melder.fehler(UemsLaeuferMelder.MISPEL_PAUSCHAL_VORMERKUNG);
                        log.warn("Pauschal-Vormerkung für Anlage {} nicht umgesetzt: {}", anlage,
                                e instanceof FoerderwegAbgelehnt a ? a.code() + " — " + a.getMessage() : e.toString());
                    }
                }
            } catch (RuntimeException e) {
                melder.fehler(UemsLaeuferMelder.MISPEL_PAUSCHAL_VORMERKUNG);
                log.warn("Pauschal-Vormerkung für Kundenbereich {} gescheitert: {}", tenant, e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        if (wartend > 0) {
            log.debug("Pauschal-Vormerkung: {} Anlage(n) warten zum {} auf das Ende der Übergangszeit (Tenor S. 3 "
                    + "Ziff. 9a, Einverständnis nicht angegeben)", wartend, ziel);
        }
        return umgesetzt;
    }
}
