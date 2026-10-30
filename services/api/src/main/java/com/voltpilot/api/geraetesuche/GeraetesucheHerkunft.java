package com.voltpilot.api.geraetesuche;

import com.voltpilot.api.uems.ProtokollAkteur;
import com.voltpilot.api.web.dto.GeraetesucheBezug;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Herkunft einer Komponente aus der Gerätesuche (Folgepaket vp-gs-folge-herkunft; Konzept §7 „Protokoll und was
 * der Kunde sieht"): der Haken im Anlege-Weg ({@code POST …/components}) und im Bearbeiten-Weg der neuen Adresse
 * (DP-7 A, {@code PUT …/components/{id}}).
 *
 * <p><b>Die Wahrheit steht genau einmal</b>, im nur anfügenden {@code geraetesuche_protokoll}
 * ({@code V20261030181500__geraetesuche_herkunft.sql}): die Zeile {@code uebernommen} nennt Suche, Fund, Komponente,
 * Person und den Suchtag. Die Komponentenliste liest daraus „aus der Gerätesuche vom …", die Aktivität der Box
 * dieselbe Zeile - keine zweite Spalte an der Komponente, die abdriften könnte. Weil das Protokoll den Läufer nach
 * 30 Tagen überlebt (DP-3 A), bleibt der Satz lesbar, wenn Suche und Fund längst gelöscht sind.
 *
 * <p>Alles unter der Verbindung der Anfrage: Mandanten-RLS und Standort-Zaun gelten für Suche, Fund und Protokoll.
 */
@Repository
public class GeraetesucheHerkunft {

    /** Ein Fund wurde über „Übernehmen" zu einer Komponente. */
    public static final String UEBERNOMMEN = "uebernommen";
    /** Die neue Adresse eines Fundes ging an eine bestehende Komponente (DP-7 A). */
    public static final String ADRESSE_UEBERNOMMEN = "adresse_uebernommen";

    /** Die Ablehnung eines Bezugs: fremd, unbekannt und abgelaufen sagen dasselbe - ein fremder Fund verrät nichts. */
    static final String UNBEKANNT = "Dieser Fund stammt aus keiner Gerätesuche dieser Anlage in den letzten 30 Tagen. "
            + "Bitte suchen Sie erneut.";

    /**
     * Ein geprüfter Bezug.
     *
     * @param gesuchtAm wann die Suche ausgelöst wurde - der Tag im Satz „aus der Gerätesuche vom …"
     */
    public record Fund(UUID suchId, UUID deviceId, String schluessel, Instant gesuchtAm) {
    }

    /** Die Herkunft einer Komponente: die jüngste Übernahme, die sie angelegt hat. */
    public record Herkunft(UUID suchId, Instant gesuchtAm, Instant uebernommenAm) {
    }

    private final JdbcTemplate jdbc;

    public GeraetesucheHerkunft(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Glaubt den Bezug des Portals erst, wenn Suche und Fund in DIESER Anlage liegen und die Suche keine 30 Tage alt
     * ist ({@link GeraetesucheDienst#VERLAUF}, Datenbank-Uhr wie der Läufer). Den Mandanten prüft RLS: ein Fund
     * eines anderen Kundenbereichs ist hier unsichtbar und damit unbekannt.
     *
     * @throws ResponseStatusException 422, ohne dass irgendetwas geschrieben wurde
     */
    public Fund pruefen(UUID siteId, GeraetesucheBezug bezug) {
        List<Fund> treffer = jdbc.query("""
                SELECT s.id, s.device_id, f.schluessel, s.ausgeloest_am
                  FROM geraetesuche s
                  JOIN geraetesuche_fund f ON f.such_id = s.id AND f.site_id = s.site_id
                 WHERE s.id = ? AND s.site_id = ? AND f.schluessel = ?
                   AND s.ausgeloest_am > now() - make_interval(days => ?)""",
                (rs, n) -> new Fund(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                        rs.getTimestamp(4).toInstant()),
                bezug.suchId(), siteId, bezug.fund(), (int) GeraetesucheDienst.VERLAUF.toDays());
        if (treffer.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, UNBEKANNT);
        }
        return treffer.get(0);
    }

    /**
     * Schreibt die Protokollzeile einer Übernahme - nur, wenn die Komponente in dieser Anlage steht. Einen Namen
     * schreibt sie nicht (DP-3 A: keine Spalte für einen Gerätenamen); die Aktivität liest ihn aus der Komponente.
     */
    public void protokollieren(UUID tenantId, UUID siteId, Fund fund, String art, UUID entityId, ProtokollAkteur wer) {
        int n = jdbc.update("""
                INSERT INTO geraetesuche_protokoll (tenant_id, site_id, device_id, such_id, art, actor_sub, actor_name,
                                                    actor_rolle, actor_art, entity_id, fund_schluessel, gesucht_am)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, m.id, ?, ?
                  FROM measurement_point m
                 WHERE m.id = ? AND m.site_id = ?""",
                tenantId, siteId, fund.deviceId(), fund.suchId(), art, wer.sub(), wer.name(), wer.rolle(), wer.art(),
                fund.schluessel(), Timestamp.from(fund.gesuchtAm()), entityId, siteId);
        if (n != 1) {
            throw new IllegalStateException("Komponente " + entityId + " fehlt in Anlage " + siteId);
        }
    }

    /** Die Herkunft je Komponente dieser Anlage; eine Komponente ohne Übernahme fehlt in der Karte. */
    public Map<UUID, Herkunft> herkunft(UUID siteId) {
        Map<UUID, Herkunft> out = new LinkedHashMap<>();
        jdbc.query("""
                SELECT DISTINCT ON (entity_id) entity_id, such_id, gesucht_am, am
                  FROM geraetesuche_protokoll
                 WHERE site_id = ? AND art = ?
                 ORDER BY entity_id, am DESC, id DESC""",
                rs -> {
                    out.put(rs.getObject("entity_id", UUID.class), new Herkunft(rs.getObject("such_id", UUID.class),
                            rs.getTimestamp("gesucht_am").toInstant(), rs.getTimestamp("am").toInstant()));
                }, siteId, UEBERNOMMEN);
        return out;
    }
}
