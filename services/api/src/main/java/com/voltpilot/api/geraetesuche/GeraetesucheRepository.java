package com.voltpilot.api.geraetesuche;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.ProtokollAkteur;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Die Tabellen der Gerätesuche ({@code V20261030140000__geraetesuche.sql}): {@code geraetesuche},
 * {@code geraetesuche_fund}, {@code geraetesuche_protokoll}. Alles unter der Verbindung der Anfrage bzw. dem Mandanten
 * der Box-Meldung: Mandanten-RLS und Standort-Zaun. Gespeichert wird nur, was die Records des Vertrags tragen — eine
 * MAC oder ein Hostname hat hier keine Spalte (DP-3 A).
 */
@Repository
public class GeraetesucheRepository {

    /** Die Box, wie die Suche sie braucht. {@code zuletztGesehen}: letzter Status-Herzschlag; null = nie. */
    public record Box(UUID siteId, boolean ausgebaut, Instant zuletztGesehen, String lanHost) {
    }

    /** Eine gespeicherte Suche. */
    public record Zeile(UUID id, UUID siteId, UUID deviceId, Instant ausgeloestAm, Instant gueltigBis,
            ProtokollAkteur akteur, String zustand, String grund, Integer standNr, String schritt, Integer erledigt,
            Integer gesamt, Integer restS, List<GeraetesucheBericht.Netz> netze, Instant letzteMeldungAm,
            Instant beendetAm, Integer dauerMs, List<String> erkenner, GeraetesucheBericht.Weitere weitere,
            Instant abbruchGesendetAm) {
    }

    private static final String SPALTEN = "id, site_id, device_id, ausgeloest_am, gueltig_bis, actor_sub, actor_name, "
            + "actor_rolle, actor_art, zustand, grund, stand_nr, schritt, erledigt, gesamt, rest_s, netze::text, "
            + "letzte_meldung_am, beendet_am, dauer_ms, erkenner, weitere_telefon_tablet, weitere_rechner, "
            + "weitere_unbekannt, abbruch_gesendet_am";

    private static final String FUND_SPALTEN = "schluessel, erkenner, art, hersteller, modell, seriennummer, firmware, "
            + "familie, spannung, kanaele, erkennung, merkmale, anbindung, hindernis, communication, ip, port, serial, "
            + "unit_id, liest_box_schon";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public GeraetesucheRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    // ------------------------------------------------------------------ Box und Anlage

    public Optional<Box> box(UUID deviceId) {
        return jdbc.query("SELECT site_id, ausgebaut_am, device_status_seen_at, lan_host FROM device WHERE id = ?",
                (rs, n) -> new Box(rs.getObject("site_id", UUID.class), rs.getTimestamp("ausgebaut_am") != null,
                        instant(rs, "device_status_seen_at"), rs.getString("lan_host")), deviceId)
                .stream().findFirst();
    }

    /** Reiht Starts an derselben Box hintereinander - nur in einer Transaktion. */
    public void sperren(UUID deviceId) {
        jdbc.queryForList("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", "geraetesuche|" + deviceId);
    }

    // ------------------------------------------------------------------ Suchen

    public void anlegen(UUID tenantId, UUID suchId, UUID siteId, UUID deviceId, Instant am, Instant gueltigBis,
            ProtokollAkteur wer) {
        jdbc.update("INSERT INTO geraetesuche (id, tenant_id, site_id, device_id, ausgeloest_am, gueltig_bis, "
                + "actor_sub, actor_name, actor_rolle, actor_art) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", suchId,
                tenantId, siteId, deviceId, Timestamp.from(am), Timestamp.from(gueltigBis), wer.sub(), wer.name(),
                wer.rolle(), wer.art());
    }

    public Optional<Zeile> finden(UUID siteId, UUID suchId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraetesuche WHERE id = ? AND site_id = ?", this::zeile,
                suchId, siteId).stream().findFirst();
    }

    /** Die jüngste Suche dieser Box, die die Box noch nicht beendet hat (wartet oder läuft). */
    public Optional<Zeile> offene(UUID deviceId) {
        return jdbc.query("SELECT " + SPALTEN + " FROM geraetesuche WHERE device_id = ? "
                + "AND zustand IN ('wartet', 'laeuft') ORDER BY ausgeloest_am DESC LIMIT 1", this::zeile, deviceId)
                .stream().findFirst();
    }

    /** Die Starts dieser Box seit {@code seit}, die die Box nicht abgelehnt hat - jüngste zuerst. */
    public List<Instant> starts(UUID deviceId, Instant seit) {
        return jdbc.query("SELECT ausgeloest_am FROM geraetesuche WHERE device_id = ? AND ausgeloest_am > ? "
                + "AND zustand <> 'abgelehnt' ORDER BY ausgeloest_am DESC",
                (rs, n) -> rs.getTimestamp(1).toInstant(), deviceId, Timestamp.from(seit));
    }

    /** Die Suchen der Anlage seit {@code seit}, jüngste zuerst; {@code deviceId} null = alle Boxen. */
    public List<Zeile> verlauf(UUID siteId, UUID deviceId, Instant seit, int hoechstens) {
        if (deviceId == null) {
            return jdbc.query("SELECT " + SPALTEN + " FROM geraetesuche WHERE site_id = ? AND ausgeloest_am > ? "
                    + "ORDER BY ausgeloest_am DESC LIMIT ?", this::zeile, siteId, Timestamp.from(seit), hoechstens);
        }
        return jdbc.query("SELECT " + SPALTEN + " FROM geraetesuche WHERE site_id = ? AND device_id = ? "
                + "AND ausgeloest_am > ? ORDER BY ausgeloest_am DESC LIMIT ?", this::zeile, siteId, deviceId,
                Timestamp.from(seit), hoechstens);
    }

    public void abbruchGesendet(UUID suchId, Instant am) {
        jdbc.update("UPDATE geraetesuche SET abbruch_gesendet_am = ? WHERE id = ?", Timestamp.from(am), suchId);
    }

    /**
     * Ein Zwischenstand: nur an einer offenen Suche DIESER Box und Anlage und nur, wenn er neuer ist als der gespeicherte
     * (QoS 1 darf doppelt und vertauscht zustellen). Die neuen Funde kommen dazu; false = verworfen.
     */
    public boolean standSchreiben(GeraetesucheBericht.Stand s, Instant am) {
        int n = jdbc.update("UPDATE geraetesuche SET zustand = 'laeuft', stand_nr = ?, schritt = ?, erledigt = ?, "
                + "gesamt = ?, rest_s = ?, netze = ?::jsonb, letzte_meldung_am = ? WHERE id = ? AND site_id = ? "
                + "AND device_id = ? AND zustand IN ('wartet', 'laeuft') AND (stand_nr IS NULL OR stand_nr < ?)",
                s.nr(), s.schritt(), s.erledigt(), s.gesamt(), s.restS(), netzeJson(s.netze()), Timestamp.from(am),
                s.suchId(), s.siteId(), s.deviceId(), s.nr());
        if (n != 1) {
            return false;
        }
        for (GeraetesucheBericht.Fund f : s.funde()) {
            fundSchreiben(s.tenantId(), s.siteId(), s.suchId(), f, am, false);
        }
        return true;
    }

    /**
     * Das Ergebnis: genau eines je Suche (nur eine offene Suche dieser Box und Anlage nimmt es an). Seine Funde ersetzen
     * die der Zwischenstände - verbindlich ist das Ergebnis. false = verworfen.
     */
    public boolean ergebnisSchreiben(GeraetesucheBericht.Ergebnis e, Instant am) {
        int n = jdbc.update(con -> {
            var ps = con.prepareStatement("UPDATE geraetesuche SET zustand = ?, grund = ?, dauer_ms = ?, "
                    + "erkenner = ?, netze = ?::jsonb, weitere_telefon_tablet = ?, weitere_rechner = ?, "
                    + "weitere_unbekannt = ?, rest_s = NULL, letzte_meldung_am = ?, beendet_am = ? WHERE id = ? "
                    + "AND site_id = ? AND device_id = ? AND zustand IN ('wartet', 'laeuft')");
            ps.setString(1, e.zustand());
            ps.setString(2, e.grund());
            ps.setInt(3, e.dauerMs());
            ps.setArray(4, con.createArrayOf("text", e.erkenner().toArray(String[]::new)));
            ps.setString(5, netzeJson(e.netze()));
            ps.setObject(6, e.weitere().telefonTablet());
            ps.setObject(7, e.weitere().rechner());
            ps.setObject(8, e.weitere().unbekannt());
            ps.setTimestamp(9, Timestamp.from(am));
            ps.setTimestamp(10, Timestamp.from(am));
            ps.setObject(11, e.suchId());
            ps.setObject(12, e.siteId());
            ps.setObject(13, e.deviceId());
            return ps;
        });
        if (n != 1) {
            return false;
        }
        jdbc.update("DELETE FROM geraetesuche_fund WHERE such_id = ?", e.suchId());
        for (GeraetesucheBericht.Fund f : e.funde()) {
            fundSchreiben(e.tenantId(), e.siteId(), e.suchId(), f, am, true);
        }
        return true;
    }

    // ------------------------------------------------------------------ Funde

    public List<GeraetesucheBericht.Fund> funde(UUID suchId) {
        return jdbc.query("SELECT " + FUND_SPALTEN + " FROM geraetesuche_fund WHERE such_id = ? "
                + "ORDER BY gemeldet_am, schluessel", (rs, n) -> new GeraetesucheBericht.Fund(
                        rs.getString("schluessel"), rs.getString("erkenner"), rs.getString("art"),
                        rs.getString("hersteller"), rs.getString("modell"), rs.getString("seriennummer"),
                        rs.getString("firmware"), rs.getString("familie"), rs.getString("spannung"),
                        (Integer) rs.getObject("kanaele"), rs.getString("erkennung"), texte(rs.getArray("merkmale")),
                        rs.getString("anbindung"), rs.getString("hindernis"),
                        new GeraetesucheBericht.Verbindung(rs.getString("communication"), rs.getString("ip"),
                                rs.getInt("port"), (Long) rs.getObject("serial"), (Integer) rs.getObject("unit_id")),
                        rs.getBoolean("liest_box_schon")), suchId);
    }

    private void fundSchreiben(UUID tenantId, UUID siteId, UUID suchId, GeraetesucheBericht.Fund f, Instant am,
            boolean ersetzen) {
        jdbc.update(con -> {
            var ps = con.prepareStatement("INSERT INTO geraetesuche_fund (such_id, tenant_id, site_id, " + FUND_SPALTEN
                    + ", gemeldet_am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    + (ersetzen ? "" : "ON CONFLICT (such_id, schluessel) DO NOTHING"));
            int i = 1;
            ps.setObject(i++, suchId);
            ps.setObject(i++, tenantId);
            ps.setObject(i++, siteId);
            ps.setString(i++, f.schluessel());
            ps.setString(i++, f.erkenner());
            ps.setString(i++, f.art());
            ps.setString(i++, f.hersteller());
            ps.setString(i++, f.modell());
            ps.setString(i++, f.seriennummer());
            ps.setString(i++, f.firmware());
            ps.setString(i++, f.familie());
            ps.setString(i++, f.spannung());
            ps.setObject(i++, f.kanaele());
            ps.setString(i++, f.erkennung());
            ps.setArray(i++, con.createArrayOf("text", f.merkmale().toArray(String[]::new)));
            ps.setString(i++, f.anbindung());
            ps.setString(i++, f.hindernis());
            ps.setString(i++, f.verbindung().communication());
            ps.setString(i++, f.verbindung().ip());
            ps.setInt(i++, f.verbindung().port());
            ps.setObject(i++, f.verbindung().serial());
            ps.setObject(i++, f.verbindung().unitId());
            ps.setBoolean(i++, f.liestBoxSchon());
            ps.setTimestamp(i, Timestamp.from(am));
            return ps;
        });
    }

    // ------------------------------------------------------------------ Komponenten für den Abgleich

    /**
     * Die Komponenten der Anlage mit ihrer gespeicherten Verbindung und der Seriennummer des Geräts, an dem sie heute
     * hängt ({@code geraet_komponente}, halboffen; ein ausgebautes Gerät zählt nicht).
     */
    public List<GeraetesucheAbgleich.Komponente> komponenten(UUID siteId) {
        return jdbc.query("""
                SELECT m.id, coalesce(nullif(btrim(m.label), ''), nullif(btrim(concat_ws(' ', m.brand, m.model)), ''),
                                      m.role) AS name,
                       m.connection_json::text AS verbindung,
                       (SELECT g.seriennummer FROM geraet_komponente gk
                          JOIN geraet g ON g.id = gk.geraet_id AND g.tenant_id = gk.tenant_id
                         WHERE gk.entity_id = m.id AND gk.tenant_id = m.tenant_id AND gk.gueltig_ab <= now()
                           AND (gk.gueltig_bis IS NULL OR gk.gueltig_bis > now()) AND g.ausgebaut_am IS NULL
                         ORDER BY gk.gueltig_ab DESC LIMIT 1) AS seriennummer
                  FROM measurement_point m
                 WHERE m.site_id = ?
                 ORDER BY m.created_at, m.id""",
                (rs, n) -> GeraetesucheAbgleich.komponente(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getString("verbindung"), rs.getString("seriennummer"), mapper), siteId);
    }

    // ------------------------------------------------------------------ Protokoll

    public void protokollPerson(UUID tenantId, UUID siteId, UUID deviceId, UUID suchId, String art,
            ProtokollAkteur wer, Instant am) {
        jdbc.update("INSERT INTO geraetesuche_protokoll (tenant_id, site_id, device_id, such_id, art, actor_sub, "
                + "actor_name, actor_rolle, actor_art, am) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", tenantId, siteId,
                deviceId, suchId, art, wer.sub(), wer.name(), wer.rolle(), wer.art(), Timestamp.from(am));
    }

    public void protokollBeendet(GeraetesucheBericht.Ergebnis e, Map<String, Integer> zaehler, Instant am) {
        try {
            jdbc.update("INSERT INTO geraetesuche_protokoll (tenant_id, site_id, device_id, such_id, art, zustand, "
                    + "grund, dauer_ms, netze, zaehler, am) VALUES (?, ?, ?, ?, 'beendet', ?, ?, ?, ?::jsonb, "
                    + "?::jsonb, ?)", e.tenantId(), e.siteId(), e.deviceId(), e.suchId(), e.zustand(), e.grund(),
                    e.dauerMs(), netzeJson(e.netze()), mapper.writeValueAsString(zaehler), Timestamp.from(am));
        } catch (com.fasterxml.jackson.core.JsonProcessingException ex) {
            throw new IllegalStateException(ex);
        }
    }

    // ------------------------------------------------------------------ Läufer

    /** DP-3 A: Suchen und ihre Funde nach 30 Tagen (Datenbank-Uhr); das Protokoll bleibt. */
    public int aufraeumen() {
        Integer n = jdbc.queryForObject("SELECT geraetesuche_aufraeumen(now() - interval '30 days')", Integer.class);
        return n == null ? 0 : n;
    }

    // ------------------------------------------------------------------ Lesen

    private Zeile zeile(ResultSet rs, int n) throws SQLException {
        Integer t = (Integer) rs.getObject("weitere_telefon_tablet");
        Integer r = (Integer) rs.getObject("weitere_rechner");
        Integer u = (Integer) rs.getObject("weitere_unbekannt");
        Array erkenner = rs.getArray("erkenner");
        return new Zeile(rs.getObject("id", UUID.class), rs.getObject("site_id", UUID.class),
                rs.getObject("device_id", UUID.class), instant(rs, "ausgeloest_am"), instant(rs, "gueltig_bis"),
                new ProtokollAkteur(rs.getString("actor_sub"), rs.getString("actor_name"), rs.getString("actor_rolle"),
                        rs.getString("actor_art")), rs.getString("zustand"), rs.getString("grund"),
                (Integer) rs.getObject("stand_nr"), rs.getString("schritt"), (Integer) rs.getObject("erledigt"),
                (Integer) rs.getObject("gesamt"), (Integer) rs.getObject("rest_s"), netze(rs.getString("netze")),
                instant(rs, "letzte_meldung_am"), instant(rs, "beendet_am"), (Integer) rs.getObject("dauer_ms"),
                erkenner == null ? null : texte(erkenner), new GeraetesucheBericht.Weitere(t, r, u),
                instant(rs, "abbruch_gesendet_am"));
    }

    private String netzeJson(List<GeraetesucheBericht.Netz> netze) {
        ArrayNode a = mapper.createArrayNode();
        for (GeraetesucheBericht.Netz n : netze) {
            ObjectNode o = a.addObject().put("rolle", n.rolle()).put("netz", n.netz()).put("box_adresse", n.boxAdresse());
            if (n.ausschnitt() == null) {
                o.putNull("ausschnitt");
            } else {
                o.put("ausschnitt", n.ausschnitt());
            }
            o.put("erreichbar", n.erreichbar()).put("aktiv", n.aktiv());
        }
        return a.toString();
    }

    private List<GeraetesucheBericht.Netz> netze(String json) {
        try {
            List<GeraetesucheBericht.Netz> out = new ArrayList<>();
            for (JsonNode n : mapper.readTree(json)) {
                JsonNode a = n.path("ausschnitt");
                out.add(new GeraetesucheBericht.Netz(n.path("rolle").asText(), n.path("netz").asText(),
                        n.path("box_adresse").asText(), a.isBoolean() ? a.asBoolean() : null,
                        n.path("erreichbar").asBoolean(), n.path("aktiv").asInt()));
            }
            return List.copyOf(out);
        } catch (Exception e) {
            throw new IllegalStateException("netze", e);
        }
    }

    private static List<String> texte(Array a) throws SQLException {
        return a == null ? List.of() : List.copyOf(Arrays.asList((String[]) a.getArray()));
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
