package com.voltpilot.api.measurement;

import com.fasterxml.jackson.databind.JsonNode;
import com.voltpilot.api.registerwrite.RegisterWriteService;
import com.voltpilot.api.registerwrite.RegisterWriteTargets;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Flüchtige Katalog-Lesung über die vorhandene Vorschau-Lane, niemals ein Schreibauftrag. */
@Service
public class MeasurementPointReadService {
    public record Reading(Double wert, String einheit, Instant gelesen_am, String grund) {}

    private final MeasurementSelectionService selections;
    private final MeasurementCatalog catalog;
    private final RegisterWriteTargets targets;
    private final RegisterWriteService preview;
    private final SummenwertQuellenService sources;

    public MeasurementPointReadService(MeasurementSelectionService selections, MeasurementCatalog catalog,
            RegisterWriteTargets targets, RegisterWriteService preview, SummenwertQuellenService sources) {
        this.selections = selections;
        this.catalog = catalog;
        this.targets = targets;
        this.preview = preview;
        this.sources = sources;
    }

    public Reading read(UUID deviceId, UUID entityId, String pointKey, RegisterWriteService.Actor actor) {
        var scope = selections.requireDevice(deviceId);
        if (entityId == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Komponente fehlt.");
        selections.requireEntity(scope, entityId);
        var point = catalog.resolve(pointKey);
        if (point == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Register nicht gefunden.");
        if (!selections.availableFamilies(deviceId, entityId).contains(point.family()))
            return missing(point, "nicht_lesbar");
        if (sources.sources(scope.siteId()).stream().noneMatch(s -> entityId.equals(s.entityId()) && deviceId.equals(s.deviceId())))
            return missing(point, "nicht_lesbar");
        // Genau die benannte Komponente. Ohne gespeichertes deviceId gilt die Push-Zuordnung oben.
        List<RegisterWriteTargets.Target> matching = targets.forSite(scope.siteId()).stream()
                .filter(t -> entityId.equals(t.entityId()) && (t.deviceId() == null || deviceId.equals(t.deviceId()))).toList();
        if (matching.size() != 1 || !matching.getFirst().writable()) return missing(point, "nicht_lesbar");
        var target = matching.getFirst();
        JsonNode registers = point.address() == null ? null : point.address().get("registers");
        Double factor = factor(point.scale());
        String kind = "modbus_holding".equals(point.sourceKind()) ? "holding"
                : "modbus_input".equals(point.sourceKind()) ? "input" : null;
        Integer bits = point.widthBits();
        if (!point.readable() || kind == null || registers == null || !registers.isArray()
                || bits == null || (bits != 16 && bits != 32) || registers.size() != bits / 16
                || factor == null || !("big".equals(point.endian()) || "word_little_byte_big".equals(point.endian()))
                || !List.of("uint16", "int16", "uint32", "int32", "float32").contains(point.valueType()))
            return missing(point, "nicht_lesbar");
        for (JsonNode address : registers)
            if (!address.canConvertToInt() || address.asInt() < 0 || address.asInt() > 65535)
                return missing(point, "nicht_lesbar");
        long raw = 0;
        try {
            // Nicht benachbarte Wörter (z.B. Gen-Port 667/671) bleiben in Katalog-Reihenfolge.
            for (int i = 0; i < registers.size(); i++) {
                var result = preview.preview(scope.siteId(), new RegisterWriteService.Command(
                        deviceId, target.lane(), entityId, target.host(), target.port(), target.unitId(),
                        kind, registers.get(i).asText(), null, null, null, null), actor);
                if (!result.ok() || result.beforeRaw() == null)
                    return missing(point, "timeout".equals(result.errorCode()) ? "box_offline" : "nicht_lesbar");
                int shift = "word_little_byte_big".equals(point.endian()) ? i * 16 : (registers.size() - 1 - i) * 16;
                raw |= ((long) result.beforeRaw() & 0xffffL) << shift;
            }
        } catch (ResponseStatusException ex) {
            if (ex.getStatusCode().value() == 404) throw ex;
            return missing(point, ex.getStatusCode().value() == 503 || ex.getStatusCode().value() == 504
                    || "device_offline".equals(ex.getReason()) ? "box_offline" : "nicht_lesbar");
        }
        double number = switch (point.valueType()) {
            case "int16" -> (short) raw;
            case "int32" -> (int) raw;
            case "float32" -> Float.intBitsToFloat((int) raw);
            default -> raw;
        };
        double value = number * factor;
        return Double.isFinite(value) ? new Reading(value, point.unit(), Instant.now(), null) : missing(point, "nicht_lesbar");
    }

    private static Double factor(JsonNode scale) {
        if (scale == null) return null;
        String kind = scale.path("kind").asText();
        if ("none".equals(kind)) return 1.0;
        if (!scale.path("value").isNumber()) return null;
        double n = scale.path("value").asDouble();
        if (!Double.isFinite(n) || n == 0) return null;
        return "factor".equals(kind) ? n : "divisor".equals(kind) ? 1.0 / n : null;
    }

    private static Reading missing(MeasurementCatalog.Point point, String reason) {
        return new Reading(null, point.unit(), null, reason);
    }
}
