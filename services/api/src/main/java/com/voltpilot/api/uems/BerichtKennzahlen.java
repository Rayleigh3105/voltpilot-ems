package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.sql.Date;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Der Kennzahlen-Abschnitt eines Berichts-Abzugs (UEMS AP-12 IP-6, bericht.md Q4, A3, Q6): welche Kennzahlen ein
 * Bericht zeigt, ihr gespeicherter Wert aus {@code kennzahl_wert} mit dem Nachweis in der Form von AP-11 IP-7 (die Zeile,
 * die {@link KennzahlWerteService#waehle} wählt, und ihre gespeicherten Eingänge) — und die Quellen, die daraus folgen.
 *
 * <p><b>Welche Kennzahlen (Q4, Geltung ⊆ Geltung).</b> Standort: Standort-, Gebäude- und Bereich-Kennzahlen des Standorts
 * und Messstellen-Kennzahlen seiner Messstellen. Unternehmen: nach den Vektoren B3/B4 (firstmate 001, 15.09.2026) die
 * Kennzahlen der Unternehmens-Ebene — Unternehmen, Prozess, Kostenstelle und Messstellen ohne Standort; Standort-Kennzahlen
 * erreichen den Unternehmensbericht nur mittelbar. Eine wirksame Zeile in {@code bericht_kennzahl_abwahl} lässt eine
 * Kennzahl weg; <b>keine Zeile heißt gewählt</b>.
 *
 * <p><b>Verfügbarkeit.</b> Fehlt eine der {@link #TABELLEN}, ist der Abschnitt leer und der Abzug entsteht trotzdem; fehlt
 * nur die Abwahl-Tabelle, sind alle Kennzahlen gewählt.
 *
 * <p><b>Was nicht in den Abschnitt kommt:</b> eine Kennzahl ohne gespeicherte Zahl in der Periode (Vertrag 1.0 verlangt
 * Version und Eingänge) — sie fehlt, nie mit 0.
 */
final class BerichtKennzahlen {

    /** Ohne diese Tabellen gibt es keinen Kennzahlen-Abschnitt — der Abzug entsteht trotzdem. */
    static final List<String> TABELLEN = List.of("bezugsgroesse", "kennzahl", "kennzahl_fassung", "kennzahl_eingang",
            "kennzahl_wert", "kennzahl_wert_eingang");

    /** Die Abwahl (V20260915113000); fehlt sie, sind alle Kennzahlen gewählt. */
    static final String ABWAHL = "bericht_kennzahl_abwahl";

    static final String MESSSTELLE = "messstelle";
    static final String BEZUGSGROESSE = "bezugsgroesse";
    static final String STAMMDATUM = "stammdatum";
    static final String KENNZAHL = "kennzahl";

    /** Wo gesucht wird: die Geltung des Berichts, seine Messstellen und seine Periode. */
    record Umfang(UUID bericht, String geltungArt, UUID standort, UUID unternehmen, Set<UUID> geltungMessstellen,
            Set<UUID> berichtMessstellen, String periodeArt, LocalDate ersterTag, LocalDate letzterTag, ZoneId zone) {}

    /** Der Abschnitt, seine Quellen und die Berechnungszeiten seiner Werte (D2). */
    record Abschnitt(ArrayNode kennzahlen, List<BerichtAbzugBildung.Quelle> quellen, List<Instant> zeiten) {}

    private record Kennzahl(UUID id, String kennzeichen, String name) {}

    /** Ein Eingang im Abzug ({@code art} des Vertrags) mit dem Objekt, das er als Quelle nennt. */
    private record Eingang(String art, String kennzeichen, String objektKennzeichen, UUID objekt, String name,
            BigDecimal wert, String einheit, Integer version, Integer fassung, LocalDate stichtag) {}

    private BerichtKennzahlen() {}

    /** Gibt es jede der Tabellen? {@code to_regclass} — die Anfrage scheitert nie an einer fehlenden Tabelle. */
    static boolean da(JdbcTemplate j, List<String> tabellen) {
        return Boolean.TRUE.equals(j.queryForObject(
                "SELECT coalesce(bool_and(to_regclass(t) IS NOT NULL), false) FROM unnest(?::text[]) AS t", Boolean.class,
                (Object) tabellen.toArray(String[]::new)));
    }

    static Abschnitt abschnitt(JdbcTemplate j, ObjectMapper json, UUID tenant, Umfang u) {
        ArrayNode aus = json.createArrayNode();
        List<BerichtAbzugBildung.Quelle> quellen = new ArrayList<>();
        List<Instant> zeiten = new ArrayList<>();
        if (!da(j, TABELLEN)) {
            return new Abschnitt(aus, quellen, zeiten);
        }
        List<Kennzahl> gewaehlt = gewaehlt(j, tenant, u);
        Set<UUID> unmittelbar = new HashSet<>();
        gewaehlt.forEach(k -> unmittelbar.add(k.id()));
        Set<UUID> besucht = new HashSet<>(unmittelbar);
        for (Kennzahl k : gewaehlt) {
            KennzahlWerteLeser.Zeile w = wert(j, k.id(), u);
            if (w == null) {
                continue;
            }
            List<Eingang> eingaenge = eingaenge(j, tenant, k.id(), w);
            if (eingaenge.isEmpty()) {
                continue;
            }
            zeiten.add(w.berechnetAm());
            aus.add(knoten(json, k, w, einheit(j, tenant, k.id(), w.definitionFassung()), eingaenge, u.zone()));
            quellen.add(new BerichtAbzugBildung.Quelle(KENNZAHL, k.kennzeichen(), k.id(), BerichtRegeln.UNMITTELBAR,
                    u.ersterTag(), u.letzterTag(), w.version(), w.definitionFassung(), k.name()));
            for (Eingang e : eingaenge) {
                switch (e.art()) {
                    // Bezugsgrößen einer Kennzahl des Berichts zitiert der Bericht selbst (ihr Wert steht im Nachweis) —
                    // so gruppieren die Vektoren B1 und B3 (BR-2026-0003).
                    case BEZUGSGROESSE, STAMMDATUM -> quellen.add(quelle(e, BerichtRegeln.UNMITTELBAR, u));
                    case MESSSTELLE -> {
                        if (!u.berichtMessstellen().contains(e.objekt())) {
                            quellen.add(quelle(e, BerichtRegeln.MITTELBAR, u));
                        }
                    }
                    default -> {
                        if (!unmittelbar.contains(e.objekt())) {
                            quellen.add(quelle(e, BerichtRegeln.MITTELBAR, u));
                            mittelbar(j, tenant, e.objekt(), u, quellen, besucht);
                        }
                    }
                }
            }
        }
        return new Abschnitt(aus, quellen, zeiten);
    }

    // =========================================================================== Auswahl (Q4)

    private static List<Kennzahl> gewaehlt(JdbcTemplate j, UUID tenant, Umfang u) {
        List<Object> args = new ArrayList<>(List.of(tenant));
        String geltung;
        String[] messstellen = u.geltungMessstellen().stream().map(UUID::toString).toArray(String[]::new);
        if (BerichtRegeln.STANDORT.equals(u.geltungArt())) {
            geltung = "(k.geltung_art = 'standort' AND k.standort_id = ?) "
                    + "OR (k.geltung_art IN ('gebaeude', 'bereich') AND k.ort_id = ANY (?::uuid[])) "
                    + "OR (k.geltung_art = 'messstelle' AND k.messstelle_id = ANY (?::uuid[]))";
            args.add(u.standort());
            args.add(orteDesStandorts(j, tenant, u).stream().map(UUID::toString).toArray(String[]::new));
            args.add(messstellen);
        } else {
            geltung = "(k.geltung_art = 'unternehmen' AND k.unternehmen_id = ?) "
                    + "OR k.geltung_art IN ('prozess', 'kostenstelle') "
                    + "OR (k.geltung_art = 'messstelle' AND k.messstelle_id = ANY (?::uuid[]))";
            args.add(u.unternehmen());
            args.add(messstellen);
        }
        String abwahl = "";
        if (da(j, List.of(ABWAHL))) {
            abwahl = " AND NOT EXISTS (SELECT 1 FROM bericht_kennzahl_abwahl a WHERE a.tenant_id = k.tenant_id "
                    + "AND a.bericht_id = ? AND a.kennzahl_id = k.id AND a.aufgehoben_am IS NULL)";
            args.add(u.bericht());
        }
        return j.query("SELECT k.id, k.kennzeichen, k.name FROM kennzahl k WHERE k.tenant_id = ? AND (" + geltung + ")"
                + abwahl + " ORDER BY k.kennzeichen, k.id",
                (rs, i) -> new Kennzahl(rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getString("name")),
                args.toArray());
    }

    /** Gebäude und Bereiche, die an einem Tag des Zeitraums unter dem Standort hängen (Tage einschließlich). */
    private static Set<UUID> orteDesStandorts(JdbcTemplate j, UUID tenant, Umfang u) {
        Set<UUID> aus = new LinkedHashSet<>();
        Date von = Date.valueOf(u.ersterTag());
        Date bis = Date.valueOf(u.letzterTag());
        j.query("""
                WITH RECURSIVE baum (ort_id, tiefe) AS (
                    SELECT z.ort_id, 0 FROM ort_zuordnung z
                     WHERE z.tenant_id = ? AND z.eltern_standort_id = ? AND z.aufgehoben_am IS NULL
                       AND z.gueltig_ab <= ? AND (z.gueltig_bis IS NULL OR z.gueltig_bis >= ?)
                    UNION
                    SELECT z.ort_id, b.tiefe + 1 FROM baum b
                      JOIN ort_zuordnung z ON z.tenant_id = ? AND z.eltern_ort_id = b.ort_id AND z.aufgehoben_am IS NULL
                       AND z.gueltig_ab <= ? AND (z.gueltig_bis IS NULL OR z.gueltig_bis >= ?)
                     WHERE b.tiefe < 8)
                SELECT DISTINCT ort_id FROM baum
                """, rs -> {
                    aus.add(rs.getObject(1, UUID.class));
                }, tenant, u.standort(), bis, von, tenant, bis, von);
        return aus;
    }

    // =========================================================================== Wert und Nachweis

    /** Die aktuelle Zeile der Periode mit einer Zahl — {@code null} ohne. */
    private static KennzahlWerteLeser.Zeile wert(JdbcTemplate j, UUID kennzahl, Umfang u) {
        KennzahlWerteLeser.Zeile z = KennzahlWerteService.waehle(
                new KennzahlWerteLeser(j).zeilen(kennzahl, u.periodeArt(), u.ersterTag(), u.ersterTag()), null);
        return z == null || z.version() == null || z.wert() == null ? null : z;
    }

    private static String einheit(JdbcTemplate j, UUID tenant, UUID kennzahl, int nummer) {
        return j.queryForObject("SELECT einheit FROM kennzahl_fassung WHERE tenant_id = ? AND kennzahl_id = ? "
                + "AND nummer = ?", String.class, tenant, kennzahl, nummer);
    }

    private static final String EINGANG_SQL = """
            SELECT e.art, coalesce(m.kennzeichen, b.kennzeichen, k.kennzeichen) AS kennzeichen,
                   coalesce(e.messstelle_id, e.bezugsgroesse_id, e.eingang_kennzahl_id) AS objekt_id,
                   coalesce(m.name, b.name, k.name) AS name, b.wertart, coalesce(o.kurzzeichen, s.kurzzeichen) AS ort,
                   %s
              FROM %s e
              LEFT JOIN messstelle m ON m.id = e.messstelle_id AND m.tenant_id = e.tenant_id
              LEFT JOIN bezugsgroesse b ON b.id = e.bezugsgroesse_id AND b.tenant_id = e.tenant_id
              LEFT JOIN ort o ON o.id = b.ort_id AND o.tenant_id = b.tenant_id
              LEFT JOIN standort s ON s.id = b.standort_id AND s.tenant_id = b.tenant_id
              LEFT JOIN kennzahl k ON k.id = e.eingang_kennzahl_id AND k.tenant_id = e.tenant_id
            """;

    /**
     * Die Eingänge, die die Zeile gespeichert hat ({@code kennzahl_wert_eingang}). Eine Zeit-Periode, die AP-11 IP-6 aus
     * ihren eigenen Teilperioden bildet (K14), hat keine — dann tragen Zähler und Nenner der Zeile die Eingänge ihrer
     * Definitions-Fassung, ohne Version (nichts wird nachgerechnet).
     */
    private static List<Eingang> eingaenge(JdbcTemplate j, UUID tenant, UUID kennzahl, KennzahlWerteLeser.Zeile w) {
        List<Eingang> aus = j.query(String.format(EINGANG_SQL, "e.objekt, e.wert, e.einheit, e.version, e.fassung",
                "kennzahl_wert_eingang") + " WHERE e.tenant_id = ? AND e.wert_id = ? ORDER BY e.position",
                (rs, i) -> eingang(rs.getString("art"), rs.getString("objekt"), rs.getObject("objekt_id", UUID.class),
                        rs.getString("name"), rs.getString("wertart"), rs.getString("ort"), rs.getBigDecimal("wert"),
                        rs.getString("einheit"), rs.getObject("version", Integer.class),
                        rs.getObject("fassung", Integer.class), w.periodeBis()),
                tenant, w.id());
        if (!aus.isEmpty()) {
            return aus.stream().filter(e -> e.wert() != null).toList();
        }
        return j.query(String.format(EINGANG_SQL, "e.rolle, coalesce(m.einheit, b.einheit) AS einheit",
                "kennzahl_eingang") + " JOIN kennzahl_fassung f ON f.id = e.fassung_id AND f.tenant_id = e.tenant_id "
                + "WHERE e.tenant_id = ? AND e.kennzahl_id = ? AND f.nummer = ? AND e.rolle IN ('zaehler', 'nenner') "
                + "ORDER BY e.position",
                (rs, i) -> eingang(rs.getString("art"), rs.getString("kennzeichen"),
                        rs.getObject("objekt_id", UUID.class), rs.getString("name"), rs.getString("wertart"),
                        rs.getString("ort"), "zaehler".equals(rs.getString("rolle")) ? w.zaehler() : w.nenner(),
                        rs.getString("einheit"), null, null, w.periodeBis()),
                tenant, kennzahl, w.definitionFassung()).stream().filter(e -> e.wert() != null).toList();
    }

    private static Eingang eingang(String art, String objekt, UUID id, String name, String wertart, String ort,
            BigDecimal wert, String einheit, Integer version, Integer fassung, LocalDate periodeBis) {
        if (BEZUGSGROESSE.equals(art) && STAMMDATUM.equals(wertart)) {
            // E17: ein Stammdatum gilt am letzten Tag der Periode; das Kennzeichen nennt sein Geltungsobjekt (K12).
            return new Eingang(STAMMDATUM, ort == null ? objekt : objekt + " (" + ort + ")", objekt, id, name, wert,
                    einheit, null, fassung, periodeBis);
        }
        return new Eingang(art, objekt, objekt, id, name, wert, einheit, BEZUGSGROESSE.equals(art) ? null : version,
                BEZUGSGROESSE.equals(art) ? fassung : null, null);
    }

    private static ObjectNode knoten(ObjectMapper json, Kennzahl k, KennzahlWerteLeser.Zeile w, String einheit,
            List<Eingang> eingaenge, ZoneId zone) {
        ObjectNode n = json.createObjectNode();
        n.put("quelle", k.kennzeichen());
        n.put("name_zum_datenstand", k.name());
        n.put("wert", w.wert());
        n.put("einheit", einheit);
        n.put("zustand", w.mengeZustand());
        n.put("abdeckung_prozent", w.abdeckungProzent() == null ? BigDecimal.ZERO : w.abdeckungProzent());
        ArrayNode kennzeichen = n.putArray("kennzeichen");
        (w.kennzeichen() == null ? List.<String>of() : w.kennzeichen()).forEach(kennzeichen::add);
        n.put("fassung", "endgueltig".equals(w.zustand()) ? KennzahlRegeln.ENDGUELTIG
                : "vorlaeufig".equals(w.zustand()) ? KennzahlRegeln.VORLAEUFIG : null);
        n.put("version", w.version());
        n.put("definition_fassung", w.definitionFassung());
        ArrayNode ein = n.putArray("eingaenge");
        for (Eingang e : eingaenge) {
            ObjectNode x = ein.addObject();
            x.put("art", e.art());
            x.put("kennzeichen", e.kennzeichen());
            x.put("wert", e.wert());
            x.put("einheit", e.einheit());
            if (e.version() != null) {
                x.put("version", e.version());
            }
            if (e.fassung() != null && BEZUGSGROESSE.equals(e.art())) {
                x.put("fassung", e.fassung());
            }
            if (e.stichtag() != null) {
                x.put("stichtag", e.stichtag().toString());
            }
        }
        n.put("berechnet_am", BerichtAbzugBildung.iso(w.berechnetAm(), zone));
        return n;
    }

    // =========================================================================== Quellen (Q6)

    private static BerichtAbzugBildung.Quelle quelle(Eingang e, String bezug, Umfang u) {
        boolean versioniert = MESSSTELLE.equals(e.art()) || KENNZAHL.equals(e.art());
        return new BerichtAbzugBildung.Quelle(e.art(), e.objektKennzeichen(), e.objekt(), bezug, u.ersterTag(),
                u.letzterTag(), versioniert ? e.version() : null, versioniert ? null : e.fassung(),
                e.name() == null ? e.objektKennzeichen() : e.name());
    }

    /** Die Eingänge einer Kennzahl, die der Bericht nur über eine andere zitiert — bis zur Messreihe, jede einmal. */
    private static void mittelbar(JdbcTemplate j, UUID tenant, UUID kennzahl, Umfang u,
            List<BerichtAbzugBildung.Quelle> quellen, Set<UUID> besucht) {
        if (!besucht.add(kennzahl)) {
            return;
        }
        KennzahlWerteLeser.Zeile w = wert(j, kennzahl, u);
        if (w == null) {
            return;
        }
        for (Eingang e : eingaenge(j, tenant, kennzahl, w)) {
            if (MESSSTELLE.equals(e.art()) && u.berichtMessstellen().contains(e.objekt())) {
                continue;
            }
            if (KENNZAHL.equals(e.art()) && besucht.contains(e.objekt())) {
                continue;
            }
            quellen.add(quelle(e, BerichtRegeln.MITTELBAR, u));
            if (KENNZAHL.equals(e.art())) {
                mittelbar(j, tenant, e.objekt(), u, quellen, besucht);
            }
        }
    }
}
