package com.voltpilot.api.uems;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Geräte des Kundenbereichs ({@code geraet}, {@code geraet_teil},
 * {@code geraet_komponente}, Migration V20260911200000) — unter RLS: ein fremdes Gerät ist
 * hier schlicht nicht da, die Route macht daraus 404, nie 403.
 *
 * <p>Eine Zeile ist EIN Einbau: Z-5a und Z-5b sind zwei Zeilen desselben Geräts GR-4. Geschrieben
 * wird nur, was der Zählerwechsel (AP-04 IP-17, {@link ZaehlerwechselService}) braucht — der Ausbau
 * des alten Einbaus, der neue Einbau und das Wandern der Speisung; die App-Rolle hat auf keiner der
 * Tabellen DELETE, und ob gewechselt werden darf, urteilt {@link MessstelleRegeln}, nie diese Klasse.
 */
@Repository
public class GeraetRepository {

    private static final String SPALTEN = "g.id, g.site_id, g.kennzeichen, g.einbau_kennzeichen, "
            + "g.geraeteart, g.hersteller, g.typ, g.seriennummer, g.bezeichnung, g.data_source_id, "
            + "g.geraete_id, g.eingebaut_am, g.ausgebaut_am, g.aus_bestand";

    /** GR-2 vor GR-10: gleiche Vorsilbe, also zuerst die kürzere Nummer. */
    private static final String REIHENFOLGE =
            " ORDER BY length(g.kennzeichen), g.kennzeichen, g.eingebaut_am, g.id";

    private final JdbcTemplate jdbc;

    public GeraetRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Ein Einbau. {@code ausgebautAm == null} heißt eingebaut. */
    public record Einbau(UUID id, UUID siteId, String kennzeichen, String einbauKennzeichen,
            String geraeteart, String hersteller, String typ, String seriennummer,
            String bezeichnung, UUID dataSourceId, Integer geraeteId, Instant eingebautAm,
            Instant ausgebautAm, boolean ausBestand) {}

    /** Ein Zeitraum, in dem der Einbau die Komponente speist — über eine Karte oder direkt. */
    public record Speisung(UUID geraetId, UUID entityId, UUID teilId, Integer steckplatz,
            Instant gueltigAb, Instant gueltigBis) {}

    /** Eine Energiekarte im Steckplatz eines Controllers. */
    public record Teil(UUID id, UUID geraetId, String teilart, Integer steckplatz,
            String bezeichnung, String typ, String seriennummer, Instant eingebautAm,
            Instant ausgebautAm) {}

    public Optional<Einbau> eines(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet g WHERE g.id = ?", GeraetRepository::einbau,
                id).stream().findFirst();
    }

    /**
     * Der Einbau, der die Komponente JETZT speist: die Speisung, deren halboffener Zeitraum
     * {@code now()} enthält (je Komponente und Zeitpunkt höchstens eine, die
     * Ausschluss-Bedingung der Tabelle). Leer ohne laufende Speisung — nie geraten.
     */
    public Optional<Einbau> laufenderDerKomponente(UUID entityId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet_komponente v JOIN geraet g ON g.id = v.geraet_id "
                + "WHERE v.entity_id = ? AND v.gueltig_ab <= now() "
                + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now())",
                GeraetRepository::einbau, entityId).stream().findFirst();
    }

    /** Alle Einbauten der Anlage, ausgebaute eingeschlossen. */
    public List<Einbau> derAnlage(UUID siteId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet g WHERE g.site_id = ?" + REIHENFOLGE,
                GeraetRepository::einbau, siteId);
    }

    /** Alle Einbauten derselben Geräte wie der Einbau — die Quelle seiner Vorgänger. */
    public List<Einbau> desselbenGeraets(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet g WHERE g.kennzeichen = "
                + "(SELECT e.kennzeichen FROM geraet e WHERE e.id = ?)" + REIHENFOLGE,
                GeraetRepository::einbau, id);
    }

    /** Alle Einbauten der Geräte, die in der Anlage stecken oder steckten. */
    public List<Einbau> derGeraeteDerAnlage(UUID siteId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraet g WHERE g.kennzeichen IN "
                + "(SELECT e.kennzeichen FROM geraet e WHERE e.site_id = ?)" + REIHENFOLGE,
                GeraetRepository::einbau, siteId);
    }

    public List<Speisung> speisungenDes(UUID geraetId) {
        return speisungen("v.geraet_id = ?", geraetId);
    }

    public List<Speisung> speisungenDerAnlage(UUID siteId) {
        return speisungen("g.site_id = ?", siteId);
    }

    /** Der Einbau, der die Komponente zu einem Zeitpunkt speist, mit dem Zeitraum dieser Speisung. */
    public record SpeisungAm(Einbau einbau, Instant gueltigAb, Instant gueltigBis) {}

    /**
     * Welcher Einbau speist die Komponente zum Zeitpunkt? Die Speisung, deren halboffener
     * Zeitraum ihn enthält (je Komponente und Zeitpunkt höchstens eine). Leer ohne Speisung —
     * vor dem Einbau oder nach einem Ausbau ohne Nachfolger; nie geraten. Die Quellenbindung
     * (IP-13) speichert genau diesen Einbau als Gerät ihres Messkanals.
     */
    public Optional<SpeisungAm> speisungAm(UUID entityId, Instant zeitpunkt) {
        Timestamp t = Timestamp.from(zeitpunkt);
        return jdbc.query("SELECT " + SPALTEN + ", v.gueltig_ab AS speisung_ab, v.gueltig_bis AS speisung_bis "
                + "FROM geraet_komponente v JOIN geraet g ON g.id = v.geraet_id "
                + "WHERE v.entity_id = ? AND v.gueltig_ab <= ? AND (v.gueltig_bis IS NULL OR v.gueltig_bis > ?)",
                (rs, n) -> new SpeisungAm(einbau(rs, n), zeit(rs, "speisung_ab"), zeit(rs, "speisung_bis")),
                entityId, t, t).stream().findFirst();
    }

    /** Die Karten, die zum Zeitpunkt in diesem Einbau stecken — über sie entscheidet erst IP-19. */
    public List<Teil> teileAm(UUID geraetId, Instant zeitpunkt) {
        Timestamp t = Timestamp.from(zeitpunkt);
        return jdbc.query("SELECT t.id, t.geraet_id, t.teilart, t.steckplatz, t.bezeichnung, t.typ, "
                + "t.seriennummer, t.eingebaut_am, t.ausgebaut_am FROM geraet_teil t "
                + "WHERE t.geraet_id = ? AND t.eingebaut_am <= ? AND (t.ausgebaut_am IS NULL OR t.ausgebaut_am > ?) "
                + "ORDER BY t.steckplatz NULLS LAST, t.eingebaut_am, t.id",
                GeraetRepository::teil, geraetId, t, t);
    }

    /** Die Speisungen dieses Einbaus, die zum Zeitpunkt laufen — die Komponenten, die mitwandern. */
    public List<Speisung> laufendeSpeisungenAm(UUID geraetId, Instant zeitpunkt) {
        Timestamp t = Timestamp.from(zeitpunkt);
        return jdbc.query("SELECT v.geraet_id, v.entity_id, v.teil_id, t.steckplatz, v.gueltig_ab, "
                + "v.gueltig_bis FROM geraet_komponente v LEFT JOIN geraet_teil t ON t.id = v.teil_id "
                + "WHERE v.geraet_id = ? AND v.gueltig_ab <= ? AND (v.gueltig_bis IS NULL OR v.gueltig_bis > ?) "
                + "ORDER BY v.gueltig_ab, v.entity_id", GeraetRepository::speisung, geraetId, t, t);
    }

    // ------------------------------------------------------------------ schreiben (IP-17)

    /**
     * Sperrt den Einbau bis zum Ende der Transaktion: zwei Wechsel an demselben Gerät warten
     * aufeinander, statt beide den Ausbau zu schreiben. {@code false}, wenn es ihn (für den
     * Aufrufer) nicht gibt — eine fremde Zeile ist unter RLS schlicht nicht da.
     */
    public boolean sperre(UUID geraetId) {
        return !jdbc.queryForList("SELECT id FROM geraet WHERE id = ? FOR UPDATE", UUID.class, geraetId)
                .isEmpty();
    }

    /**
     * Baut den Einbau zum Zeitpunkt aus. {@code false}, wenn er inzwischen schon ausgebaut ist —
     * ein abgeschlossener Zeitraum wird nie überschrieben.
     */
    public boolean ausbauen(UUID geraetId, Instant am) {
        return jdbc.update("UPDATE geraet SET ausgebaut_am = ? WHERE id = ? AND ausgebaut_am IS NULL",
                Timestamp.from(am), geraetId) == 1;
    }

    /** Der Nachfolger eines Wechsels: dasselbe {@code kennzeichen} (GR-4), ein neues {@code einbau_kennzeichen}. */
    public record NeuerEinbau(UUID tenantId, UUID siteId, String kennzeichen, String einbauKennzeichen,
            String geraeteart, String hersteller, String typ, String seriennummer, String bezeichnung,
            UUID dataSourceId, Integer geraeteId, Instant eingebautAm, String createdBy) {}

    public UUID einbauen(NeuerEinbau e) {
        return jdbc.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, hersteller, typ, seriennummer, bezeichnung, data_source_id, geraete_id, "
                + "eingebaut_am, aus_bestand, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,false,?) RETURNING id",
                UUID.class, e.tenantId(), e.siteId(), e.kennzeichen(), e.einbauKennzeichen(), e.geraeteart(),
                e.hersteller(), e.typ(), e.seriennummer(), e.bezeichnung(), e.dataSourceId(), e.geraeteId(),
                Timestamp.from(e.eingebautAm()), e.createdBy());
    }

    /** Beendet die laufende Speisung der Komponente durch DIESEN Einbau zum Zeitpunkt. */
    public boolean speisungBeenden(UUID geraetId, UUID entityId, Instant bis) {
        return jdbc.update("UPDATE geraet_komponente SET gueltig_bis = ? WHERE geraet_id = ? AND entity_id = ? "
                + "AND gueltig_bis IS NULL", Timestamp.from(bis), geraetId, entityId) == 1;
    }

    /** Ab dem Zeitpunkt speist der neue Einbau die Komponente — über dieselbe Karte, wenn es eine gab. */
    public void speisungAnlegen(UUID tenantId, UUID geraetId, UUID entityId, UUID teilId, Instant ab) {
        jdbc.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, gueltig_ab) "
                + "VALUES (?,?,?,?,?)", tenantId, geraetId, entityId, teilId, Timestamp.from(ab));
    }

    /** Eine Karten-Zeile ist ihr Einbau im Controller. Der alte Einbau bleibt samt Seriennummer erhalten. */
    public UUID karteWechseln(UUID tenant, Teil alt, UUID neu, Instant am, boolean uebernommen) {
        if (jdbc.update("UPDATE geraet_teil SET ausgebaut_am = ? WHERE id = ? AND ausgebaut_am IS NULL",
                Timestamp.from(am), alt.id()) != 1) {
            throw new IllegalStateException("Karten-Einbau wurde inzwischen verändert");
        }
        return jdbc.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, teilart, steckplatz, "
                + "bezeichnung, typ, seriennummer, eingebaut_am) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class, tenant, neu, alt.teilart(), alt.steckplatz(), alt.bezeichnung(), alt.typ(),
                uebernommen ? alt.seriennummer() : null, Timestamp.from(am));
    }

    /** Jedes Einbau-Kennzeichen des Kundenbereichs — Vorlage für ein freies (IP-17). */
    public List<String> einbauKennzeichen() {
        return jdbc.queryForList("SELECT einbau_kennzeichen FROM geraet", String.class);
    }

    // ------------------------------------------------------------------ lesen

    public List<Teil> teileDes(UUID geraetId) {
        return teile("t.geraet_id = ?", geraetId);
    }

    public List<Teil> teileDerAnlage(UUID siteId) {
        return teile("g.site_id = ?", siteId);
    }

    private List<Speisung> speisungen(String bedingung, UUID wert) {
        return jdbc.query("SELECT v.geraet_id, v.entity_id, v.teil_id, t.steckplatz, v.gueltig_ab, "
                + "v.gueltig_bis FROM geraet_komponente v JOIN geraet g ON g.id = v.geraet_id "
                + "LEFT JOIN geraet_teil t ON t.id = v.teil_id WHERE " + bedingung
                + " ORDER BY v.gueltig_ab, v.entity_id",
                GeraetRepository::speisung, wert);
    }

    private List<Teil> teile(String bedingung, UUID wert) {
        return jdbc.query("SELECT t.id, t.geraet_id, t.teilart, t.steckplatz, t.bezeichnung, t.typ, "
                + "t.seriennummer, t.eingebaut_am, t.ausgebaut_am FROM geraet_teil t "
                + "JOIN geraet g ON g.id = t.geraet_id WHERE " + bedingung
                + " ORDER BY t.steckplatz NULLS LAST, t.eingebaut_am, t.id",
                GeraetRepository::teil, wert);
    }

    private static Speisung speisung(ResultSet rs, int n) throws SQLException {
        return new Speisung(rs.getObject("geraet_id", UUID.class), rs.getObject("entity_id", UUID.class),
                rs.getObject("teil_id", UUID.class), (Integer) rs.getObject("steckplatz"),
                zeit(rs, "gueltig_ab"), zeit(rs, "gueltig_bis"));
    }

    private static Teil teil(ResultSet rs, int n) throws SQLException {
        return new Teil(rs.getObject("id", UUID.class), rs.getObject("geraet_id", UUID.class),
                rs.getString("teilart"), (Integer) rs.getObject("steckplatz"), rs.getString("bezeichnung"),
                rs.getString("typ"), rs.getString("seriennummer"), zeit(rs, "eingebaut_am"),
                zeit(rs, "ausgebaut_am"));
    }

    private static Einbau einbau(ResultSet rs, int n) throws SQLException {
        return new Einbau(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getString("kennzeichen"), rs.getString("einbau_kennzeichen"),
                rs.getString("geraeteart"), rs.getString("hersteller"), rs.getString("typ"),
                rs.getString("seriennummer"), rs.getString("bezeichnung"),
                rs.getObject("data_source_id", UUID.class), (Integer) rs.getObject("geraete_id"),
                zeit(rs, "eingebaut_am"), zeit(rs, "ausgebaut_am"), rs.getBoolean("aus_bestand"));
    }

    private static Instant zeit(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
