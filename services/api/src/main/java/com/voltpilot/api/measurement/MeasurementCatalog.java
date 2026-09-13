package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

/**
 * Read-only API consumer of the canonical generated catalog. Maven packages the
 * root {@code catalog/measurement-points/dist} artifact byte-for-byte into the
 * jar; this class never carries a second point list.
 *
 * <p>⚠ The artifact carries TWO versions (catalog README „Inhaltsstand und
 * Laufzeitstand“). {@link #version()} is the RUNTIME version the box speaks — it
 * travels in every measurement config, and the edge palette refuses a config whose
 * {@code catalog_version} differs from its own catalog. {@link #inhaltsstand()} is
 * the content version of the packaged file (e.g. {@code quantity}/{@code direction},
 * which the box never reads).
 */
@Component
public class MeasurementCatalog {

    public static final String CUSTOM_ACTION_LABEL = "Eigenen Messwert hinzufügen";
    public static final Set<String> SEMANTIC_STATUSES =
            Set.of("known", "vendor_label_only", "unknown");
    private static final Pattern MODULE_INDEX = Pattern.compile("\\[([0-9]{1,3})]", Pattern.CASE_INSENSITIVE);

    public record RetentionView(String retentionClass, int rawRetentionDays,
            Integer longTermCadenceS, String longTermStrategy) {
        static RetentionView of(MeasurementRetention r) {
            return new RetentionView(r.retentionClass(), r.rawRetentionDays(),
                    r.longTermCadenceS(), r.longTermStrategy());
        }
    }

    public record Point(String family, String pointKey, String sourceKind, JsonNode address,
            String selector, Integer widthBits, String valueType, Boolean signed, String endian,
            JsonNode scale, String unit, String group, String labelDe, String labelSource,
            String semanticStatus, String aggregationKind, Integer defaultCadenceS,
            Integer minCadenceS, Integer longTermCadenceS, String pollGroup, String sourceUrl,
            String sourceCommit, String sourceRevision, boolean readable, String edgeMinVersion,
            boolean dynamic, boolean recommended, RetentionView retention,
            boolean available, String availabilityStatus, String availabilityReason,
            boolean recorded, boolean selected, Integer selectedCadenceS,
            Instant lastReadAt, String rawValue, String decodedValue, String quality,
            boolean gap, long droppedSamples, long estimatedDataPerYearBytes) {

        Point view(Integer cadence, boolean wasRecorded, boolean familyAvailable,
                MeasurementSelectionRepository.Observation observation) {
            boolean seen = observation != null;
            String availability = seen ? "read" : familyAvailable ? "family_configured" : "not_configured";
            String reason = seen ? "Von diesem Gerät gelesen."
                    : familyAvailable ? "Für die konfigurierte Anbindungsfamilie vorgesehen; noch nicht gelesen."
                    : "Für die aktuelle Geräteanbindung nicht als verfügbar bestätigt.";
            int effectiveCadence = cadence == null
                    ? defaultCadenceS == null ? 300 : defaultCadenceS : cadence;
            long annualBytes = Math.round(365.25 * 24 * 3600 / Math.max(1, effectiveCadence)
                    * MeasurementBudget.BYTES_PER_SAMPLE);
            return new Point(family, pointKey, sourceKind, address, selector, widthBits, valueType,
                    signed, endian, scale, unit, group, labelDe, labelSource, semanticStatus,
                    aggregationKind, defaultCadenceS, minCadenceS, longTermCadenceS, pollGroup,
                    sourceUrl, sourceCommit, sourceRevision, readable, edgeMinVersion, dynamic,
                    recommended, retention, seen || familyAvailable, availability, reason,
                    wasRecorded, cadence != null, cadence,
                    seen ? observation.lastReadAt() : null, seen ? observation.rawValue() : null,
                    seen ? observation.decodedValue() : null, seen ? observation.quality() : null,
                    seen && observation.gap(), seen ? observation.droppedSamples() : 0L, annualBytes);
        }

        Point instantiate(String actualKey) {
            if (!dynamic || !pointKey.contains("[*]")) {
                return null;
            }
            Matcher m = MODULE_INDEX.matcher(actualKey);
            if (!m.find()) {
                return null;
            }
            int index = Integer.parseInt(m.group(1));
            if (index > 255 || !pointKey.replace("[*]", "[" + index + "]").equals(actualKey)) {
                return null;
            }
            return new Point(family, actualKey, sourceKind, address,
                    selector.replace("[*]", "[" + index + "]"), widthBits, valueType, signed,
                    endian, scale, unit, group, labelDe, labelSource, semanticStatus,
                    aggregationKind, defaultCadenceS, minCadenceS, longTermCadenceS,
                    pollGroup.replace("[*]", "[" + index + "]"), sourceUrl, sourceCommit,
                    sourceRevision, readable, edgeMinVersion, false, recommended, retention,
                    false, "not_configured", "Noch nicht vom Gerät bestätigt.", false, false,
                    null, null, null, null, null, false, 0, 0);
        }
    }

    public record Facet(String value, long count) {}

    /** Größe und Richtung eines Punkts in den Katalogwörtern ({@code null} = nicht belegt). */
    public record Semantik(String quantity, String direction) {}

    public record SearchResult(String catalogVersion, String edgeMinVersion,
            String customPointActionLabel, long total, int offset, int limit,
            List<Facet> groups, List<Facet> semanticStatuses, List<Point> points) {}

    private final String version;
    private final String inhaltsstand;
    private final String edgeMinVersion;
    private final List<Point> points;
    private final Map<String, Point> byKey;
    private final Map<String, Semantik> semantik;

    public MeasurementCatalog(ObjectMapper mapper) {
        JsonNode root = readCanonical(mapper);
        this.inhaltsstand = required(root, "catalog_version");
        String runtime = text(root, "runtime_catalog_version");
        this.version = runtime == null ? inhaltsstand : runtime;
        this.edgeMinVersion = required(root, "edge_min_version");
        List<Point> loaded = new ArrayList<>();
        Map<String, Point> indexed = new LinkedHashMap<>();
        Map<String, Semantik> meanings = new LinkedHashMap<>();
        for (JsonNode n : root.path("points")) {
            MeasurementRetention retention = MeasurementRetention.ofCatalog(n);
            Point p = new Point(text(n, "family"), text(n, "point_key"),
                    text(n, "source_kind"), copyOrNull(n.get("address")), text(n, "selector"),
                    nullableInt(n.get("width_bits")), text(n, "value_type"),
                    nullableBoolean(n.get("signed")), text(n, "endian"),
                    copyOrNull(n.get("scale")), text(n, "unit"), text(n, "group"),
                    text(n, "label_de"), text(n, "label_source"),
                    text(n, "semantic_status"), text(n, "aggregation_kind"),
                    nullableInt(n.get("default_cadence_s")),
                    nullableInt(n.get("min_cadence_s")),
                    nullableInt(n.get("long_term_cadence_s")), text(n, "poll_group"),
                    text(n, "source_url"), text(n, "source_commit"), text(n, "source_revision"),
                    n.path("readable").asBoolean(false), text(n, "edge_min_version"),
                    n.path("dynamic").asBoolean(false), n.path("recommended").asBoolean(false),
                    RetentionView.of(retention), false, "not_configured",
                    "Noch nicht vom Gerät bestätigt.", false, false, null, null, null, null, null,
                    false, 0, 0);
            if (p.pointKey() == null || indexed.put(p.pointKey(), p) != null) {
                throw new IllegalStateException("duplicate/missing measurement point key: "
                        + p.pointKey());
            }
            meanings.put(p.pointKey(), new Semantik(text(n, "quantity"), text(n, "direction")));
            loaded.add(p);
        }
        if (loaded.isEmpty()) {
            throw new IllegalStateException("measurement catalog declares no points");
        }
        this.points = List.copyOf(loaded);
        this.byKey = Map.copyOf(indexed);
        this.semantik = Map.copyOf(meanings);
    }

    /** The runtime version the box speaks (see the class comment). */
    public String version() {
        return version;
    }

    /** The content version of the packaged artifact. */
    public String inhaltsstand() {
        return inhaltsstand;
    }

    /**
     * Größe und Richtung eines Punkts; ein konkreter Modul-Schlüssel ({@code module[3]})
     * trägt die seiner Vorlage. {@code null} für einen Schlüssel, den der Katalog nicht kennt.
     */
    public Semantik semantik(String pointKey) {
        Semantik exact = pointKey == null ? null : semantik.get(pointKey);
        if (exact != null || pointKey == null || !pointKey.contains("[")) {
            return exact;
        }
        for (Point candidate : points) {
            if (candidate.instantiate(pointKey) != null) {
                return semantik.get(candidate.pointKey());
            }
        }
        return null;
    }

    public Set<String> families() {
        return points.stream().map(Point::family).collect(java.util.stream.Collectors.toUnmodifiableSet());
    }

    /**
     * Die Einheit eines Messkanals, wie der Katalog sie nennt; {@code null} ohne Eintrag oder ohne
     * Einheit. Die UEMS-Verdichtung liest die Einheit einer Reihe NUR hier ({@code uems.ReihenKontext}).
     */
    public String einheit(String pointKey) {
        Point p = resolve(pointKey);
        return p == null ? null : p.unit();
    }

    public Point resolve(String pointKey) {
        if (pointKey == null || pointKey.isBlank()) {
            return null;
        }
        Point exact = byKey.get(pointKey);
        if (exact != null) {
            return exact;
        }
        if (!pointKey.contains("[")) {
            return null;
        }
        for (Point candidate : points) {
            Point instantiated = candidate.instantiate(pointKey);
            if (instantiated != null) {
                return instantiated;
            }
        }
        return null;
    }

    public SearchResult search(String query, Set<String> families, String group,
            String semanticStatus, Boolean recorded, boolean availableOnly, boolean selectedOnly,
            Set<String> availableFamilies, Map<String, Integer> selected,
            Set<String> recordedPointKeys,
            Map<String, MeasurementSelectionRepository.Observation> observations,
            int offset, int limit) {
        if (semanticStatus != null && !SEMANTIC_STATUSES.contains(semanticStatus)) {
            throw new IllegalArgumentException("Unbekannter Semantikstatus.");
        }
        int safeOffset = Math.max(0, offset);
        int safeLimit = Math.max(1, Math.min(limit, 250));
        String q = lower(query);
        Set<String> requestedFamilies = families == null ? Set.of() : families;
        // Dynamic points live in the canonical catalog as `[*]`, while an
        // enabled selection carries its concrete module index. The compact
        // selected-only view must therefore materialize those concrete keys;
        // otherwise it would fix ordinary points but still hide module values.
        List<Point> candidates = new ArrayList<>(points);
        for (String selectedKey : selected.keySet()) {
            if (!byKey.containsKey(selectedKey)) {
                Point instantiated = resolve(selectedKey);
                if (instantiated != null) {
                    candidates.add(instantiated);
                }
            }
        }
        List<Point> filtered = candidates.stream()
                .filter(Point::readable)
                .filter(p -> !selectedOnly || selected.containsKey(p.pointKey()))
                .filter(p -> requestedFamilies.isEmpty() || requestedFamilies.contains(p.family()))
                .filter(p -> !availableOnly || availableFamilies.contains(p.family()))
                .filter(p -> group == null || group.equals(p.group()))
                .filter(p -> semanticStatus == null || semanticStatus.equals(p.semanticStatus()))
                .filter(p -> recorded == null || recorded.equals(recordedPointKeys.contains(p.pointKey())))
                .filter(p -> q.isEmpty() || searchable(p).contains(q))
                .toList();
        List<Facet> groups = facets(filtered, Point::group);
        List<Facet> semantics = facets(filtered, Point::semanticStatus);
        List<Point> page = filtered.stream().skip(safeOffset).limit(safeLimit)
                .map(p -> p.view(selected.get(p.pointKey()), recordedPointKeys.contains(p.pointKey()),
                        availableFamilies.contains(p.family()), observations.get(p.pointKey()))).toList();
        return new SearchResult(version, edgeMinVersion, CUSTOM_ACTION_LABEL, filtered.size(),
                safeOffset, safeLimit, groups, semantics, page);
    }

    private static List<Facet> facets(List<Point> source,
            java.util.function.Function<Point, String> key) {
        Map<String, Long> counts = new LinkedHashMap<>();
        source.stream().map(key).filter(v -> v != null && !v.isBlank())
                .forEach(v -> counts.merge(v, 1L, Long::sum));
        return counts.entrySet().stream()
                .map(e -> new Facet(e.getKey(), e.getValue()))
                .sorted(Comparator.comparing(Facet::value, String.CASE_INSENSITIVE_ORDER))
                .toList();
    }

    private static String searchable(Point p) {
        return lower(String.join(" ", nonNull(p.labelDe()), nonNull(p.labelSource()),
                nonNull(p.selector()), nonNull(p.unit()), nonNull(p.group()),
                nonNull(p.pointKey()), nonNull(p.family()),
                p.address() == null ? "" : p.address().toString()));
    }

    private static JsonNode readCanonical(ObjectMapper mapper) {
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver().getResources(
                    "classpath*:measurementcatalog/measurement-point-catalog-*.json");
            if (resources.length != 1) {
                throw new IllegalStateException("expected exactly one packaged measurement catalog, got "
                        + resources.length);
            }
            try (InputStream in = resources[0].getInputStream()) {
                return mapper.readTree(in);
            }
        } catch (IOException e) {
            throw new IllegalStateException("canonical measurement catalog unreadable", e);
        }
    }

    private static String required(JsonNode root, String field) {
        String v = text(root, field);
        if (v == null || v.isBlank()) {
            throw new IllegalStateException("measurement catalog missing " + field);
        }
        return v;
    }

    private static JsonNode copyOrNull(JsonNode n) {
        return n == null || n.isNull() ? null : n.deepCopy();
    }

    private static String text(JsonNode n, String field) {
        JsonNode v = n == null ? null : n.get(field);
        return v == null || v.isNull() ? null : v.asText();
    }

    private static Integer nullableInt(JsonNode n) {
        return n == null || n.isNull() ? null : n.asInt();
    }

    private static Boolean nullableBoolean(JsonNode n) {
        return n == null || n.isNull() ? null : n.asBoolean();
    }

    private static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }

    private static String nonNull(String s) {
        return s == null ? "" : s;
    }
}
