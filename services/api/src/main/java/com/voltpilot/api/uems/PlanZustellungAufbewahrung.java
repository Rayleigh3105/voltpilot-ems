package com.voltpilot.api.uems;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die Frist für {@code plan_zustellung} (AP-15 IP-11, Befund aus IP-10: 96 Zeilen je Box und Tag,
 * keine Frist). Eine Zeile, deren jüngster Zeitpunkt (Erzeugung, Veröffentlichung, Ankunft der
 * Quittung) älter als {@code voltpilot.uems.plan-zustellung.aufbewahrung-tage} (Vorgabe 35) ist,
 * wird gelöscht — <b>außer</b> je Box der jüngsten veröffentlichten und der jüngsten angenommenen
 * Zeile, auch wenn sie älter sind: sie tragen „veröffentlicht gegen angenommen“ (R11) und damit
 * die Box-Metriken und das Betreiber-Blatt. „Jüngste“ in derselben Ordnung wie
 * {@link PlanZustellungRepository#stand}.
 *
 * <p>Der Lauf arbeitet über alle Kundenbereiche und braucht darum die Verwaltungsrolle (V4s
 * {@code ALTER DEFAULT PRIVILEGES} gibt ihr {@code DELETE}; die App-Rolle hat es bewusst nicht).
 * Stapel zu {@link #STAPEL} Zeilen, damit eine große Altlast keine lange Sperre hält.
 */
@Component
public class PlanZustellungAufbewahrung {

    public static final int STAPEL = 5_000;

    /** Die Ordnung von {@link PlanZustellungRepository#stand}. */
    private static final String JUENGSTE = """
            SELECT DISTINCT ON (device_id) device_id, plan_id FROM plan_zustellung
             WHERE %s
             ORDER BY device_id, generated_at DESC NULLS LAST, COALESCE(veroeffentlicht_um, quittiert_um) DESC
            """;

    private static final String LOESCHEN = "DELETE FROM plan_zustellung WHERE (device_id, plan_id) IN ("
            + "SELECT z.device_id, z.plan_id FROM plan_zustellung z "
            + "WHERE GREATEST(z.generated_at, z.veroeffentlicht_um, z.empfangen_um) < now() - make_interval(days => ?) "
            + "AND (z.device_id, z.plan_id) NOT IN (" + JUENGSTE.formatted("veroeffentlicht_um IS NOT NULL") + ") "
            + "AND (z.device_id, z.plan_id) NOT IN (" + JUENGSTE.formatted("urteil = 'angenommen'") + ") "
            + "LIMIT " + STAPEL + ")";

    private final JdbcTemplate admin;
    private final int tage;

    public PlanZustellungAufbewahrung(@Qualifier("adminJdbcTemplate") JdbcTemplate admin,
            @Value("${voltpilot.uems.plan-zustellung.aufbewahrung-tage:35}") int tage) {
        if (tage < 1) {
            throw new IllegalArgumentException("voltpilot.uems.plan-zustellung.aufbewahrung-tage muss mindestens 1 sein");
        }
        this.admin = admin;
        this.tage = tage;
    }

    /** Löscht jede Zeile jenseits der Frist, die nicht die jüngste ihrer Art ist; gibt die Zahl zurück. */
    public int lauf() {
        int gesamt = 0;
        int stapel;
        do {
            stapel = admin.update(LOESCHEN, tage);
            gesamt += stapel;
        } while (stapel == STAPEL);
        return gesamt;
    }
}
