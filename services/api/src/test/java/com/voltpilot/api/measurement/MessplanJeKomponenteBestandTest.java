package com.voltpilot.api.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.measurement.MeasurementSelectionRepository.DeviceScope;
import com.voltpilot.api.measurement.MeasurementSelectionService.SelectionPoint;
import com.voltpilot.api.measurement.MeasurementSelectionService.State;
import com.voltpilot.api.uems.BoxFaehigkeiten;
import com.voltpilot.api.uems.EdgeSupports;
import com.voltpilot.api.uems.ErwarteteKadenz.Messkanal;
import com.voltpilot.api.uems.KadenzRegeln;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * AP-07 IP-18b Teil 2: der Mess-Plan mit geteiltem Punkt geht NUR an eine Box, die
 * {@code measurement_config_per_component} meldet. Jede andere Box bekommt den zusammengelegten
 * Plan - Byte für Byte gegen die WÖRTLICHE Kopie des Wegs von vorher ({@link #vorher}), wie
 * {@code RegistryPushJeBoxBestandTest} es für den Registry-Push tut.
 */
class MessplanJeKomponenteBestandTest {
    private static final UUID TENANT = UUID.fromString("00000000-0000-0000-0000-000000000001");
    private static final UUID SITE = UUID.fromString("00000000-0000-0000-0000-000000000002");
    private static final UUID DEVICE = UUID.fromString("00000000-0000-0000-0000-000000000003");
    private static final DeviceScope SCOPE = new DeviceScope(TENANT, SITE, DEVICE);
    private static final UUID A1 = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID A2 = UUID.fromString("00000000-0000-0000-0000-0000000000a2");
    private static final UUID A3 = UUID.fromString("00000000-0000-0000-0000-0000000000a3");
    private static final String BATTERY = "deye.hybrid_1p.battery.battery";
    private static final String VOLTAGE = "deye.hybrid_1p.battery.battery-voltage";
    private final ObjectMapper mapper = new ObjectMapper().findAndRegisterModules();

    @Test
    void dasWortStehtImGemeinsamenVokabular() {
        assertThat(MeasurementConfigPublisher.FAEHIGKEIT_JE_KOMPONENTE)
                .isEqualTo("measurement_config_per_component");
        assertThat(EdgeSupports.NAMES).contains(MeasurementConfigPublisher.FAEHIGKEIT_JE_KOMPONENTE);
    }

    /** Heutige Box an neuer Cloud: in jeder kleinen Welt dieselben Bytes wie vorher. */
    @Test
    void eineBoxOhneDasWortBekommtDenPlanVonVorherByteGleich() throws Exception {
        Random zufall = new Random(18_2);
        for (int welt = 0; welt < 2_000; welt++) {
            State state = welt(zufall);
            Map<Messkanal, Integer> fassungen = fassungen(zufall, state);
            byte[] erwartet = vorher(SCOPE, state, fassungen);
            assertThat(publisher(fassungen, null).payload(SCOPE, state)).as("ohne Abfrage, Welt %d", welt)
                    .isEqualTo(erwartet);
            assertThat(publisher(fassungen, faehigkeiten(false)).payload(SCOPE, state))
                    .as("Wort nicht gemeldet, Welt %d", welt).isEqualTo(erwartet);
            assertThat(publisher(fassungen, kaputt()).payload(SCOPE, state))
                    .as("Abfrage wirft, Welt %d", welt).isEqualTo(erwartet);
        }
    }

    /**
     * Auch die fähige Box bekommt ohne geteilten Punkt dieselben Bytes: der Plan ändert sich
     * nur dort, wo zwei Komponenten denselben Punkt beobachten.
     */
    @Test
    void eineFaehigeBoxOhneGeteiltenPunktBekommtDieselbenBytes() throws Exception {
        Random zufall = new Random(18_3);
        int ohneGeteilt = 0;
        for (int welt = 0; welt < 2_000; welt++) {
            State state = welt(zufall);
            if (hatGeteiltenPunkt(state)) continue;
            ohneGeteilt++;
            Map<Messkanal, Integer> fassungen = fassungen(zufall, state);
            assertThat(publisher(fassungen, faehigkeiten(true)).payload(SCOPE, state))
                    .as("Welt %d", welt).isEqualTo(vorher(SCOPE, state, fassungen));
        }
        assertThat(ohneGeteilt).isGreaterThan(200);
    }

    /** Die fähige Box: je Komponente ein Eintrag, jede mit ihrer Kadenz - die Beispieldatei. */
    @Test
    void eineFaehigeBoxBekommtDenGeteiltenPunktJeKomponente() throws Exception {
        State state = state(10, List.of(selection(A1, BATTERY, 30), selection(A2, BATTERY, 10),
                selection(null, VOLTAGE, 30)));
        JsonNode fixture = mapper.readTree(Files.readString(Path.of("..", "..", "docs", "contracts",
                "v2", "examples", "mqtt-measurement-config.valid.shared-point.json")));
        assertThat(mapper.readTree(publisher(Map.of(), faehigkeiten(true)).payload(SCOPE, state)))
                .isEqualTo(fixture);
        // Dieselbe Welt an einer Box ohne das Wort: ein Eintrag, schnellste Kadenz, ohne Komponente.
        JsonNode alt = mapper.readTree(publisher(Map.of(), faehigkeiten(false)).payload(SCOPE, state));
        assertThat(alt.at("/selections")).hasSize(2);
        assertThat(alt.at("/selections/0/cadence_s").asInt()).isEqualTo(10);
        assertThat(alt.at("/selections/0/entity_id").isMissingNode()).isTrue();
    }

    /**
     * Die Regel des Vertrags an jeder Welt der fähigen Box: ein {@code point_key} steht nur
     * mehrfach, wenn jedes Vorkommen eine Komponente nennt und keine zweimal; jede Komponente
     * trägt die schnellste IHRER Kadenzen (Fassung vor Auswahl, wie bisher); ein Punkt mit einer
     * Zeile ohne Komponente bleibt zusammengelegt wie vorher.
     */
    @Test
    void derGeteilteDokumentteilHaeltDieRegelDesVertrags() throws Exception {
        Random zufall = new Random(18_4);
        int geteilt = 0;
        for (int welt = 0; welt < 2_000; welt++) {
            State state = welt(zufall);
            Map<Messkanal, Integer> fassungen = fassungen(zufall, state);
            JsonNode neu = mapper.readTree(publisher(fassungen, faehigkeiten(true)).payload(SCOPE, state));
            JsonNode alt = mapper.readTree(vorher(SCOPE, state, fassungen));
            Map<String, List<JsonNode>> jeSchluessel = new LinkedHashMap<>();
            neu.at("/selections").forEach(s -> jeSchluessel
                    .computeIfAbsent(s.path("point_key").asText(), k -> new ArrayList<>()).add(s));
            assertThat(jeSchluessel.keySet()).as("Reihenfolge der Punkte, Welt %d", welt)
                    .containsExactlyElementsOf(punkte(alt));
            for (var e : jeSchluessel.entrySet()) {
                if (e.getValue().size() == 1) {
                    assertThat(e.getValue().get(0)).isEqualTo(eintrag(alt, e.getKey()));
                    continue;
                }
                geteilt++;
                Set<String> komponenten = new LinkedHashSet<>();
                for (JsonNode s : e.getValue()) {
                    assertThat(s.has("entity_id")).isTrue();
                    assertThat(komponenten.add(s.path("entity_id").asText())).isTrue();
                    UUID entity = UUID.fromString(s.path("entity_id").asText());
                    assertThat(s.path("cadence_s").asInt()).isEqualTo(schnellste(state, fassungen,
                            entity, e.getKey()));
                }
                assertThat(state.selections().stream().filter(p -> p.enabled()
                        && p.pointKey().equals(e.getKey())).allMatch(p -> p.entityId() != null)).isTrue();
                // Gelesen wird je Ziel einmal in der schnellsten Kadenz: das ist die des alten Eintrags.
                assertThat(e.getValue().stream().mapToInt(s -> s.path("cadence_s").asInt()).min().orElseThrow())
                        .isEqualTo(eintrag(alt, e.getKey()).path("cadence_s").asInt());
            }
            ObjectNode ohneAuswahl = ((ObjectNode) neu.deepCopy());
            ohneAuswahl.remove("selections");
            ObjectNode altOhneAuswahl = ((ObjectNode) alt.deepCopy());
            altOhneAuswahl.remove("selections");
            assertThat(ohneAuswahl).isEqualTo(altOhneAuswahl);
        }
        assertThat(geteilt).isGreaterThan(200);
    }

    // ------------------------------------------------------------------ kleine Welten

    private static State welt(Random zufall) {
        UUID[] entities = {null, A1, A2, A3};
        String[] keys = {BATTERY, VOLTAGE, "deye.hybrid_1p.meter.grid-power"};
        Integer[] cadences = {10, 30, 60, 5};
        List<SelectionPoint> rows = new ArrayList<>();
        Set<String> belegt = new LinkedHashSet<>();
        int n = 1 + zufall.nextInt(6);
        for (int i = 0; i < n; i++) {
            UUID entity = entities[zufall.nextInt(entities.length)];
            String key = keys[zufall.nextInt(keys.length)];
            // Die Auswahl ist je (Komponente, Punkt) eine Zeile.
            if (!belegt.add(entity + "|" + key)) continue;
            SelectionPoint p = selection(entity, key, cadences[zufall.nextInt(cadences.length)]);
            if (zufall.nextInt(6) == 0) p = abgeschaltet(p);
            rows.add(p);
        }
        return state(1 + zufall.nextInt(50), rows);
    }

    private static Map<Messkanal, Integer> fassungen(Random zufall, State state) {
        Map<Messkanal, Integer> out = new LinkedHashMap<>();
        int[] werte = {15, 30, 0, 86401};
        for (SelectionPoint p : state.selections()) {
            if (p.entityId() != null && zufall.nextInt(3) == 0) {
                out.put(new Messkanal(p.entityId(), p.pointKey()), werte[zufall.nextInt(werte.length)]);
            }
        }
        return out;
    }

    private static boolean hatGeteiltenPunkt(State state) {
        Map<String, Set<UUID>> je = new LinkedHashMap<>();
        Map<String, Boolean> alle = new LinkedHashMap<>();
        for (SelectionPoint p : state.selections()) {
            if (!p.enabled()) continue;
            je.computeIfAbsent(p.pointKey(), k -> new LinkedHashSet<>()).add(p.entityId());
            alle.merge(p.pointKey(), p.entityId() != null, Boolean::logicalAnd);
        }
        return je.entrySet().stream().anyMatch(e -> alle.get(e.getKey()) && e.getValue().size() > 1);
    }

    private static int schnellste(State state, Map<Messkanal, Integer> fassungen, UUID entity, String key) {
        return state.selections().stream().filter(p -> p.enabled() && key.equals(p.pointKey())
                        && entity.equals(p.entityId()))
                .mapToInt(p -> {
                    Integer f = fassungen.get(new Messkanal(entity, key));
                    return KadenzRegeln.imRahmen(f) ? f : p.cadenceS();
                }).min().orElseThrow();
    }

    private static List<String> punkte(JsonNode plan) {
        List<String> out = new ArrayList<>();
        plan.at("/selections").forEach(s -> out.add(s.path("point_key").asText()));
        return out;
    }

    private static JsonNode eintrag(JsonNode plan, String key) {
        for (JsonNode s : plan.at("/selections")) if (s.path("point_key").asText().equals(key)) return s;
        throw new AssertionError(key);
    }

    private MeasurementConfigPublisher publisher(Map<Messkanal, Integer> fassungen, BoxFaehigkeiten f) {
        MeasurementConfigPublisher p = new MeasurementConfigPublisher("tcp://unused:1883", "", "", mapper,
                (kanaele, zeitpunkt) -> fassungen);
        if (f != null) p.setFaehigkeiten(f);
        return p;
    }

    private static BoxFaehigkeiten faehigkeiten(boolean kann) {
        BoxFaehigkeiten f = mock(BoxFaehigkeiten.class);
        when(f.kann(any(), anyString())).thenReturn(false);
        when(f.kann(DEVICE, "measurement_config_per_component")).thenReturn(kann);
        return f;
    }

    private static BoxFaehigkeiten kaputt() {
        BoxFaehigkeiten f = mock(BoxFaehigkeiten.class);
        when(f.kann(any(), anyString())).thenThrow(new IllegalStateException("db weg"));
        return f;
    }

    private static State state(long revision, List<SelectionPoint> rows) {
        return new State(DEVICE, SITE, null, revision, "2026.08.26.3", "pending_edge", null, null, null,
                rows, List.of(), null);
    }

    private static SelectionPoint selection(UUID entityId, String pointKey, Integer cadenceS) {
        return new SelectionPoint(entityId, pointKey, true, cadenceS, 9, null, null,
                "2026.08.26.3", "test", null, null, "pending_edge", null, null, null,
                "thermal_bms", 90, 900, "fifteen_minute", null, null, null, null);
    }

    private static SelectionPoint abgeschaltet(SelectionPoint p) {
        return new SelectionPoint(p.entityId(), p.pointKey(), false, p.cadenceS(), p.desiredRevision(),
                p.enabledAt(), p.disabledAt(), p.catalogVersion(), p.changedBy(), p.changedByName(),
                p.changedAt(), p.applyStatus(), p.applyReason(), p.appliedAt(), p.customDefinition(),
                p.retentionClass(), p.rawRetentionDays(), p.longTermCadenceS(), p.longTermStrategy(),
                p.label(), p.family(), p.group(), p.semanticStatus());
    }

    // ------------------------------------------------------------------ WÖRTLICH von vorher
    // MeasurementConfigPublisher#payload + #wireEntry und MeasurementPlan#compose auf origin/uems
    // d783a9fc6, nur zu statischen Methoden dieser Klasse gemacht. Nicht anfassen.

    private byte[] vorher(DeviceScope scope, State state, Map<Messkanal, Integer> fassungen)
            throws Exception {
        List<Map<String, Object>> selections = vorherCompose(state.selections(), fassungen)
                .stream().map(MessplanJeKomponenteBestandTest::vorherWireEntry).toList();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schema_version", "2.0");
        payload.put("tenant_id", scope.tenantId());
        payload.put("site_id", scope.siteId());
        payload.put("device_id", scope.deviceId());
        payload.put("revision", state.desiredRevision());
        payload.put("catalog_version", state.catalogVersion());
        payload.put("selections", selections);
        return mapper.writeValueAsBytes(payload);
    }

    private static Map<String, Object> vorherWireEntry(MeasurementPlan.Entry entry) {
        Map<String, Object> selection = new LinkedHashMap<>();
        selection.put("point_key", entry.pointKey());
        selection.put("cadence_s", entry.cadenceS());
        if (entry.customDefinition() != null) selection.put("definition",
                MeasurementConfigPublisher.fuerDieBox(entry.customDefinition()));
        if (entry.entityId() != null) selection.put("entity_id", entry.entityId());
        return selection;
    }

    private static List<MeasurementPlan.Entry> vorherCompose(List<SelectionPoint> selections,
            Map<Messkanal, Integer> cadenceVersions) {
        Map<String, MeasurementPlan.Entry> byPointKey = new LinkedHashMap<>();
        Map<String, Boolean> unambiguousEntity = new LinkedHashMap<>();
        for (SelectionPoint point : selections) {
            if (!point.enabled()) continue;
            Integer cadence = vorherCadence(point, cadenceVersions);
            MeasurementPlan.Entry existing = byPointKey.get(point.pointKey());
            if (existing == null) {
                byPointKey.put(point.pointKey(), vorherEntry(point.entityId(), point, cadence));
                unambiguousEntity.put(point.pointKey(), Boolean.TRUE);
                continue;
            }
            if (cadence != null && (existing.cadenceS() == null
                    || cadence < existing.cadenceS())) {
                byPointKey.put(point.pointKey(), new MeasurementPlan.Entry(existing.entityId(),
                        existing.pointKey(), cadence, existing.customDefinition(),
                        existing.retentionClass(), existing.rawRetentionDays(),
                        existing.longTermCadenceS(), existing.longTermStrategy()));
            }
            if (!Objects.equals(point.entityId(), existing.entityId())) {
                unambiguousEntity.put(point.pointKey(), Boolean.FALSE);
            }
        }
        return byPointKey.values().stream().map(entry ->
                Boolean.TRUE.equals(unambiguousEntity.get(entry.pointKey())) ? entry
                        : new MeasurementPlan.Entry(null, entry.pointKey(), entry.cadenceS(),
                                entry.customDefinition(), entry.retentionClass(),
                                entry.rawRetentionDays(), entry.longTermCadenceS(),
                                entry.longTermStrategy()))
                .toList();
    }

    private static MeasurementPlan.Entry vorherEntry(UUID entityId, SelectionPoint point, Integer cadence) {
        return new MeasurementPlan.Entry(entityId, point.pointKey(), cadence, point.customDefinition(),
                point.retentionClass(), point.rawRetentionDays(), point.longTermCadenceS(),
                point.longTermStrategy());
    }

    private static Integer vorherCadence(SelectionPoint point, Map<Messkanal, Integer> cadenceVersions) {
        Integer version = point.entityId() == null ? null
                : cadenceVersions.get(new Messkanal(point.entityId(), point.pointKey()));
        Integer effective = KadenzRegeln.imRahmen(version) ? version : point.cadenceS();
        return effective;
    }
}
