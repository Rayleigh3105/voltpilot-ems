package com.voltpilot.api.web.dto;

/**
 * Die nächste freie Sequenznummer des Release-Registers - das EINE, was ein
 * Veröffentlicher lesen muss, um ein Manifest bauen zu können.
 *
 * <p>{@code release_seq} steht IM signierten Manifest, die Signatur geht über
 * dessen exakte Bytes: die Ordnung muss also VOR dem Signieren feststehen und
 * kann nicht erst beim Eintragen vergeben werden.
 *
 * @param nextSeq        die Nummer, die das nächste Release tragen muss
 * @param currentSeq     die höchste vergebene Nummer, {@code null} bei leerem
 *                       Register - zugleich der natürliche Vorgänger-Stand
 * @param currentVersion die Version zu {@code currentSeq}, {@code null} bei
 *                       leerem Register
 */
public record NextReleaseSeqDto(long nextSeq, Long currentSeq, String currentVersion) {
}
