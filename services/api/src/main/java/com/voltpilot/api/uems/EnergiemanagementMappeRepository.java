package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Konzept Nachweisen n1, Entscheid 7: die Mappen „Unterlagen zusammenstellen“ und ihr Abruf-Protokoll unter
 * Mandanten-RLS und dem Zaun „nur unternehmensweit“ ({@code site_scope}, V20261007150000). Die App-Rolle legt an,
 * protokolliert jeden Abruf und leert nach der Frist nur die beiden Datei-Spalten; den Rest hält der Trigger
 * {@code energiemanagement_mappe_eingefroren}. Die Frist zählt die Datenbank ({@code now()}, echte Zeit).
 */
@Repository
public class EnergiemanagementMappeRepository {

    /** Eine Mappe ohne ihre Dateien; {@code abrufbar} sagt die Datenbank zur Zeit der Abfrage. */
    public record Mappe(UUID id, String anlass, LocalDate von, LocalDate bis, List<String> gruppen, List<String> offen,
            Instant stichtag, int eintraege, int gilt, String pdfSha256, String csvSha256, Instant abrufbarBis,
            boolean abrufbar, int abrufbarTage, ProtokollAkteur akteur, Instant angelegtAm) {}

    public record Dateien(byte[] pdf, byte[] csv) {}

    private static final String SPALTEN = "id, anlass, von, bis, gruppen, offen, stichtag, eintraege, gilt, pdf_sha256, "
            + "csv_sha256, abrufbar_bis, (pdf IS NOT NULL AND abrufbar_bis > now()) AS abrufbar, "
            // Die Tage bis zum Ende der Frist, angebrochene als ganze - gezählt mit der Uhr der Datenbank.
            + "CASE WHEN pdf IS NULL THEN 0 ELSE GREATEST(0, ceil(extract(epoch FROM abrufbar_bis - now()) / 86400))::int "
            + "END AS abrufbar_tage, actor_sub, actor_name, actor_rolle, actor_art, created_at";

    private static final RowMapper<Mappe> MAPPE = (rs, n) -> new Mappe(rs.getObject("id", UUID.class),
            rs.getString("anlass"), rs.getObject("von", LocalDate.class), rs.getObject("bis", LocalDate.class),
            texte(rs, "gruppen"), texte(rs, "offen"), instant(rs, "stichtag"), rs.getInt("eintraege"), rs.getInt("gilt"),
            rs.getString("pdf_sha256"), rs.getString("csv_sha256"), instant(rs, "abrufbar_bis"),
            rs.getBoolean("abrufbar"), rs.getInt("abrufbar_tage"), new ProtokollAkteur(rs.getString("actor_sub"),
                    rs.getString("actor_name"), rs.getString("actor_rolle"), rs.getString("actor_art")),
            instant(rs, "created_at"));

    private final JdbcTemplate jdbc;

    public EnergiemanagementMappeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Alle Mappen im Zaun, die jüngste zuerst. */
    public List<Mappe> mappen() {
        return jdbc.query("SELECT " + SPALTEN + " FROM energiemanagement_mappe ORDER BY created_at DESC, id", MAPPE);
    }

    public Optional<Mappe> mappe(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM energiemanagement_mappe WHERE id = ?", MAPPE, id).stream()
                .findFirst();
    }

    /** Die Dateien, solange die Mappe abrufbar ist; danach leer. */
    public Optional<Dateien> dateien(UUID id) {
        return jdbc.query("SELECT pdf, csv FROM energiemanagement_mappe WHERE id = ? AND pdf IS NOT NULL "
                + "AND abrufbar_bis > now()", (rs, n) -> new Dateien(rs.getBytes("pdf"), rs.getBytes("csv")), id)
                .stream().findFirst();
    }

    /** Die Frist in Stunden: 30 Tage sind 720 Stunden, auch über eine Zeitumstellung hinweg. */
    public UUID anlegen(String anlass, LocalDate von, LocalDate bis, List<String> gruppen, List<String> offen,
            Instant stichtag, int eintraege, int gilt, byte[] pdf, String pdfSha256, byte[] csv, String csvSha256,
            int tage, ProtokollAkteur wer) {
        return jdbc.queryForObject("""
                INSERT INTO energiemanagement_mappe (tenant_id, anlass, von, bis, gruppen, offen, stichtag, eintraege,
                    gilt, pdf, pdf_sha256, csv, csv_sha256, abrufbar_bis, actor_sub, actor_name, actor_rolle, actor_art)
                VALUES (?,?,?,?,?::text[],?::text[],?,?,?,?,?,?,?, now() + ? * interval '24 hours',?,?,?,?) RETURNING id
                """, UUID.class, tenant(), anlass, von, bis, feld(gruppen), feld(offen), Timestamp.from(stichtag),
                eintraege, gilt, pdf, pdfSha256, csv, csvSha256, tage, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    /** Jeder Abruf einer Datei (PDF oder CSV) - wer, wann, welche. */
    public void abruf(UUID mappe, String format, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO energiemanagement_mappe_abruf (tenant_id, mappe_id, format, actor_sub, actor_name, "
                + "actor_rolle, actor_art) VALUES (?,?,?,?,?,?,?)", tenant(), mappe, format, wer.sub(), wer.name(),
                wer.rolle(), wer.art());
    }

    /** Wie oft eine Mappe abgerufen wurde. */
    public int abrufe(UUID mappe) {
        Integer n = jdbc.queryForObject("SELECT count(*)::int FROM energiemanagement_mappe_abruf WHERE mappe_id = ?",
                Integer.class, mappe);
        return n == null ? 0 : n;
    }

    /**
     * Nach der Frist: die Dateien abgelaufener Mappen leeren (Aufbewahrung 30 Tage, Entscheid 7). Läuft bei jedem
     * Anlegen und Lesen der Liste; ohne Abruf ist eine abgelaufene Mappe ohnehin nicht mehr zu haben.
     */
    public int abgelaufeneLeeren() {
        return jdbc.update("UPDATE energiemanagement_mappe SET pdf = NULL, csv = NULL "
                + "WHERE pdf IS NOT NULL AND abrufbar_bis <= now()");
    }

    private static String feld(List<String> werte) {
        return "{" + String.join(",", werte) + "}";
    }

    private static List<String> texte(ResultSet rs, String spalte) throws SQLException {
        Array a = rs.getArray(spalte);
        return a == null ? List.of() : Arrays.stream((Object[]) a.getArray()).map(Object::toString).toList();
    }

    private static UUID tenant() {
        return Objects.requireNonNull(TenantContext.get(), "Mandant aus TenantContext erforderlich");
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
