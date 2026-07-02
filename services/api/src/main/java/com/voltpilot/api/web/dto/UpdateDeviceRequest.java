package com.voltpilot.api.web.dto;

import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Request to update a device. Only the device TYPE and the optional label
 * (Bezeichnung) are editable - the {@code external_ref} is the device's
 * identity (MQTT topics, registry gating, the printed sticker) and stays
 * immutable; correcting a wrong ref means unclaiming and re-claiming.
 */
public record UpdateDeviceRequest(
        @Pattern(regexp = "inverter|battery|meter", message = "kind must be one of inverter, battery, meter")
                String kind,
        @Size(max = 120) String name) {

    /** Blank label means "remove the label". */
    public String nameOrNull() {
        return name == null || name.isBlank() ? null : name.trim();
    }
}
