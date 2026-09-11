package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * Nimmt einen {@code measurement-samples}-Umschlag (2.0/2.1) an. Der UMSCHLAG ist die Einheit für
 * Fassung, Form und Kennung — ein Fehler dort wirft {@link UmschlagAbgewiesen}. Ein SAMPLE ist die
 * Einheit für seinen Inhalt und seine Messzeit (UEMS AP-07 IP-5): ein fehlerhaftes oder
 * unplausibles Sample verwirft nur sich selbst, die übrigen gehen als {@code measurements.raw}
 * weiter; die Ablehnungen stehen gebündelt in der {@link Annahme}. Die Messzeit eines Samples ist
 * sein {@code observed_at}, sonst das des Umschlags; ist die des Umschlags unplausibel, geht die Uhr
 * der Box falsch und KEIN Sample wird angenommen.
 */
@Component
public class MeasurementSamplesValidator {
    private static final Pattern KEY = Pattern.compile("^[a-z0-9][a-z0-9._*\\[\\]@-]{0,239}$");
    private static final Pattern CATALOG = Pattern.compile("^[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}\\.[0-9]+$");
    private static final Set<String> QUALITY = Set.of(
            "good", "uncertain", "invalid", "stale", "device_error");
    static final Set<String> ROOT_FIELDS_2_0 = Set.of("schema_version", "tenant_id",
            "site_id", "device_id", "catalog_version", "sequence", "observed_at", "samples",
            "dropped_samples", "gap");
    static final Set<String> SAMPLE_FIELDS_2_0 = Set.of("point_key", "raw", "decoded",
            "quality", "observed_at", "signed_data", "signed_data_format");
    // 2.1 (UEMS AP-07 IP-2) = 2.0 plus two OPTIONAL provenance fields, and only under 2.1.
    // Ingest validates them but does not forward them: the measurements.raw event stays 1.0 with
    // exactly the 2.0 sample fields, which the writer checks strictly (forwarding needs the writer
    // in the same step - IP-6/IP-7).
    static final String APPLIED_REVISION = "applied_revision";
    static final String ENTITY_ID = "entity_id";
    static final Set<String> ROOT_FIELDS_2_1 = plus(ROOT_FIELDS_2_0, APPLIED_REVISION);
    static final Set<String> SAMPLE_FIELDS_2_1 = plus(SAMPLE_FIELDS_2_0, ENTITY_ID);
    static final String STROM = "measurement-samples";
    private final ObjectMapper mapper;
    private final Messzeitregel messzeit;

    public MeasurementSamplesValidator(ObjectMapper mapper, Messzeitregel messzeit) {
        this.mapper = mapper;
        this.messzeit = messzeit;
    }

    public Annahme<MeasurementRawEvent> annehmen(String topic, String payload, Instant ingestedAt) {
        JsonNode r;
        try {
            r = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(payload);
        } catch (Exception e) {
            throw new UmschlagAbgewiesen(Grund.SCHEMA_VERLETZT, "not JSON", null, null);
        }
        if (r == null || !r.isObject()) {
            throw new UmschlagAbgewiesen(Grund.SCHEMA_VERLETZT, "not an object", null, null);
        }
        JsonNode seq = r.path("sequence");
        Long seqLesbar = seq.isIntegralNumber() && seq.canConvertToLong() && seq.asLong() >= 0
                ? seq.asLong() : null;
        Long zahl = r.path("samples").isArray() ? (long) r.get("samples").size() : null;
        Umschlag u = new Umschlag(seqLesbar, zahl);

        // Fassung → Form → Kennung (die Reihenfolge von EreignisVokabular.pruefeUmschlag).
        JsonNode version = r.get("schema_version");
        boolean v21 = version != null && version.isTextual() && "2.1".equals(version.asText());
        if (!v21 && !(version != null && version.isTextual() && "2.0".equals(version.asText()))) {
            u.bad(Grund.FASSUNG_UNBEKANNT, "schema_version");
        }
        if (!onlyFields(r, v21 ? ROOT_FIELDS_2_1 : ROOT_FIELDS_2_0)) u.bad(Grund.SCHEMA_VERLETZT, "fields");
        UUID tenant = u.uuid(r, "tenant_id");
        UUID site = u.uuid(r, "site_id");
        UUID device = u.uuid(r, "device_id");
        String catalog = u.text(r, "catalog_version");
        if (!CATALOG.matcher(catalog).matches()) u.bad(Grund.SCHEMA_VERLETZT, "catalog_version");
        if (seqLesbar == null) u.bad(Grund.SCHEMA_VERLETZT, "sequence");
        Instant observed = u.zeit(r, "observed_at");
        JsonNode samples = r.get("samples");
        if (samples == null || !samples.isArray() || samples.isEmpty() || samples.size() > 256) {
            u.bad(Grund.SCHEMA_VERLETZT, "batch bounds");
        }
        if (r.has(APPLIED_REVISION) && (!r.get(APPLIED_REVISION).isIntegralNumber()
                || r.get(APPLIED_REVISION).asLong(-1) < 0)) u.bad(Grund.SCHEMA_VERLETZT, APPLIED_REVISION);
        if (r.has("dropped_samples") && !r.get("dropped_samples").isIntegralNumber()) {
            u.bad(Grund.SCHEMA_VERLETZT, "drops");
        }
        if (r.has("gap") && !r.get("gap").isBoolean()) u.bad(Grund.SCHEMA_VERLETZT, "gap");
        long dropped = r.path("dropped_samples").asLong(0);
        if (dropped < 0) u.bad(Grund.SCHEMA_VERLETZT, "drops");
        String[] p = topic == null ? new String[0] : topic.split("/");
        if (p.length != 6 || !"ems".equals(p[0]) || !"v2".equals(p[4]) || !STROM.equals(p[5])
                || !p[1].equals(tenant.toString()) || !p[2].equals(site.toString())
                || !p[3].equals(device.toString())) u.bad(Grund.KENNUNG_ABWEICHEND, "topic identity");

        // Je Sample: erst der Inhalt, dann die Messzeit — ein Fehler verwirft nur dieses Sample.
        Ablehnungen ablehnungen = new Ablehnungen();
        Map<String, Integer> jeSchluessel = new HashMap<>();
        samples.forEach(s -> {
            if (s.path("point_key").isTextual()) jeSchluessel.merge(s.get("point_key").asText(), 1, Integer::sum);
        });
        List<JsonNode> inhaltlichGut = new ArrayList<>();
        for (JsonNode s : samples) {
            Grund g = sampleGrund(s, v21);
            if (g == null && jeSchluessel.get(s.get("point_key").asText()) > 1) {
                g = Grund.REGEL_VERLETZT; // point_key doppelt: welcher Wert gilt, wird nie geraten
            }
            if (g != null) {
                ablehnungen.abgewiesen(g, 1);
            } else {
                inhaltlichGut.add(s);
            }
        }
        List<JsonNode> angenommen = new ArrayList<>();
        Optional<Messzeitregel.Abweichung> uhr = messzeit.pruefe(observed, ingestedAt);
        if (uhr.isPresent()) {
            ablehnungen.zeit(uhr.get(), inhaltlichGut.size());
        } else {
            for (JsonNode s : inhaltlichGut) {
                Optional<Messzeitregel.Abweichung> a = s.has("observed_at")
                        ? messzeit.pruefe(OffsetDateTime.parse(s.get("observed_at").asText()).toInstant(),
                                ingestedAt)
                        : Optional.empty();
                if (a.isPresent()) {
                    ablehnungen.zeit(a.get(), 1);
                } else {
                    angenommen.add(s);
                }
            }
        }

        Annahme.Absender absender = new Annahme.Absender(tenant, site, device, STROM, seqLesbar);
        MeasurementRawEvent event = null;
        if (!angenommen.isEmpty()) {
            ArrayNode weiter = mapper.createArrayNode();
            angenommen.forEach(s -> {
                ObjectNode copy = s.deepCopy();
                copy.remove(ENTITY_ID);
                weiter.add(copy);
            });
            event = new MeasurementRawEvent("1.0", UUID.randomUUID(), tenant, site, device, catalog,
                    seqLesbar, observed, ingestedAt, topic, weiter, dropped, r.path("gap").asBoolean(false));
        }
        return new Annahme<>(event, absender, ablehnungen.liste());
    }

    /** Warum dieses Sample den Vertrag verletzt — {@code null}, wenn sein Inhalt stimmt. */
    private static Grund sampleGrund(JsonNode s, boolean v21) {
        if (!s.isObject() || !onlyFields(s, v21 ? SAMPLE_FIELDS_2_1 : SAMPLE_FIELDS_2_0)) {
            return Grund.SCHEMA_VERLETZT;
        }
        if (s.has(ENTITY_ID) && !(s.get(ENTITY_ID).isTextual() && canonicalUuid(s.get(ENTITY_ID).asText()))) {
            return Grund.SCHEMA_VERLETZT;
        }
        JsonNode key = s.get("point_key");
        JsonNode raw = s.get("raw");
        if (key == null || !key.isTextual() || !KEY.matcher(key.asText()).matches()
                || raw == null || !scalar(raw) || !s.path("quality").isTextual()) {
            return Grund.SCHEMA_VERLETZT;
        }
        if (s.has("decoded") && !scalar(s.get("decoded"))) return Grund.SCHEMA_VERLETZT;
        if (s.has("observed_at") && !zeitLesbar(s.get("observed_at"))) return Grund.SCHEMA_VERLETZT;
        if (s.has("signed_data") && !textBis(s.get("signed_data"), 32768)) return Grund.SCHEMA_VERLETZT;
        if (s.has("signed_data_format") && !textBis(s.get("signed_data_format"), 128)) {
            return Grund.SCHEMA_VERLETZT;
        }
        if (!QUALITY.contains(s.get("quality").asText())) return Grund.WORT_UNBEKANNT;
        return null;
    }

    /** Was über den Umschlag schon lesbar ist, für das {@code rejected} seiner Abweisung. */
    private record Umschlag(Long sequenz, Long anzahl) {
        void bad(Grund grund, String hinweis) {
            throw new UmschlagAbgewiesen(grund, hinweis, sequenz, anzahl);
        }

        UUID uuid(JsonNode node, String field) {
            try {
                return UUID.fromString(text(node, field));
            } catch (IllegalArgumentException e) {
                bad(Grund.SCHEMA_VERLETZT, field);
                return null;
            }
        }

        String text(JsonNode node, String field) {
            JsonNode value = node.get(field);
            if (value == null || !value.isTextual() || value.asText().isBlank()) {
                bad(Grund.SCHEMA_VERLETZT, field);
            }
            return value.asText();
        }

        Instant zeit(JsonNode node, String field) {
            if (!zeitLesbar(node.get(field))) bad(Grund.SCHEMA_VERLETZT, field);
            return OffsetDateTime.parse(node.get(field).asText()).toInstant();
        }
    }

    private static boolean textBis(JsonNode value, int laenge) {
        return value.isTextual() && !value.asText().isBlank() && value.asText().length() <= laenge;
    }

    private static boolean zeitLesbar(JsonNode value) {
        if (value == null || !value.isTextual() || value.asText().isBlank()) return false;
        try {
            OffsetDateTime.parse(value.asText());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean canonicalUuid(String value) {
        try {
            return UUID.fromString(value).toString().equalsIgnoreCase(value);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static Set<String> plus(Set<String> base, String field) {
        Set<String> all = new HashSet<>(base);
        all.add(field);
        return Set.copyOf(all);
    }

    private static boolean scalar(JsonNode node) {
        return node.isNumber() && Double.isFinite(node.asDouble())
                || node.isTextual() || node.isBoolean();
    }
    private static boolean onlyFields(JsonNode node, Set<String> allowed) {
        var names = node.fieldNames();
        while (names.hasNext()) if (!allowed.contains(names.next())) return false;
        return true;
    }
}
