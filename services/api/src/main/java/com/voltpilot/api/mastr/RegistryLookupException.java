package com.voltpilot.api.mastr;

/**
 * A registry lookup failed in a way the CUSTOMER must understand: the message
 * is plain German and rendered verbatim in the portal drawer. The reason maps
 * to an HTTP status in the controller (INVALID_NUMBER -> 400, NOT_FOUND -> 404,
 * UNAVAILABLE -> 502).
 */
public class RegistryLookupException extends Exception {

    public enum Reason { INVALID_NUMBER, NOT_FOUND, UNAVAILABLE }

    private final Reason reason;

    public RegistryLookupException(Reason reason, String germanMessage) {
        super(germanMessage);
        this.reason = reason;
    }

    public RegistryLookupException(Reason reason, String germanMessage, Throwable cause) {
        super(germanMessage, cause);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
