package com.voltpilot.api.erzeugungsanlage;

import com.voltpilot.api.uems.ProtokollAkteur;
import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * Die Erzeugungsanlagen einer Anlage (Messkonzepte S1, {@code V20261112043000}): Identität, Fassungen, Verweise auf
 * Komponenten und das Protokoll. Unter RLS wie jede Anlagen-Abfrage - eine fremde Anlage liefert nichts. Eine EA und
 * eine Fassung werden aufgehoben, nie geändert oder gelöscht; geändert werden nur Name, Art und die Angaben zur
 * Inbetriebnahme und zum Register (mit Protokolleintrag).
 */
@Repository
public class ErzeugungsanlageRepository {

    /** Eine EA, wie sie gespeichert ist. */
    public record Ea(UUID id, UUID siteId, int nummer, String name, String art, LocalDate inbetriebnahme,
            Boolean abSolarspitzengesetz, String registry, String registryUnitId, Instant registryFetchedAt,
            boolean folgtAnlage) {
    }

    /** Eine wirksame (nicht aufgehobene) Fassung; {@code gueltigAb} null = von der Inbetriebnahme an. */
    public record Fassung(UUID id, UUID eaId, LocalDate gueltigAb, BigDecimal leistungKwp, String einspeiseart,
            BigDecimal satzAngegebenCtKwh, String herkunft, Instant eingetragenAm) {
    }

    /** Ein nicht aufgehobener Verweis EA → Komponente. */
    public record Verweis(UUID id, UUID eaId, UUID komponenteId, String komponenteName, Integer eingang,
            LocalDate gueltigAb, LocalDate gueltigBis, Instant eingetragenAm) {
    }

    /**
     * Was die Anlage HEUTE über ihre PV weiß - genau die Werte, mit denen Karte „Einspeisevergütung“, Fahrplan und
     * Erlöse rechnen: das primäre PV-Aggregat (PV-Summe, Inbetriebnahme, MaStR-Einheit) und die Angaben der Anlage.
     */
    public record Bestand(UUID tenantId, boolean hatPvAggregat, BigDecimal kwp, LocalDate inbetriebnahme, String registry,
            String registryUnitId, Instant registryFetchedAt, BigDecimal satzCtKwh, Boolean abSolarspitzengesetz,
            String plantKind, boolean netzladenErlaubt) {
    }

    /** Ein Erzeuger mit kWp, der noch keine EA speist. */
    public record Vorschlag(UUID komponenteId, String name, BigDecimal leistungKwp, String registryUnitId) {
    }

    /** Der Netzanschluss, an dem die Anlage an einem Tag hängt. */
    public record Anschluss(UUID id, String kennzeichen, String name) {
    }

    private static final String EA_SPALTEN = "id, site_id, nummer, name, art, inbetriebnahme, "
            + "inbetriebnahme_ab_solarspitzengesetz, registry, registry_unit_id, registry_fetched_at, folgt_anlage";

    private static final RowMapper<Ea> EA = (rs, n) -> new Ea(
            rs.getObject("id", UUID.class),
            rs.getObject("site_id", UUID.class),
            rs.getInt("nummer"),
            rs.getString("name"),
            rs.getString("art"),
            rs.getObject("inbetriebnahme", LocalDate.class),
            rs.getObject("inbetriebnahme_ab_solarspitzengesetz", Boolean.class),
            rs.getString("registry"),
            rs.getString("registry_unit_id"),
            instant(rs, "registry_fetched_at"),
            rs.getBoolean("folgt_anlage"));

    private static final RowMapper<Fassung> FASSUNG = (rs, n) -> new Fassung(
            rs.getObject("id", UUID.class),
            rs.getObject("erzeugungsanlage_id", UUID.class),
            rs.getObject("gueltig_ab", LocalDate.class),
            ohneNullen(rs.getBigDecimal("leistung_kwp")),
            rs.getString("einspeiseart"),
            ohneNullen(rs.getBigDecimal("satz_angegeben_ct_kwh")),
            rs.getString("herkunft"),
            instant(rs, "created_at"));

    private final JdbcTemplate jdbc;

    public ErzeugungsanlageRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ------------------------------------------------------------------------------------------ lesen

    /** Die nicht aufgehobenen EA einer Anlage, nach Nummer. */
    public List<Ea> aktive(UUID siteId) {
        return jdbc.query("SELECT " + EA_SPALTEN + " FROM erzeugungsanlage "
                + "WHERE site_id = ? AND aufgehoben_am IS NULL ORDER BY nummer", EA, siteId);
    }

    /** Hat die Anlage je eine EA getragen (auch eine aufgehobene)? */
    public boolean jeEine(UUID siteId) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM erzeugungsanlage WHERE site_id = ?)", Boolean.class, siteId));
    }

    /** Die nächste freie Nummer - eine einmal vergebene (auch aufgehobene) wird nie neu vergeben. */
    public int naechsteNummer(UUID siteId) {
        Integer max = jdbc.queryForObject("SELECT max(nummer) FROM erzeugungsanlage WHERE site_id = ?",
                Integer.class, siteId);
        return max == null ? 1 : max + 1;
    }

    /** Die wirksamen Fassungen der EA, je EA nach erstem Tag (die erste Fassung zuerst). */
    public List<Fassung> fassungen(Collection<UUID> eaIds) {
        if (eaIds.isEmpty()) {
            return List.of();
        }
        return jdbc.query("SELECT id, erzeugungsanlage_id, gueltig_ab, leistung_kwp, einspeiseart, "
                + "satz_angegeben_ct_kwh, herkunft, created_at FROM erzeugungsanlage_fassung "
                + "WHERE erzeugungsanlage_id = ANY (?::uuid[]) AND aufgehoben_am IS NULL "
                + "ORDER BY erzeugungsanlage_id, gueltig_ab NULLS FIRST", FASSUNG, uuidArray(eaIds));
    }

    /** Die nicht aufgehobenen Verweise der EA auf Komponenten, mit dem Namen der Komponente. */
    public List<Verweis> verweise(Collection<UUID> eaIds) {
        if (eaIds.isEmpty()) {
            return List.of();
        }
        return jdbc.query("SELECT v.id, v.erzeugungsanlage_id, v.komponente_id, mp.label, v.eingang, v.gueltig_ab, "
                + "v.gueltig_bis, v.created_at FROM erzeugungsanlage_komponente v "
                + "JOIN measurement_point mp ON mp.id = v.komponente_id "
                + "WHERE v.erzeugungsanlage_id = ANY (?::uuid[]) AND v.aufgehoben_am IS NULL "
                + "ORDER BY v.gueltig_ab, mp.label, v.eingang NULLS FIRST",
                (rs, n) -> new Verweis(
                        rs.getObject("id", UUID.class),
                        rs.getObject("erzeugungsanlage_id", UUID.class),
                        rs.getObject("komponente_id", UUID.class),
                        rs.getString("label"),
                        rs.getObject("eingang", Integer.class),
                        rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class),
                        instant(rs, "created_at")),
                uuidArray(eaIds));
    }

    /** Alle nicht aufgehobenen Verweise auf eine Komponente (gleich welcher EA der Anlage). */
    public List<Verweis> verweiseAuf(UUID siteId, UUID komponenteId) {
        return jdbc.query("SELECT v.id, v.erzeugungsanlage_id, v.komponente_id, mp.label, v.eingang, v.gueltig_ab, "
                + "v.gueltig_bis, v.created_at FROM erzeugungsanlage_komponente v "
                + "JOIN measurement_point mp ON mp.id = v.komponente_id "
                + "JOIN erzeugungsanlage e ON e.id = v.erzeugungsanlage_id AND e.aufgehoben_am IS NULL "
                + "WHERE e.site_id = ? AND v.komponente_id = ? AND v.aufgehoben_am IS NULL",
                (rs, n) -> new Verweis(
                        rs.getObject("id", UUID.class),
                        rs.getObject("erzeugungsanlage_id", UUID.class),
                        rs.getObject("komponente_id", UUID.class),
                        rs.getString("label"),
                        rs.getObject("eingang", Integer.class),
                        rs.getObject("gueltig_ab", LocalDate.class),
                        rs.getObject("gueltig_bis", LocalDate.class),
                        instant(rs, "created_at")),
                siteId, komponenteId);
    }

    /** Der Name einer Komponente dieser Anlage, oder null, wenn es sie hier nicht gibt. */
    public String komponenteName(UUID siteId, UUID komponenteId) {
        List<String> namen = jdbc.queryForList(
                "SELECT label FROM measurement_point WHERE id = ? AND site_id = ?", String.class, komponenteId, siteId);
        return namen.isEmpty() ? null : (namen.get(0) == null ? "" : namen.get(0));
    }

    /** Der Bestand der Anlage, oder null, wenn RLS sie verbirgt. */
    public Bestand bestand(UUID siteId) {
        List<Bestand> zeilen = jdbc.query("SELECT s.tenant_id, pv.id AS pv_id, pv.pv_capacity_kwp, pv.commissioned_on, "
                + "pv.registry, pv.registry_unit_id, pv.registry_fetched_at, s.einspeiseverguetung_ct_kwh, "
                + "s.inbetriebnahme_ab_solarspitzengesetz, s.plant_kind, s.netzladen_erlaubt FROM site s "
                + "LEFT JOIN asset pv ON pv.site_id = s.id AND pv.type = 'pv' AND pv.is_primary WHERE s.id = ?",
                (rs, n) -> new Bestand(
                        rs.getObject("tenant_id", UUID.class),
                        rs.getObject("pv_id") != null,
                        ohneNullen(rs.getBigDecimal("pv_capacity_kwp")),
                        rs.getObject("commissioned_on", LocalDate.class),
                        rs.getString("registry"),
                        rs.getString("registry_unit_id"),
                        instant(rs, "registry_fetched_at"),
                        ohneNullen(rs.getBigDecimal("einspeiseverguetung_ct_kwh")),
                        rs.getObject("inbetriebnahme_ab_solarspitzengesetz", Boolean.class),
                        rs.getString("plant_kind"),
                        rs.getBoolean("netzladen_erlaubt")),
                siteId);
        return zeilen.isEmpty() ? null : zeilen.get(0);
    }

    /**
     * Weitere Erzeuger mit Nennleistung, die am Tag keine EA speisen - der Vorschlag weiterer EA. Nie still angelegt:
     * ein Mensch entscheidet, ob sie eine eigene EA sind oder zu einer gehören.
     *
     * <p>Einfach bleibt einfach: solange eine EA der Anlage folgt, ist ihre Leistung die PV-Summe der Anlage - jeder
     * Erzeuger ohne eigene SEE-Nummer gehört dann still zu ihr und ist kein Vorschlag. Nur ein Erzeuger mit einer
     * SEE-Nummer, die keine EA trägt, deutet dann auf eine weitere EA. Folgt keine EA (ab der zweiten), ist jeder
     * Erzeuger ohne Verweis ein Vorschlag.
     */
    public List<Vorschlag> vorschlaege(UUID siteId, LocalDate tag) {
        return jdbc.query("SELECT mp.id, mp.label, mp.capacity_kwp, mp.registry_unit_id FROM measurement_point mp "
                + "WHERE mp.site_id = ? AND mp.role = 'pv-generation' AND mp.capacity_kwp > 0 "
                + "AND NOT EXISTS (SELECT 1 FROM erzeugungsanlage_komponente v "
                + "  JOIN erzeugungsanlage e ON e.id = v.erzeugungsanlage_id AND e.aufgehoben_am IS NULL "
                + "  WHERE v.komponente_id = mp.id AND v.aufgehoben_am IS NULL "
                + "    AND daterange(v.gueltig_ab, v.gueltig_bis, '[]') @> ?::date) "
                + "AND NOT (EXISTS (SELECT 1 FROM erzeugungsanlage f WHERE f.site_id = mp.site_id "
                + "      AND f.folgt_anlage AND f.aufgehoben_am IS NULL) "
                + "  AND (mp.registry_unit_id IS NULL OR EXISTS (SELECT 1 FROM erzeugungsanlage g "
                + "      WHERE g.site_id = mp.site_id AND g.aufgehoben_am IS NULL "
                + "        AND g.registry_unit_id = mp.registry_unit_id))) "
                + "ORDER BY mp.label, mp.id",
                (rs, n) -> new Vorschlag(rs.getObject("id", UUID.class), rs.getString("label"),
                        ohneNullen(rs.getBigDecimal("capacity_kwp")), rs.getString("registry_unit_id")),
                siteId, tag);
    }

    /** Der Netzanschluss der Anlage am Tag, oder null (keiner angelegt oder keiner gebunden). */
    public Anschluss netzanschluss(UUID siteId, LocalDate tag) {
        List<Anschluss> zeilen = jdbc.query("SELECT n.id, n.kennzeichen, n.name FROM anlage_netzanschluss b "
                + "JOIN netzanschluss n ON n.id = b.netzanschluss_id "
                + "WHERE b.site_id = ? AND b.aufgehoben_am IS NULL "
                + "AND daterange(b.gueltig_ab, b.gueltig_bis, '[]') @> ?::date",
                (rs, n) -> new Anschluss(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                        rs.getString("name")),
                siteId, tag);
        return zeilen.isEmpty() ? null : zeilen.get(0);
    }

    // --------------------------------------------------------------------------------------- schreiben

    /** Hält die Anlage bis zum Ende der Transaktion: zwei Schreibvorgänge an ihren EA laufen nacheinander. */
    public void sperren(UUID siteId) {
        jdbc.queryForList("SELECT id FROM site WHERE id = ? FOR UPDATE", UUID.class, siteId);
    }

    public UUID anlegen(UUID tenant, UUID siteId, int nummer, String name, String art, LocalDate inbetriebnahme,
            Boolean abSolarspitzengesetz, String registry, String registryUnitId, Instant registryFetchedAt,
            boolean folgtAnlage, String wer) {
        return jdbc.queryForObject("INSERT INTO erzeugungsanlage (tenant_id, site_id, nummer, name, art, "
                + "inbetriebnahme, inbetriebnahme_ab_solarspitzengesetz, registry, registry_unit_id, "
                + "registry_fetched_at, folgt_anlage, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                UUID.class, tenant, siteId, nummer, name, art, inbetriebnahme, abSolarspitzengesetz, registry,
                registryUnitId, ts(registryFetchedAt), folgtAnlage, wer);
    }

    /** Name, Art, Inbetriebnahme und Register in einem - die Voll-Darstellung der Identität. */
    public void identitaet(UUID eaId, String name, String art, LocalDate inbetriebnahme, Boolean abSolarspitzengesetz,
            String registry, String registryUnitId, Instant registryFetchedAt, Instant jetzt) {
        jdbc.update("UPDATE erzeugungsanlage SET name = ?, art = ?, inbetriebnahme = ?, "
                + "inbetriebnahme_ab_solarspitzengesetz = ?, registry = ?, registry_unit_id = ?, "
                + "registry_fetched_at = ?, updated_at = ? WHERE id = ?",
                name, art, inbetriebnahme, abSolarspitzengesetz, registry, registryUnitId, ts(registryFetchedAt),
                ts(jetzt), eaId);
    }

    public void folgtNichtMehr(UUID eaId, Instant jetzt) {
        jdbc.update("UPDATE erzeugungsanlage SET folgt_anlage = false, updated_at = ? WHERE id = ?", ts(jetzt), eaId);
    }

    public void aufheben(UUID eaId, Instant jetzt) {
        jdbc.update("UPDATE erzeugungsanlage SET aufgehoben_am = ?, updated_at = ? WHERE id = ?",
                ts(jetzt), ts(jetzt), eaId);
    }

    public void fassungAufheben(UUID fassungId, Instant jetzt) {
        jdbc.update("UPDATE erzeugungsanlage_fassung SET aufgehoben_am = ? WHERE id = ?", ts(jetzt), fassungId);
    }

    public UUID fassungEintragen(UUID tenant, UUID eaId, LocalDate gueltigAb, BigDecimal leistungKwp,
            String einspeiseart, BigDecimal satzCtKwh, String herkunft, String wer) {
        return jdbc.queryForObject("INSERT INTO erzeugungsanlage_fassung (tenant_id, erzeugungsanlage_id, gueltig_ab, "
                + "leistung_kwp, einspeiseart, satz_angegeben_ct_kwh, herkunft, created_by) "
                + "VALUES (?,?,?,?,?,?,?,?) RETURNING id", UUID.class,
                tenant, eaId, gueltigAb, leistungKwp, einspeiseart, satzCtKwh, herkunft, wer);
    }

    public UUID verweisEintragen(UUID tenant, UUID eaId, UUID komponenteId, Integer eingang, LocalDate gueltigAb,
            String wer) {
        return jdbc.queryForObject("INSERT INTO erzeugungsanlage_komponente (tenant_id, erzeugungsanlage_id, "
                + "komponente_id, eingang, gueltig_ab, created_by) VALUES (?,?,?,?,?,?) RETURNING id", UUID.class,
                tenant, eaId, komponenteId, eingang, gueltigAb, wer);
    }

    public void verweisBeenden(UUID verweisId, LocalDate gueltigBis) {
        jdbc.update("UPDATE erzeugungsanlage_komponente SET gueltig_bis = ? WHERE id = ?", gueltigBis, verweisId);
    }

    public void verweisAufheben(UUID verweisId, Instant jetzt) {
        jdbc.update("UPDATE erzeugungsanlage_komponente SET aufgehoben_am = ? WHERE id = ?", ts(jetzt), verweisId);
    }

    public void protokoll(UUID tenant, UUID siteId, UUID eaId, String art, String altJson, String neuJson,
            ProtokollAkteur wer) {
        jdbc.update("INSERT INTO erzeugungsanlage_aenderung (tenant_id, site_id, erzeugungsanlage_id, art, alt, neu, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?,?,?,?,?::jsonb,?::jsonb,?,?,?,?)",
                tenant, siteId, eaId, art, altJson, neuJson, wer.sub(), wer.name(), wer.rolle(), wer.art());
    }

    // ------------------------------------------------------------------------------------------ Gerüst

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }

    /** Ein Postgres-Feld-Literal {@code {a,b}} - UUIDs brauchen kein Quoting. */
    private static String uuidArray(Collection<UUID> ids) {
        StringBuilder s = new StringBuilder("{");
        for (UUID id : ids) {
            if (s.length() > 1) {
                s.append(',');
            }
            s.append(id);
        }
        return s.append('}').toString();
    }

    /** {@code 30.000} aus NUMERIC wird {@code 30} - die Zahl, die eingetragen wurde. */
    static BigDecimal ohneNullen(BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        BigDecimal kurz = wert.stripTrailingZeros();
        return kurz.scale() < 0 ? kurz.setScale(0) : kurz;
    }
}
