package com.voltpilot.api.uems;

import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegeln.Vergeben;
import com.voltpilot.api.uems.MessstelleRegeln.Vorschlag;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.support.DataAccessUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Die Messstellen des Kundenbereichs ({@code messstelle}, {@code messstelle_groesse},
 * {@code messstelle_kennzeichen}, {@code messstelle_kennzeichen_seq}; Migration
 * V20260911140000) — unter RLS: eine fremde Messstelle ist hier schlicht nicht da,
 * die Route macht daraus 404, nie 403.
 *
 * <p>Nur der Unterbau (AP-04 IP-2). Die Regeln prüft {@link MessstelleRegeln}: die
 * Schreibrouten ({@link MessstelleService}, IP-3) fragen {@code kennzeichenPruefen} mit
 * {@link #vergeben()} VOR dem Schreiben, damit das Urteil den Träger nennt. Die Datenbank
 * hält die Invarianten trotzdem selbst — ein Kennzeichen außerhalb der Form scheitert mit 23514 an
 * {@code messstelle_kennzeichen_format}, eines, das eine ANDERE Messstelle trägt oder
 * trug, mit 23505 an {@code messstelle_kennzeichen_eindeutig} (heute getragen) oder
 * {@code messstelle_kennzeichen_belegt} (archiviert oder früher getragen).
 *
 * <p>Eine Messstelle wird archiviert, nie gelöscht: deshalb gibt es hier kein DELETE,
 * und die App-Rolle hat keines.
 */
@Repository
public class MessstelleRepository {

    private static final String SPALTEN = "id, kennzeichen, name, art, medium, groesse, richtung, "
            + "einheit, wertart, notiz, angehalten_ab, archiviert_am, " + anschlussleistung("messstelle");

    /**
     * Die Anschlussleistung (AP-08 IP-7, V20260913180000) über die ZEILE gelesen, nicht über die Spalte:
     * Migrationstests legen Messstellen mit diesem Repository auf einer Fassung VOR der Spalte an —
     * eine Spalten-Referenz bräche dort mit „column does not exist“, der Schlüssel der Zeile fehlt nur
     * ({@code NULL}). Geschrieben wird sie darum auch nicht im INSERT, sondern mit
     * {@link #anschlussleistungSetzen}.
     */
    static String anschlussleistung(String zeile) {
        return "(to_jsonb(" + zeile + ") ->> 'anschlussleistung_kw')::numeric AS anschlussleistung_kw";
    }

    private final JdbcTemplate jdbc;

    public MessstelleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Eine neue Messstelle, so wie sie gespeichert wird. {@code kennzeichen} {@code null}
     * heißt: das nächste automatische (E7); {@code name} {@code null} heißt: fehlt noch
     * (ein Entwurf). Art, Medium und Hauptgröße sind danach nie mehr änderbar.
     */
    public record NeueMessstelle(UUID tenantId, String kennzeichen, String name, String art,
            String medium, Groesse hauptgroesse, String notiz) {}

    /** {@code anschlussleistungKw}: optional (AP-08 IP-7), {@code null} = nicht deklariert. */
    public record Messstelle(UUID id, String kennzeichen, String name, String art, String medium,
            Groesse hauptgroesse, String notiz, Instant angehaltenAb, Instant archiviertAm,
            BigDecimal anschlussleistungKw) {}

    /** {@code archiviertAm} {@code null} = aktiv. */
    public record Nebengroesse(UUID id, UUID messstelleId, Groesse groesse, Instant archiviertAm) {}

    /**
     * Legt eine Messstelle an. Mit eigenem Kennzeichen bleibt der Zähler, wo er ist. Ohne
     * vergibt diese Methode unter der Zeilensperre des Zählers den Vorschlag von
     * {@link MessstelleRegeln#kennzeichenVorschlag} und rückt den Zähler auf ihn vor —
     * zwei gleichzeitige Vergaben bekommen zwei verschiedene Nummern. Die Sperre hält nur
     * bis zum Ende der Transaktion; ohne Transaktion wäre sie nach dem SELECT schon weg,
     * deshalb verweigert die automatische Vergabe dann.
     */
    @Transactional
    public Messstelle anlegen(NeueMessstelle m) {
        String kennzeichen = m.kennzeichen();
        Vorschlag vergabe = null;
        if (kennzeichen == null) {
            if (!TransactionSynchronizationManager.isActualTransactionActive()) {
                throw new IllegalStateException("Die automatische Kennzeichen-Vergabe braucht eine "
                        + "Transaktion - sonst hielte die Sperre des Zählers nicht bis zum Speichern.");
            }
            vergabe = MessstelleRegeln.kennzeichenVorschlag(zaehlerSperren(m.tenantId()),
                    belegteKennzeichen());
            kennzeichen = vergabe.kennzeichen();
        }
        Groesse g = m.hauptgroesse();
        Messstelle neu = jdbc.queryForObject("INSERT INTO messstelle (tenant_id, kennzeichen, name, "
                + "art, medium, groesse, richtung, einheit, wertart, notiz) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING " + SPALTEN,
                MessstelleRepository::map, m.tenantId(), kennzeichen, m.name(), m.art(), m.medium(),
                g.groesse(), g.richtung(), g.einheit(), g.wertart(), m.notiz());
        if (vergabe != null) {
            jdbc.update("INSERT INTO messstelle_kennzeichen_seq (tenant_id, zaehler) VALUES (?, ?) "
                    + "ON CONFLICT (tenant_id) DO UPDATE SET zaehler = EXCLUDED.zaehler, "
                    + "updated_at = now()", m.tenantId(), vergabe.zaehler());
        }
        return neu;
    }

    /**
     * Der Stand des Kennzeichen-Zählers und die belegten Kennzeichen — die Eingänge von
     * {@link MessstelleRegeln#kennzeichenVorschlag} für eine LISTE von Vorschlägen (IP-16).
     * Bewegt den Zähler nicht.
     */
    public Kennzeichenstand kennzeichenstand() {
        Integer zaehler = DataAccessUtils.singleResult(
                jdbc.queryForList("SELECT zaehler FROM messstelle_kennzeichen_seq", Integer.class));
        return new Kennzeichenstand(zaehler == null ? 0 : zaehler, belegteKennzeichen());
    }

    public record Kennzeichenstand(int zaehler, List<String> belegt) {}

    /** Der nächste automatische Vorschlag für den Dialog — ohne den Zähler zu bewegen. */
    public Vorschlag vorschlag() {
        Integer zaehler = DataAccessUtils.singleResult(
                jdbc.queryForList("SELECT zaehler FROM messstelle_kennzeichen_seq", Integer.class));
        return MessstelleRegeln.kennzeichenVorschlag(zaehler == null ? 0 : zaehler,
                belegteKennzeichen());
    }

    /**
     * Jedes belegte Kennzeichen des Kundenbereichs mit seinem Träger — genau die Eingabe
     * {@code vergeben} von {@link MessstelleRegeln#kennzeichenPruefen}: was eine Messstelle
     * trägt, ein archiviertes UND das frühere einer umbenannten.
     */
    public List<Vergeben> vergeben() {
        return List.copyOf(jdbc.query("SELECT k.kennzeichen, m.kennzeichen AS traeger, m.name, "
                + "m.archiviert_am IS NOT NULL AS archiviert, k.kennzeichen <> m.kennzeichen AS frueher "
                + "FROM messstelle_kennzeichen k JOIN messstelle m ON m.id = k.messstelle_id "
                + "ORDER BY k.belegt_am, k.kennzeichen",
                (rs, n) -> new Vergeben(rs.getString("kennzeichen"), rs.getString("traeger"),
                        rs.getString("name"), rs.getBoolean("archiviert"), rs.getBoolean("frueher"))));
    }

    /** Die Messstelle im Zaun — leer, wenn es sie nicht gibt ODER sie einem anderen Mandanten gehört. */
    public Optional<Messstelle> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM messstelle WHERE id = ?",
                MessstelleRepository::map, id).stream().findFirst();
    }

    /**
     * Die Messstelle, die HEUTE dieses Kennzeichen trägt, im Zaun (AP-08 IP-9) — leer, wenn es sie
     * nicht gibt ODER sie einem anderen Mandanten gehört. Ein früher getragenes Kennzeichen findet
     * nichts: es ist belegt, aber es benennt keine Messstelle mehr.
     */
    public Optional<Messstelle> findeNachKennzeichen(String kennzeichen) {
        return jdbc.query("SELECT " + SPALTEN + " FROM messstelle WHERE kennzeichen = ?",
                MessstelleRepository::map, kennzeichen).stream().findFirst();
    }

    /** Alle Messstellen des Mandanten, archivierte eingeschlossen, nach Kennzeichen. */
    public List<Messstelle> alle() {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM messstelle ORDER BY kennzeichen",
                MessstelleRepository::map));
    }

    /**
     * Gibt der Messstelle ein anderes Kennzeichen; das bisherige bleibt ihr belegt.
     * {@code false}, wenn es sie im Zaun nicht gibt.
     */
    public boolean kennzeichenAendern(UUID id, String kennzeichen) {
        return jdbc.update("UPDATE messstelle SET kennzeichen = ?, updated_at = now() WHERE id = ?",
                kennzeichen, id) == 1;
    }

    /**
     * Schreibt die drei änderbaren Felder (Vertrag §1: Art, Medium und Hauptgröße nie). Ein
     * neues Kennzeichen belegt der Trigger wie bei {@link #kennzeichenAendern}; das bisherige
     * bleibt der Messstelle belegt. {@code false}: nicht da oder archiviert.
     */
    public boolean bearbeiten(UUID id, String kennzeichen, String name, String notiz) {
        return jdbc.update("UPDATE messstelle SET kennzeichen = ?, name = ?, notiz = ?, "
                + "updated_at = now() WHERE id = ? AND archiviert_am IS NULL",
                kennzeichen, name, notiz, id) == 1;
    }

    /**
     * Setzt die Anschlussleistung (AP-08 IP-7); {@code null} nimmt sie zurück. {@code false}: nicht da
     * oder archiviert.
     */
    public boolean anschlussleistungSetzen(UUID id, BigDecimal kw) {
        return jdbc.update("UPDATE messstelle SET anschlussleistung_kw = ?, updated_at = now() "
                + "WHERE id = ? AND archiviert_am IS NULL", kw, id) == 1;
    }

    /** Archiviert die Messstelle; ihr Kennzeichen bleibt belegt. {@code false}: nicht da oder schon archiviert. */
    public boolean archivieren(UUID id, Instant am) {
        return jdbc.update("UPDATE messstelle SET archiviert_am = ?, updated_at = now() "
                + "WHERE id = ? AND archiviert_am IS NULL", Timestamp.from(am), id) == 1;
    }

    /** Hält die Messstelle ab {@code ab} an. {@code false}: nicht da, archiviert oder schon angehalten. */
    public boolean anhalten(UUID id, Instant ab) {
        return jdbc.update("UPDATE messstelle SET angehalten_ab = ?, updated_at = now() "
                + "WHERE id = ? AND archiviert_am IS NULL AND angehalten_ab IS NULL",
                Timestamp.from(ab), id) == 1;
    }

    /**
     * Setzt die angehaltene Messstelle fort. Gespeichert bleibt nur der Zustands-Eingang; wann
     * sie angehalten war, erzählt das Änderungsprotokoll. {@code false}: nicht da, archiviert
     * oder nicht angehalten.
     */
    public boolean fortsetzen(UUID id) {
        return jdbc.update("UPDATE messstelle SET angehalten_ab = NULL, updated_at = now() "
                + "WHERE id = ? AND archiviert_am IS NULL AND angehalten_ab IS NOT NULL", id) == 1;
    }

    /**
     * Fügt der Messstelle eine Nebengröße hinzu (E1); das Medium kommt von der Messstelle.
     * Leer, wenn es die Messstelle im Zaun nicht gibt.
     */
    public Optional<UUID> nebengroesseHinzufuegen(UUID messstelleId, Groesse g) {
        return jdbc.queryForList("INSERT INTO messstelle_groesse (tenant_id, messstelle_id, medium, "
                + "groesse, richtung, einheit, wertart) "
                + "SELECT m.tenant_id, m.id, m.medium, ?, ?, ?, ? FROM messstelle m WHERE m.id = ? "
                + "RETURNING id", UUID.class, g.groesse(), g.richtung(), g.einheit(), g.wertart(),
                messstelleId).stream().findFirst();
    }

    /** Archiviert eine Nebengröße. {@code false}: nicht da oder schon archiviert. */
    public boolean nebengroesseArchivieren(UUID id, Instant am) {
        return jdbc.update("UPDATE messstelle_groesse SET archiviert_am = ? "
                + "WHERE id = ? AND archiviert_am IS NULL", Timestamp.from(am), id) == 1;
    }

    /** Die Nebengrößen der Messstelle, archivierte eingeschlossen, in der Reihenfolge des Hinzufügens. */
    public List<Nebengroesse> nebengroessen(UUID messstelleId) {
        return List.copyOf(jdbc.query("SELECT id, messstelle_id, groesse, richtung, einheit, wertart, "
                + "archiviert_am FROM messstelle_groesse WHERE messstelle_id = ? "
                + "ORDER BY created_at, id",
                (rs, n) -> new Nebengroesse(
                        rs.getObject("id", UUID.class),
                        rs.getObject("messstelle_id", UUID.class),
                        groesse(rs),
                        instant(rs.getTimestamp("archiviert_am"))),
                messstelleId));
    }

    /** Legt die Zählerzeile des Mandanten an, falls sie fehlt, und sperrt sie bis zum Transaktionsende. */
    private int zaehlerSperren(UUID tenantId) {
        jdbc.update("INSERT INTO messstelle_kennzeichen_seq (tenant_id) VALUES (?) "
                + "ON CONFLICT (tenant_id) DO NOTHING", tenantId);
        return jdbc.queryForObject("SELECT zaehler FROM messstelle_kennzeichen_seq FOR UPDATE",
                Integer.class);
    }

    private List<String> belegteKennzeichen() {
        return jdbc.queryForList("SELECT kennzeichen FROM messstelle_kennzeichen", String.class);
    }

    /** Eine Zeile mit den Spalten von {@code SPALTEN} — auch die des Registers ({@link MessstelleRegisterRepository}). */
    static Messstelle map(ResultSet rs, int n) throws SQLException {
        return new Messstelle(
                rs.getObject("id", UUID.class),
                rs.getString("kennzeichen"),
                rs.getString("name"),
                rs.getString("art"),
                rs.getString("medium"),
                groesse(rs),
                rs.getString("notiz"),
                instant(rs.getTimestamp("angehalten_ab")),
                instant(rs.getTimestamp("archiviert_am")),
                rs.getBigDecimal("anschlussleistung_kw"));
    }

    private static Groesse groesse(ResultSet rs) throws SQLException {
        return new Groesse(rs.getString("groesse"), rs.getString("richtung"),
                rs.getString("einheit"), rs.getString("wertart"));
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
