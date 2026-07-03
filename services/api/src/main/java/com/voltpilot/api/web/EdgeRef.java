package com.voltpilot.api.web;

/**
 * Validation for self-generated edge references. When a customer-side Edge-App
 * has no configured reference it generates its own and shows it on its local
 * ({@code :8484}) web app for the customer to type into the portal. The format
 * is {@value #PREFIX} + six body characters + one trailing check character - a
 * position-weighted mod-31 checksum over the body.
 *
 * <p>A single-character typo (substitution, adjacent transposition, or a wrong
 * length) breaks the checksum, so {@link DeviceController} can reject it with a
 * 422 instead of silently creating a ghost device that would "wait for first
 * data" forever - the same fail-fast the {@code VP-} sticker registry gate gives
 * manufactured devices.
 *
 * <p>MUST stay in lockstep with the generator in the edge core
 * ({@code edge-app/core/internal/agent/agent.go}): identical alphabet, identical
 * position weights. The Go {@code ref_test.go} and {@link EdgeRefTest} pin the
 * shared vectors from both sides.
 */
final class EdgeRef {

    /** No 0/O/1/l/i lookalikes - mirrors the edge generator's {@code refAlphabet}. */
    static final String ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
    /** Self-generated references carry this prefix. */
    static final String PREFIX = "edge-";
    private static final int BODY_LEN = 6;

    private EdgeRef() {
    }

    /**
     * Whether a (canonicalized, lowercased) ref looks like a self-generated
     * reference and so should be check-character-gated. This deliberately does
     * NOT gate every {@value #PREFIX} ref: a generated ref is {@code PREFIX} +
     * seven alphabet characters, and a single-character typo yields six to eight
     * alphabet characters, so we treat {@code PREFIX} + 6..8 pure-alphabet chars
     * as a candidate. Free-form refs that carry a hyphen or an out-of-alphabet
     * character (dev seeds like {@code edge-fresh-01}, integration refs like
     * {@code edge-inverter-42}) fall outside this and stay ungated - preserving
     * backward compatibility for anything that is not a generated ref.
     */
    static boolean isGeneratedFormat(String ref) {
        if (ref == null || !ref.startsWith(PREFIX)) {
            return false;
        }
        String rest = ref.substring(PREFIX.length());
        if (rest.length() < BODY_LEN || rest.length() > BODY_LEN + 2) {
            return false;
        }
        for (int i = 0; i < rest.length(); i++) {
            if (ALPHABET.indexOf(rest.charAt(i)) < 0) {
                return false;
            }
        }
        return true;
    }

    /**
     * Whether a generated-format ref carries a valid check character. Call only
     * when {@link #isGeneratedFormat} is true. Assumes a lowercase ref (the
     * claim path canonicalizes {@value #PREFIX} refs to lowercase first).
     */
    static boolean isValid(String ref) {
        String rest = ref.substring(PREFIX.length());
        if (rest.length() != BODY_LEN + 1) {
            return false;
        }
        int sum = 0;
        for (int i = 0; i < BODY_LEN; i++) {
            int v = ALPHABET.indexOf(rest.charAt(i));
            if (v < 0) {
                return false;
            }
            sum += (i + 1) * v;
        }
        return rest.charAt(BODY_LEN) == ALPHABET.charAt(sum % ALPHABET.length());
    }
}
