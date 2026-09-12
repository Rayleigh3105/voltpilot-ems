package com.voltpilot.api.uems;

import com.voltpilot.api.tenant.TenantContext;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Formel-Fassungen einer berechneten Messstelle ({@code messstelle_formel_fassung},
 * V20260912210000, UEMS AP-10 IP-3): tagesgenau gültig, Fassung n + 1 beendet n am Vortag. Die
 * REGELN stehen in {@link MessstelleFormelRegeln#fassungEintrag}; hier nur Lesen und Schreiben.
 * Der Mandant ist die RLS; {@code tenant_id} beim Schreiben kommt aus dem {@link TenantContext}.
 */
@Repository
public class MessstelleFormelFassungRepository {

    private final JdbcTemplate jdbc;

    public MessstelleFormelFassungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Eine gespeicherte Fassung. {@code gueltigAb == null} = gilt seit Beginn (nur Fassung 1),
     * {@code gueltigBis} ist der LETZTE Tag einschließlich ({@code null} = offen).
     */
    public record FassungZeile(UUID id, int nummer, String formelTyp, LocalDate gueltigAb, LocalDate gueltigBis,
            String herkunft, boolean rueckwirkend, String begruendung, Instant eingetragenAm) {

        /** Die Sicht der Regel-Klasse. */
        public MessstelleFormelRegeln.Fassung alsRegel() {
            return new MessstelleFormelRegeln.Fassung(nummer, gueltigAb, gueltigBis);
        }
    }

    /** Die wirksamen (nicht aufgehobenen) Fassungen der Messstelle, nach Nummer. */
    public List<FassungZeile> wirksame(UUID messstelleId) {
        return jdbc.query("SELECT id, nummer, formel_typ, gueltig_ab, gueltig_bis, herkunft, rueckwirkend, "
                + "begruendung, eingetragen_am FROM messstelle_formel_fassung "
                + "WHERE messstelle_id = ? AND aufgehoben_am IS NULL ORDER BY nummer",
                (rs, n) -> new FassungZeile(rs.getObject("id", UUID.class), rs.getInt("nummer"),
                        rs.getString("formel_typ"), rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class), rs.getString("herkunft"),
                        rs.getBoolean("rueckwirkend"), rs.getString("begruendung"),
                        rs.getTimestamp("eingetragen_am").toInstant()),
                messstelleId);
    }

    /** Legt eine Fassung an und gibt ihre ID zurück; {@code tenant_id} aus dem {@link TenantContext}. */
    public UUID anlegen(UUID messstelleId, int nummer, String formelTyp, LocalDate gueltigAb, String herkunft,
            boolean rueckwirkend, String begruendung, Instant eingetragenAm, ProtokollAkteur wer) {
        return jdbc.queryForObject("INSERT INTO messstelle_formel_fassung (tenant_id, messstelle_id, nummer, "
                + "formel_typ, gueltig_ab, herkunft, rueckwirkend, begruendung, actor_sub, actor_name, "
                + "actor_rolle, actor_art, eingetragen_am) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class, TenantContext.get(), messstelleId, nummer, formelTyp,
                gueltigAb == null ? null : Date.valueOf(gueltigAb), herkunft, rueckwirkend, begruendung,
                wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(eingetragenAm));
    }

    /** Beendet eine Fassung am Tag {@code bis} (einschließlich) — nur verkürzt, nie verlängert (Trigger). */
    public void beenden(UUID fassungId, LocalDate bis) {
        jdbc.update("UPDATE messstelle_formel_fassung SET gueltig_bis = ? WHERE id = ?",
                Date.valueOf(bis), fassungId);
    }

    /**
     * Die Sperre bis zum Ende der Transaktion: alle Formel-Fassungen EINES Kundenbereichs entstehen
     * nacheinander (Transaktions-Advisory-Lock auf den Mandanten) — sonst läsen zwei Fassungen
     * derselben Messstelle dieselbe jüngste Fassung, und zwei Fassungen A→B und B→A bestünden
     * beide die Kreis-Prüfung. Dazu die Zeilensperre der Messstelle.
     */
    public void sperre(UUID messstelleId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended('uems_formel_fassung:' || ?::text, 0))",
                rs -> null, TenantContext.get());
        jdbc.query("SELECT id FROM messstelle WHERE id = ? FOR UPDATE", rs -> null, messstelleId);
    }

    /**
     * Die höchste je vergebene Nummer der Messstelle — AUCH aufgehobener Fassungen (die Nummer ist je
     * Messstelle eindeutig und wird nie wiederverwendet); 0 ohne Fassung.
     */
    public int hoechsteNummer(UUID messstelleId) {
        Integer n = jdbc.queryForObject("SELECT coalesce(max(nummer), 0) FROM messstelle_formel_fassung "
                + "WHERE messstelle_id = ?", Integer.class, messstelleId);
        return n == null ? 0 : n;
    }

    /**
     * Welche Messstellen die berechneten Messstellen des Kundenbereichs verketten — über die
     * wirksamen Fassungen, die am Tag {@code ab} oder danach gelten (eine neue Fassung ab
     * {@code ab} kann nur mit ihnen einen Kreis bilden; eine vorher beendete verkettet nichts
     * mehr), in Kennzeichen. Die Eingabe von {@link MessstelleFormelRegeln#zyklus} — bewusst
     * vorsichtig: zwei Kanten, die an verschiedenen Tagen ab {@code ab} gelten, zählen zusammen.
     */
    public Map<String, List<String>> verkettungen(LocalDate ab) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        jdbc.query("""
                SELECT DISTINCT m.kennzeichen AS von, q.kennzeichen AS nach
                  FROM messstelle_formel_term t
                  JOIN messstelle_formel_fassung f ON f.id = t.fassung_id AND f.aufgehoben_am IS NULL
                   AND (f.gueltig_bis IS NULL OR f.gueltig_bis >= ?)
                  JOIN messstelle m ON m.id = t.messstelle_id
                  JOIN messstelle q ON q.id = t.quell_messstelle_id
                 WHERE t.eingang_art = 'messstelle'
                 ORDER BY 1, 2
                """, rs -> {
                    out.computeIfAbsent(rs.getString("von"), k -> new ArrayList<>()).add(rs.getString("nach"));
                }, Date.valueOf(ab));
        return out;
    }
}
