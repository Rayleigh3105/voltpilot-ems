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
 * Die FUNKTION je Standort ({@code funktion}, Migration V20260914190000, UEMS AP-01 IP-2), unter
 * RLS: „Messen &amp; Auswerten“ bzw. „Steuern &amp; Optimieren“ an einem Standort mit dem
 * gespeicherten Zustand (Codes aus {@link FunktionZustandAbleitung.Zustand}, nie
 * {@code kein_objekt} — kein Objekt ist keine Zeile).
 *
 * <p>Die App-Rolle liest, legt an und ändert nur Zustand und Zeitpunkte; gelöscht wird nie
 * (nur das Offboarding räumt ab). Je Standort und Funktion gibt es höchstens EINE nicht
 * archivierte Zeile ({@code uq_funktion_je_standort}, E6 = C).
 */
@Repository
public class FunktionRepository {

    private static final String SPALTEN = "id, standort_id, funktion, zustand, eingerichtet_am, aktiv_seit, "
            + "angehalten_seit, archiviert_am, geaendert_von, created_at, updated_at";

    private final JdbcTemplate jdbc;

    public FunktionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Funktion mit ihrem Zustand; {@code null} an einem Zeitpunkt = nicht (oder nicht bekannt). */
    public record Funktion(UUID id, UUID standortId, FunktionZustandAbleitung.Funktion funktion,
            FunktionZustandAbleitung.Zustand zustand, Instant eingerichtetAm, Instant aktivSeit,
            Instant angehaltenSeit, Instant archiviertAm, String geaendertVon, Instant createdAt,
            Instant updatedAt) {}

    /** Die Zeitpunkte, die ein Übergang schreibt — die ganze Menge. */
    public record Stand(FunktionZustandAbleitung.Zustand zustand, Instant eingerichtetAm, Instant aktivSeit,
            Instant angehaltenSeit, Instant archiviertAm) {}

    /** Legt die Funktion eines Standorts an und liefert ihre Kennung. */
    public UUID anlegen(UUID tenantId, UUID standortId, FunktionZustandAbleitung.Funktion funktion, Stand stand,
            String geaendertVon, Instant jetzt) {
        pruefen(stand.zustand());
        return jdbc.queryForObject("INSERT INTO funktion (tenant_id, standort_id, funktion, zustand, "
                + "eingerichtet_am, aktiv_seit, angehalten_seit, archiviert_am, geaendert_von, created_at, "
                + "updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class,
                tenantId, standortId, funktion.code(), stand.zustand().code(), ts(stand.eingerichtetAm()),
                ts(stand.aktivSeit()), ts(stand.angehaltenSeit()), ts(stand.archiviertAm()), geaendertVon,
                ts(jetzt), ts(jetzt));
    }

    /** Schreibt Zustand und Zeitpunkte — {@code false}, wenn es die Funktion (im Zaun) nicht gibt. */
    public boolean zustandSetzen(UUID id, Stand stand, String geaendertVon, Instant jetzt) {
        pruefen(stand.zustand());
        return jdbc.update("UPDATE funktion SET zustand = ?, eingerichtet_am = ?, aktiv_seit = ?, "
                + "angehalten_seit = ?, archiviert_am = ?, geaendert_von = ?, updated_at = ? WHERE id = ?",
                stand.zustand().code(), ts(stand.eingerichtetAm()), ts(stand.aktivSeit()),
                ts(stand.angehaltenSeit()), ts(stand.archiviertAm()), geaendertVon, ts(jetzt), id) == 1;
    }

    /** Die Funktion im Zaun — leer, wenn es sie nicht gibt ODER sie einem anderen Mandanten gehört. */
    public Optional<Funktion> finde(UUID id) {
        return jdbc.query("SELECT " + SPALTEN + " FROM funktion WHERE id = ?", FunktionRepository::map, id)
                .stream().findFirst();
    }

    /** Die nicht archivierte Funktion dieser Art am Standort — höchstens eine (E6 = C). */
    public Optional<Funktion> laufende(UUID standortId, FunktionZustandAbleitung.Funktion funktion) {
        return jdbc.query("SELECT " + SPALTEN + " FROM funktion WHERE standort_id = ? AND funktion = ? "
                + "AND zustand <> 'archiviert'", FunktionRepository::map, standortId, funktion.code())
                .stream().findFirst();
    }

    /** Alle Funktionen des Mandanten, archivierte eingeschlossen, in der Reihenfolge des Anlegens. */
    public List<Funktion> alle() {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM funktion ORDER BY created_at, id",
                FunktionRepository::map));
    }

    private static void pruefen(FunktionZustandAbleitung.Zustand zustand) {
        if (zustand == FunktionZustandAbleitung.Zustand.KEIN_OBJEKT) {
            throw new IllegalArgumentException("kein_objekt ist keine Zeile");
        }
    }

    private static Funktion map(ResultSet rs, int n) throws SQLException {
        return new Funktion(
                rs.getObject("id", UUID.class),
                rs.getObject("standort_id", UUID.class),
                FunktionZustandAbleitung.Funktion.vonCode(rs.getString("funktion")),
                FunktionZustandAbleitung.Zustand.vonCode(rs.getString("zustand")),
                instant(rs, "eingerichtet_am"),
                instant(rs, "aktiv_seit"),
                instant(rs, "angehalten_seit"),
                instant(rs, "archiviert_am"),
                rs.getString("geaendert_von"),
                instant(rs, "created_at"),
                instant(rs, "updated_at"));
    }

    static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
