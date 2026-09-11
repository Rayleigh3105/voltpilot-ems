package com.voltpilot.ingest;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * ENVELOPE validation of an inbound mqtt-telemetry-2.0 payload (contract:
 * {@code docs/contracts/v2/mqtt-telemetry-2.0.schema.json}): schema version,
 * topic==payload identity (the v1 rule), id formats, timestamps, and the
 * structural shape - entity ids topic-safe, channels flat maps of FINITE
 * numbers. Channel NAMES are deliberately NOT validated against the entity
 * registry, and an unknown entity id is data, not an error (the capability set
 * is an edge/portal concern - contract §3).
 *
 * <p>UEMS AP-07 IP-5: the ENVELOPE (version, identity, {@code ts}, {@code seq},
 * the {@code entities} object) is the unit that is refused as a whole
 * ({@link UmschlagAbgewiesen}); a VALUE is one channel of one entity. A bad
 * channel drops only itself, an entity without a readable id, {@code ts} or
 * channel block drops its channels, and the measurement-time rule
 * ({@link Messzeitregel}, E13) applies per entity (an entity carries the time):
 * an implausible top-level {@code ts} means the box clock is off and drops every
 * entity. {@code seq} is forwarded unchanged; absent stays absent.
 */
@Component
public class TelemetryV2Validator {

    static final String EXPECTED_VERSION = "2.0";
    static final String STROM = "telemetry";

    private static final Pattern ENTITY_ID =
            Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    private static final Pattern CHANNEL = Pattern.compile("^[a-z][a-z0-9_]{0,63}$");

    private final ObjectMapper mapper;
    private final Messzeitregel messzeit;

    public TelemetryV2Validator(ObjectMapper mapper, Messzeitregel messzeit) {
        this.mapper = mapper;
        this.messzeit = messzeit;
    }

    /**
     * Validates the envelope and maps what is accepted onto the
     * {@code telemetry-v2.raw} event ({@code null} when no value is left).
     * Throws {@link UmschlagAbgewiesen} when the envelope itself is refused.
     */
    public Annahme<TelemetryV2RawEvent> annehmen(String topic, String payload, Instant now) {
        JsonNode root = parse(payload);
        JsonNode seqNode = root.get("seq");
        Long seq = seqNode != null && seqNode.isIntegralNumber() && seqNode.canConvertToLong()
                && seqNode.asLong() >= 0 ? seqNode.asLong() : null;
        JsonNode entities = root.get("entities");
        Long werte = entities != null && entities.isObject() ? werteImUmschlag(entities) : null;
        Umschlag u = new Umschlag(seq, werte);

        JsonNode version = root.get("schema_version");
        if (version == null || !version.isTextual() || !EXPECTED_VERSION.equals(version.asText())) {
            u.bad(Grund.FASSUNG_UNBEKANNT, "unsupported schema_version: " + version);
        }
        UUID tenantId = u.uuid(root, "tenant_id");
        UUID siteId = u.uuid(root, "site_id");
        UUID deviceId = u.uuid(root, "device_id");
        Instant observedAt = u.timestamp(root, "ts");
        if (seqNode != null && seq == null) {
            u.bad(Grund.SCHEMA_VERLETZT, "seq must be an integer >= 0");
        }
        if (entities == null || !entities.isObject() || entities.isEmpty()) {
            u.bad(Grund.SCHEMA_VERLETZT, "entities must be a non-empty object");
        }
        u.requireTopicIdentity(topic, tenantId, siteId, deviceId);

        Ablehnungen ablehnungen = new Ablehnungen();
        ObjectNode inhaltlichGut = mapper.createObjectNode();
        for (Iterator<Map.Entry<String, JsonNode>> it = entities.fields(); it.hasNext();) {
            Map.Entry<String, JsonNode> entity = it.next();
            ObjectNode gut = entityOhneFehler(entity.getKey(), entity.getValue(), ablehnungen);
            if (gut != null) {
                inhaltlichGut.set(entity.getKey(), gut);
            }
        }

        ObjectNode angenommen = mapper.createObjectNode();
        Optional<Messzeitregel.Abweichung> uhr = messzeit.pruefe(observedAt, now);
        if (uhr.isPresent()) {
            ablehnungen.zeit(uhr.get(), werteImUmschlag(inhaltlichGut));
        } else {
            inhaltlichGut.fields().forEachRemaining(e -> {
                JsonNode ts = e.getValue().get("ts");
                Optional<Messzeitregel.Abweichung> a = ts == null || ts.isNull() ? Optional.empty()
                        : messzeit.pruefe(OffsetDateTime.parse(ts.asText()).toInstant(), now);
                if (a.isPresent()) {
                    ablehnungen.zeit(a.get(), e.getValue().get("channels").size());
                } else {
                    angenommen.set(e.getKey(), e.getValue());
                }
            });
        }

        Annahme.Absender absender = new Annahme.Absender(tenantId, siteId, deviceId, STROM, seq);
        TelemetryV2RawEvent event = angenommen.isEmpty() ? null
                : new TelemetryV2RawEvent(TelemetryV2RawEvent.SCHEMA_VERSION, UUID.randomUUID(),
                        tenantId, siteId, deviceId, observedAt, now, topic, seq, angenommen);
        return new Annahme<>(event, absender, ablehnungen.liste());
    }

    /**
     * The entity with only its valid channels, or {@code null} when nothing of it
     * is left; every dropped value is counted with its reason.
     */
    private static ObjectNode entityOhneFehler(String id, JsonNode entity, Ablehnungen ablehnungen) {
        JsonNode channels = entity == null ? null : entity.get("channels");
        boolean kanaele = channels != null && channels.isObject() && !channels.isEmpty();
        JsonNode ts = entity == null ? null : entity.get("ts");
        if (!ENTITY_ID.matcher(id).matches() || entity == null || !entity.isObject() || !kanaele
                || (ts != null && !ts.isNull() && !zeitLesbar(ts))) {
            ablehnungen.abgewiesen(Grund.SCHEMA_VERLETZT, kanaele ? channels.size() : 1);
            return null;
        }
        ObjectNode gut = entity.deepCopy();
        ObjectNode gutChannels = (ObjectNode) gut.get("channels");
        List<String> falsch = new ArrayList<>();
        channels.fields().forEachRemaining(c -> {
            JsonNode value = c.getValue();
            if (!CHANNEL.matcher(c.getKey()).matches()
                    || !value.isNumber() || !Double.isFinite(value.asDouble())) {
                falsch.add(c.getKey());
            }
        });
        if (!falsch.isEmpty()) {
            ablehnungen.abgewiesen(Grund.SCHEMA_VERLETZT, falsch.size());
            gutChannels.remove(falsch);
        }
        return gutChannels.isEmpty() ? null : gut;
    }

    /** How many values (channels) an entities block carries; a broken entity counts as one. */
    private static long werteImUmschlag(JsonNode entities) {
        long n = 0;
        for (JsonNode e : entities) {
            JsonNode c = e == null ? null : e.get("channels");
            n += c != null && c.isObject() && !c.isEmpty() ? c.size() : 1;
        }
        return n;
    }

    private JsonNode parse(String payload) {
        try {
            JsonNode root = mapper.readTree(payload);
            if (root == null || !root.isObject()) {
                throw new UmschlagAbgewiesen(Grund.SCHEMA_VERLETZT,
                        "payload is not a JSON object", null, null);
            }
            return root;
        } catch (UmschlagAbgewiesen e) {
            throw e;
        } catch (Exception e) {
            throw new UmschlagAbgewiesen(Grund.SCHEMA_VERLETZT,
                    "payload is not valid JSON: " + e.getMessage(), null, null);
        }
    }

    private static boolean zeitLesbar(JsonNode value) {
        if (!value.isTextual()) {
            return false;
        }
        try {
            OffsetDateTime.parse(value.asText());
            return true;
        } catch (DateTimeParseException e) {
            return false;
        }
    }

    /** What is already readable about the envelope, for the {@code rejected} of its refusal. */
    private record Umschlag(Long sequenz, Long anzahl) {
        void bad(Grund grund, String hinweis) {
            throw new UmschlagAbgewiesen(grund, hinweis, sequenz, anzahl);
        }

        String text(JsonNode root, String field) {
            JsonNode node = root.get(field);
            if (node == null || !node.isTextual()) {
                bad(Grund.SCHEMA_VERLETZT, "missing field: " + field);
            }
            return node.asText();
        }

        UUID uuid(JsonNode root, String field) {
            try {
                return UUID.fromString(text(root, field));
            } catch (IllegalArgumentException e) {
                bad(Grund.SCHEMA_VERLETZT, "field " + field + " is not a UUID");
                return null;
            }
        }

        Instant timestamp(JsonNode root, String field) {
            if (!zeitLesbar(root.path(field))) {
                bad(Grund.SCHEMA_VERLETZT, field + " is not RFC 3339");
            }
            return OffsetDateTime.parse(root.get(field).asText()).toInstant();
        }

        /** Topic shape ems/{t}/{s}/{d}/v2/telemetry, identities equal the payload's. */
        void requireTopicIdentity(String topic, UUID tenantId, UUID siteId, UUID deviceId) {
            String[] parts = topic == null ? new String[0] : topic.split("/");
            if (parts.length != 6 || !"ems".equals(parts[0]) || !"v2".equals(parts[4])
                    || !STROM.equals(parts[5])) {
                bad(Grund.KENNUNG_ABWEICHEND, "unexpected topic shape: " + topic);
            }
            if (!parts[1].equals(tenantId.toString()) || !parts[2].equals(siteId.toString())
                    || !parts[3].equals(deviceId.toString())) {
                bad(Grund.KENNUNG_ABWEICHEND, "topic identity does not match payload identity: " + topic);
            }
        }
    }
}
