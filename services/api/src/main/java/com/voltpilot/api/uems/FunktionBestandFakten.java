package com.voltpilot.api.uems;

import com.voltpilot.api.profile.AnwendungKatalog;
import com.voltpilot.api.profile.SiteProfileService;
import com.voltpilot.api.web.dto.SiteProfilesDto;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Liest, was der BESTAND über eine Anlage weiß, als {@link FunktionZustandAbleitung.BestandEingang}
 * (UEMS AP-01 IP-2, §4.3 „Bestand → Zustand“, W5) — die Eingänge der Regel, nie die Regel selbst.
 * Rein lesend: kein Schreibzug, kein Publisher.
 *
 * <p><b>Die Abbildung</b> (jede Zeile ein Fakt, den es heute schon gibt):
 * <ul>
 *   <li><b>Betriebsmodell an</b> — eine Anwendung der Exklusiv-Gruppe {@code speicher}
 *       (Marktoptimierung, Lastspitzenkappung, Atypische Netznutzung), die das Regal der Anlage
 *       als {@code active} zeigt: gespeichertes {@code an} ODER abgeleitet aktiv, ein
 *       gespeichertes {@code aus} schlägt beides. Gelesen über {@link SiteProfileService#profiles}
 *       — dieselbe Rechnung wie die Fläche „Betriebsmodelle“, nie eine zweite. {@code seit} ist
 *       das der Karte (nur ein gespeichertes {@code an} hat eines).</li>
 *   <li><b>Scharfschaltung</b> — eine Zeile {@code device_control_activation} an einem nicht
 *       ausgebauten Gerät der Anlage (Glossar „Steuer-Scharfschaltung“). Die Tabelle ist
 *       mandantenfrei; gelesen über die BYPASSRLS-Verbindung, eng auf Mandant UND Anlage.</li>
 *   <li><b>Eigenverbrauchs-Fahrplan läuft</b> — scharfgeschaltet UND der Grundmodus
 *       {@code speicher-fahrplan} ist aktiv (die Anlage hat einen Speicher); seit der frühesten
 *       Scharfschaltung.</li>
 *   <li><b>Steuerart oder Regel wirksam</b> — eine aktive {@code consumer_policy} eines
 *       eingeschalteten Verbrauchers, ein aktiver {@code flow_definition}, oder eine Lade-Steuerart
 *       „Nur Sonne“/„Sonne zuerst“ (Standard der Anlage oder je Ladepunkt); seit der frühesten
 *       Aktivierung, die Lade-Steuerart ohne Datum.</li>
 * </ul>
 *
 * <p><b>⚠ Im Zweifel „läuft“.</b> Die Richtung eines Irrtums ist nicht gleichgültig: eine
 * steuernde Anlage, die als „eingerichtet“ oder „reine Messung“ übernommen würde, fiele mit der
 * Ruhe bis zum Start (IP-4, R0) aus ihrer Steuerung — eine fälschlich „aktive“ zeigt dagegen nur
 * „steuert nicht — Grund“ (Vektor {@code eigenverbrauchs-fahrplan-laeuft-ist-aktiv}).
 */
@Component
public class FunktionBestandFakten {

    /** Die Exklusiv-Gruppe der Betriebsmodelle des Speichers im Katalog. */
    static final String BETRIEBSMODELLE = "speicher";

    private final SiteProfileService profile;
    private final JdbcTemplate jdbc;
    private final JdbcTemplate adminJdbc;

    public FunktionBestandFakten(SiteProfileService profile, JdbcTemplate jdbc,
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc) {
        this.profile = profile;
        this.jdbc = jdbc;
        this.adminJdbc = adminJdbc;
    }

    /** Die Bestandsfakten der Anlage des Mandanten {@code tenantId} (im {@code TenantContext}). */
    public FunktionZustandAbleitung.BestandEingang lesen(UUID tenantId, UUID siteId, String anlagenName) {
        SiteProfilesDto regal = profile.profiles(siteId);
        List<SiteProfilesDto.Profile> karten = new ArrayList<>();
        if (regal != null) {
            karten.addAll(regal.profiles());
            karten.addAll(regal.weitere());
        }
        boolean betriebsmodellAn = false;
        Instant betriebsmodellSeit = null;
        boolean grundmodus = false;
        for (SiteProfilesDto.Profile k : karten) {
            if (!k.active()) {
                continue;
            }
            if (BETRIEBSMODELLE.equals(k.exklusivGruppe())) {
                betriebsmodellAn = true;
                betriebsmodellSeit = frueher(betriebsmodellSeit, k.seit());
            } else if (AnwendungKatalog.SPEICHER_FAHRPLAN.equals(k.id())) {
                grundmodus = true;
            }
        }

        Frueheste scharf = adminJdbc.queryForObject("SELECT count(*) AS n, min(a.activated_at) AS seit "
                + "FROM device_control_activation a JOIN device d ON d.id = a.device_id AND d.ausgebaut_am IS NULL "
                + "WHERE d.tenant_id = ? AND d.site_id = ?", Frueheste::map, tenantId, siteId);
        boolean scharfschaltung = scharf.n() > 0;

        Frueheste regel = jdbc.queryForObject("SELECT count(*) AS n, min(p.activated_at) AS seit "
                + "FROM consumer_policy p JOIN consumer_profile c ON c.entity_id = p.entity_id "
                + "WHERE p.site_id = ? AND p.lifecycle = 'active' AND c.enabled", Frueheste::map, siteId);
        Frueheste flow = jdbc.queryForObject("SELECT count(*) AS n, min(activated_at) AS seit "
                + "FROM flow_definition WHERE site_id = ? AND lifecycle = 'active'", Frueheste::map, siteId);
        boolean ladeSteuerart = Boolean.TRUE.equals(jdbc.queryForObject("SELECT "
                + "EXISTS (SELECT 1 FROM site_charging_config WHERE site_id = ? "
                + "AND surplus_policy IN ('nur_sonne', 'sonne_zuerst')) "
                + "OR EXISTS (SELECT 1 FROM site_charge_point_allowlist WHERE site_id = ? "
                + "AND source IN ('nur_sonne', 'sonne_zuerst'))", Boolean.class, siteId, siteId));

        boolean eigenverbrauch = scharfschaltung && grundmodus;
        boolean steuerart = regel.n() > 0 || flow.n() > 0 || ladeSteuerart;
        return new FunktionZustandAbleitung.BestandEingang(anlagenName,
                betriebsmodellAn, betriebsmodellSeit,
                eigenverbrauch, eigenverbrauch ? scharf.seit() : null,
                steuerart, frueher(regel.seit(), flow.seit()),
                scharfschaltung);
    }

    private record Frueheste(long n, Instant seit) {

        static Frueheste map(java.sql.ResultSet rs, int zeile) throws java.sql.SQLException {
            Timestamp t = rs.getTimestamp("seit");
            return new Frueheste(rs.getLong("n"), t == null ? null : t.toInstant());
        }
    }

    private static Instant frueher(Instant a, Instant b) {
        if (a == null) {
            return b;
        }
        return b == null || a.isBefore(b) ? a : b;
    }
}
