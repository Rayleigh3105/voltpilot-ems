package com.voltpilot.api.optimizer;

import com.voltpilot.api.repo.SteuerungVorsprung;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Tabelle {@code steuerung_vorsprung} (NS-2 A, Vertrag
 * {@code docs/contracts/steuerung-vorsprung-v1.md}): je Anlage EINE Zeile, die
 * {@link SteuerungVorsprungLaeufer} bei jedem Takt überschreibt und der
 * Optimierer beim Einlesen liest. Läuft unter {@code TenantContext} mit der
 * Laufzeitrolle - RLS zäunt den Kundenbereich, auch beim Aufräumen.
 */
@Repository
public class SteuerungVorsprungRepository {

    private final JdbcTemplate jdbc;

    public SteuerungVorsprungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Schreibt die Stände des Kundenbereichs und löscht die Zeilen jeder
     * anderen seiner Anlagen - eine Anlage ohne Stand hat für den Optimierer
     * kein Budget, nie ein altes.
     *
     * @return die Zahl der geschriebenen Zeilen
     */
    public int schreibe(UUID tenant, Map<UUID, SteuerungVorsprung.Stand> staende, Instant jetzt) {
        int geschrieben = 0;
        for (Map.Entry<UUID, SteuerungVorsprung.Stand> e : staende.entrySet()) {
            geschrieben += upsert(tenant, e.getKey(), e.getValue(), jetzt);
        }
        UUID[] behalten = staende.keySet().toArray(UUID[]::new);
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                    "DELETE FROM steuerung_vorsprung WHERE NOT (site_id = ANY (?))");
            ps.setArray(1, con.createArrayOf("uuid", behalten));
            return ps;
        });
        return geschrieben;
    }

    private int upsert(UUID tenant, UUID site, SteuerungVorsprung.Stand s, Instant jetzt) {
        return jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement("""
                    INSERT INTO steuerung_vorsprung (site_id, tenant_id, tag, messung_bis,
                        bewertung_ct_kwh, vorsprung_kwh, kapazitaet_kwh, monat_mit_bestand_eur,
                        sieben_tage_mit_bestand_eur, tage_mit_bestand_eur, berechnet_am)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (site_id) DO UPDATE SET
                        tag = EXCLUDED.tag,
                        messung_bis = EXCLUDED.messung_bis,
                        bewertung_ct_kwh = EXCLUDED.bewertung_ct_kwh,
                        vorsprung_kwh = EXCLUDED.vorsprung_kwh,
                        kapazitaet_kwh = EXCLUDED.kapazitaet_kwh,
                        monat_mit_bestand_eur = EXCLUDED.monat_mit_bestand_eur,
                        sieben_tage_mit_bestand_eur = EXCLUDED.sieben_tage_mit_bestand_eur,
                        tage_mit_bestand_eur = EXCLUDED.tage_mit_bestand_eur,
                        berechnet_am = EXCLUDED.berechnet_am
                    """);
            ps.setObject(1, site);
            ps.setObject(2, tenant);
            ps.setDate(3, Date.valueOf(s.tag()));
            ps.setTimestamp(4, Timestamp.from(s.messungBis()));
            ps.setBigDecimal(5, s.bewertungCtKwh());
            ps.setBigDecimal(6, s.vorsprungKwh());
            ps.setBigDecimal(7, s.kapazitaetKwh());
            setzeBetrag(ps, 8, s.monatMitBestandEur());
            setzeBetrag(ps, 9, s.siebenTageMitBestandEur());
            Array tage = con.createArrayOf("numeric", s.tageMitBestandEur().toArray());
            ps.setArray(10, tage);
            ps.setTimestamp(11, Timestamp.from(jetzt));
            return ps;
        });
    }

    private static void setzeBetrag(PreparedStatement ps, int index, BigDecimal betrag)
            throws java.sql.SQLException {
        if (betrag == null) {
            ps.setNull(index, Types.NUMERIC);
        } else {
            ps.setBigDecimal(index, betrag);
        }
    }
}
