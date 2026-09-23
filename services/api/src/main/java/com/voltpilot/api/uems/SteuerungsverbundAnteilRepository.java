package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.uems.SteuerungsverbundVokabular.Grenzart;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Schritt;
import com.voltpilot.api.uems.SteuerungsverbundZweischritt.Tabelle;
import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Lese- und Schreibwege der Anteile einer Gemeinsamen Steuerung (UEMS AP-15 IP-7, Migration V20260921190000):
 * Vorbehalt am Verbund (wer/wann), Geräte je Box, veröffentlichte Anteils-Dokumente und die Marke „Rückspielen
 * erkannt“ (A18). Alles unter RLS des aktuellen Mandanten; der Mandant kommt vom Aufrufer (TenantContext).
 */
@Repository
public class SteuerungsverbundAnteilRepository {

    /** Der gespeicherte Vorbehalt je Richtung; eine fehlende Richtung ist unbekannt, keine Null. */
    public record Vorbehalt(Map<Grenzart, BigDecimal> kw, String von, Instant am) {}

    /** Ein Gerät (oder das Ungeregelte, {@code entityId} leer) hinter dem Abgang einer Box. */
    public record GeraetZeile(UUID id, UUID deviceId, UUID entityId, Grenzart richtung, BigDecimal nennKw,
            boolean schreibfreigabe, String hinweis, Instant createdAt, String createdBy) {}

    /** Ein veröffentlichtes Anteils-Dokument. {@code ziel} nur beim Übergang mit ausstehendem Zielstand. */
    public record DokumentZeile(UUID id, long epoche, long revision, Schritt schritt, Tabelle tabelle, Tabelle ziel,
            List<String> verengteBoxen, String anlass, Instant createdAt, String createdBy) {

        public SteuerungsverbundZweischritt.Stand stand() {
            return new SteuerungsverbundZweischritt.Stand(epoche, revision);
        }
    }

    private static final String DOKUMENT_SPALTEN = "id, epoche, revision, schritt, verteilbar_einspeisung_kw, "
            + "verteilbar_bezug_kw, anteile::text AS anteile, ziel::text AS ziel, verengte_boxen, anlass, created_at, "
            + "created_by";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public SteuerungsverbundAnteilRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    // ------------------------------------------------------------------ Vorbehalt und Rückspielen

    public Vorbehalt vorbehalt(UUID verbundId) {
        return jdbc.query("SELECT vorbehalt_einspeisung_kw, vorbehalt_bezug_kw, vorbehalt_von, vorbehalt_am "
                + "FROM steuerungsverbund WHERE id = ?", (rs, n) -> {
                    Map<Grenzart, BigDecimal> kw = new EnumMap<>(Grenzart.class);
                    if (rs.getBigDecimal("vorbehalt_einspeisung_kw") != null) {
                        kw.put(Grenzart.EINSPEISUNG, rs.getBigDecimal("vorbehalt_einspeisung_kw"));
                    }
                    if (rs.getBigDecimal("vorbehalt_bezug_kw") != null) {
                        kw.put(Grenzart.BEZUG, rs.getBigDecimal("vorbehalt_bezug_kw"));
                    }
                    return new Vorbehalt(kw, rs.getString("vorbehalt_von"), instant(rs, "vorbehalt_am"));
                }, verbundId).stream().findFirst().orElse(new Vorbehalt(Map.of(), null, null));
    }

    /** Setzt den Vorbehalt mit wer/wann (die Zeit setzt die Datenbank); false ohne Verbund. */
    public boolean vorbehaltSetzen(UUID verbundId, BigDecimal einspeisungKw, BigDecimal bezugKw, String wer) {
        return jdbc.update("UPDATE steuerungsverbund SET vorbehalt_einspeisung_kw = ?, vorbehalt_bezug_kw = ?, "
                + "vorbehalt_von = ?, vorbehalt_am = now(), updated_at = now() WHERE id = ?",
                einspeisungKw, bezugKw, wer, verbundId) > 0;
    }

    /** Wann ein Rückspielen erkannt wurde — leer, solange keines erkannt ist. */
    public Optional<Instant> rueckgespieltErkannt(UUID verbundId) {
        return jdbc.query("SELECT rueckgespielt_erkannt_am FROM steuerungsverbund WHERE id = ?",
                (rs, n) -> Optional.ofNullable(instant(rs, "rueckgespielt_erkannt_am")), verbundId)
                .stream().findFirst().orElse(Optional.empty());
    }

    /** Markiert das Rückspielen (nur das erste Mal); true, wenn die Marke neu gesetzt wurde. */
    public boolean rueckgespieltMarkieren(UUID verbundId, Instant am) {
        return jdbc.update("UPDATE steuerungsverbund SET rueckgespielt_erkannt_am = ? "
                + "WHERE id = ? AND rueckgespielt_erkannt_am IS NULL", Timestamp.from(am), verbundId) > 0;
    }

    /** Nur das Scharfschalten (neue Epoche) hebt die Marke auf. */
    public void rueckgespieltAufheben(UUID verbundId) {
        jdbc.update("UPDATE steuerungsverbund SET rueckgespielt_erkannt_am = NULL WHERE id = ?", verbundId);
    }

    // ------------------------------------------------------------------ Geräte

    public UUID geraetEintragen(UUID tenant, UUID verbundId, UUID deviceId, UUID entityId, Grenzart richtung,
            BigDecimal nennKw, boolean schreibfreigabe, String hinweis, String wer) {
        return jdbc.queryForObject("INSERT INTO steuerungsverbund_geraet (tenant_id, steuerungsverbund_id, site_id, "
                + "device_id, entity_id, richtung, nenn_kw, schreibfreigabe, hinweis, created_by) "
                + "SELECT ?::uuid, v.id, v.site_id, ?::uuid, ?::uuid, ?, ?, ?, ?, ? FROM steuerungsverbund v "
                + "WHERE v.id = ? RETURNING id", UUID.class, tenant, deviceId, entityId, richtung.code(), nennKw,
                schreibfreigabe, hinweis, wer, verbundId);
    }

    public boolean geraetAufheben(UUID geraetId) {
        return jdbc.update("UPDATE steuerungsverbund_geraet SET aufgehoben_am = now() "
                + "WHERE id = ? AND aufgehoben_am IS NULL", geraetId) > 0;
    }

    /** Die wirksamen Geräte-Angaben des Verbunds. */
    public List<GeraetZeile> geraete(UUID verbundId) {
        return jdbc.query("SELECT id, device_id, entity_id, richtung, nenn_kw, schreibfreigabe, hinweis, created_at, "
                + "created_by FROM steuerungsverbund_geraet WHERE steuerungsverbund_id = ? AND aufgehoben_am IS NULL "
                + "ORDER BY device_id, richtung, entity_id NULLS LAST, id", (rs, n) -> new GeraetZeile(
                        rs.getObject("id", UUID.class), rs.getObject("device_id", UUID.class),
                        rs.getObject("entity_id", UUID.class), richtung(rs.getString("richtung")),
                        rs.getBigDecimal("nenn_kw"), rs.getBoolean("schreibfreigabe"), rs.getString("hinweis"),
                        instant(rs, "created_at"), rs.getString("created_by")), verbundId);
    }

    /**
     * Die Komponenten der Anlage, die zur Reserve der anderen steuerbaren Verbraucher zählen (AP-15 Folge von IP-19,
     * {@link SteuerungsverbundAbleitung#zaehltZurReserve}): ihr Typ und, für eine Wallbox, ob sie in
     * {@code wallboxes[]} reist (ein Verbraucher-Profil hat, wie {@code ChargingConfigRepository#wallboxes}).
     */
    public List<String> komponentenZurReserve(UUID siteId) {
        List<String> out = new ArrayList<>();
        jdbc.query("SELECT mp.id, mp.entity_type, EXISTS (SELECT 1 FROM consumer_profile cp WHERE cp.entity_id = mp.id) "
                + "AS im_ladepark FROM measurement_point mp WHERE mp.site_id = ? ORDER BY mp.id", rs -> {
                    if (SteuerungsverbundAbleitung.zaehltZurReserve(rs.getString("entity_type"),
                            rs.getBoolean("im_ladepark"))) {
                        out.add(rs.getObject("id", UUID.class).toString());
                    }
                }, siteId);
        return out;
    }

    // ------------------------------------------------------------------ Dokumente

    /** Hängt ein Dokument an; ein zweites mit derselben Epoche und Revision scheitert (23505). */
    public UUID dokumentAnhaengen(UUID tenant, UUID verbundId, long epoche, long revision, Schritt schritt,
            Tabelle tabelle, Tabelle ziel, Collection<String> verengteBoxen, String anlass, String wer) {
        return jdbc.queryForObject("INSERT INTO steuerungsverbund_anteile (tenant_id, steuerungsverbund_id, site_id, "
                + "epoche, revision, schritt, verteilbar_einspeisung_kw, verteilbar_bezug_kw, anteile, ziel, "
                + "verengte_boxen, anlass, created_by) SELECT ?::uuid, v.id, v.site_id, ?, ?, ?, ?, ?, ?::jsonb, "
                + "?::jsonb, ?::uuid[], ?, ? FROM steuerungsverbund v WHERE v.id = ? RETURNING id", UUID.class,
                tenant, epoche, revision, schritt.code(), tabelle.verteilbar().get(Grenzart.EINSPEISUNG),
                tabelle.verteilbar().get(Grenzart.BEZUG), anteileJson(tabelle), ziel == null ? null : zielJson(ziel),
                verengteBoxen.toArray(String[]::new), anlass, wer, verbundId);
    }

    /** Alle Dokumente des Verbunds, das neueste zuerst. */
    public List<DokumentZeile> dokumente(UUID verbundId) {
        return jdbc.query("SELECT " + DOKUMENT_SPALTEN + " FROM steuerungsverbund_anteile "
                + "WHERE steuerungsverbund_id = ? ORDER BY epoche DESC, revision DESC", this::dokument, verbundId);
    }

    /** Die höchste je vergebene Revision des Verbunds (0 ohne Dokument). */
    public long hoechsteRevision(UUID verbundId) {
        Long r = jdbc.queryForObject("SELECT max(revision) FROM steuerungsverbund_anteile "
                + "WHERE steuerungsverbund_id = ?", Long.class, verbundId);
        return r == null ? 0 : r;
    }

    // ------------------------------------------------------------------ Anlage

    /** Die Werte der Anlage für die Grenzauflösung: {@code site.max_feed_in_kw}, Ladepark-Bezug (je null möglich). */
    public BigDecimal[] grenzwerteDerAnlage(UUID siteId) {
        return jdbc.query("SELECT s.max_feed_in_kw, c.grid_limit_kw FROM site s "
                + "LEFT JOIN site_charging_config c ON c.site_id = s.id WHERE s.id = ?",
                (rs, n) -> new BigDecimal[] {rs.getBigDecimal("max_feed_in_kw"), rs.getBigDecimal("grid_limit_kw")},
                siteId).stream().findFirst().orElse(new BigDecimal[] {null, null});
    }

    /**
     * Die Leistung der Speicher, die an der führenden Box {@code box} hängen (Übergangszuschlag, AP-15 Folge): je
     * Richtung die Summe über {@code asset} vom Typ {@code battery} — Einspeisung = {@code max_discharge_kw}, Bezug =
     * {@code max_charge_kw}. Ein Speicher ohne Box ({@code device_id} leer) zählt mit, die sichere Seite: ihn steuert
     * keine mitsteuernde Box. Ohne Speicher oder ohne Angabe 0.
     */
    public Map<Grenzart, BigDecimal> speicherLeistung(UUID siteId, UUID box) {
        Map<Grenzart, BigDecimal> out = new EnumMap<>(Grenzart.class);
        jdbc.query("SELECT COALESCE(sum(max_discharge_kw), 0) AS entladen, COALESCE(sum(max_charge_kw), 0) AS laden "
                + "FROM asset WHERE site_id = ? AND type = 'battery' AND (device_id = ? OR device_id IS NULL)", rs -> {
                    out.put(Grenzart.EINSPEISUNG, rs.getBigDecimal("entladen"));
                    out.put(Grenzart.BEZUG, rs.getBigDecimal("laden"));
                }, siteId, box);
        return out;
    }

    /** Die Speicher-Komponenten der Anlage ({@link SteuerungsverbundAbleitung#SPEICHER_TYPEN}) — für ihre Rückfallzeit. */
    public List<UUID> speicherKomponenten(UUID siteId) {
        List<Object> args = new ArrayList<>();
        args.add(siteId);
        SteuerungsverbundAbleitung.SPEICHER_TYPEN.stream().sorted().forEach(args::add);
        return jdbc.query("SELECT id FROM measurement_point WHERE site_id = ? AND entity_type IN ("
                + String.join(", ", java.util.Collections.nCopies(args.size() - 1, "?")) + ") ORDER BY id",
                (rs, n) -> rs.getObject("id", UUID.class), args.toArray());
    }

    // ------------------------------------------------------------------ JSON

    String anteileJson(Tabelle t) {
        return schreiben(anteileKnoten(t));
    }

    String zielJson(Tabelle t) {
        ObjectNode n = mapper.createObjectNode();
        n.set("anteile", anteileKnoten(t));
        ObjectNode v = n.putObject("verteilbar");
        t.verteilbar().forEach((r, kw) -> v.put(r.code(), kw));
        return schreiben(n);
    }

    private ObjectNode anteileKnoten(Tabelle t) {
        ObjectNode n = mapper.createObjectNode();
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            if (VerbundAnteileDokument.unbegrenzt(t, r)) {
                continue; // ausdrücklich unbegrenzt: der Schlüssel fehlt (Leser: Planer, anteileLesen)
            }
            ObjectNode je = n.putObject(r.code());
            new TreeMap<>(t.anteile().getOrDefault(r, Map.of())).forEach(je::put);
        }
        return n;
    }

    private Map<Grenzart, Map<String, BigDecimal>> anteileLesen(JsonNode n) {
        Map<Grenzart, Map<String, BigDecimal>> a = new EnumMap<>(Grenzart.class);
        for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
            if (!n.has(r.code())) {
                continue; // ausdrücklich unbegrenzt — nicht „keine Box“
            }
            Map<String, BigDecimal> je = new TreeMap<>();
            n.path(r.code()).fields().forEachRemaining(e -> je.put(e.getKey(), e.getValue().decimalValue()));
            a.put(r, je);
        }
        return a;
    }

    private DokumentZeile dokument(ResultSet rs, int n) throws SQLException {
        try {
            Map<Grenzart, BigDecimal> verteilbar = new EnumMap<>(Grenzart.class);
            if (rs.getBigDecimal("verteilbar_einspeisung_kw") != null) { // NULL = ausdrücklich unbegrenzt
                verteilbar.put(Grenzart.EINSPEISUNG, rs.getBigDecimal("verteilbar_einspeisung_kw"));
            }
            verteilbar.put(Grenzart.BEZUG, rs.getBigDecimal("verteilbar_bezug_kw"));
            Tabelle tabelle = new Tabelle(anteileLesen(mapper.readTree(rs.getString("anteile"))), verteilbar);
            Tabelle ziel = null;
            if (rs.getString("ziel") != null) {
                JsonNode z = mapper.readTree(rs.getString("ziel"));
                Map<Grenzart, BigDecimal> zv = new EnumMap<>(Grenzart.class);
                for (Grenzart r : SteuerungsverbundAnteile.RICHTUNGEN) {
                    if (z.path("verteilbar").has(r.code())) { // fehlt = ausdrücklich unbegrenzt, nie 0
                        zv.put(r, z.path("verteilbar").path(r.code()).decimalValue());
                    }
                }
                ziel = new Tabelle(anteileLesen(z.path("anteile")), zv);
            }
            List<String> verengt = new ArrayList<>();
            Array arr = rs.getArray("verengte_boxen");
            if (arr != null) {
                for (Object o : (Object[]) arr.getArray()) {
                    verengt.add(o.toString());
                }
            }
            return new DokumentZeile(rs.getObject("id", UUID.class), rs.getLong("epoche"), rs.getLong("revision"),
                    Schritt.aus(rs.getString("schritt")), tabelle, ziel, List.copyOf(verengt), rs.getString("anlass"),
                    instant(rs, "created_at"), rs.getString("created_by"));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Anteils-Dokument unlesbar", e);
        }
    }

    private String schreiben(JsonNode n) {
        try {
            return mapper.writeValueAsString(n);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Grenzart richtung(String code) {
        for (Grenzart g : Grenzart.values()) {
            if (g.code().equals(code)) {
                return g;
            }
        }
        throw new IllegalStateException("unbekannte Richtung " + code);
    }

    private static Instant instant(ResultSet rs, String spalte) throws SQLException {
        Timestamp t = rs.getTimestamp(spalte);
        return t == null ? null : t.toInstant();
    }
}
