package com.voltpilot.api.enrollment;

/**
 * A device-supplied CSR that cannot be accepted: not PEM, not a certification
 * request, an invalid self-signature (no proof-of-possession of the key), or a
 * key outside the accepted policy (RSA &gt;= 2048 / EC P-256/P-384). Surfaced
 * as HTTP 400 with the (customer-facing German) message.
 */
public class InvalidCsrException extends RuntimeException {

    public InvalidCsrException(String message) {
        super(message);
    }

    public InvalidCsrException(String message, Throwable cause) {
        super(message, cause);
    }
}
