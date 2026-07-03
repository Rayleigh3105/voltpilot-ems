package com.voltpilot.api.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * The check-character validator for self-generated edge references. These
 * vectors MUST match the generator in edge-app/core/internal/agent/agent.go
 * (mirrored by ref_test.go) - a single, non-negotiable shared algorithm is the
 * whole point of B1: a one-character typo is rejected instead of creating a
 * ghost device.
 */
class EdgeRefTest {

    // body "abcdef": weighted sum 1*0+2*1+3*2+4*3+5*4+6*5 = 70; 70 mod 31 = 8;
    // ALPHABET[8] = 'j'. Recomputed independently here to pin the algorithm.
    private static final String VALID = "edge-abcdefj";

    @Test
    void acceptsAWellFormedGeneratedRef() {
        assertThat(EdgeRef.isGeneratedFormat(VALID)).isTrue();
        assertThat(EdgeRef.isValid(VALID)).isTrue();
    }

    @Test
    void rejectsEverySingleCharacterSubstitution() {
        String body = VALID.substring(EdgeRef.PREFIX.length()); // 7 chars incl. check
        for (int pos = 0; pos < body.length(); pos++) {
            for (char c : EdgeRef.ALPHABET.toCharArray()) {
                if (c == body.charAt(pos)) {
                    continue;
                }
                String mutated = EdgeRef.PREFIX + body.substring(0, pos) + c + body.substring(pos + 1);
                assertThat(EdgeRef.isValid(mutated))
                        .as("substitution at %d -> %s should be invalid", pos, mutated)
                        .isFalse();
            }
        }
    }

    @Test
    void rejectsAdjacentTranspositions() {
        String valid = "edge-mnpqrs" + checkCharOf("mnpqrs");
        assertThat(EdgeRef.isValid(valid)).isTrue();
        String body = valid.substring(EdgeRef.PREFIX.length());
        for (int i = 0; i < body.length() - 1; i++) {
            if (body.charAt(i) == body.charAt(i + 1)) {
                continue;
            }
            String swapped = EdgeRef.PREFIX + body.substring(0, i) + body.charAt(i + 1)
                    + body.charAt(i) + body.substring(i + 2);
            assertThat(EdgeRef.isValid(swapped))
                    .as("transposition at %d -> %s should be invalid", i, swapped)
                    .isFalse();
        }
    }

    @Test
    void rejectsWrongLengthAndOutOfAlphabetChars() {
        assertThat(EdgeRef.isValid("edge-abcdef")).isFalse();   // deletion (6 body chars)
        assertThat(EdgeRef.isValid("edge-abcdefgh")).isFalse(); // insertion (8)
        assertThat(EdgeRef.isValid("edge-abcde0j")).isFalse();  // '0' is not in the alphabet
    }

    @Test
    void onlyGeneratedShapeIsGated_freeFormEdgeRefsStayUngated() {
        assertThat(EdgeRef.isGeneratedFormat("VP-1234-ABCD")).isFalse();
        assertThat(EdgeRef.isGeneratedFormat("demo-inverter-01")).isFalse();
        // Free-form edge refs carry a hyphen / out-of-alphabet char -> NOT gated
        // (backward compatibility with dev seeds and integration refs).
        assertThat(EdgeRef.isGeneratedFormat("edge-fresh-01")).isFalse();
        assertThat(EdgeRef.isGeneratedFormat("edge-inverter-42")).isFalse();
        // The generated shape (6..8 pure-alphabet chars) IS a candidate.
        assertThat(EdgeRef.isGeneratedFormat("edge-abcdefj")).isTrue();  // 7 chars
        assertThat(EdgeRef.isGeneratedFormat("edge-abcdef")).isTrue();   // 6 (a deletion typo)
        assertThat(EdgeRef.isGeneratedFormat("edge-abcdefgh")).isTrue(); // 8 (an insertion typo)
    }

    /** Independent re-implementation of the check char, to catch a drifting VALID vector. */
    private static char checkCharOf(String body) {
        int sum = 0;
        for (int i = 0; i < body.length(); i++) {
            sum += (i + 1) * EdgeRef.ALPHABET.indexOf(body.charAt(i));
        }
        return EdgeRef.ALPHABET.charAt(sum % EdgeRef.ALPHABET.length());
    }
}
