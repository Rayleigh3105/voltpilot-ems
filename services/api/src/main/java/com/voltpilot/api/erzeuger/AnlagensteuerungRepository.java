package com.voltpilot.api.erzeuger;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * UEMS EZ-6: die Tabellen der Anlagensteuerung — {@code geraet} (Geräteart controller), {@code geraet_teil}
 * (Teilart erzeugungseinheit), {@code registerbild_fassung}, {@code anlage_netz_vermarktung} und die Komponente
 * vom Typ {@value #ENTITY_TYPE}. Alles unter RLS als App-Rolle: eine fremde oder umzäunte Anlage liefert keine
 * Zeile.
 */
@Repository
public class AnlagensteuerungRepository {

    /** Der Komponententyp „Anlagensteuerung“ ({@code entitytypes/catalog.json}). */
    public static final String ENTITY_TYPE = "anlagensteuerung";

    /** Eine Datenquelle, wie die Anlege-Prüfung sie braucht. */
    public record Quelle(UUID id, UUID siteId, String kennzeichen, String protokoll, String adresse,
            List<Integer> geraeteIds, boolean archiviert) {}

    /** Eine Steuerung: das Gerät mit seiner Komponente und Datenquelle. */
    public record Steuerung(UUID geraetId, UUID siteId, String kennzeichen, String einbauKennzeichen,
            String bezeichnung, String hersteller, String typ, Instant eingebautAm, UUID entityId,
            UUID dataSourceId, String quelleKennzeichen, String adresse, Integer unitId) {}

    /** Die Fassung, wie sie in der Tabelle steht ({@code rseStufen} als JSON-Text). */
    public record Fassung(UUID id, String bildart, int basisadresse, int funktionscode, String wortfolge,
            int teAnzahl, String anlagenart, Long steuerungKennung, String rseStufen, int veraltetNetzpunktS,
            Integer programmstandSoll, Instant gueltigAb) {}

    /** Die Stammdaten Netz und Vermarktung einer Anlage. */
    public record Stammdaten(String direktvermarkter, String direktvermarkterKanal, String einspeisemanagement,
            BigDecimal einspeisemanagementProzent, String netzbetreiberBild, String direktvermarkterBild,
            Instant namenGelesenAm, int revision) {}

    /** Der jüngste Wert eines Punkts der Komponente; {@code zeit == null} = keiner. */
    public record Jungster(String pointKey, Instant zeit, BigDecimal zahl, String qualitaet) {}

    /** Ein Eimer einer Kurve (UEMS EZ-10): Mittel, kleinster, größter und letzter guter Wert und ihre Zahl. */
    public record Eimer(String pointKey, Instant start, BigDecimal avg, BigDecimal min, BigDecimal max,
            BigDecimal last, int n) {}

    private static final String STEUERUNG = "SELECT g.id, g.site_id, g.kennzeichen, g.einbau_kennzeichen, "
            + "g.bezeichnung, g.hersteller, g.typ, g.eingebaut_am, v.entity_id, g.data_source_id, "
            + "q.kennzeichen AS quelle_kennzeichen, q.adresse, g.geraete_id "
            + "FROM geraet g "
            + "JOIN geraet_komponente v ON v.geraet_id = g.id AND v.gueltig_ab <= now() "
            + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis > now()) "
            + "JOIN measurement_point m ON m.id = v.entity_id AND m.entity_type = '" + ENTITY_TYPE + "' "
            + "LEFT JOIN data_source q ON q.id = g.data_source_id "
            + "WHERE g.geraeteart = 'controller' AND g.ausgebaut_am IS NULL ";

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public AnlagensteuerungRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    // ------------------------------------------------------------------ lesen

    /** Sichtbarkeit vor fachlichen Fehlern: eine fremde oder umzäunte Anlage ist nicht da. */
    public boolean anlageSichtbar(UUID siteId) {
        return !jdbc.queryForList("SELECT s.id FROM site s WHERE s.id = ?", UUID.class, siteId).isEmpty();
    }

    /** Die eingebauten Boxen der Anlage. */
    public List<UUID> boxen(UUID siteId) {
        return jdbc.queryForList("SELECT id FROM device WHERE site_id = ? AND ausgebaut_am IS NULL ORDER BY id",
                UUID.class, siteId);
    }

    public Optional<Quelle> quelle(UUID dataSourceId) {
        return jdbc.query("SELECT id, site_id, kennzeichen, protokoll, adresse, geraete_ids, archiviert_am "
                + "FROM data_source WHERE id = ?", (rs, n) -> new Quelle(rs.getObject("id", UUID.class),
                        rs.getObject("site_id", UUID.class), rs.getString("kennzeichen"), rs.getString("protokoll"),
                        rs.getString("adresse"), ganzzahlen(rs.getArray("geraete_ids")),
                        rs.getTimestamp("archiviert_am") != null), dataSourceId).stream().findFirst();
    }

    /** Die Box, die die Datenquelle JETZT liest — leer ohne laufende Zuständigkeit. */
    public Optional<UUID> leser(UUID dataSourceId) {
        return jdbc.queryForList("SELECT a.device_id FROM data_source_assignment a WHERE a.data_source_id = ? "
                + "AND a.zurueckgenommen_am IS NULL AND a.effective_from <= now() "
                + "AND (a.effective_to IS NULL OR a.effective_to > now())", UUID.class, dataSourceId)
                .stream().findFirst();
    }

    /** Gibt es an dieser Datenquelle und Geräte-ID schon eine eingebaute Anlagensteuerung? */
    public boolean steuerungAnQuelle(UUID dataSourceId, int unitId) {
        return !jdbc.query(STEUERUNG + "AND g.data_source_id = ? AND g.geraete_id = ?", (rs, n) -> true,
                dataSourceId, unitId).isEmpty();
    }

    public List<Steuerung> steuerungen(UUID siteId) {
        return jdbc.query(STEUERUNG + "AND g.site_id = ? ORDER BY g.eingebaut_am, g.kennzeichen",
                AnlagensteuerungRepository::steuerung, siteId);
    }

    public Optional<Steuerung> steuerung(UUID geraetId) {
        return jdbc.query(STEUERUNG + "AND g.id = ?", AnlagensteuerungRepository::steuerung, geraetId)
                .stream().findFirst();
    }

    /** Die laufende Fassung der Steuerung — leer ohne eine. */
    public Optional<Fassung> fassung(UUID geraetId) {
        return jdbc.query("SELECT id, bildart, basisadresse, funktionscode, wortfolge, te_anzahl, anlagenart, "
                + "steuerung_kennung, rse_stufen::text AS rse_stufen, veraltet_netzpunkt_s, programmstand_soll, gueltig_ab "
                + "FROM registerbild_fassung WHERE geraet_id = ? AND gueltig_ab <= now() "
                + "AND (gueltig_bis IS NULL OR gueltig_bis > now())",
                (rs, n) -> new Fassung(rs.getObject("id", UUID.class), rs.getString("bildart"),
                        rs.getInt("basisadresse"), rs.getInt("funktionscode"), rs.getString("wortfolge"),
                        rs.getInt("te_anzahl"), rs.getString("anlagenart"), (Long) rs.getObject("steuerung_kennung"),
                        rs.getString("rse_stufen"), rs.getInt("veraltet_netzpunkt_s"),
                        (Integer) rs.getObject("programmstand_soll"), rs.getTimestamp("gueltig_ab").toInstant()), geraetId).stream().findFirst();
    }

    /** Die Erzeugungseinheiten, die jetzt an der Steuerung stecken, nach TE-Nr. */
    public List<com.voltpilot.api.uems.GeraetRepository.Teil> einheiten(UUID geraetId) {
        return jdbc.query("SELECT t.id, t.geraet_id, t.teilart, t.steckplatz, t.bezeichnung, t.typ, t.seriennummer, "
                + "t.eingebaut_am, t.ausgebaut_am, t.te_nr, t.einheit_art, t.nennleistung_kw, t.registry_unit_id, "
                + "t.typ_bild FROM geraet_teil t WHERE t.geraet_id = ? AND t.teilart = 'erzeugungseinheit' "
                + "AND t.eingebaut_am <= now() AND (t.ausgebaut_am IS NULL OR t.ausgebaut_am > now()) "
                + "ORDER BY t.te_nr", (rs, n) -> new com.voltpilot.api.uems.GeraetRepository.Teil(
                        rs.getObject("id", UUID.class), rs.getObject("geraet_id", UUID.class), rs.getString("teilart"),
                        (Integer) rs.getObject("steckplatz"), rs.getString("bezeichnung"), rs.getString("typ"),
                        rs.getString("seriennummer"), rs.getTimestamp("eingebaut_am").toInstant(),
                        rs.getTimestamp("ausgebaut_am") == null ? null : rs.getTimestamp("ausgebaut_am").toInstant(),
                        (Integer) rs.getObject("te_nr"), rs.getString("einheit_art"),
                        rs.getBigDecimal("nennleistung_kw"), rs.getString("registry_unit_id"),
                        rs.getString("typ_bild")), geraetId);
    }

    public Optional<Stammdaten> stammdaten(UUID siteId) {
        return jdbc.query("SELECT direktvermarkter, direktvermarkter_kanal, einspeisemanagement, "
                + "einspeisemanagement_prozent, netzbetreiber_bild, direktvermarkter_bild, namen_gelesen_am, revision "
                + "FROM anlage_netz_vermarktung WHERE site_id = ?", (rs, n) -> new Stammdaten(
                        rs.getString("direktvermarkter"), rs.getString("direktvermarkter_kanal"),
                        rs.getString("einspeisemanagement"), rs.getBigDecimal("einspeisemanagement_prozent"),
                        rs.getString("netzbetreiber_bild"), rs.getString("direktvermarkter_bild"),
                        rs.getTimestamp("namen_gelesen_am") == null ? null
                                : rs.getTimestamp("namen_gelesen_am").toInstant(),
                        rs.getInt("revision")), siteId).stream().findFirst();
    }

    /** Der Netzbetreiber des Netzanschlusses, an dem die Anlage an diesem Tag hängt; leer ohne Eintrag. */
    public Optional<String> netzbetreiber(UUID siteId, LocalDate tag) {
        return jdbc.queryForList("SELECT n.netzbetreiber FROM anlage_netzanschluss b "
                + "JOIN netzanschluss n ON n.id = b.netzanschluss_id AND n.tenant_id = b.tenant_id "
                + "WHERE b.site_id = ? AND b.aufgehoben_am IS NULL AND b.gueltig_ab <= ? "
                + "AND (b.gueltig_bis IS NULL OR b.gueltig_bis >= ?) AND n.netzbetreiber IS NOT NULL",
                String.class, siteId, tag, tag).stream().findFirst();
    }

    /**
     * Der jüngste Wert je Punktschlüssel der Komponente — in EINER Abfrage über den Reihen-Index
     * {@code (tenant_id, entity_id, point_key, time)}. Ein Schlüssel ohne Wert kommt mit {@code zeit == null}.
     */
    public List<Jungster> juengste(UUID tenantId, UUID entityId, List<String> pointKeys) {
        return jdbc.query("SELECT k.key, s.time, s.zahl, s.quality FROM unnest(?::text[]) WITH ORDINALITY AS k(key, nr) "
                + "LEFT JOIN LATERAL (SELECT d.time, coalesce(d.decoded_numeric, d.raw_numeric) AS zahl, d.quality "
                + "FROM device_measurement_sample d WHERE d.tenant_id = ? AND d.entity_id = ? AND d.point_key = k.key "
                + "AND d.role IS DISTINCT FROM 'spiegel' ORDER BY d.time DESC LIMIT 1) s ON TRUE ORDER BY k.nr",
                (rs, n) -> new Jungster(rs.getString("key"),
                        rs.getTimestamp("time") == null ? null : rs.getTimestamp("time").toInstant(),
                        rs.getBigDecimal("zahl"), rs.getString("quality")),
                pointKeys.toArray(String[]::new), tenantId, entityId);
    }

    // ---------------------------------------------------------------- schreiben

    /** Der Controller „Anlagensteuerung“ — eingebaut ab {@code ab}, mit Datenquelle und Geräte-ID. */
    /**
     * Die Kurven der Komponente über [von, bis) in Eimern (UEMS EZ-10) — über denselben Reihen-Index wie
     * {@link #juengste}. Nur gute Werte zählen; ein Eimer ohne Wert fehlt (nie 0). {@code tagesEimer} schneidet
     * die Tage an der Berliner Mitternacht wie die übrige Historie.
     */
    public List<Eimer> verlauf(UUID tenantId, UUID entityId, List<String> pointKeys, Instant von, Instant bis,
            int eimerMinuten, boolean tagesEimer) {
        String eimer = tagesEimer ? "time_bucket(CAST('1 day' AS interval), d.time, 'Europe/Berlin')"
                : "time_bucket(CAST(? AS interval), d.time)";
        String sql = "SELECT d.point_key, " + eimer + " AS start, avg(z) AS avg, min(z) AS min, max(z) AS max, "
                + "last(z, d.time) AS last, count(*) AS n FROM device_measurement_sample d "
                + "CROSS JOIN LATERAL (SELECT coalesce(d.decoded_numeric, d.raw_numeric) AS z) w "
                + "WHERE d.tenant_id = ? AND d.entity_id = ? AND d.point_key = ANY(?::text[]) AND d.time >= ? "
                + "AND d.time < ? AND d.quality = 'good' AND d.role IS DISTINCT FROM 'spiegel' AND z IS NOT NULL "
                + "GROUP BY 1, 2 ORDER BY 1, 2";
        List<Object> args = new java.util.ArrayList<>();
        if (!tagesEimer) {
            args.add(eimerMinuten + " minutes");
        }
        args.addAll(List.of(tenantId, entityId, pointKeys.toArray(String[]::new), Timestamp.from(von),
                Timestamp.from(bis)));
        return jdbc.query(sql, (rs, n) -> new Eimer(rs.getString("point_key"), rs.getTimestamp("start").toInstant(),
                rs.getBigDecimal("avg"), rs.getBigDecimal("min"), rs.getBigDecimal("max"), rs.getBigDecimal("last"),
                rs.getInt("n")), args.toArray());
    }

    public Steuerung geraetAnlegen(UUID tenant, UUID siteId, String bezeichnung, String hersteller, String typ,
            UUID dataSourceId, int unitId, Instant ab, String subject) {
        return jdbc.queryForObject("INSERT INTO geraet (tenant_id, site_id, kennzeichen, einbau_kennzeichen, "
                + "geraeteart, hersteller, typ, bezeichnung, data_source_id, geraete_id, eingebaut_am, aus_bestand, "
                + "created_by) SELECT ?, ?, n.k, n.k, 'controller', ?, ?, ?, ?, ?, ?, false, ? "
                + "FROM (SELECT uems_geraet_kennzeichen(?) AS k) n RETURNING id, kennzeichen",
                (rs, n) -> new Steuerung(rs.getObject("id", UUID.class), siteId, rs.getString("kennzeichen"),
                        rs.getString("kennzeichen"), bezeichnung, hersteller, typ, ab, null, dataSourceId, null, null,
                        unitId),
                tenant, siteId, hersteller, typ, bezeichnung, dataSourceId, unitId, Timestamp.from(ab), subject, tenant);
    }

    /** Die Komponente bindet die Messpunkte an die Datenquelle der Steuerung. */
    public void komponenteBinden(UUID tenant, UUID geraetId, UUID entityId, UUID dataSourceId, Instant ab,
            String subject) {
        jdbc.update("UPDATE measurement_point SET data_source_id = ? WHERE id = ? AND data_source_id IS NULL",
                dataSourceId, entityId);
        jdbc.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, gueltig_ab, created_by) "
                + "VALUES (?,?,?,NULL,?,?)", tenant, geraetId, entityId, Timestamp.from(ab), subject);
    }

    public UUID einheitAnlegen(UUID tenant, UUID geraetId, int teNr, String einheitArt, String bezeichnung,
            String typ, String typBild, BigDecimal nennleistungKw, String registryUnitId, Instant ab, String subject) {
        return jdbc.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, teilart, te_nr, einheit_art, "
                + "bezeichnung, typ, typ_bild, nennleistung_kw, registry_unit_id, eingebaut_am, created_by) "
                + "VALUES (?,?,'erzeugungseinheit',?,?,?,?,?,?,?,?,?) RETURNING id", UUID.class, tenant, geraetId,
                teNr, einheitArt, bezeichnung, typ, typBild, nennleistungKw, registryUnitId, Timestamp.from(ab),
                subject);
    }

    public void fassungAnlegen(UUID tenant, UUID siteId, UUID geraetId, int basisadresse, int funktionscode,
            String wortfolge, int teAnzahl, String anlagenart, Long steuerungKennung, Object rseStufen,
            int veraltetNetzpunktS, Integer programmstandSoll, Instant ab, String subject) {
        jdbc.update("INSERT INTO registerbild_fassung (tenant_id, site_id, geraet_id, bildart, basisadresse, "
                + "funktionscode, wortfolge, te_anzahl, anlagenart, steuerung_kennung, rse_stufen, "
                + "veraltet_netzpunkt_s, programmstand_soll, gueltig_ab, created_by) "
                + "VALUES (?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?)",
                tenant, siteId, geraetId, ErzeugerRegisterbild.BILDART, basisadresse, funktionscode, wortfolge,
                teAnzahl, anlagenart, steuerungKennung, rseStufen == null ? null : text(rseStufen),
                veraltetNetzpunktS, programmstandSoll, Timestamp.from(ab), subject);
    }

    /** Ersetzt die Angaben einer eingebauten Einheit; false, wenn es sie nicht (mehr) gibt. */
    public boolean einheitAendern(UUID geraetId, int teNr, String einheitArt, String bezeichnung, String typ,
            BigDecimal nennleistungKw, String registryUnitId) {
        return jdbc.update("UPDATE geraet_teil SET einheit_art = ?, bezeichnung = ?, typ = ?, nennleistung_kw = ?, "
                + "registry_unit_id = ? WHERE geraet_id = ? AND te_nr = ? AND teilart = 'erzeugungseinheit' "
                + "AND ausgebaut_am IS NULL", einheitArt, bezeichnung, typ, nennleistungKw, registryUnitId, geraetId,
                teNr) == 1;
    }

    /** Der Typname aus dem Bild; eine leere Anzeige ({@code typ}) bekommt ihn als Vorbelegung. */
    public void typAusBild(UUID geraetId, int teNr, String typBild) {
        jdbc.update("UPDATE geraet_teil SET typ_bild = ?, typ = COALESCE(typ, ?) WHERE geraet_id = ? AND te_nr = ? "
                + "AND teilart = 'erzeugungseinheit' AND ausgebaut_am IS NULL", typBild, typBild, geraetId, teNr);
    }

    /** Legt die Stammdaten-Zeile der Anlage an, wenn es noch keine gibt. */
    public void stammdatenSicherstellen(UUID tenant, UUID siteId, String subject) {
        jdbc.update("INSERT INTO anlage_netz_vermarktung (site_id, tenant_id, updated_by) VALUES (?,?,?) "
                + "ON CONFLICT (site_id) DO NOTHING", siteId, tenant, subject);
    }

    /** Ersetzt die Stammdaten bei passender Revision; false bei veralteter Revision. */
    public boolean stammdatenAendern(UUID siteId, int erwartet, String direktvermarkter, String kanal,
            String einspeisemanagement, BigDecimal prozent, String subject) {
        return jdbc.update("UPDATE anlage_netz_vermarktung SET direktvermarkter = ?, direktvermarkter_kanal = ?, "
                + "einspeisemanagement = ?, einspeisemanagement_prozent = ?, revision = revision + 1, "
                + "updated_at = now(), updated_by = ? WHERE site_id = ? AND revision = ?", direktvermarkter, kanal,
                einspeisemanagement, prozent, subject, siteId, erwartet) == 1;
    }

    /**
     * Die Namen aus dem Bild: unverändert gespeichert; eine leere Anzeige des Direktvermarkters wird vorbelegt,
     * eine vorhandene nie überschrieben.
     */
    public void namenAusBild(UUID siteId, String netzbetreiber, String direktvermarkter, Instant am, String subject) {
        jdbc.update("UPDATE anlage_netz_vermarktung SET netzbetreiber_bild = ?, direktvermarkter_bild = ?, "
                + "namen_gelesen_am = ?, direktvermarkter = COALESCE(direktvermarkter, ?), revision = revision + 1, "
                + "updated_at = now(), updated_by = ? WHERE site_id = ?", netzbetreiber, direktvermarkter,
                Timestamp.from(am), direktvermarkter, subject, siteId);
    }

    private String text(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalArgumentException("nicht als JSON darstellbar", e);
        }
    }

    private static Steuerung steuerung(ResultSet rs, int n) throws SQLException {
        return new Steuerung(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getString("kennzeichen"), rs.getString("einbau_kennzeichen"), rs.getString("bezeichnung"),
                rs.getString("hersteller"), rs.getString("typ"), rs.getTimestamp("eingebaut_am").toInstant(),
                rs.getObject("entity_id", UUID.class), rs.getObject("data_source_id", UUID.class),
                rs.getString("quelle_kennzeichen"), rs.getString("adresse"), (Integer) rs.getObject("geraete_id"));
    }

    private static List<Integer> ganzzahlen(Array array) throws SQLException {
        if (array == null) {
            return List.of();
        }
        Object[] werte = (Object[]) array.getArray();
        return java.util.Arrays.stream(werte).map(w -> ((Number) w).intValue()).toList();
    }
}
