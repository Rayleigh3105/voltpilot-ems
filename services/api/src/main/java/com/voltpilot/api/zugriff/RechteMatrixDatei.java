package com.voltpilot.api.zugriff;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.uems.RechteAbleitung;
import com.voltpilot.api.uems.RechteAbleitung.Matrix;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Die ganze Rechte-Matrix zur Laufzeit (UEMS AP-03 IP-4): {@code docs/contracts/v2/rechte-matrix.json}, vom Build
 * unverändert unter {@code uems/rechte-matrix.json} ins Jar gelegt ({@code pom.xml}, {@code Dockerfile}) — keine
 * Kopie, die auseinanderlaufen könnte.
 *
 * <p>Sie braucht nur die Selbstauskunft (Rechte je Aktion). Die Routen-Prüfungen mit wenigen Zeilen behalten ihre
 * gepinnte Kopie ({@code KorrekturRechte}, {@code KennzahlRechte}, {@code BerichtRechte}).
 *
 * <p>Geladen beim ersten Gebrauch: fehlt die Datei im Jar, scheitert {@code /me} mit einer klaren Meldung, der Rest
 * des API startet und läuft.
 */
public final class RechteMatrixDatei {

    public static final String PFAD = "uems/rechte-matrix.json";

    private RechteMatrixDatei() {
    }

    public static Matrix matrix() {
        return Halter.MATRIX;
    }

    /** Die Kennungen der Aktionen in der Folge der Datei. */
    public static List<String> aktionen() {
        return Halter.AKTIONEN;
    }

    private static final class Halter {
        private static final JsonNode DATEI = lies();
        static final Matrix MATRIX = RechteAbleitung.matrix(DATEI);
        static final List<String> AKTIONEN = kennungen(DATEI);

        private static JsonNode lies() {
            try (InputStream in = RechteMatrixDatei.class.getClassLoader().getResourceAsStream(PFAD)) {
                if (in == null) {
                    throw new IllegalStateException("Rechte-Matrix fehlt im Jar: " + PFAD
                            + " (pom.xml legt docs/contracts/v2/rechte-matrix.json dorthin)");
                }
                return new ObjectMapper().readTree(in);
            } catch (IOException e) {
                throw new IllegalStateException("Rechte-Matrix nicht lesbar: " + PFAD, e);
            }
        }

        private static List<String> kennungen(JsonNode datei) {
            List<String> aus = new ArrayList<>();
            datei.path("aktionen").forEach(a -> aus.add(a.path("kennung").asText()));
            return List.copyOf(aus);
        }
    }
}
