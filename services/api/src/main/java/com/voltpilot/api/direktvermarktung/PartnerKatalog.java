package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

/**
 * Der Partnerkatalog ({@code catalog/direktvermarkter/profiles/*.json}, PR #1999, E6 = A "Partnerkatalog als
 * Daten"): die Datei ist die von Hand gepflegte Wahrheit (Konzept-Beispiel 5.3, jetzt real: {@code luox.json});
 * diese Klasse liest nur, was dort steht (Maven-Ressource im {@code pom.xml} dieses Moduls, Quelle
 * {@code .../profiles}, Zielpfad {@code direktvermarkter/}, Muster {@code catalog/control-profiles}/
 * {@code measurement-points}). Die GEPACKTE Sicht unter {@code edge-app/core/internal/direktvermarkter/} ist
 * nur für den Go-Kern der Box - diese Klasse liest das Profil selbst, nicht die gepackte Sicht. Ohne einen
 * einzigen Partner liefert sie schlicht eine leere Liste; das ist kein Fehler, sondern "noch kein Partner im
 * Katalog" (Bildschirm 2, "Startseite, noch nicht verbunden").
 */
@Component
public class PartnerKatalog {

    private static final Logger log = LoggerFactory.getLogger(PartnerKatalog.class);
    private static final String MUSTER = "classpath*:direktvermarkter/*.json";

    private final PathMatchingResourcePatternResolver resolver;
    private final ObjectMapper json;

    public PartnerKatalog(ResourceLoader resourceLoader, ObjectMapper json) {
        this.resolver = new PathMatchingResourcePatternResolver(resourceLoader);
        this.json = json;
    }

    /** Alle lesbaren Profile, nach Anzeigename sortiert; ein beschädigtes Profil fehlt nur selbst, bricht den Katalog nicht. */
    public List<PartnerProfil> alle() {
        List<PartnerProfil> out = new ArrayList<>();
        Resource[] gefunden;
        try {
            gefunden = resolver.getResources(MUSTER);
        } catch (IOException e) {
            log.warn("direktvermarktung: Partnerkatalog nicht lesbar: {}", e.toString());
            return List.of();
        }
        for (Resource r : gefunden) {
            try (var in = r.getInputStream()) {
                PartnerProfil p = json.readValue(in, PartnerProfil.class);
                if (p.partner() != null && !p.partner().isBlank()) out.add(p);
            } catch (IOException e) {
                log.warn("direktvermarktung: Partnerprofil {} nicht lesbar: {}", r.getFilename(), e.toString());
            }
        }
        out.sort(Comparator.comparing(PartnerProfil::anzeigename, String.CASE_INSENSITIVE_ORDER));
        return out;
    }

    /** Ein Profil anhand seines Schlüssels, oder {@code null}. */
    public PartnerProfil finde(String partner) {
        return alle().stream().filter(p -> p.partner().equals(partner)).findFirst().orElse(null);
    }
}
