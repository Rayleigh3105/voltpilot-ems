package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Das Regelwerk-Verzeichnis im Kopf jedes Berichts-Abzugs (UEMS AP-12 IP-5, RW1, E10 = A): der Software-Stand, der den
 * Abzug gebildet hat, und die {@code schema_version} der Verträge, nach denen seine Zahlen gebildet sind. Es ist die
 * „Formelversion“ der Verdichtungsregeln, die am Wert keine Fassungsnummer tragen (RW3): je Wert steht
 * {@code berechnet_am}, und die Software zu diesem Zeitpunkt ist aus dem Deploy-Protokoll (GitOps) bestimmbar.
 *
 * <p>{@code software} = {@code voltpilot-api <Version>} aus {@code META-INF/build-info.properties}
 * ({@code spring-boot:build-info}, pom.xml) und in Klammern die Build-Kennung des Deployments
 * ({@code VOLTPILOT_BUILD}, der Git-SHA) — ohne sie die Build-Zeit. Im Docker-Build gibt es kein {@code .git}; darum
 * kommt der SHA aus dem Deployment, nicht aus dem Build.
 *
 * <p>Die Fassungen stehen hier und nicht in einer Datei, die zur Laufzeit gelesen würde (die Verträge liegen nicht im
 * Klassenpfad): {@code BerichtRegelwerkTest} hält jede gleich der {@code schema_version} ihrer Vektor-Datei.
 */
public record BerichtRegelwerk(String software, Map<String, String> vertraege) {

    public static final String ARTEFAKT = "voltpilot-api";

    /** RW1 — Vertrag → {@code schema_version} seiner Vektor-Datei unter {@code docs/contracts/v2}. */
    public static final Map<String, String> VERTRAEGE = vertraegeHeute();

    private static final DateTimeFormatter BUILD_ZEIT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
            .withZone(ZoneOffset.UTC);

    public BerichtRegelwerk {
        vertraege = Collections.unmodifiableMap(new LinkedHashMap<>(vertraege));
    }

    /** Das Regelwerk dieser Software: Version und Build-Zeit aus build-info, die Build-Kennung aus dem Deployment. */
    public static BerichtRegelwerk heute(String version, Instant gebaut, String buildKennung) {
        return new BerichtRegelwerk(software(version, gebaut, buildKennung), VERTRAEGE);
    }

    static String software(String version, Instant gebaut, String buildKennung) {
        String name = version == null || version.isBlank() ? ARTEFAKT : ARTEFAKT + " " + version.strip();
        if (buildKennung != null && !buildKennung.isBlank()) {
            return name + " (" + buildKennung.strip() + ")";
        }
        if (gebaut != null) {
            return name + " (gebaut " + BUILD_ZEIT.format(gebaut) + ")";
        }
        return name + " (Build-Kennung unbekannt)";
    }

    private static Map<String, String> vertraegeHeute() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("verbrauch", "1.0");
        m.put("ergebnis-zustand", "1.10");
        m.put("bilanz", "1.1");
        m.put("bilanzwert-herkunft", "1.0");
        m.put("kennzahl", "1.0");
        m.put("bericht", "1.0");
        return Collections.unmodifiableMap(m);
    }
}
