package com.voltpilot.api.uems;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Die Eingangs-Geltungen einer Kennzahl (R-A6), ausschließlich Metadaten, niemals Werte oder Teilrechnungen.
 * Alle Fassungen und gespeicherten Eingänge gehören dazu: Detail, Fassungen und Versionshistorie dürfen keine
 * frühere fremde Quelle verraten. Messstellen-Formeln, Paare und Bezugsgrößen werden rekursiv aufgelöst.
 * Kein Aufheben von RLS: ein verdeckter oder fehlender Bezug bleibt unbekannt und damit außerhalb des Zugriffs.
 * Das Rechte-Urteil fällt ausschließlich {@code Geltungsbereich}.
 */
@Component
public class KennzahlUmfang {
    public static final String UNTERNEHMEN = "unternehmen";
    public static final String UNBEKANNT = "unbekannt";
    private final JdbcTemplate jdbc;

    public KennzahlUmfang(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private record Objekt(String art, UUID id) {}

    /** Standort-UUIDs oder die beiden ausdrücklich benannten Geltungen, ohne Namen. */
    public Set<String> eingaenge(UUID kennzahl) {
        Set<String> ziele = new LinkedHashSet<>();
        Set<Objekt> besucht = new HashSet<>();
        for (Objekt e : kennzahlEingaenge(kennzahl)) {
            sammeln(e, besucht, new HashSet<>(), ziele);
        }
        return Set.copyOf(ziele);
    }

    public Set<String> objekt(String art, UUID id) {
        Set<String> ziele = new LinkedHashSet<>();
        sammeln(new Objekt(art, id), new HashSet<>(), new HashSet<>(), ziele);
        return Set.copyOf(ziele);
    }

    private void sammeln(Objekt o, Set<Objekt> besucht, Set<Objekt> pfad, Set<String> ziele) {
        if (pfad.contains(o) || pfad.size() >= 32 || o.id() == null) {
            ziele.add(UNBEKANNT);
            return;
        }
        if (!besucht.add(o)) {
            return;
        }
        pfad.add(o);
        switch (o.art()) {
            case "kennzahl", "bezugsgroesse" -> {
                List<Objekt> geltung = jdbc.query("SELECT geltung_art, "
                        + "coalesce(unternehmen_id, standort_id, ort_id, prozess_id, kostenstelle_id, messstelle_id) "
                        + "FROM " + o.art() + " WHERE id = ?", (rs, n) -> new Objekt(rs.getString(1),
                        rs.getObject(2, UUID.class)), o.id());
                kinder(geltung, besucht, pfad, ziele);
                if (o.art().equals("kennzahl")) {
                    kinder(kennzahlEingaenge(o.id()), besucht, pfad, ziele);
                }
            }
            case "messstelle" -> {
                kinder(jdbc.query("SELECT CASE WHEN unternehmen_id IS NOT NULL THEN 'unternehmen' "
                        + "WHEN standort_id IS NOT NULL THEN 'standort' ELSE 'ort' END, "
                        + "coalesce(unternehmen_id, standort_id, ort_id) FROM messstelle_ort WHERE messstelle_id = ?",
                        (rs, n) -> new Objekt(rs.getString(1), rs.getObject(2, UUID.class)), o.id()),
                        besucht, pfad, ziele);
                List<Objekt> quellen = jdbc.query("SELECT CASE WHEN quell_messstelle_id IS NOT NULL "
                        + "THEN 'messstelle' ELSE 'messkanal' END, coalesce(quell_messstelle_id, entity_id) "
                        + "FROM messstelle_formel_term WHERE messstelle_id = ?",
                        (rs, n) -> new Objekt(rs.getString(1), rs.getObject(2, UUID.class)), o.id());
                quellen.forEach(q -> sammeln(q, besucht, pfad, ziele));
            }
            case "messkanal" -> kinder(jdbc.query("SELECT 'anlage', site_id FROM measurement_point WHERE id = ?",
                    (rs, n) -> new Objekt(rs.getString(1), rs.getObject(2, UUID.class)), o.id()), besucht, pfad, ziele);
            case "anlage" -> kinder(jdbc.query("SELECT 'standort', standort_id FROM anlage_standort "
                    + "WHERE site_id = ?", (rs, n) -> new Objekt(rs.getString(1), rs.getObject(2, UUID.class)), o.id()),
                    besucht, pfad, ziele);
            case "gebaeude", "bereich", "ort" -> kinder(jdbc.query("SELECT CASE WHEN eltern_standort_id IS NOT NULL "
                    + "THEN 'standort' ELSE 'ort' END, coalesce(eltern_standort_id, eltern_ort_id) "
                    + "FROM ort_zuordnung WHERE ort_id = ?",
                    (rs, n) -> new Objekt(rs.getString(1), rs.getObject(2, UUID.class)), o.id()), besucht, pfad, ziele);
            case "standort" -> ziele.add(o.id().toString());
            case "unternehmen", "prozess", "kostenstelle" -> ziele.add(UNTERNEHMEN);
            default -> ziele.add(UNBEKANNT);
        }
        pfad.remove(o);
    }

    private void kinder(List<Objekt> kinder, Set<Objekt> besucht, Set<Objekt> pfad, Set<String> ziele) {
        if (kinder.isEmpty()) {
            ziele.add(UNBEKANNT);
        }
        kinder.forEach(k -> sammeln(k, besucht, pfad, ziele));
    }

    private List<Objekt> kennzahlEingaenge(UUID kennzahl) {
        // Die eingefrorenen Eingänge gehören dazu, auch wenn eine heutige Fassung sie nicht mehr nennt.
        return jdbc.query("SELECT art, coalesce(messstelle_id, bezugsgroesse_id, eingang_kennzahl_id) "
                + "FROM kennzahl_eingang WHERE kennzahl_id = ? UNION "
                + "SELECT art, coalesce(messstelle_id, bezugsgroesse_id, eingang_kennzahl_id) "
                + "FROM kennzahl_wert_eingang WHERE kennzahl_id = ?",
                (rs, n) -> new Objekt(rs.getString(1), rs.getObject(2, UUID.class)), kennzahl, kennzahl);
    }
}
