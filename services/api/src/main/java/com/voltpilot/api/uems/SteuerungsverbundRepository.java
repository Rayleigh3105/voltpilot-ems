package com.voltpilot.api.uems;

import com.voltpilot.api.uems.SteuerungsverbundVokabular.Rolle;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Stufe;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Lese- und Schreibwege des Verbund-Objekts einer Gemeinsamen Steuerung (UEMS AP-15 IP-4; Tabellen
 * {@code steuerungsverbund}, {@code …_mitglied}, {@code …_aenderung}, Migration V20260921140000). Alles unter RLS des
 * aktuellen Mandanten; der Mandant eines Schreibwegs kommt vom Aufrufer (TenantContext), nie aus einem Request.
 *
 * <p>Keine Route und keine Regel hier: die Routen, Rechte und Stufenwechsel als Ablauf baut IP-5, die Urteile rechnet
 * {@link SteuerungsverbundRegeln} über {@link #regelStand}. Jeder Schreibweg, der den Verbund ändert, gehört mit
 * GENAU EINEM Eintrag in {@link #protokoll} in dieselbe Transaktion — das hält der Aufrufer.
 */
@Repository
public class SteuerungsverbundRepository {

    /** Der Verbund einer Anlage. */
    public record VerbundZeile(UUID id, UUID siteId, Stufe stufe, long epoche, Instant createdAt, Instant updatedAt) {}

    /**
     * Ein Mitglied in einem Zeitraum [gueltigAb, gueltigBis). Gesendet/quittiert: das zuletzt gesendete und das zuletzt
     * quittierte Anteils-Dokument (Epoche, Revision) — null = noch nie.
     */
    public record MitgliedZeile(UUID id, UUID verbundId, UUID deviceId, Rolle rolle, UUID dataSourceId,
            Instant gueltigAb, Instant gueltigBis, Instant aufgehobenAm, Long gesendetEpoche, Long gesendetRevision,
            Instant gesendetAm, Long quittiertEpoche, Long quittiertRevision, Instant quittiertAm) {}

    /** Ein Protokolleintrag. */
    public record Aenderung(long id, UUID verbundId, UUID siteId, String art, String alt, String neu, Instant giltAb,
            boolean rueckwirkend, String grund, String actorName, String actorRolle, String actorArt, Instant createdAt) {}

    /** Was {@link SteuerungsverbundRegeln#pruefen} braucht — Kennungen sind die UUIDs als Text. */
    public record RegelStand(SteuerungsverbundRegeln.Verbund verbund, List<SteuerungsverbundRegeln.Datenquelle> quellen) {}

    private static final String VERBUND_SPALTEN = "id, site_id, stufe, epoche, created_at, updated_at";
    private static final String MITGLIED_SPALTEN = "id, steuerungsverbund_id, device_id, rolle, data_source_id, "
            + "gueltig_ab, gueltig_bis, aufgehoben_am, gesendet_epoche, gesendet_revision, gesendet_am, "
            + "quittiert_epoche, quittiert_revision, quittiert_am";

    private final JdbcTemplate jdbc;

    public SteuerungsverbundRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------ Verbund

    /** Der Verbund der Anlage — leer, wenn sie keine Gemeinsame Steuerung hat (Bestand, I6) oder RLS sie verbirgt. */
    public Optional<VerbundZeile> derAnlage(UUID siteId) {
        return jdbc.query("SELECT " + VERBUND_SPALTEN + " FROM steuerungsverbund WHERE site_id = ?", VERBUND, siteId)
                .stream().findFirst();
    }

    public Optional<VerbundZeile> finden(UUID verbundId) {
        return jdbc.query("SELECT " + VERBUND_SPALTEN + " FROM steuerungsverbund WHERE id = ?", VERBUND, verbundId)
                .stream().findFirst();
    }

    /** Richtet ein (S0 erklärt, Epoche 0). Eine zweite je Anlage scheitert an steuerungsverbund_je_anlage_einer (23505). */
    public UUID einrichten(UUID tenant, UUID siteId, String wer) {
        return jdbc.queryForObject("INSERT INTO steuerungsverbund (tenant_id, site_id, created_by) VALUES (?,?,?) "
                + "RETURNING id", UUID.class, tenant, siteId, wer);
    }

    /** Setzt die Stufe; false, wenn es den Verbund nicht gibt. Welcher Wechsel erlaubt ist, entscheidet IP-5. */
    public boolean stufeSetzen(UUID verbundId, Stufe stufe) {
        return jdbc.update("UPDATE steuerungsverbund SET stufe = ?, updated_at = now() WHERE id = ?",
                stufe.code(), verbundId) > 0;
    }

    /** Eine neue Epoche (nur beim Scharfschalten, G5); liefert sie — leer, wenn es den Verbund nicht gibt. */
    public Optional<Long> epocheErhoehen(UUID verbundId) {
        return jdbc.queryForList("UPDATE steuerungsverbund SET epoche = epoche + 1, updated_at = now() WHERE id = ? "
                + "RETURNING epoche", Long.class, verbundId).stream().findFirst();
    }

    // ------------------------------------------------------------------ Mitglieder

    /** Die Mitglieder zu einem Zeitpunkt (halboffen, ohne aufgehobene), die führende zuerst. */
    public List<MitgliedZeile> mitglieder(UUID verbundId, Instant zeitpunkt) {
        return jdbc.query("SELECT " + MITGLIED_SPALTEN + " FROM steuerungsverbund_mitglied "
                + "WHERE steuerungsverbund_id = ? AND aufgehoben_am IS NULL AND gueltig_ab <= ? "
                + "AND (gueltig_bis IS NULL OR gueltig_bis > ?) ORDER BY (rolle = 'fuehrt') DESC, gueltig_ab, id",
                MITGLIED, verbundId, Timestamp.from(zeitpunkt), Timestamp.from(zeitpunkt));
    }

    /** Die ganze Geschichte der Mitglieder, auch beendete und aufgehobene. */
    public List<MitgliedZeile> mitgliederGeschichte(UUID verbundId) {
        return jdbc.query("SELECT " + MITGLIED_SPALTEN + " FROM steuerungsverbund_mitglied "
                + "WHERE steuerungsverbund_id = ? ORDER BY gueltig_ab, id", MITGLIED, verbundId);
    }

    /**
     * Nimmt eine Box auf. Die Datenbank lehnt ab: eine Box einer anderen Anlage und einen Messpunkt einer anderen Anlage
     * (23503), `liest` und eine führende ohne Messpunkt (23514), eine zweite führende, dieselbe Box oder denselben
     * Messpunkt im selben Zeitraum (23P01). Die Anlage ist die des Verbunds — der Aufrufer nennt sie nie getrennt.
     */
    public UUID mitgliedAufnehmen(UUID tenant, UUID verbundId, UUID deviceId, Rolle rolle, UUID dataSourceId,
            Instant gueltigAb, Instant gueltigBis, String wer) {
        return jdbc.queryForObject("INSERT INTO steuerungsverbund_mitglied (tenant_id, steuerungsverbund_id, site_id, "
                + "device_id, rolle, data_source_id, gueltig_ab, gueltig_bis, created_by) "
                + "SELECT ?::uuid, v.id, v.site_id, ?::uuid, ?, ?::uuid, ?::timestamptz, ?::timestamptz, ? "
                + "FROM steuerungsverbund v WHERE v.id = ? RETURNING id",
                UUID.class, tenant, deviceId, rolle.code(), dataSourceId, Timestamp.from(gueltigAb),
                gueltigBis == null ? null : Timestamp.from(gueltigBis), wer, verbundId);
    }

    /** Beendet ein offenes Mitglied zum Zeitpunkt {@code bis}; false, wenn es schon endet oder nicht (mehr) sichtbar ist. */
    public boolean mitgliedBeenden(UUID mitgliedId, Instant bis) {
        return jdbc.update("UPDATE steuerungsverbund_mitglied SET gueltig_bis = ? "
                + "WHERE id = ? AND gueltig_bis IS NULL AND aufgehoben_am IS NULL", Timestamp.from(bis), mitgliedId) > 0;
    }

    /** Hebt einen falschen Eintrag auf — er bleibt stehen, zählt aber nicht mehr (nie gelöscht, nie umgeschrieben). */
    public boolean mitgliedAufheben(UUID mitgliedId) {
        return jdbc.update("UPDATE steuerungsverbund_mitglied SET aufgehoben_am = now() "
                + "WHERE id = ? AND aufgehoben_am IS NULL", mitgliedId) > 0;
    }

    /**
     * Ein Anteils-Dokument (Epoche, Revision) ging an das Mitglied. Steigt nur: ein älterer oder gleicher Stand ändert
     * nichts (false).
     */
    public boolean gesendet(UUID mitgliedId, long epoche, long revision, Instant am) {
        return jdbc.update("UPDATE steuerungsverbund_mitglied SET gesendet_epoche = ?, gesendet_revision = ?, "
                + "gesendet_am = ? WHERE id = ? AND (gesendet_epoche IS NULL "
                + "OR (gesendet_epoche, gesendet_revision) < (?::bigint, ?::bigint))",
                epoche, revision, Timestamp.from(am), mitgliedId, epoche, revision) > 0;
    }

    /**
     * Das Mitglied quittiert (Epoche, Revision). Steigt nur, und nie über das Gesendete hinaus — eine Quittung für einen
     * nie gesendeten Stand ändert nichts (false; der CHECK hielte sie ohnehin).
     */
    public boolean quittiert(UUID mitgliedId, long epoche, long revision, Instant am) {
        return jdbc.update("UPDATE steuerungsverbund_mitglied SET quittiert_epoche = ?, quittiert_revision = ?, "
                + "quittiert_am = ? WHERE id = ? AND gesendet_epoche IS NOT NULL "
                + "AND (?::bigint, ?::bigint) <= (gesendet_epoche, gesendet_revision) "
                + "AND (quittiert_epoche IS NULL OR (quittiert_epoche, quittiert_revision) < (?::bigint, ?::bigint))",
                epoche, revision, Timestamp.from(am), mitgliedId, epoche, revision, epoche, revision) > 0;
    }

    // ------------------------------------------------------------------ Stand für die Regel

    /** Die Heimat einer Box (ihre Anlage) — leer, wenn es sie im Kundenbereich nicht gibt. */
    public Optional<UUID> heimatDerBox(UUID deviceId) {
        return jdbc.queryForList("SELECT site_id FROM device WHERE id = ?", UUID.class, deviceId).stream().findFirst();
    }

    /** Die an diesem Tag gebundenen Netzanschlüsse der Anlage (T2; die Datenbank lässt höchstens einen zu). */
    public List<UUID> netzanschluesse(UUID siteId, LocalDate tag) {
        return jdbc.queryForList("SELECT netzanschluss_id FROM anlage_netzanschluss WHERE site_id = ? "
                + "AND aufgehoben_am IS NULL AND gueltig_ab <= ? AND (gueltig_bis IS NULL OR gueltig_bis >= ?)",
                UUID.class, siteId, tag, tag);
    }

    /** Anlage und lesende Box je Datenquelle zu einem Zeitpunkt; unbekannte Quellen fehlen in der Liste. */
    public List<SteuerungsverbundRegeln.Datenquelle> quellen(Collection<UUID> dataSourceIds, Instant zeitpunkt) {
        if (dataSourceIds.isEmpty()) {
            return List.of();
        }
        Timestamp t = Timestamp.from(zeitpunkt);
        return jdbc.query("SELECT ds.id, ds.site_id, (SELECT a.device_id FROM data_source_assignment a "
                + "WHERE a.data_source_id = ds.id AND a.effective_from <= ? "
                + "AND (a.effective_to IS NULL OR a.effective_to > ?)) AS gelesen_von "
                + "FROM data_source ds WHERE ds.id = ANY (?::uuid[])",
                (rs, n) -> new SteuerungsverbundRegeln.Datenquelle(rs.getString("id"), rs.getString("site_id"),
                        rs.getString("gelesen_von")),
                t, t, dataSourceIds.stream().map(UUID::toString).toArray(String[]::new));
    }

    /**
     * Der Stand eines gespeicherten Verbunds für die Regel: Mitglieder zum Zeitpunkt samt Heimat ihrer Box, die
     * Netzanschlüsse des Tags und die Messpunkte mit ihrer lesenden Box. Leer ohne Verbund.
     */
    public Optional<RegelStand> regelStand(UUID siteId, Instant zeitpunkt, LocalDate tag) {
        Optional<VerbundZeile> v = derAnlage(siteId);
        if (v.isEmpty()) {
            return Optional.empty();
        }
        List<SteuerungsverbundRegeln.Mitglied> mitglieder = new ArrayList<>();
        List<UUID> messpunkte = new ArrayList<>();
        for (MitgliedZeile m : mitglieder(v.get().id(), zeitpunkt)) {
            String heimat = heimatDerBox(m.deviceId()).map(UUID::toString).orElse(null);
            mitglieder.add(new SteuerungsverbundRegeln.Mitglied(m.deviceId().toString(), heimat, m.rolle(),
                    m.dataSourceId() == null ? null : m.dataSourceId().toString()));
            if (m.dataSourceId() != null) {
                messpunkte.add(m.dataSourceId());
            }
        }
        List<String> na = netzanschluesse(siteId, tag).stream().map(UUID::toString).toList();
        return Optional.of(new RegelStand(new SteuerungsverbundRegeln.Verbund(siteId.toString(), na, mitglieder),
                quellen(messpunkte, zeitpunkt)));
    }

    // ------------------------------------------------------------------ Routen (IP-5)

    /** Die Anlage gibt es im Kundenbereich (RLS) — sonst antwortet eine Route 404 wie für eine unbekannte. */
    public boolean anlageSichtbar(UUID siteId) {
        return !jdbc.queryForList("SELECT 1 FROM site WHERE id = ?", Integer.class, siteId).isEmpty();
    }

    /** Sperrt den Verbund für die laufende Transaktion — zwei Übergänge derselben Anlage laufen nacheinander. */
    public void sperren(UUID verbundId) {
        jdbc.queryForList("SELECT id FROM steuerungsverbund WHERE id = ? FOR UPDATE", UUID.class, verbundId);
    }

    /** Die Box ist angemeldet und nicht ausgebaut (eine ausgebaute ist nicht mehr in ihrer Anlage — T1). */
    public boolean boxAngemeldet(UUID deviceId) {
        return !jdbc.queryForList("SELECT 1 FROM device WHERE id = ? AND ausgebaut_am IS NULL", Integer.class,
                deviceId).isEmpty();
    }

    /** Die Anlage der Datenquelle — leer, wenn es sie im Kundenbereich nicht gibt. */
    public Optional<UUID> anlageDerQuelle(UUID dataSourceId) {
        return jdbc.queryForList("SELECT site_id FROM data_source WHERE id = ?", UUID.class, dataSourceId).stream()
                .findFirst();
    }

    /** Die Werte der Anlage, gegen die das Grenzblatt aufgelöst wird (W1): Einspeisung und Bezug des Ladeparks. */
    public GrenzeAufloesung.Grenzen grenzenDerAnlage(UUID siteId) {
        return jdbc.query("SELECT s.max_feed_in_kw, c.grid_limit_kw FROM site s "
                + "LEFT JOIN site_charging_config c ON c.site_id = s.id WHERE s.id = ?",
                (rs, n) -> new GrenzeAufloesung.Grenzen(rs.getBigDecimal("max_feed_in_kw"),
                        rs.getBigDecimal("grid_limit_kw")), siteId).stream().findFirst()
                .orElse(new GrenzeAufloesung.Grenzen(null, null));
    }

    /** Wann das Mitglied bestätigt wurde ({@code bestaetigt_am}, V20260921180000) — null = noch nicht. */
    public java.util.Map<UUID, Instant> bestaetigt(UUID verbundId) {
        java.util.Map<UUID, Instant> out = new java.util.HashMap<>();
        jdbc.query("SELECT id, bestaetigt_am FROM steuerungsverbund_mitglied WHERE steuerungsverbund_id = ? "
                + "AND bestaetigt_am IS NOT NULL", rs -> {
                    out.put(rs.getObject("id", UUID.class), rs.getTimestamp("bestaetigt_am").toInstant());
                }, verbundId);
        return out;
    }

    /** Bestätigt ein offenes Mitglied (I4); false, wenn es schon bestätigt oder nicht (mehr) wirksam ist. */
    public boolean bestaetigen(UUID mitgliedId, String wer, Instant am) {
        return jdbc.update("UPDATE steuerungsverbund_mitglied SET bestaetigt_am = ?, bestaetigt_von = ? "
                + "WHERE id = ? AND bestaetigt_am IS NULL AND aufgehoben_am IS NULL", Timestamp.from(am), wer,
                mitgliedId) > 0;
    }

    // ------------------------------------------------------------------ Protokoll

    /** GENAU EIN Eintrag je Schreibvorgang; die Eintragszeit setzt die Datenbank. */
    public void protokoll(UUID tenant, UUID verbundId, UUID siteId, String art, String altJson, String neuJson,
            Instant giltAb, boolean rueckwirkend, String grund, ProtokollAkteur wer) {
        jdbc.update("INSERT INTO steuerungsverbund_aenderung (tenant_id, steuerungsverbund_id, site_id, art, alt, neu, "
                + "gilt_ab, rueckwirkend, grund, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?,?,?,?,?)", tenant, verbundId, siteId, art, altJson, neuJson,
                Timestamp.from(giltAb), rueckwirkend, grund, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    /** Das Protokoll der Anlage, neueste zuerst — auch nach dem Ende ihres Verbunds. */
    public List<Aenderung> protokollDerAnlage(UUID siteId) {
        return jdbc.query("SELECT id, steuerungsverbund_id, site_id, art, alt::text AS alt, neu::text AS neu, gilt_ab, "
                + "rueckwirkend, grund, actor_name, actor_rolle, actor_art, created_at FROM steuerungsverbund_aenderung "
                + "WHERE site_id = ? ORDER BY created_at DESC, id DESC", AENDERUNG, siteId);
    }

    // ------------------------------------------------------------------ Mapper

    private static final RowMapper<VerbundZeile> VERBUND = (rs, n) -> new VerbundZeile(rs.getObject("id", UUID.class),
            rs.getObject("site_id", UUID.class), stufe(rs.getString("stufe")), rs.getLong("epoche"),
            instant(rs, "created_at"), instant(rs, "updated_at"));

    private static final RowMapper<MitgliedZeile> MITGLIED = (rs, n) -> new MitgliedZeile(rs.getObject("id", UUID.class),
            rs.getObject("steuerungsverbund_id", UUID.class), rs.getObject("device_id", UUID.class),
            rolle(rs.getString("rolle")), rs.getObject("data_source_id", UUID.class), instant(rs, "gueltig_ab"),
            instant(rs, "gueltig_bis"), instant(rs, "aufgehoben_am"), (Long) rs.getObject("gesendet_epoche"),
            (Long) rs.getObject("gesendet_revision"), instant(rs, "gesendet_am"), (Long) rs.getObject("quittiert_epoche"),
            (Long) rs.getObject("quittiert_revision"), instant(rs, "quittiert_am"));

    private static final RowMapper<Aenderung> AENDERUNG = (rs, n) -> new Aenderung(rs.getLong("id"),
            rs.getObject("steuerungsverbund_id", UUID.class), rs.getObject("site_id", UUID.class), rs.getString("art"),
            rs.getString("alt"), rs.getString("neu"), instant(rs, "gilt_ab"), rs.getBoolean("rueckwirkend"),
            rs.getString("grund"), rs.getString("actor_name"), rs.getString("actor_rolle"), rs.getString("actor_art"),
            instant(rs, "created_at"));

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    static Stufe stufe(String code) {
        for (Stufe s : Stufe.values()) {
            if (s.code().equals(code)) {
                return s;
            }
        }
        throw new IllegalStateException("unbekannte Stufe " + code);
    }

    static Rolle rolle(String code) {
        for (Rolle r : Rolle.values()) {
            if (r.code().equals(code)) {
                return r;
            }
        }
        throw new IllegalStateException("unbekannte Rolle " + code);
    }
}
