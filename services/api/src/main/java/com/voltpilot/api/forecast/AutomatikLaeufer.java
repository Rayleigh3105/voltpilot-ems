package com.voltpilot.api.forecast;

import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.repo.ForecastRueckblickRepository;
import com.voltpilot.api.repo.ForecastRueckblickRepository.ModellVergleich;
import com.voltpilot.api.repo.SiteForecastAutomatikRepository;
import com.voltpilot.api.tenant.TenantContext;
import java.time.LocalDate;
import java.time.ZoneId;
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
 * Der TAKT der Verbrauchs-Automatik (S5, Konzept vp-prognosen-konzept, E6 = B
 * / E7 = A, Bericht R.4): vergleicht täglich je Anlage den Vortagsvergleich
 * (28 Tage, {@code forecast_rueckblick}) des aktiven Lastmodells gegen seine
 * Kandidaten und übernimmt den Gewinner über
 * {@link ForecastModelService#promoteAutomatisch}.
 *
 * <p><b>Die Regel, wörtlich wie im Bericht:</b> ein Kandidat übernimmt, wenn
 * sein mittlerer Fehler je Viertelstunde mindestens 10&nbsp;% kleiner ist als
 * der des Basismodells UND sein mittlerer Tagesfehler (kWh) nicht größer ist;
 * erfüllen das mehrere, gewinnt der kleinste Fehler. Verglichen wird immer
 * gegen das BASISMODELL (``load-persistence``), nie gegen das gerade aktive -
 * damit ist ein Rücktausch dieselbe Entscheidung wie eine Übernahme: liegt
 * das zuvor übernommene Modell nicht mehr vorn, gewinnt wieder die Basis, ganz
 * ohne eigenen Rückweg-Code. Jede Anlage, deren Automatik ausgeschaltet ist
 * (eine Wahl von Hand, Bericht R.4 Punkt 2), wird übersprungen.
 *
 * <p><b>⚠ Wie jeder {@code @Scheduled} ist er im TESTLAUF AUS</b> (surefire-
 * Systemeigenschaft) und in PRODUKTION AN ({@code application.yml},
 * {@code matchIfMissing}) - dieselbe Form wie {@code LadeparkGrenzeLaeufer}.
 * Höchstens einmal am Tag (Bericht R.4 Punkt 4), weil der Takt selbst nur
 * einmal täglich läuft - kein eigenes Schloss nötig. Er wirft nie je Anlage.
 */
@Component
@ConditionalOnProperty(name = "voltpilot.forecast.automatik.enabled", havingValue = "true", matchIfMissing = true)
public class AutomatikLaeufer {

    private static final Logger log = LoggerFactory.getLogger(AutomatikLaeufer.class);
    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    /** 28 Tage Vergleich (Bericht R.4 Punkt 5) - sowohl Fenster als auch Mindestmenge. */
    static final int VERGLEICHSTAGE = 28;
    /** Mindestens 10 % kleinerer mittlerer Fehler je Viertelstunde (Bericht R.4). */
    static final double SCHWELLE = 0.9;
    private static final int LEAD_DAYS_VORTAG = 1;

    private final JdbcTemplate adminJdbc;
    private final JdbcTemplate jdbc;
    private final ForecastRueckblickRepository rueckblick;
    private final SiteForecastAutomatikRepository automatik;
    private final ForecastModelService modelle;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public AutomatikLaeufer(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            JdbcTemplate jdbc,
            ForecastRueckblickRepository rueckblick,
            SiteForecastAutomatikRepository automatik,
            ForecastModelService modelle) {
        this.adminJdbc = adminJdbc;
        this.jdbc = jdbc;
        this.rueckblick = rueckblick;
        this.automatik = automatik;
        this.modelle = modelle;
    }

    @Scheduled(cron = "${voltpilot.forecast.automatik.cron:0 0 6 * * *}", zone = "Europe/Berlin")
    public void takt() {
        try {
            int n = lauf();
            if (n > 0) {
                log.info("Prognose-Automatik: {} Anlage(n) umgestellt", n);
            }
        } catch (RuntimeException e) {
            log.warn("Prognose-Automatik: Takt übersprungen: {}", e.toString());
        }
    }

    /** Ein Takt über alle Kundenbereiche und ihre Anlagen. Gibt die Zahl der Umstellungen zurück. */
    public int lauf() {
        List<UUID> kundenbereiche =
                adminJdbc.queryForList("SELECT id FROM tenant ORDER BY created_at, id", UUID.class);
        LocalDate seit = LocalDate.now(BERLIN).minusDays(VERGLEICHSTAGE);
        int umgestellt = 0;
        for (UUID tenant : kundenbereiche) {
            if (beendete.beendet(tenant)) {
                continue; // Kundenbereich beendet: der Läufer lässt ihn aus
            }
            try {
                TenantContext.set(tenant);
                for (UUID site : jdbc.queryForList("SELECT id FROM site", UUID.class)) {
                    try {
                        if (umstellen(site, seit)) {
                            umgestellt++;
                        }
                    } catch (RuntimeException e) {
                        log.warn("Prognose-Automatik für Anlage {} gescheitert: {}", site, e.toString());
                    }
                }
            } catch (RuntimeException e) {
                log.warn("Prognose-Automatik für Kundenbereich {} gescheitert: {}", tenant, e.toString());
            } finally {
                TenantContext.clear();
            }
        }
        return umgestellt;
    }

    private boolean umstellen(UUID siteId, LocalDate seit) {
        if (!automatik.aktiv(siteId)) {
            return false; // eine Wahl von Hand gewinnt (Bericht R.4 Punkt 2)
        }
        List<ModellVergleich> vergleich =
                rueckblick.vergleich(siteId, ForecastModels.KIND_LOAD, LEAD_DAYS_VORTAG, seit);
        String aktiv = modelle.activeModels(siteId).get(ForecastModels.KIND_LOAD);
        String gewinner = entscheide(
                vergleich, ForecastModels.baselineOf(ForecastModels.KIND_LOAD), aktiv,
                VERGLEICHSTAGE, SCHWELLE);
        if (gewinner == null) {
            return false;
        }
        modelle.promoteAutomatisch(siteId, ForecastModels.KIND_LOAD, gewinner);
        log.info("Prognose-Automatik: Anlage {} wechselt Verbrauch von {} zu {}", siteId, aktiv, gewinner);
        return true;
    }

    /**
     * Die Entscheidung selbst - rein, ohne Datenbank (Bericht R.4): verglichen
     * wird jeder Kandidat IMMER gegen das Basismodell, nie gegen das gerade
     * aktive, damit ein Rücktausch dieselbe Rechnung ist wie eine Übernahme.
     * Gibt die Modell-Id zurück, die ab jetzt gelten soll, oder {@code null},
     * wenn sich nichts ändert (das Basismodell hat selbst zu wenig Tage, oder
     * der Gewinner ist bereits aktiv).
     */
    static String entscheide(
            List<ModellVergleich> vergleich, String basisModel, String aktivesModel,
            int mindestTage, double schwelle) {
        ModellVergleich basis = vergleich.stream()
                .filter(m -> basisModel.equals(m.model()))
                .findFirst()
                .orElse(null);
        if (basis == null || basis.tage() < mindestTage) {
            return null; // keine verlässliche Vergleichsgröße
        }
        ModellVergleich bester = null;
        for (ModellVergleich kandidat : vergleich) {
            if (kandidat.model().equals(basisModel) || kandidat.tage() < mindestTage) {
                continue;
            }
            boolean deutlichGenauer = kandidat.meanMaeKw() <= basis.meanMaeKw() * schwelle;
            boolean nichtSchlechterImTag = kandidat.meanTagesfehlerKwh() <= basis.meanTagesfehlerKwh();
            if (deutlichGenauer && nichtSchlechterImTag
                    && (bester == null || kandidat.meanMaeKw() < bester.meanMaeKw())) {
                bester = kandidat;
            }
        }
        String gewinner = bester != null ? bester.model() : basisModel;
        return gewinner.equals(aktivesModel) ? null : gewinner;
    }
}
