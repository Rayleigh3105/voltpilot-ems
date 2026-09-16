package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MeasurementBudget;
import com.voltpilot.api.measurement.MeasurementBudget.SourceCandidate;
import com.voltpilot.api.measurement.MeasurementBudget.SourceRequest;
import com.voltpilot.api.measurement.MeasurementCatalog;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Liest die heutige Last je Datenquelle und Box und lässt {@link DatenquelleBudget} vor einer
 * Zuständigkeitsänderung urteilen. Die Kostentabelle bleibt bis AP-07 IP-4 ausschließlich die
 * heutige Java-Tabelle in {@link MeasurementBudget}; dieser Cloud-Baustein löst kein Edge-Release aus.
 */
@Service
public class DatenquelleBudgetService {

    private static final ZoneId BERLIN = ZoneId.of("Europe/Berlin");

    private final JdbcTemplate jdbc;
    private final MeasurementCatalog catalog;

    public DatenquelleBudgetService(JdbcTemplate jdbc, MeasurementCatalog catalog) {
        this.jdbc = jdbc;
        this.catalog = catalog;
    }

    /** {@code null} = im Rahmen oder noch keine vorrechenbaren Kanäle; sonst die 422-Fakten. */
    public DatenquelleBudget.Ablehnung pruefe(UUID quelleId, UUID zielBox, Instant zeitpunkt) {
        Map<UUID, Quelle> quellen = quellen(zeitpunkt);
        Quelle kandidat = quellen.get(quelleId);
        SourceCandidate kandidatLast = kandidat == null ? null : kandidat.last();
        if (kandidatLast == null) return null;

        Map<UUID, UUID> boxJeQuelle = new LinkedHashMap<>();
        jdbc.query("SELECT data_source_id, device_id FROM data_source_assignment "
                        + "WHERE zurueckgenommen_am IS NULL AND effective_from <= ? "
                        + "AND (effective_to IS NULL OR effective_to > ?)",
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> boxJeQuelle.put(
                        rs.getObject("data_source_id", UUID.class),
                        rs.getObject("device_id", UUID.class)),
                Timestamp.from(zeitpunkt), Timestamp.from(zeitpunkt));

        Map<UUID, List<SourceCandidate>> lastJeBox = new LinkedHashMap<>();
        Set<UUID> nichtVorrechenbar = new LinkedHashSet<>();
        boxJeQuelle.forEach((qid, box) -> {
            if (qid.equals(quelleId)) return; // Wechsel: dieselbe Quelle zählt nur am Ziel.
            Quelle q = quellen.get(qid);
            SourceCandidate last = q == null ? null : q.last();
            if (last == null) nichtVorrechenbar.add(box);
            else lastJeBox.computeIfAbsent(box, k -> new ArrayList<>()).add(last);
        });

        // Unbekannt ist keine Null: ohne Takt/Kanäle einer bestehenden Quelle wird weder eine
        // scheinbar freie Ziel-Box noch eine scheinbar passende Ausweich-Box behauptet.
        if (nichtVorrechenbar.contains(zielBox)) return null;

        List<Box> amStandort = boxenAmStandort(kandidat.siteId, zeitpunkt);
        amStandort.removeIf(b -> nichtVorrechenbar.contains(b.id));
        if (amStandort.stream().noneMatch(b -> b.id.equals(zielBox))) {
            box(zielBox).ifPresent(amStandort::add);
        }
        List<DatenquelleBudget.BoxStand> staende = amStandort.stream()
                .map(b -> new DatenquelleBudget.BoxStand(b.id, b.name,
                        List.copyOf(lastJeBox.getOrDefault(b.id, List.of()))))
                .toList();
        return DatenquelleBudget.pruefe(kandidat.kennzeichen, kandidatLast, zielBox, staende);
    }

    private Map<UUID, Quelle> quellen(Instant zeitpunkt) {
        Map<UUID, Quelle> out = new LinkedHashMap<>();
        jdbc.query("""
                SELECT q.id, q.site_id, q.kennzeichen, q.protokoll, q.kadenz_s,
                       s.entity_id, s.point_key, s.custom_definition IS NOT NULL AS frei,
                       g.id AS geraet_id, CASE WHEN g.id IS NULL THEN NULL ELSE v.teil_id END AS teil_id
                  FROM data_source q
                  LEFT JOIN measurement_point p ON p.data_source_id = q.id
                  LEFT JOIN device_measurement_selection s ON s.entity_id = p.id AND s.enabled
                  LEFT JOIN geraet_komponente v ON v.entity_id = p.id AND v.gueltig_ab <= ?
                       AND (v.gueltig_bis IS NULL OR v.gueltig_bis > ?)
                  LEFT JOIN geraet g ON g.id = v.geraet_id AND g.data_source_id = q.id
                 WHERE q.archiviert_am IS NULL
                 ORDER BY q.id, s.entity_id, s.point_key
                """, (org.springframework.jdbc.core.RowCallbackHandler) rs -> {
            UUID id = rs.getObject("id", UUID.class);
            UUID site = rs.getObject("site_id", UUID.class);
            String kennzeichen = rs.getString("kennzeichen");
            String protokoll = rs.getString("protokoll");
            Integer cadence = (Integer) rs.getObject("kadenz_s");
            Quelle q = out.computeIfAbsent(id,
                    k -> new Quelle(id, site, kennzeichen, protokoll, cadence));
            UUID entity = rs.getObject("entity_id", UUID.class);
            String point = rs.getString("point_key");
            UUID geraet = rs.getObject("geraet_id", UUID.class);
            UUID teil = rs.getObject("teil_id", UUID.class);
            if (entity != null && point != null) q.add(entity, geraet, teil, point, rs.getBoolean("frei"));
        }, Timestamp.from(zeitpunkt), Timestamp.from(zeitpunkt));
        return out;
    }

    private List<Box> boxenAmStandort(UUID siteId, Instant zeitpunkt) {
        LocalDate tag = zeitpunkt.atZone(BERLIN).toLocalDate();
        List<UUID> standorte = jdbc.query("SELECT standort_id FROM anlage_standort WHERE site_id = ? "
                        + "AND gueltig_ab <= ? AND (gueltig_bis IS NULL OR gueltig_bis >= ?) "
                        + "AND aufgehoben_am IS NULL ORDER BY gueltig_ab DESC LIMIT 1",
                (rs, n) -> rs.getObject(1, UUID.class), siteId, tag, tag);
        if (standorte.isEmpty()) {
            return jdbc.query("SELECT id, name, external_ref FROM device WHERE site_id = ? "
                            + "AND status = 'claimed' ORDER BY name, external_ref, id",
                    (rs, n) -> box(rsUuid(rs, "id"), rsString(rs, "name"), rsString(rs, "external_ref")),
                    siteId);
        }
        return jdbc.query("""
                SELECT d.id, d.name, d.external_ref
                  FROM device d
                  JOIN anlage_standort a ON a.site_id = d.site_id
                 WHERE a.standort_id = ? AND a.gueltig_ab <= ?
                   AND (a.gueltig_bis IS NULL OR a.gueltig_bis >= ?)
                   AND a.aufgehoben_am IS NULL AND d.status = 'claimed'
                 ORDER BY d.name, d.external_ref, d.id
                """, (rs, n) -> box(rsUuid(rs, "id"), rsString(rs, "name"), rsString(rs, "external_ref")),
                standorte.get(0), tag, tag);
    }

    private java.util.Optional<Box> box(UUID id) {
        return jdbc.query("SELECT id, name, external_ref FROM device WHERE id = ? AND status = 'claimed'",
                (rs, n) -> box(rsUuid(rs, "id"), rsString(rs, "name"), rsString(rs, "external_ref")), id)
                .stream().findFirst();
    }

    private static Box box(UUID id, String name, String externalRef) {
        String sichtbar = name != null && !name.isBlank() ? name.strip()
                : externalRef != null && !externalRef.isBlank() ? externalRef.strip() : id.toString();
        return new Box(id, sichtbar);
    }

    private record Box(UUID id, String name) {}

    private final class Quelle {
        final UUID id;
        final UUID siteId;
        final String kennzeichen;
        final String protokoll;
        final Integer cadence;
        final Set<String> channels = new LinkedHashSet<>();
        final Map<String, Anfrage> requests = new LinkedHashMap<>();

        Quelle(UUID id, UUID siteId, String kennzeichen, String protokoll, Integer cadence) {
            this.id = id;
            this.siteId = siteId;
            this.kennzeichen = kennzeichen;
            this.protokoll = protokoll;
            this.cadence = cadence;
        }

        void add(UUID entity, UUID geraet, UUID teil, String point, boolean frei) {
            String kanal = entity + ":" + point;
            if (!channels.add(kanal) || "ocpp".equals(protokoll)) return;
            if (frei) {
                requests.put("frei:" + kanal, new Anfrage(
                        MeasurementBudget.customRegisterRequestCostMs(), false, Set.of(entity)));
                return;
            }
            MeasurementCatalog.Point p = catalog.resolve(point);
            UUID physisch = geraet == null ? entity : geraet;
            String gruppe = p == null || p.pollGroup() == null || p.pollGroup().isBlank()
                    ? kanal : physisch + ":" + p.pollGroup();
            boolean wago = p != null && "wago_registerbild".equals(p.sourceKind());
            UUID blockTeil = teil == null ? entity : teil;
            requests.compute(gruppe, (k, alt) -> alt == null
                    ? new Anfrage(MeasurementBudget.requestCostMsForProtocol(protokoll), wago,
                            new LinkedHashSet<>(Set.of(blockTeil)))
                    : alt.mit(blockTeil));
        }

        SourceCandidate last() {
            if (cadence == null || channels.isEmpty()) return null;
            Map<Integer, Integer> jeKosten = new LinkedHashMap<>();
            requests.values().forEach(a -> jeKosten.merge(a.cost,
                    a.wago ? wagoBloecke(a.teile.size()) : 1, Integer::sum));
            List<SourceRequest> batches = jeKosten.entrySet().stream()
                    .map(e -> new SourceRequest(e.getValue(), e.getKey())).toList();
            return new SourceCandidate(id.toString(), protokoll, channels.size(), cadence, batches);
        }
    }

    /** WAGO v1 liest höchstens fünf Energiekarten (≈ 500 Wörter) in einem Block. */
    static int wagoBloecke(int karten) {
        return karten <= 0 ? 0 : (karten + 4) / 5;
    }

    private record Anfrage(int cost, boolean wago, Set<UUID> teile) {
        Anfrage mit(UUID teil) {
            Set<UUID> zusammen = new LinkedHashSet<>(teile);
            zusammen.add(teil);
            return new Anfrage(cost, wago, zusammen);
        }
    }

    private static UUID rsUuid(java.sql.ResultSet rs, String name) {
        try { return rs.getObject(name, UUID.class); }
        catch (java.sql.SQLException e) { throw new IllegalStateException(e); }
    }

    private static String rsString(java.sql.ResultSet rs, String name) {
        try { return rs.getString(name); }
        catch (java.sql.SQLException e) { throw new IllegalStateException(e); }
    }
}
