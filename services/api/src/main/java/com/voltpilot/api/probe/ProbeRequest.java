package com.voltpilot.api.probe;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

/**
 * The portal's ask: read these registers on this plant's device, once.
 *
 * <p>Bean validation here is the FORM check only, and deliberately not a second
 * copy of the box's rules. The rules that decide whether a device is actually
 * touched - private target, expiry, rate limit - live on the BOX
 * ({@code edge-app/core/internal/probe}) and stay there: the box is the one
 * that has to be right about its own LAN, and a cloud-side copy would be a
 * second truth that drifts. What this class does is refuse a request the box
 * would only refuse after a broker round trip, so an obvious typo comes back
 * immediately.
 *
 * @param deviceId optional explicit box for an unbound target; otherwise the leading box.
 * @param entityId optional existing component; its source execution takes precedence.
 */
public record ProbeRequest(UUID deviceId, @NotEmpty @Size(max = 8) @Valid List<Op> ops, UUID entityId) {
    public ProbeRequest(UUID deviceId, List<Op> ops) { this(deviceId, ops, null); }

    /**
     * One read step. The field names and defaults mirror the contract's
     * {@code op_read} one-to-one, so what the customer filled in is what the
     * device is asked - no translation layer in between.
     */
    public record Op(
            @NotBlank @Pattern(regexp = "^[a-z0-9][a-z0-9_-]{0,31}$") String id,
            @NotBlank @Size(max = 253) String host,
            @Min(1) @Max(65535) Integer port,
            @Min(0) @Max(255) Integer unitId,
            @NotBlank @Pattern(regexp = "^(holding|input)$") String registerKind,
            @Min(0) @Max(65535) int address,
            @NotBlank @Pattern(regexp = "^(u16|s16|u32|s32|float32)$") String dataType,
            @Pattern(regexp = "^(big|little)$") String wordOrder,
            Double scale, Double offset) {
    }
}
