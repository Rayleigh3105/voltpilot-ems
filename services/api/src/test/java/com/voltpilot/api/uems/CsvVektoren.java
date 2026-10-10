package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * Macht aus einer Prüfung der Regel {@code csv} (Block {@code csv.pruefungen} und die Fälle B1, B12,
 * B13 der Vektor-Datei) Bytes, liest sie mit {@link CsvLeser} und vergleicht jedes Feld des
 * Ergebnisses, das in der Datei steht. Gemeinsam für {@code CsvLeserTest} und
 * {@code BezugsdatenVectorsTest} — EINE Lesart der Vektoren, nicht zwei.
 */
final class CsvVektoren {

    private CsvVektoren() {}

    /** {@code zeilen} | {@code text} | {@code hex}, dann {@code fuellen}, dann Kodierung und BOM. */
    static byte[] datei(JsonNode d) {
        if (d.has("hex")) {
            return HexFormat.of().parseHex(d.path("hex").asText());
        }
        String ende = d.path("zeilenende").asText("\n");
        StringBuilder text = new StringBuilder();
        if (d.has("text")) {
            text.append(d.path("text").asText());
        } else {
            List<String> zeilen = new ArrayList<>();
            d.path("zeilen").forEach(z -> zeilen.add(z.asText()));
            text.append(String.join(ende, zeilen));
            if (!zeilen.isEmpty() && !d.path("ohne_schluss").asBoolean(false)) {
                text.append(ende);
            }
        }
        if (d.has("fuellen")) {
            String zeile = d.path("fuellen").path("zeile").asText() + ende;
            text.append(zeile.repeat(d.path("fuellen").path("anzahl").asInt()));
        }
        byte[] inhalt = kodiere(text.toString(), d.path("kodierung").asText(CsvLeser.UTF_8));
        if (!d.path("bom").asBoolean(false)) {
            return inhalt;
        }
        byte[] mitBom = new byte[inhalt.length + 3];
        mitBom[0] = (byte) 0xEF;
        mitBom[1] = (byte) 0xBB;
        mitBom[2] = (byte) 0xBF;
        System.arraycopy(inhalt, 0, mitBom, 3, inhalt.length);
        return mitBom;
    }

    /** Streng: ein Zeichen, das die Kodierung nicht kennt, ist ein Fehler der Vektor-Datei. */
    private static byte[] kodiere(String text, String kodierung) {
        Charset zs = CsvLeser.UTF_8.equals(kodierung) ? StandardCharsets.UTF_8 : Charset.forName("windows-1252");
        try {
            ByteBuffer b = zs.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .encode(CharBuffer.wrap(text));
            byte[] bytes = new byte[b.remaining()];
            b.get(bytes);
            return bytes;
        } catch (CharacterCodingException e) {
            throw new IllegalStateException("Vektor-Text nicht in " + kodierung + " darstellbar", e);
        }
    }

    static CsvLeser.Vorgabe vorgabe(JsonNode v) {
        if (v.isMissingNode() || v.isNull()) {
            return CsvLeser.Vorgabe.ERKENNEN;
        }
        return new CsvLeser.Vorgabe(
                v.path("kodierung").asText(null),
                v.path("trennzeichen").asText(null),
                v.has("kopfzeile") ? v.path("kopfzeile").asBoolean() : null);
    }

    static CsvLeser.Ergebnis lies(JsonNode eingang) {
        return CsvLeser.lies(datei(eingang.path("datei")), vorgabe(eingang.path("vorgabe")));
    }

    static void pruefe(String why, JsonNode eingang, JsonNode soll) {
        CsvLeser.Ergebnis ist = lies(eingang);
        assertThat(ist.befund()).as(why + " · befund").isEqualTo(soll.path("befund").asText(null));
        assertThat(ist.zusatz()).as(why + " · zusatz").isEqualTo(soll.path("zusatz").asText(null));
        assertThat(ist.zeile()).as(why + " · zeile").isEqualTo(zahl(soll.path("zeile")));
        assertThat(ist.kodierung()).as(why + " · kodierung").isEqualTo(soll.path("kodierung").asText(null));
        assertThat(ist.bom()).as(why + " · bom").isEqualTo(wahr(soll.path("bom")));
        assertThat(ist.trennzeichen()).as(why + " · trennzeichen").isEqualTo(soll.path("trennzeichen").asText(null));
        assertThat(ist.kopfzeile()).as(why + " · kopfzeile").isEqualTo(wahr(soll.path("kopfzeile")));
        assertThat(ist.kopf()).as(why + " · kopf").isEqualTo(soll.path("kopf").isNull() ? null : texte(soll.path("kopf")));
        assertThat(ist.spalten()).as(why + " · spalten").isEqualTo(zahl(soll.path("spalten")));
        assertThat(ist.datenzeilen()).as(why + " · datenzeilen").isEqualTo(zahl(soll.path("datenzeilen")));
        if (soll.has("zeilen")) {
            List<String> sollZeilen = new ArrayList<>();
            soll.path("zeilen").forEach(z -> sollZeilen.add(
                    z.path("nr").asInt() + " | " + z.path("text").asText() + " | " + texte(z.path("felder"))));
            assertThat(ist.zeilen().stream().map(z -> z.nr() + " | " + z.text() + " | " + z.felder()).toList())
                    .as(why + " · zeilen")
                    .isEqualTo(sollZeilen);
        }
        if (soll.has("anzeige")) {
            List<List<String>> sollAnzeige = new ArrayList<>();
            soll.path("anzeige").forEach(z -> sollAnzeige.add(texte(z)));
            assertThat(ist.zeilen().stream().map(CsvLeser.Zeile::anzeige).toList())
                    .as(why + " · anzeige")
                    .isEqualTo(sollAnzeige);
        }
    }

    static List<String> texte(JsonNode n) {
        List<String> r = new ArrayList<>();
        n.forEach(x -> r.add(x.asText()));
        return r;
    }

    private static Integer zahl(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asInt();
    }

    private static Boolean wahr(JsonNode n) {
        return n.isNull() || n.isMissingNode() ? null : n.asBoolean();
    }
}
