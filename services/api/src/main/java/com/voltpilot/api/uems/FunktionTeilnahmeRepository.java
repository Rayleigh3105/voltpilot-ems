package com.voltpilot.api.uems;

import static com.voltpilot.api.uems.FunktionRepository.instant;
import static com.voltpilot.api.uems.FunktionRepository.ts;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die TEILNAHME einer Anlage an „Steuern &amp; Optimieren“ ihres Standorts
 * ({@code funktion_teilnahme}, Migration V20260914190000, UEMS AP-01 IP-2, W7), unter RLS.
 *
 * <p>Je Anlage höchstens EINE nicht archivierte Teilnahme ({@code uq_funktion_teilnahme_je_anlage});
 * „Steuerung beenden“ archiviert sie, eine neue Aufnahme ist eine neue Zeile. Die App-Rolle liest,
 * legt an und ändert nur Zustand und Zeitpunkte — nie Anlage, Funktion oder die Herkunft
 * {@code uebernommen}. Es gibt keinen Fremdschlüssel auf {@code site} (W5): die Teilnahme
 * überlebt die gelöschte Anlage, das Einfügen prüft ein Trigger.
 */
@Repository
public class FunktionTeilnahmeRepository {

    private static final String SPALTEN = "id, funktion_id, site_id, zustand, uebernommen, eingerichtet_am, "
            + "gestartet_am, angehalten_seit, beendet_am, created_at, updated_at";

    private final JdbcTemplate jdbc;

    public FunktionTeilnahmeRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Eine Teilnahme; {@code null} an einem Zeitpunkt = nicht (oder nicht bekannt). */
    public record Teilnahme(UUID id, UUID funktionId, UUID siteId, FunktionZustandAbleitung.Zustand zustand,
            boolean uebernommen, Instant eingerichtetAm, Instant gestartetAm, Instant angehaltenSeit,
            Instant beendetAm, Instant createdAt, Instant updatedAt) {

        /**
         * Seit wann sie in ihrem Zustand ist — das {@code seit} der Standort-Ableitung
         * ({@link FunktionZustandAbleitung#standort}); {@code null} im Entwurf oder wenn unbekannt.
         */
        public Instant seit() {
            return switch (zustand) {
                case AKTIV -> gestartetAm;
                case EINGERICHTET -> eingerichtetAm;
                case ANGEHALTEN -> angehaltenSeit;
                case ARCHIVIERT -> beendetAm;
                case ENTWURF, KEIN_OBJEKT -> null;
            };
        }
    }

    /** Die Zeitpunkte, die ein Übergang schreibt — die ganze Menge. */
    public record Stand(FunktionZustandAbleitung.Zustand zustand, Instant eingerichtetAm, Instant gestartetAm,
            Instant angehaltenSeit, Instant beendetAm) {}

    /**
     * Nimmt die Anlage auf — leer, wenn sie schon eine laufende Teilnahme hat (ein erneuter Lauf
     * schreibt keine doppelt und überschreibt keine).
     */
    public Optional<UUID> anlegen(UUID tenantId, UUID funktionId, UUID siteId, Stand stand, boolean uebernommen,
            Instant jetzt) {
        if (stand.zustand() == FunktionZustandAbleitung.Zustand.KEIN_OBJEKT) {
            throw new IllegalArgumentException("kein_objekt ist keine Zeile");
        }
        return jdbc.query("INSERT INTO funktion_teilnahme (tenant_id, funktion_id, site_id, zustand, uebernommen, "
                + "eingerichtet_am, gestartet_am, angehalten_seit, beendet_am, created_at, updated_at) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                + "ON CONFLICT (tenant_id, site_id) WHERE zustand <> 'archiviert' DO NOTHING RETURNING id",
                (rs, n) -> rs.getObject("id", UUID.class),
                tenantId, funktionId, siteId, stand.zustand().code(), uebernommen, ts(stand.eingerichtetAm()),
                ts(stand.gestartetAm()), ts(stand.angehaltenSeit()), ts(stand.beendetAm()), ts(jetzt), ts(jetzt))
                .stream().findFirst();
    }

    /** Schreibt Zustand und Zeitpunkte — {@code false}, wenn es die Teilnahme (im Zaun) nicht gibt. */
    public boolean zustandSetzen(UUID id, Stand stand, Instant jetzt) {
        if (stand.zustand() == FunktionZustandAbleitung.Zustand.KEIN_OBJEKT) {
            throw new IllegalArgumentException("kein_objekt ist keine Zeile");
        }
        return jdbc.update("UPDATE funktion_teilnahme SET zustand = ?, eingerichtet_am = ?, gestartet_am = ?, "
                + "angehalten_seit = ?, beendet_am = ?, updated_at = ? WHERE id = ?",
                stand.zustand().code(), ts(stand.eingerichtetAm()), ts(stand.gestartetAm()),
                ts(stand.angehaltenSeit()), ts(stand.beendetAm()), ts(jetzt), id) == 1;
    }

    /** Die laufende (nicht archivierte) Teilnahme der Anlage — höchstens eine. */
    public Optional<Teilnahme> laufendeDerAnlage(UUID siteId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM funktion_teilnahme WHERE site_id = ? "
                + "AND zustand <> 'archiviert'", FunktionTeilnahmeRepository::map, siteId).stream().findFirst();
    }

    /** Alle Teilnahmen einer Funktion, beendete eingeschlossen, in der Reihenfolge der Aufnahme. */
    public List<Teilnahme> derFunktion(UUID funktionId) {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM funktion_teilnahme WHERE funktion_id = ? "
                + "ORDER BY created_at, id", FunktionTeilnahmeRepository::map, funktionId));
    }

    /** Alle Teilnahmen des Mandanten, beendete eingeschlossen — EIN Lesezug statt einer Abfrage je Anlage. */
    public List<Teilnahme> alle() {
        return List.copyOf(jdbc.query("SELECT " + SPALTEN + " FROM funktion_teilnahme ORDER BY created_at, id",
                FunktionTeilnahmeRepository::map));
    }

    private static Teilnahme map(ResultSet rs, int n) throws SQLException {
        return new Teilnahme(
                rs.getObject("id", UUID.class),
                rs.getObject("funktion_id", UUID.class),
                rs.getObject("site_id", UUID.class),
                FunktionZustandAbleitung.Zustand.vonCode(rs.getString("zustand")),
                rs.getBoolean("uebernommen"),
                instant(rs, "eingerichtet_am"),
                instant(rs, "gestartet_am"),
                instant(rs, "angehalten_seit"),
                instant(rs, "beendet_am"),
                instant(rs, "created_at"),
                instant(rs, "updated_at"));
    }
}
