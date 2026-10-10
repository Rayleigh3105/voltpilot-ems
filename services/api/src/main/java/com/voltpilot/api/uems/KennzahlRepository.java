package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.KennzahlDto;
import java.math.BigDecimal;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Tabellen der Kennzahl-Definition (UEMS AP-11 IP-4, {@code V20260915003000}) für die Schreibrouten und das
 * Lesemodell der Definition (IP-5). Alles läuft unter der Mandanten-RLS der Anwendungsrolle: eine fremde Zeile ist
 * nicht da. Werte schreibt hier niemand — das tut der Rechenlauf als Verwaltungsrolle ({@link KennzahlLauf}); gelesen
 * werden sie für die Vorschau, die Paare einer Zusammenfassung und den Rechenlauf ({@link #werte}).
 */
@Repository
public class KennzahlRepository {

    private final JdbcTemplate jdbc;

    public KennzahlRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------------------ Formen

    public record Zeile(UUID id, String kennzeichen, String name, String rechenform, String geltungArt, UUID geltungId,
            String verantwortlichSub, String verantwortlichName, String zweck, Instant archiviertAm, Instant angelegtAm) {}

    public record FassungZeile(UUID id, UUID kennzahlId, int nummer, String rechenform, LocalDate gueltigAb,
            LocalDate gueltigBis, Instant aufgehobenAm, String herkunft, boolean rueckwirkend, String begruendung,
            String actorName, String actorRolle, String actorArt, Instant eingetragenAm, boolean komplement,
            String einheit) {

        public boolean wirksam() {
            return aufgehobenAm == null;
        }

        public MessstelleFormelRegeln.Fassung alsRegel() {
            return new MessstelleFormelRegeln.Fassung(nummer, gueltigAb, gueltigBis);
        }
    }

    /** Ein Eingang einer Fassung mit dem HEUTIGEN Kennzeichen, Namen und der Einheit seines Objekts. */
    public record EingangZeile(UUID fassungId, UUID kennzahlId, int position, String rolle, String art, UUID objektId,
            String kennzeichen, String name) {}

    public record MessstelleZeile(UUID id, String kennzeichen, String name, String groesse, String einheit,
            String wertart) {}

    public record BezugsgroesseZeile(UUID id, String kennzeichen, String name, String wertart, String einheit,
            String periodeArt, String geltungArt, UUID geltungId, Instant archiviertAm) {}

    public record Standort(UUID id, String name, String zeitzone) {}

    /** Der jüngste Stand eines Kennzahl-Werts einer Periode (höchste Version, dann jüngstes {@code berechnet_am}). */
    public record WertZeile(BigDecimal wert, BigDecimal zaehler, BigDecimal nenner, String mengeZustand, String richtung,
            BigDecimal abdeckungProzent, String zustand, List<String> kennzeichenJson) {}

    private static final String SPALTEN = "k.id, k.kennzeichen, k.name, k.rechenform, k.geltung_art, "
            + "coalesce(k.unternehmen_id, k.standort_id, k.ort_id, k.prozess_id, k.kostenstelle_id, k.messstelle_id) "
            + "AS geltung_id, k.verantwortlich_sub, k.verantwortlich_name, k.zweck, k.archiviert_am, k.angelegt_am";

    private static final String FASSUNG_SPALTEN = "f.id, f.kennzahl_id, f.nummer, f.rechenform, f.gueltig_ab, "
            + "f.gueltig_bis, f.aufgehoben_am, f.herkunft, f.rueckwirkend, f.begruendung, f.actor_name, f.actor_rolle, "
            + "f.actor_art, f.eingetragen_am, f.komplement, f.einheit";

    private static final String EINGANG_SQL = "SELECT e.fassung_id, e.kennzahl_id, e.position, e.rolle, e.art, "
            + "coalesce(e.messstelle_id, e.bezugsgroesse_id, e.eingang_kennzahl_id) AS objekt_id, "
            + "coalesce(m.kennzeichen, b.kennzeichen, k.kennzeichen) AS kennzeichen, "
            + "coalesce(m.name, b.name, k.name) AS name "
            + "FROM kennzahl_eingang e "
            + "LEFT JOIN messstelle m ON m.id = e.messstelle_id "
            + "LEFT JOIN bezugsgroesse b ON b.id = e.bezugsgroesse_id "
            + "LEFT JOIN kennzahl k ON k.id = e.eingang_kennzahl_id ";

    // ------------------------------------------------------------------------------ lesen

    public List<Zeile> alle() {
        return jdbc.query("SELECT " + SPALTEN + " FROM kennzahl k ORDER BY k.kennzeichen", KennzahlRepository::zeile);
    }

    public Optional<Zeile> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM kennzahl k WHERE k.id = ?", KennzahlRepository::zeile, id)
                .stream().findFirst();
    }

    /** Sperrt die Kennzahl für die Dauer der Transaktion (Fassung, Stammdaten, Archivieren). */
    public Optional<Zeile> sperre(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM kennzahl k WHERE k.id = ? FOR UPDATE", KennzahlRepository::zeile,
                id).stream().findFirst();
    }

    public Optional<Zeile> nachKennzeichen(String kennzeichen) {
        return jdbc.query("SELECT " + SPALTEN + " FROM kennzahl k WHERE k.kennzeichen = ?", KennzahlRepository::zeile,
                kennzeichen).stream().findFirst();
    }

    /** Alle Fassungen des Kundenbereichs, je Kennzahl nach Nummer. */
    public List<FassungZeile> alleFassungen() {
        return jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM kennzahl_fassung f ORDER BY f.kennzahl_id, f.nummer",
                KennzahlRepository::fassung);
    }

    public List<FassungZeile> fassungen(UUID kennzahl) {
        return jdbc.query("SELECT " + FASSUNG_SPALTEN + " FROM kennzahl_fassung f WHERE f.kennzahl_id = ? "
                + "ORDER BY f.nummer", KennzahlRepository::fassung, kennzahl);
    }

    public int hoechsteNummer(UUID kennzahl) {
        Integer n = jdbc.queryForObject("SELECT coalesce(max(nummer), 0) FROM kennzahl_fassung WHERE kennzahl_id = ?",
                Integer.class, kennzahl);
        return n == null ? 0 : n;
    }

    /** Alle Eingänge des Kundenbereichs, je Fassung nach Position. */
    public List<EingangZeile> alleEingaenge() {
        return jdbc.query(EINGANG_SQL + "ORDER BY e.fassung_id, e.position", KennzahlRepository::eingang);
    }

    public Optional<MessstelleZeile> messstelle(String kennzeichen) {
        return jdbc.query("SELECT id, kennzeichen, name, groesse, einheit, wertart FROM messstelle WHERE kennzeichen = ?",
                (rs, i) -> new MessstelleZeile(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                        rs.getString("name"), rs.getString("groesse"), rs.getString("einheit"), rs.getString("wertart")),
                kennzeichen).stream().findFirst();
    }

    public Optional<MessstelleZeile> messstelle(UUID id) {
        return jdbc.query("SELECT id, kennzeichen, name, groesse, einheit, wertart FROM messstelle WHERE id = ?",
                (rs, i) -> new MessstelleZeile(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                        rs.getString("name"), rs.getString("groesse"), rs.getString("einheit"), rs.getString("wertart")),
                id).stream().findFirst();
    }

    private static final String BEZUGSGROESSE_SQL = "SELECT id, kennzeichen, name, wertart, einheit, periode_art, "
            + "geltung_art, coalesce(unternehmen_id, standort_id, ort_id, prozess_id, kostenstelle_id, messstelle_id) "
            + "AS geltung_id, archiviert_am FROM bezugsgroesse ";

    public Optional<BezugsgroesseZeile> bezugsgroesse(String kennzeichen) {
        return jdbc.query(BEZUGSGROESSE_SQL + "WHERE kennzeichen = ?", KennzahlRepository::bezugsgroesse, kennzeichen)
                .stream().findFirst();
    }

    public Optional<BezugsgroesseZeile> bezugsgroesse(UUID id) {
        return jdbc.query(BEZUGSGROESSE_SQL + "WHERE id = ?", KennzahlRepository::bezugsgroesse, id).stream().findFirst();
    }

    /** Der Name des Objekts eines Geltungsbereichs — leer, wenn es im Kundenbereich nicht da ist. */
    public Optional<String> geltungName(String art, UUID id) {
        String sql = switch (art) {
            case "unternehmen" -> "SELECT name FROM unternehmen WHERE id = ?";
            case "standort" -> "SELECT name FROM standort WHERE id = ?";
            case "gebaeude", "bereich" -> "SELECT name FROM ort WHERE id = ? AND art = '" + art + "'";
            case "prozess" -> "SELECT name FROM prozess WHERE id = ?";
            case "kostenstelle" -> "SELECT name FROM kostenstelle WHERE id = ?";
            case "messstelle" -> "SELECT coalesce(name, kennzeichen) FROM messstelle WHERE id = ?";
            default -> null;
        };
        return sql == null ? Optional.empty()
                : jdbc.queryForList(sql, String.class, id).stream().findFirst();
    }

    public List<Standort> standorte() {
        return jdbc.query("SELECT id, name, zeitzone FROM standort ORDER BY name, id",
                (rs, i) -> new Standort(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("zeitzone")));
    }

    /** Die Zeitzone eines Standorts, sonst die des Unternehmens, sonst Europe/Berlin (Muster Bezugsgröße). */
    public String zeitzone(UUID standort) {
        return jdbc.queryForObject("SELECT coalesce((SELECT s.zeitzone FROM standort s WHERE s.id = ?), "
                + "(SELECT u.zeitzone FROM unternehmen u ORDER BY u.id LIMIT 1), 'Europe/Berlin')", String.class, standort);
    }

    /**
     * Der Standort eines Orts (Gebäude oder Bereich) an einem Tag: die Kette seiner wirksamen Zuordnungen hinauf
     * bis zum Standort. Leer, wenn der Ort an dem Tag keinem Standort gehört.
     */
    public Optional<UUID> standortVonOrt(UUID ort, LocalDate tag) {
        return jdbc.queryForList("WITH RECURSIVE kette (eltern_standort_id, eltern_ort_id, tiefe) AS ("
                + " SELECT z.eltern_standort_id, z.eltern_ort_id, 0 FROM ort_zuordnung z"
                + "  WHERE z.ort_id = ? AND z.aufgehoben_am IS NULL AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> ?::date"
                + " UNION ALL"
                + " SELECT z.eltern_standort_id, z.eltern_ort_id, k.tiefe + 1 FROM ort_zuordnung z"
                + "  JOIN kette k ON z.ort_id = k.eltern_ort_id"
                + "  WHERE z.aufgehoben_am IS NULL AND daterange(z.gueltig_ab, z.gueltig_bis, '[]') @> ?::date AND k.tiefe < 8)"
                + " SELECT eltern_standort_id FROM kette WHERE eltern_standort_id IS NOT NULL LIMIT 1",
                UUID.class, ort, Date.valueOf(tag), Date.valueOf(tag)).stream().findFirst();
    }

    /** Der Standort einer Messstelle an einem Tag: ihr Ort (Standort direkt oder über Gebäude/Bereich). */
    public Optional<UUID> standortVonMessstelle(UUID messstelle, LocalDate tag) {
        List<UUID[]> orte = jdbc.query("SELECT standort_id, ort_id FROM messstelle_ort WHERE messstelle_id = ? "
                + "AND aufgehoben_am IS NULL AND daterange(gueltig_ab, gueltig_bis, '[]') @> ?::date",
                (rs, i) -> new UUID[] {rs.getObject("standort_id", UUID.class), rs.getObject("ort_id", UUID.class)},
                messstelle, Date.valueOf(tag));
        if (orte.isEmpty()) {
            return Optional.empty();
        }
        UUID[] o = orte.get(0);
        return o[0] != null ? Optional.of(o[0]) : o[1] != null ? standortVonOrt(o[1], tag) : Optional.empty();
    }

    /** G1: der Standort des Objekts eines Geltungsbereichs an einem Tag; leer für Unternehmen, Prozess, Kostenstelle. */
    public Optional<UUID> standortVonGeltung(String art, UUID id, LocalDate tag) {
        return switch (art) {
            case "standort" -> Optional.of(id);
            case "gebaeude", "bereich" -> standortVonOrt(id, tag);
            case "messstelle" -> standortVonMessstelle(id, tag);
            default -> Optional.empty();
        };
    }

    /** Jedes Kennzeichen, das je eine Kennzahl des Kundenbereichs trug — auch eine gelöschte (Grabstein). */
    public List<String> jeBelegt() {
        return jdbc.queryForList("SELECT kennzeichen FROM kennzahl_kennzeichen_verlauf", String.class);
    }

    /** Wie {@link #jeBelegt}, ohne die Kennzeichen der Kennzahl selbst (sie darf zu ihrem früheren zurück). */
    public List<String> belegtVonAnderen(UUID id) {
        return jdbc.queryForList("SELECT kennzeichen FROM kennzahl_kennzeichen_verlauf WHERE kennzahl_id IS DISTINCT FROM ?",
                String.class, id);
    }

    /** AP-17 IP-8 (B3): die laufende Bezugsbasis mit ihrer laufenden freigegebenen, sonst jüngsten Fassung. */
    public KennzahlDto.Bezugsbasis bezugsbasis(UUID kennzahl) {
        return jdbc.query("SELECT b.kennzeichen, f.fassung, f.freigabe_status, f.datenlage FROM bezugsbasis b "
                + "LEFT JOIN LATERAL (SELECT x.fassung, x.freigabe_status, x.datenlage FROM bezugsbasis_fassung x "
                + "WHERE x.bezugsbasis_id = b.id ORDER BY (x.freigabe_status = 'freigegeben' AND x.gilt_bis IS NULL) DESC, "
                + "x.fassung DESC LIMIT 1) f ON true WHERE b.kennzahl_id = ? AND b.beendet_am IS NULL",
                (rs, i) -> new KennzahlDto.Bezugsbasis(rs.getString("kennzeichen"), rs.getObject("fassung", Integer.class),
                        rs.getString("freigabe_status"), "vorlaeufig".equals(rs.getString("datenlage"))), kennzahl)
                .stream().findFirst().orElse(null);
    }

    public long werteZahl(UUID kennzahl) {
        Long n = jdbc.queryForObject("SELECT count(*) FROM kennzahl_wert WHERE kennzahl_id = ?", Long.class, kennzahl);
        return n == null ? 0 : n;
    }

    /** Die Kennzeichen der ANDEREN Kennzahlen, die diese in irgendeiner Fassung lesen. */
    public List<String> leser(UUID kennzahl) {
        return jdbc.queryForList("SELECT DISTINCT l.kennzeichen FROM kennzahl_eingang e JOIN kennzahl l ON l.id = e.kennzahl_id "
                + "WHERE e.eingang_kennzahl_id = ? AND e.kennzahl_id <> ? ORDER BY l.kennzeichen", String.class, kennzahl,
                kennzahl);
    }

    /** Der jüngste Wert einer Kennzahl in einer Periode — leer, wenn keiner gebildet ist (IP-6). */
    public Optional<WertZeile> juengsterWert(UUID kennzahl, String periodeArt, LocalDate periodeVon) {
        return jdbc.query("SELECT wert, zaehler, nenner, menge_zustand, richtung, abdeckung_prozent, zustand, "
                + "kennzeichen::text AS kennzeichen FROM kennzahl_wert WHERE kennzahl_id = ? AND periode_art = ? "
                + "AND periode_von = ? ORDER BY version DESC NULLS LAST, berechnet_am DESC LIMIT 1",
                (rs, i) -> new WertZeile(rs.getBigDecimal("wert"), rs.getBigDecimal("zaehler"), rs.getBigDecimal("nenner"),
                        rs.getString("menge_zustand"), rs.getString("richtung"), rs.getBigDecimal("abdeckung_prozent"),
                        rs.getString("zustand"), rs.getString("kennzeichen") == null ? List.of()
                                : List.of(rs.getString("kennzeichen"))),
                kennzahl, periodeArt, Date.valueOf(periodeVon)).stream().findFirst();
    }

    // ------------------------------------------------------------------------------ Werte (IP-6)

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Die jüngste Zeile eines Kennzahl-Werts in ihrer Periode (höchste Version, dann jüngstes {@code berechnet_am}).
     * {@code eingangZustand} ist der schlechteste Zustand ihrer Eingänge — eine Zeile ohne Zahl hat selbst keinen.
     */
    public record Gespeichert(UUID id, LocalDate periodeVon, Integer version, BigDecimal wert, BigDecimal zaehler,
            BigDecimal nenner, String mengeZustand, List<String> kennzeichen, BigDecimal abdeckungProzent,
            String richtung, String grund, String zustand, Instant endgueltigAb, UUID definitionFassungId,
            Instant berechnetAm, String eingangZustand) {

        public boolean endgueltig() {
            return "endgueltig".equals(zustand);
        }
    }

    /** Je Periode, deren erster Tag in {@code [von, bis]} liegt, die jüngste Zeile. */
    public Map<LocalDate, Gespeichert> werte(UUID kennzahl, String periodeArt, LocalDate von, LocalDate bis) {
        Map<LocalDate, Gespeichert> aus = new LinkedHashMap<>();
        jdbc.query("SELECT DISTINCT ON (w.periode_von) w.id, w.periode_von, w.version, w.wert, w.zaehler, w.nenner, "
                + "w.menge_zustand, w.kennzeichen::text AS kennzeichen, w.abdeckung_prozent, w.richtung, w.grund, "
                + "w.zustand, w.endgueltig_ab, w.definition_fassung_id, w.berechnet_am, "
                + "(SELECT e.menge_zustand FROM kennzahl_wert_eingang e WHERE e.tenant_id = w.tenant_id "
                + "AND e.wert_id = w.id ORDER BY array_position(ARRAY['vollständig', 'mit Ersatzwert', 'unvollständig', "
                + "'keine Werte']::text[], e.menge_zustand) DESC NULLS LAST LIMIT 1) AS eingang_zustand "
                + "FROM kennzahl_wert w WHERE w.kennzahl_id = ? AND w.periode_art = ? AND w.periode_von BETWEEN ? AND ? "
                + "ORDER BY w.periode_von, w.version DESC NULLS LAST, w.berechnet_am DESC",
                (rs, i) -> new Gespeichert(rs.getObject("id", UUID.class), rs.getDate("periode_von").toLocalDate(),
                        rs.getObject("version", Integer.class), rs.getBigDecimal("wert"), rs.getBigDecimal("zaehler"),
                        rs.getBigDecimal("nenner"), rs.getString("menge_zustand"), saetze(rs.getString("kennzeichen")),
                        rs.getBigDecimal("abdeckung_prozent"), rs.getString("richtung"), rs.getString("grund"),
                        rs.getString("zustand"), instant(rs.getTimestamp("endgueltig_ab")),
                        rs.getObject("definition_fassung_id", UUID.class), instant(rs.getTimestamp("berechnet_am")),
                        rs.getString("eingang_zustand")),
                kennzahl, periodeArt, Date.valueOf(von), Date.valueOf(bis)).forEach(g -> aus.put(g.periodeVon(), g));
        return aus;
    }

    /** Was eine gespeicherte Zeile von ihren Eingängen las — je Eingang eine Textzeile in Position (Vergleich V3). */
    public List<String> eingaengeText(UUID wert) {
        return jdbc.query("SELECT position, rolle, art, objekt, wert, zaehler, nenner, einheit, menge_zustand, "
                + "abdeckung_prozent, version, fassung, kennzeichen::text AS kennzeichen FROM kennzahl_wert_eingang "
                + "WHERE wert_id = ? ORDER BY position",
                (rs, i) -> KennzahlLauf.eingangText(rs.getInt("position"), rs.getString("rolle"), rs.getString("art"),
                        rs.getString("objekt"), rs.getBigDecimal("wert"), rs.getBigDecimal("zaehler"),
                        rs.getBigDecimal("nenner"), rs.getString("einheit"), rs.getString("menge_zustand"),
                        rs.getBigDecimal("abdeckung_prozent"), rs.getObject("version", Integer.class),
                        rs.getObject("fassung", Integer.class), saetze(rs.getString("kennzeichen"))),
                wert);
    }

    /** Das Kurzzeichen des Geltungsobjekts — der Präfix geerbter Kennzeichen („G-5 ab 15.10.2026“, Q8/K3). */
    public Optional<String> geltungKurzzeichen(String art, UUID id) {
        if ("unternehmen".equals(art)) {
            return Optional.of(KennzahlEingangLeser.UNTERNEHMEN_KURZ);
        }
        String sql = switch (art) {
            case "standort" -> "SELECT kurzzeichen FROM standort WHERE id = ?";
            case "gebaeude", "bereich" -> "SELECT kurzzeichen FROM ort WHERE id = ?";
            case "prozess" -> "SELECT kennzeichen FROM prozess WHERE id = ?";
            case "kostenstelle" -> "SELECT kennzeichen FROM kostenstelle WHERE id = ?";
            case "messstelle" -> "SELECT kennzeichen FROM messstelle WHERE id = ?";
            default -> null;
        };
        return sql == null ? Optional.empty() : jdbc.queryForList(sql, String.class, id).stream().findFirst();
    }

    static List<String> saetze(String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        try {
            return List.copyOf(JSON.readValue(text, new TypeReference<List<String>>() {}));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("kennzeichen ist kein Array von Sätzen: " + text, e);
        }
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    // ------------------------------------------------------------------------------ schreiben

    public void kundenbereichSperren(UUID tenant) {
        jdbc.queryForObject("SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(?, 0))) x", Integer.class,
                "uems_kennzahl:" + tenant);
    }

    /** Legt die Kennzahl an; die Verweis-Spalte folgt der Geltungsbereich-Art. Das Kennzeichen belegt der Trigger. */
    public UUID anlegen(UUID tenant, String kennzeichen, String name, String rechenform, String geltungArt, UUID geltungId,
            String verantwortlichSub, String verantwortlichName, String zweck) {
        UUID[] v = verweis(geltungArt, geltungId);
        return jdbc.queryForObject("INSERT INTO kennzahl (tenant_id, kennzeichen, name, rechenform, geltung_art, "
                + "unternehmen_id, standort_id, ort_id, prozess_id, kostenstelle_id, messstelle_id, verantwortlich_sub, "
                + "verantwortlich_name, zweck) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenant,
                kennzeichen, name, rechenform, geltungArt, v[0], v[1], v[2], v[3], v[4], v[5], verantwortlichSub,
                verantwortlichName, zweck);
    }

    public UUID fassungAnlegen(UUID tenant, UUID kennzahl, int nummer, String rechenform, LocalDate gueltigAb,
            String herkunft, boolean rueckwirkend, String begruendung, Instant eingetragenAm, ProtokollAkteur wer,
            boolean komplement, String einheit) {
        return jdbc.queryForObject("INSERT INTO kennzahl_fassung (tenant_id, kennzahl_id, nummer, rechenform, gueltig_ab, "
                + "herkunft, rueckwirkend, begruendung, actor_sub, actor_name, actor_rolle, actor_art, eingetragen_am, "
                + "komplement, einheit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenant, kennzahl,
                nummer, rechenform, gueltigAb == null ? null : Date.valueOf(gueltigAb), herkunft, rueckwirkend, begruendung,
                wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(eingetragenAm), komplement, einheit);
    }

    public void eingangAnlegen(UUID tenant, UUID kennzahl, UUID fassung, String rechenform, int position, String rolle,
            String art, UUID objekt) {
        jdbc.update("INSERT INTO kennzahl_eingang (tenant_id, kennzahl_id, fassung_id, rechenform, position, rolle, art, "
                + "messstelle_id, bezugsgroesse_id, eingang_kennzahl_id) VALUES (?,?,?,?,?,?,?,?,?,?)", tenant, kennzahl,
                fassung, rechenform, position, rolle, art, KennzahlRegeln.MESSSTELLE.equals(art) ? objekt : null,
                KennzahlRegeln.BEZUGSGROESSE.equals(art) ? objekt : null, KennzahlRegeln.KENNZAHL.equals(art) ? objekt : null);
    }

    /** V1: die laufende Fassung endet am Vortag der neuen (nur verkürzen, Trigger). */
    public void fassungBeenden(UUID fassung, LocalDate gueltigBis) {
        jdbc.update("UPDATE kennzahl_fassung SET gueltig_bis = ? WHERE id = ?", Date.valueOf(gueltigBis), fassung);
    }

    public void stammdatenAendern(UUID id, String kennzeichen, String name, String verantwortlichSub,
            String verantwortlichName, String zweck) {
        jdbc.update("UPDATE kennzahl SET kennzeichen = ?, name = ?, verantwortlich_sub = ?, verantwortlich_name = ?, "
                + "zweck = ?, updated_at = now() WHERE id = ?", kennzeichen, name, verantwortlichSub, verantwortlichName,
                zweck, id);
    }

    public void archivieren(UUID id) {
        jdbc.update("UPDATE kennzahl SET archiviert_am = now(), updated_at = now() WHERE id = ?", id);
    }

    /** V5 über {@code uems_kennzahl_loeschen} ({@code V20260915020000}): das Kennzeichen der gelöschten, sonst leer. */
    public Optional<String> loeschen(UUID id) {
        return Optional.ofNullable(jdbc.queryForObject("SELECT uems_kennzahl_loeschen(?)", String.class, id));
    }

    /** Ein Protokolleintrag; die Eintragszeit setzt die Datenbank. */
    public void protokoll(UUID tenant, UUID kennzahl, String art, String altJson, String neuJson, Instant giltAb,
            boolean rueckwirkend, String grund, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO kennzahl_aenderung (tenant_id, kennzahl_id, art, alt, neu, gilt_ab, rueckwirkend, grund, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?)", tenant,
                kennzahl, art, altJson, neuJson, Timestamp.from(giltAb), rueckwirkend, grund, wer.sub(), wer.name(),
                wer.rolle(), wer.art());
    }

    // ------------------------------------------------------------------------------ Gerüst

    private static UUID[] verweis(String art, UUID id) {
        return new UUID[] {
            "unternehmen".equals(art) ? id : null,
            "standort".equals(art) ? id : null,
            "gebaeude".equals(art) || "bereich".equals(art) ? id : null,
            "prozess".equals(art) ? id : null,
            "kostenstelle".equals(art) ? id : null,
            "messstelle".equals(art) ? id : null
        };
    }

    private static Zeile zeile(ResultSet rs, int i) throws SQLException {
        return new Zeile(rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getString("name"),
                rs.getString("rechenform"), rs.getString("geltung_art"), rs.getObject("geltung_id", UUID.class),
                rs.getString("verantwortlich_sub"), rs.getString("verantwortlich_name"), rs.getString("zweck"),
                instant(rs, "archiviert_am"), instant(rs, "angelegt_am"));
    }

    private static FassungZeile fassung(ResultSet rs, int i) throws SQLException {
        return new FassungZeile(rs.getObject("id", UUID.class), rs.getObject("kennzahl_id", UUID.class), rs.getInt("nummer"),
                rs.getString("rechenform"), tag(rs, "gueltig_ab"), tag(rs, "gueltig_bis"), instant(rs, "aufgehoben_am"),
                rs.getString("herkunft"), rs.getBoolean("rueckwirkend"), rs.getString("begruendung"),
                rs.getString("actor_name"), rs.getString("actor_rolle"), rs.getString("actor_art"),
                instant(rs, "eingetragen_am"), rs.getBoolean("komplement"), rs.getString("einheit"));
    }

    private static EingangZeile eingang(ResultSet rs, int i) throws SQLException {
        return new EingangZeile(rs.getObject("fassung_id", UUID.class), rs.getObject("kennzahl_id", UUID.class),
                rs.getInt("position"), rs.getString("rolle"), rs.getString("art"), rs.getObject("objekt_id", UUID.class),
                rs.getString("kennzeichen"), rs.getString("name"));
    }

    private static BezugsgroesseZeile bezugsgroesse(ResultSet rs, int i) throws SQLException {
        return new BezugsgroesseZeile(rs.getObject("id", UUID.class), rs.getString("kennzeichen"), rs.getString("name"),
                rs.getString("wertart"), rs.getString("einheit"), rs.getString("periode_art"), rs.getString("geltung_art"),
                rs.getObject("geltung_id", UUID.class), instant(rs, "archiviert_am"));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    private static LocalDate tag(ResultSet rs, String spalte) throws SQLException {
        Date d = rs.getDate(spalte);
        return d == null ? null : d.toLocalDate();
    }
}
