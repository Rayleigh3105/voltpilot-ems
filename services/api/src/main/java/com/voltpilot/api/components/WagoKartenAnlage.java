package com.voltpilot.api.components;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.templates.WagoComponentTemplateSeeder;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.SaveComponentRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die Energiekarten einer WAGO-Steuerung als TEILE EINES Controllers (AP-00 E12, AP-05 E4) —
 * Befund aus PR 1139/1140: der Anlege-Trigger ({@code uems_geraet_anlegen}) legte je
 * Karten-Komponente ein eigenes Gerät an, aber keine {@code geraet_teil}-Karte mit Steckplatz.
 * Ohne Karte gibt es weder ein Registerbild für die Box ({@code WagoRegisterbilder}) noch eine
 * Soll-Lesung ({@link WagoSollLesung}), und die Kartenangaben lehnen mit 409 ab.
 *
 * <p>Zwei Wege, eine Regel:
 * <ul>
 *   <li>{@link #anlegen}: der Assistent legt die Karten-Komponenten und ihren Controller in
 *       EINER Transaktion an. Der Trigger läuft zur Commit-Zeit und legt für eine Komponente mit
 *       Speisung nichts an — es entsteht kein Wegwerf-Gerät.</li>
 *   <li>{@link #nachtragen}: Bestand. Eine WAGO-Komponente, die der Trigger ohne Karte angelegt
 *       hat, bekommt ihre Karte ab der nächsten vollen Minute; die abgeleitete Speisung endet dort,
 *       nichts wird gelöscht oder umgeschrieben.</li>
 * </ul>
 *
 * <p>Welche Karten in EINER Steuerung stecken, sagt der Aufrufer ausdrücklich (der Assistent hat
 * genau diesen einen Kopf gelesen). Dieselbe Verbindung beweist keine Gerätegleichheit — sie ist
 * hier nur die Gegenprobe: Karten mit verschiedener Verbindung können nicht ein Registerbild sein.
 * Der Kartentyp kommt aus der Kartenlesung; ungelesen bleibt er leer, nie geraten.
 *
 * <p><b>Gerät und Weg</b> (Konzept „Ein Gerät, ein Eintrag“, GE-6): der Assistent nennt den Anschluss
 * ({@code data_source}), den er für genau diese Steuerung angelegt hat; der Controller verweist darauf
 * ({@code geraet.data_source_id}) und heißt wie er. Die Adresse ist auch hier nur die Gegenprobe. Für den Bestand holt
 * {@link #quellenNachholen} den Verweis nach — allein über die {@code data_source_id}, die die Komponenten
 * der Karten schon tragen, nie über eine gleiche Adresse.
 */
@Service
public class WagoKartenAnlage {
    /** Die Verbindung des Registerbilds — ohne {@code slot}, der je Karte verschieden ist. */
    private static final List<String> VERBINDUNG =
            List.of("ip", "port", "mb_slave_id", "base_address", "function_code", "word_order");
    private static final Set<Integer> KARTENTYPEN = Set.of(493, 494, 495);
    private static final ObjectMapper JSON = new ObjectMapper();

    /** Eine Karte, die der Assistent gelesen hat, samt der Komponente, die sie speist. */
    public record NeueKarte(@NotNull @Min(1) @Max(65535) Integer steckplatz,
            Integer kartentyp, @NotNull @Valid SaveComponentRequest komponente) {}
    /** {@code dataSourceId}: der Anschluss der Steuerung (GE-6); ohne bleibt der Controller unverknüpft. */
    public record Anlegen(@NotEmpty @Size(max = 64) List<@NotNull @Valid NeueKarte> karten, UUID dataSourceId) {}
    /** Eine bestehende WAGO-Komponente und die Karte, die sie speist. */
    public record Zuordnung(@NotNull UUID entityId, @NotNull @Min(1) @Max(65535) Integer steckplatz,
            Integer kartentyp) {}
    public record Nachtragen(@NotEmpty @Size(max = 64) List<@NotNull @Valid Zuordnung> karten) {}
    /** {@code index}: Karte n im Registerbild = n-te nach Steckplatz ({@code karte[n]}). */
    public record KarteErgebnis(UUID entityId, UUID teilId, int steckplatz, String typ, int index) {}
    public record Ergebnis(UUID geraetId, String kennzeichen, Instant eingebautAm,
            List<KarteErgebnis> karten) {}

    private final JdbcTemplate jdbc;
    private final ComponentService components;

    public WagoKartenAnlage(JdbcTemplate jdbc, ComponentService components) {
        this.jdbc = jdbc;
        this.components = components;
    }

    /** Karten-Komponenten und Controller in einer Transaktion — der Weg des Assistenten. */
    @Transactional
    public Ergebnis anlegen(UUID siteId, Anlegen in, String subject) {
        sichtbar(siteId);
        List<Integer> steckplaetze = in.karten().stream().map(NeueKarte::steckplatz).toList();
        pruefeSteckplaetze(steckplaetze);
        List<Map<String, Object>> verbindungen = new ArrayList<>();
        for (NeueKarte k : in.karten()) {
            if (!WagoComponentTemplateSeeder.REF.equals(k.komponente().templateRef())) {
                throw bad("Eine Energiekarte wird mit der WAGO-Vorlage angelegt.");
            }
            typ(k.kartentyp());
            Map<String, Object> v = k.komponente().connection() == null ? Map.of() : k.komponente().connection();
            pruefeSlot(v.get("slot"), k.steckplatz());
            verbindungen.add(v);
        }
        Integer unitId = gemeinsameVerbindung(verbindungen);
        Anschluss quelle = in.dataSourceId() == null ? null
                : anschluss(siteId, in.dataSourceId(), verbindungen.getFirst(), unitId);
        Instant ab = Instant.now().truncatedTo(ChronoUnit.MINUTES);
        List<UUID> entities = new ArrayList<>();
        for (NeueKarte k : in.karten()) {
            Set<UUID> vorher = komponenten(siteId);
            components.create(siteId, k.komponente(), subject);
            Set<UUID> neu = komponenten(siteId);
            neu.removeAll(vorher);
            if (neu.size() != 1) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Die Energiekarte an Steckplatz "
                        + k.steckplatz() + " wurde nicht als eigene Komponente angelegt.");
            }
            entities.add(neu.iterator().next());
        }
        List<Integer> typen = in.karten().stream().map(NeueKarte::kartentyp).toList();
        return controller(siteId, entities, steckplaetze, typen, unitId, quelle, ab, subject);
    }

    /**
     * Bestand: bestehende WAGO-Komponenten ohne Karte bekommen EINEN Controller mit ihren Karten, ab
     * der nächsten vollen Minute. Die abgeleitete Speisung endet dort; ihr Gerät wird ausgebaut, wenn
     * es danach nichts mehr speist. Eine Komponente mit Karte bleibt unberührt (409) — ein Tausch ist
     * ein Kartenwechsel.
     */
    @Transactional
    public Ergebnis nachtragen(UUID siteId, Nachtragen in, String subject) {
        sichtbar(siteId);
        List<Integer> steckplaetze = in.karten().stream().map(Zuordnung::steckplatz).toList();
        pruefeSteckplaetze(steckplaetze);
        List<UUID> entities = in.karten().stream().map(Zuordnung::entityId).toList();
        if (new HashSet<>(entities).size() != entities.size()) {
            throw bad("Jede Komponente steckt in genau einer Karte.");
        }
        List<Map<String, Object>> verbindungen = new ArrayList<>();
        Map<UUID, UUID> bisher = new LinkedHashMap<>();
        for (Zuordnung z : in.karten()) {
            typ(z.kartentyp());
            List<String> zeile = jdbc.query("SELECT m.connection_json::text FROM measurement_point m "
                    + "JOIN site s ON s.id=m.site_id WHERE m.id=? AND m.site_id=? AND lower(m.brand)='wago' "
                    + "FOR UPDATE OF m", (rs, n) -> rs.getString(1), z.entityId(), siteId);
            if (zeile.isEmpty()) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "WAGO-Komponente nicht gefunden.");
            }
            Map<String, Object> v = verbindung(zeile.getFirst());
            pruefeSlot(v.get("slot"), z.steckplatz());
            verbindungen.add(v);
            List<Map<String, Object>> speisung = jdbc.queryForList("SELECT v.geraet_id, v.teil_id "
                    + "FROM geraet_komponente v WHERE v.entity_id=? AND v.gueltig_bis IS NULL FOR UPDATE",
                    z.entityId());
            if (speisung.stream().anyMatch(s -> s.get("teil_id") != null)) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Diese Komponente steckt schon in "
                        + "einer Energiekarte. Ein Tausch ist ein Kartenwechsel.");
            }
            if (!speisung.isEmpty()) bisher.put(z.entityId(), (UUID) speisung.getFirst().get("geraet_id"));
        }
        Integer unitId = gemeinsameVerbindung(verbindungen);
        // Ab der NÄCHSTEN Minute: die abgeleitete Speisung beginnt spätestens in dieser, und ein
        // Zeitraum endet nie vor oder an seinem Beginn (geraet_komponente_nicht_leer).
        Instant ab = Instant.now().truncatedTo(ChronoUnit.MINUTES).plus(1, ChronoUnit.MINUTES);
        for (Map.Entry<UUID, UUID> e : bisher.entrySet()) {
            jdbc.update("UPDATE geraet_komponente SET gueltig_bis=? WHERE geraet_id=? AND entity_id=? "
                    + "AND gueltig_bis IS NULL", Timestamp.from(ab), e.getValue(), e.getKey());
        }
        for (UUID alt : new LinkedHashSet<>(bisher.values())) {
            // Nur ein Gerät, das danach nichts mehr speist und keine Karte trägt, ist ausgebaut.
            jdbc.update("UPDATE geraet g SET ausgebaut_am=? WHERE g.id=? AND g.ausgebaut_am IS NULL "
                    + "AND NOT EXISTS (SELECT 1 FROM geraet_komponente v WHERE v.geraet_id=g.id "
                    + "AND (v.gueltig_bis IS NULL OR v.gueltig_bis>?)) "
                    + "AND NOT EXISTS (SELECT 1 FROM geraet_teil t WHERE t.geraet_id=g.id)",
                    Timestamp.from(ab), alt, Timestamp.from(ab));
        }
        List<Integer> typen = in.karten().stream().map(Zuordnung::kartentyp).toList();
        Ergebnis e = controller(siteId, entities, steckplaetze, typen, unitId, null, ab, subject);
        nachholen("g.id = ?", e.geraetId());
        return e;
    }

    /**
     * Bestand (GE-6): ein WAGO-Controller ohne Anschluss bekommt den Anschluss, den die Komponenten
     * seiner Karten schon tragen ({@code measurement_point.data_source_id}) — nur wenn sie genau EINEN
     * nennen, er an derselben Anlage liegt und nicht archiviert ist. Nennen sie keinen oder zwei
     * verschiedene, bleibt der Controller unverknüpft; eine gleiche Adresse zählt nie. Idempotent: ein
     * Controller mit Anschluss bleibt, wie er ist. Läuft unter RLS je Kundenbereich.
     *
     * @return wie viele Controller jetzt verknüpft wurden
     */
    @Transactional
    public int quellenNachholen() {
        return nachholen("TRUE");
    }

    private int nachholen(String auswahl, Object... argumente) {
        return jdbc.update("UPDATE geraet g SET data_source_id = q.quelle "
                + "FROM (SELECT v.geraet_id, (array_agg(DISTINCT m.data_source_id) "
                + "FILTER (WHERE m.data_source_id IS NOT NULL))[1] AS quelle "
                + "FROM geraet_komponente v JOIN geraet_teil t ON t.id = v.teil_id AND t.teilart = 'energiekarte' "
                + "JOIN measurement_point m ON m.id = v.entity_id "
                + "WHERE v.gueltig_bis IS NULL OR v.gueltig_bis > now() "
                + "GROUP BY v.geraet_id HAVING count(DISTINCT m.data_source_id) = 1) q "
                + "JOIN data_source d ON d.id = q.quelle "
                + "WHERE g.id = q.geraet_id AND g.data_source_id IS NULL AND g.ausgebaut_am IS NULL "
                + "AND g.geraeteart = 'controller' AND d.site_id = g.site_id AND d.archiviert_am IS NULL "
                + "AND " + auswahl, argumente);
    }

    /**
     * Der Anschluss, den der Assistent nennt: an dieser Anlage (sonst 404), nicht archiviert (409) und
     * — als Gegenprobe, nie als Identität — derselbe Weg wie die Karten: Modbus TCP an ihrer Adresse mit
     * ihrer Geräte-ID (400).
     */
    private Anschluss anschluss(UUID siteId, UUID id, Map<String, Object> verbindung, Integer unitId) {
        record Weg(String kennzeichen, String name, String protokoll, String adresse, List<Integer> geraeteIds,
                boolean archiviert) {}
        List<Weg> weg = jdbc.query("SELECT kennzeichen, name, protokoll, adresse, geraete_ids, "
                + "archiviert_am IS NOT NULL AS archiviert FROM data_source WHERE id=? AND site_id=?", (rs, n) -> new Weg(
                        rs.getString("kennzeichen"), rs.getString("name"), rs.getString("protokoll"),
                        rs.getString("adresse"), List.of((Integer[]) rs.getArray("geraete_ids").getArray()),
                        rs.getBoolean("archiviert")), id, siteId);
        if (weg.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anschluss an dieser Anlage nicht gefunden.");
        }
        Weg w = weg.getFirst();
        if (w.archiviert()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Der Anschluss " + w.kennzeichen()
                    + " ist archiviert.");
        }
        String adresse = verbindung.get("ip") + ":" + verbindung.get("port");
        if (!"modbus_tcp".equals(w.protokoll()) || !adresse.equals(w.adresse())
                || unitId == null || !w.geraeteIds().contains(unitId)) {
            throw bad("Die Karten antworten nicht über den Anschluss " + w.kennzeichen() + " (" + w.adresse()
                    + ", Geräte-ID " + w.geraeteIds() + ").");
        }
        return new Anschluss(id, w.name() == null || w.name().isBlank() ? null : w.name().trim());
    }

    /** Der Anschluss der Steuerung: der Controller verweist darauf und trägt seinen Namen (der Weg heißt wie das Gerät). */
    private record Anschluss(UUID id, String name) {}

    private Ergebnis controller(UUID siteId, List<UUID> entities, List<Integer> steckplaetze,
            List<Integer> typen, Integer unitId, Anschluss quelle, Instant ab, String subject) {
        UUID tenant = TenantContext.get();
        Timestamp am = Timestamp.from(ab);
        Map<String, Object> geraet = jdbc.queryForMap("INSERT INTO geraet (tenant_id, site_id, kennzeichen, "
                + "einbau_kennzeichen, geraeteart, hersteller, bezeichnung, data_source_id, geraete_id, eingebaut_am, "
                + "aus_bestand, created_by) SELECT ?, ?, n.k, n.k, 'controller', 'WAGO', ?, ?, ?, ?, false, ? "
                + "FROM (SELECT uems_geraet_kennzeichen(?) AS k) n RETURNING id, kennzeichen",
                tenant, siteId, quelle == null ? null : quelle.name(), quelle == null ? null : quelle.id(), unitId, am,
                subject, tenant);
        UUID geraetId = (UUID) geraet.get("id");
        List<Integer> reihenfolge = steckplaetze.stream().sorted(Comparator.naturalOrder()).toList();
        List<KarteErgebnis> karten = new ArrayList<>();
        for (int i = 0; i < entities.size(); i++) {
            String typ = typen.get(i) == null ? null : "750-" + typen.get(i);
            UUID teil = jdbc.queryForObject("INSERT INTO geraet_teil (tenant_id, geraet_id, steckplatz, typ, "
                    + "eingebaut_am, created_by) VALUES (?,?,?,?,?,?) RETURNING id", UUID.class,
                    tenant, geraetId, steckplaetze.get(i), typ, am, subject);
            jdbc.update("INSERT INTO geraet_komponente (tenant_id, geraet_id, entity_id, teil_id, gueltig_ab, "
                    + "created_by) VALUES (?,?,?,?,?,?)", tenant, geraetId, entities.get(i), teil, am, subject);
            karten.add(new KarteErgebnis(entities.get(i), teil, steckplaetze.get(i), typ,
                    reihenfolge.indexOf(steckplaetze.get(i)) + 1));
        }
        karten.sort(Comparator.comparingInt(KarteErgebnis::steckplatz));
        return new Ergebnis(geraetId, (String) geraet.get("kennzeichen"), ab, karten);
    }

    /** Sichtbarkeit vor fachlichen Fehlern: eine fremde oder umzäunte Anlage ist 404, nie 400. */
    private void sichtbar(UUID siteId) {
        if (jdbc.queryForList("SELECT s.id FROM site s WHERE s.id=?", UUID.class, siteId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Anlage nicht gefunden.");
        }
    }

    private static void pruefeSteckplaetze(List<Integer> steckplaetze) {
        if (new HashSet<>(steckplaetze).size() != steckplaetze.size()) {
            throw bad("Jeder Steckplatz trägt höchstens eine Energiekarte.");
        }
    }

    private static void typ(Integer kartentyp) {
        if (kartentyp != null && !KARTENTYPEN.contains(kartentyp)) {
            throw bad("Unbekannter Kartentyp 750-" + kartentyp + ".");
        }
    }

    /** Ein {@code slot} der Verbindung, wenn es ihn gibt, ist derselbe Steckplatz wie die Karte. */
    private static void pruefeSlot(Object slot, int steckplatz) {
        if (slot != null && !String.valueOf(steckplatz).equals(String.valueOf(slot))) {
            throw bad("Steckplatz " + steckplatz + " widerspricht dem Steckplatz der Verbindung (" + slot + ").");
        }
    }

    /** Alle Karten eines Registerbilds antworten über dieselbe Verbindung — die Geräte-ID dahinter. */
    private static Integer gemeinsameVerbindung(List<Map<String, Object>> verbindungen) {
        Set<List<String>> anders = new LinkedHashSet<>();
        for (Map<String, Object> v : verbindungen) {
            anders.add(VERBINDUNG.stream().map(k -> v.get(k) == null ? null : String.valueOf(v.get(k))).toList());
        }
        if (anders.size() != 1 || anders.iterator().next().contains(null)) {
            throw bad("Die Karten einer Steuerung brauchen dieselbe vollständige Verbindung "
                    + "(Adresse, Port, Geräte-ID, Basisadresse, Funktionscode, Wortfolge).");
        }
        String unit = anders.iterator().next().get(2);
        return unit.matches("\\d{1,5}") ? Integer.valueOf(unit) : null;
    }

    private Set<UUID> komponenten(UUID siteId) {
        return new HashSet<>(jdbc.queryForList("SELECT m.id FROM measurement_point m WHERE m.site_id=?",
                UUID.class, siteId));
    }

    private static Map<String, Object> verbindung(String json) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (json == null) return out;
        try {
            JsonNode n = JSON.readTree(json);
            n.fields().forEachRemaining(e -> out.put(e.getKey(),
                    e.getValue().isValueNode() ? e.getValue().asText() : e.getValue().toString()));
        } catch (Exception e) {
            return out;
        }
        return out;
    }

    private static ResponseStatusException bad(String grund) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, grund);
    }
}
