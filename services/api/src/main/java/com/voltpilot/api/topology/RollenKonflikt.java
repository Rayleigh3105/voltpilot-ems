package com.voltpilot.api.topology;

import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

/** Ein Zuordnungskonflikt mit maschinenlesbarem Grund und den bisherigen Haltern. */
public class RollenKonflikt extends ResponseStatusException {
    private final String code;
    private final List<UUID> halter;

    public RollenKonflikt(String code, String message, List<UUID> halter) {
        super(HttpStatus.CONFLICT, message);
        this.code = code;
        this.halter = List.copyOf(halter);
    }

    public String code() { return code; }
    public List<UUID> halter() { return halter; }
}
