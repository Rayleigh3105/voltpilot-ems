package com.voltpilot.api.zugriff;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.config.BeanDefinition;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.core.type.classreading.MetadataReader;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

/**
 * Kein Kunden-Schreibpfad ohne Recht (UEMS AP-03 IP-6, §8 Prüfnachweis): jede Route unter {@code /api/v1/} außer
 * {@code /api/v1/admin/**} mit POST, PUT, PATCH oder DELETE trägt {@link Recht} — oder steht mit Grund in
 * {@link #OHNE_RECHT}. Gelesen wird der übersetzte Code (Spring-Annotationen, auch zusammengesetzte), nicht der
 * Quelltext; eine neue Route in einem neuen Controller ist ohne Pflege dabei.
 *
 * <p>Dazu: jede Kennung steht in der Matrix-Datei, die zur Laufzeit gilt; {@link RechtZiel#DIENST} nur mit Stelle der
 * genauen Prüfung ({@link #DIENST}); die Pfadvariable der Zielart steht im Pfad; {@link Recht} nur an Kunden-
 * Schreibrouten. Beide Listen sind genau: ein Eintrag ohne Route (oder für eine Route, die inzwischen {@link Recht}
 * trägt) ist ebenso rot wie eine Route ohne Eintrag.
 *
 * <p>Rein: kein Spring-Kontext, keine Datenbank.
 */
class RechtRoutenArchitekturTest {

    /**
     * Kunden-Schreibrouten, die IP-6 bewusst nicht bindet. Schlüssel {@code Controller#methode}.
     */
    static final Map<String, String> OHNE_RECHT = ohneRecht();

    private static Map<String, String> ohneRecht() {
        Map<String, String> m = new TreeMap<>();
        String offen = "öffentlich (SecurityConfig permitAll) — kein Kundenkonto, kein Kundenbereich";
        m.put("RegistrationController#register", offen);
        m.put("EnrollmentController#submitCsr", offen);
        return m;
    }

    /** {@link RechtZiel#DIENST}: wo die genaue Prüfung am Ziel steht. */
    static final Map<String, String> DIENST = dienst();

    private static Map<String, String> dienst() {
        Map<String, String> m = new TreeMap<>();
        String kennzahl = "KennzahlService.darf — Geltung der Kennzahl (Standort/Unternehmen), Aufrufer KennzahlAufrufer";
        for (String r : List.of("anlegen", "aendern", "fassungEintragen", "archivieren", "loeschen", "vorschau")) {
            m.put("KennzahlController#" + r, kennzahl);
        }
        String bezugsbasis = "KennzahlService.fuerBezugsbasis — bezugsbasis.verwalten an der Geltung der Kennzahl";
        m.put("BezugsbasisController#anlegen", bezugsbasis);
        m.put("BezugsbasisController#entwerfen", bezugsbasis);
        m.put("BezugsbasisController#verantwortlicher", bezugsbasis);
        String freigabe = "KennzahlService.fuerBezugsbasis — bezugsbasis.freigeben an der Geltung der Kennzahl, "
                + "Vier-Augen im Dienst";
        m.put("BezugsbasisController#beantragen", freigabe);
        m.put("BezugsbasisController#freigeben", freigabe);
        m.put("BezugsbasisController#ablehnen", freigabe);
        String bericht = "BerichtService — Geltung des Berichts (G1), Aufrufer KennzahlAufrufer";
        for (String r : List.of("anlegen", "freigeben", "archivieren", "verwerfen", "wiedervorlage")) {
            m.put("BerichtController#" + r, bericht);
        }
        for (String r : List.of("erfassen", "ablehnen", "zuruecknehmen")) {
            m.put("KorrekturPortalController#" + r, "KorrekturPortalService — Standort jeder Reihe, RechteAbleitung und Vier-Augen");
        }
        String energieziel = "EnergiezielService über KennzahlService.fuerBezugsbasis — verbesserung.verwalten an der "
                + "Geltung der Kennzahl des Ziels";
        for (String r : List.of("anlegen", "aendern", "verantwortlicher", "beenden")) {
            m.put("EnergiezielController#" + r, energieziel);
        }
        String massnahme = "MassnahmeService über KennzahlService.fuerBezugsbasis bzw. KennzahlService.darf — "
                + "verbesserung.verwalten an der Geltung der Kennzahl oder am Standort der Maßnahme";
        for (String r : List.of("anlegen", "aendern", "verantwortlicher", "umgesetzt", "verwerfen", "eintrag")) {
            m.put("MassnahmeController#" + r, massnahme);
        }
        for (String r : List.of("bewerten", "bewertungBeantragen", "bewertungFreigeben", "bewertungAblehnen")) {
            m.put("EnergiezielController#" + r, "EnergiezielService über KennzahlService.fuerBezugsbasis — "
                    + "verbesserung.abschliessen an der Geltung der Kennzahl des Ziels");
        }
        String abweichung = "AbweichungService über KennzahlService.fuerBezugsbasis — verbesserung.verwalten bzw. "
                + "verbesserung.abschliessen an der Geltung der Kennzahl der Abweichung bzw. des Vermerks";
        for (String r : List.of("anlegen", "eintrag", "frist", "verantwortlicher", "abschliessen")) {
            m.put("AbweichungController#" + r, abweichung);
        }
        m.put("AuffaelligkeitController#antwort", abweichung);
        for (String r : List.of("bewerten", "bewertungBeantragen", "bewertungFreigeben", "bewertungAblehnen")) {
            m.put("MassnahmeController#" + r, "MassnahmeBewertung über MassnahmeService.zeile — "
                    + "verbesserung.abschliessen an der Geltung der Kennzahl oder am Standort der Maßnahme");
        }
        // AP-18 IP-17: die Antwort auf einen Anstoß — verwalten (bleibt, neu_kopiert) bzw. abschliessen (neu_bewertet).
        m.put("MassnahmeController#anstossAntwort", "VorgangAntwort über MassnahmeService.zeile — "
                + "verbesserung.verwalten bzw. verbesserung.abschliessen an der Geltung der Kennzahl oder am Standort");
        m.put("EnergiezielController#anstossAntwort", "VorgangAntwort über EnergiezielService.fuerAnstoss — "
                + "verbesserung.verwalten bzw. verbesserung.abschliessen an der Geltung der Kennzahl des Ziels");
        m.put("BezugsbasisPflegeController#bleibt", bezugsbasis);
        m.put("BezugsbasisPflegeController#beenden", bezugsbasis);
        m.put("KorrekturPortalController#vorschau", "KorrekturPortalService — lesende Vorschau ohne Schreibvorgang");
        String korrektur = "KorrekturFreigabeService über KorrekturRechte.aufrufer — Ziel Unternehmen (schließt S)";
        m.put("KorrekturFreigabeController#freigeben", korrektur);
        m.put("KorrekturFreigabeController#zuruecknehmen", korrektur);
        m.put("DeviceController#claim", "DeviceController.claim — RechtPruefung.pruefen an der Anlage aus siteId");
        m.put("AblesungController#eingeben", "AblesungController.recht — Kennzeichen zu UUID, RechtPruefung an der Messstelle");
        m.put("AblesungController#berichtigen", "AblesungController.recht — Kennzeichen zu UUID, RechtPruefung an der Messstelle");
        m.put("BezugsgroesseController#anlegen", "BezugsgroesseController.geltungPruefen — Geltung aus dem Körper");
        m.put("MessstelleController#anlegen", "keine — eine neue Messstelle hängt an keinem Standort (Ort erst danach)");
        m.put("MessstelleFormelController#anlegen", "keine — eine neue berechnete Messstelle hängt an keinem Standort");
        m.put("BezugsdatenImportController#vorschau", "keine — die Vorschau schreibt nichts");
        String bezugsdatenImport = "ImportUebernahmeService.recht — RechtPruefung an jeder Bezugsgröße des Imports";
        m.put("BezugsdatenImportController#uebernehmen", bezugsdatenImport);
        m.put("BezugsdatenImportController#ruecknahme", bezugsdatenImport);
        m.put("BezugsdatenImportController#freigeben",
                "KorrekturFreigabeService über KorrekturRechte.aufrufer — jedes Ziel des Import-Vorschlags");
        m.put("BezugsdatenVorlageController#speichern",
                "BezugsdatenVorlageService.speichern — RechtPruefung je genannter Bezugsgröße an ihrer Geltung");
        // AP-03 IP-7: zwei Rechte in einem Rumpf bzw. je Aktion.
        String steuern = "FunktionController.pruefeSteuern — RechtPruefung.pruefen je Aktion (starten/beenden · anhalten/"
                + "fortsetzen)";
        m.put("FunktionController#steuernAnlage", steuern + " an der Anlage");
        m.put("FunktionController#steuernStandort", steuern + " am Standort");
        m.put("SiteChargingConfigController#save", "SiteChargingConfigController.save — RechtPruefung.pruefen je Feld: "
                + "gridLimitKw = grenze.eintragen, Reihenfolge/Quellen-Wahl = betriebsweise.aendern");
        // AP-19 IP-7: der Zaun folgt dem Standort des Bezugs (DK1) — beim Anlegen aus dem Körper, sonst am Dokument.
        m.put("EnergiemanagementDokumentController#anlegen", "EnergiemanagementDokumentService.anlegen — "
                + "energiemanagement.verwalten am Standort des Bezugs aus dem Körper bzw. am Unternehmen");
        String dokument = "EnergiemanagementDokumentService.schreibbar — Recht am Standort des Bezugs bzw. am Unternehmen";
        for (String r : List.of("entwerfen", "bekanntmachen", "beantragen", "freigeben", "ablehnen", "geprueft",
                "aufheben")) {
            m.put("EnergiemanagementDokumentController#" + r, dokument);
        }
        // AP-19 IP-19: die Feststellung ebenso — beim Erfassen aus dem Körper (`bezug.standort_id`), sonst an ihr.
        m.put("FeststellungController#erfassen", "FeststellungService.neu — energiemanagement.verwalten am Standort des "
                + "Bezugs aus dem Körper bzw. am Unternehmen");
        for (String r : List.of("eintrag", "frist", "verantwortlicher")) {
            m.put("FeststellungController#" + r, "FeststellungService.schreibbar — energiemanagement.verwalten am "
                    + "Standort des Bezugs bzw. am Unternehmen");
        }
        return m;
    }

    private record Route(String schluessel, Class<?> controller, Method methode, List<String> pfade,
            Set<RequestMethod> methoden) {}

    @Test
    void jedeKundenSchreibrouteTraegtEinRechtOderStehtMitGrundInDerListe() throws Exception {
        List<Route> routen = routen(mainController());
        List<String> befunde = befunde(routen, OHNE_RECHT, DIENST, true);
        long mitRecht = routen.stream().filter(r -> kundenSchreibroute(r) && r.methode().isAnnotationPresent(Recht.class))
                .count();
        long ohne = routen.stream().filter(r -> kundenSchreibroute(r) && !r.methode().isAnnotationPresent(Recht.class))
                .count();
        System.out.printf("Kunden-Schreibrouten: %d mit @Recht, %d in OHNE_RECHT%n", mitRecht, ohne);
        assertThat(befunde).as("Befunde").isEmpty();
        assertThat(mitRecht).as("Routen mit @Recht").isGreaterThanOrEqualTo(163);
    }

    /** Der Test beißt: eine Kunden-Schreibroute ohne {@link Recht} und ohne Eintrag fällt auf. */
    @Test
    void eineSchreibrouteOhneRechtFaelltAuf() {
        List<String> befunde = befunde(routen(List.of(ProbeOhneRecht.class)), Map.of(), Map.of(), false);
        assertThat(befunde).containsExactly(
                "ProbeOhneRecht#schreiben: Kunden-Schreibroute ohne @Recht und ohne Eintrag in OHNE_RECHT");
    }

    /** Eine erfundene Kennung, DIENST ohne Stelle und eine fehlende Pfadvariable fallen ebenso auf. */
    @Test
    void falscheAngabenFallenAuf() {
        List<String> befunde = befunde(routen(List.of(ProbeFalsch.class)), Map.of(), Map.of(), false);
        assertThat(befunde).containsExactlyInAnyOrder(
                "ProbeFalsch#erfunden: Kennung nicht in der Matrix: anlage.erfunden",
                "ProbeFalsch#dienst: DIENST ohne Eintrag in DIENST (wo prüft der Dienst?)",
                "ProbeFalsch#variable: Pfadvariable {siteId} fehlt in /api/v1/probe/{id}");
    }

    @RestController
    @RequestMapping("/api/v1/probe")
    static class ProbeOhneRecht {
        @PostMapping("/{siteId}")
        void schreiben() {
        }
    }

    @RestController
    @RequestMapping("/api/v1/probe")
    static class ProbeFalsch {
        @PostMapping("/erfunden")
        @Recht(value = "anlage.erfunden", ziel = RechtZiel.UNTERNEHMEN)
        void erfunden() {
        }

        @PostMapping("/dienst")
        @Recht(value = "anlage.verwalten", ziel = RechtZiel.DIENST)
        void dienst() {
        }

        @PostMapping("/{id}")
        @Recht(value = "anlage.verwalten", ziel = RechtZiel.ANLAGE)
        void variable() {
        }
    }

    // ------------------------------------------------------------------ Prüfung

    private static List<String> befunde(List<Route> routen, Map<String, String> ohneRecht, Map<String, String> dienst,
            boolean listenGenau) {
        Set<String> kennungen = new TreeSet<>(RechteMatrixDatei.aktionen());
        List<String> aus = new ArrayList<>();
        Set<String> gesehenOhne = new TreeSet<>();
        Set<String> gesehenDienst = new TreeSet<>();
        for (Route r : routen) {
            Recht recht = r.methode().getAnnotation(Recht.class);
            boolean schreibend = kundenSchreibroute(r);
            if (recht == null) {
                if (!schreibend) {
                    continue;
                }
                if (ohneRecht.containsKey(r.schluessel())) {
                    gesehenOhne.add(r.schluessel());
                } else {
                    aus.add(r.schluessel() + ": Kunden-Schreibroute ohne @Recht und ohne Eintrag in OHNE_RECHT");
                }
                continue;
            }
            if (!schreibend) {
                aus.add(r.schluessel() + ": @Recht an einer Route, die keine Kunden-Schreibroute ist " + r.pfade());
                continue;
            }
            if (ohneRecht.containsKey(r.schluessel())) {
                aus.add(r.schluessel() + ": trägt @Recht und steht trotzdem in OHNE_RECHT");
            }
            for (String k : recht.value()) {
                if (!kennungen.contains(k)) {
                    aus.add(r.schluessel() + ": Kennung nicht in der Matrix: " + k);
                }
            }
            if (recht.ziel() == RechtZiel.DIENST) {
                if (dienst.containsKey(r.schluessel())) {
                    gesehenDienst.add(r.schluessel());
                } else {
                    aus.add(r.schluessel() + ": DIENST ohne Eintrag in DIENST (wo prüft der Dienst?)");
                }
                continue;
            }
            if (recht.value().length != 1) {
                aus.add(r.schluessel() + ": mehrere Kennungen nur mit DIENST");
            }
            String variable = recht.variable().isEmpty() ? recht.ziel().variable() : recht.variable();
            if (!variable.isEmpty()) {
                for (String p : r.pfade()) {
                    if (!p.contains("{" + variable + "}")) {
                        aus.add(r.schluessel() + ": Pfadvariable {" + variable + "} fehlt in " + p);
                    }
                }
            }
        }
        if (listenGenau) {
            ohneRecht.keySet().stream().filter(k -> !gesehenOhne.contains(k))
                    .forEach(k -> aus.add(k + ": steht in OHNE_RECHT, ist aber keine Kunden-Schreibroute ohne @Recht"));
            dienst.keySet().stream().filter(k -> !gesehenDienst.contains(k))
                    .forEach(k -> aus.add(k + ": steht in DIENST, trägt aber kein @Recht mit DIENST"));
        }
        return aus;
    }

    private static boolean kundenSchreibroute(Route r) {
        boolean schreibend = r.methoden().stream().anyMatch(m -> m == RequestMethod.POST || m == RequestMethod.PUT
                || m == RequestMethod.PATCH || m == RequestMethod.DELETE);
        boolean kunde = r.pfade().stream().anyMatch(p -> p.startsWith("/api/v1/") && !p.startsWith("/api/v1/admin/"));
        return schreibend && kunde;
    }

    private static List<Class<?>> mainController() throws Exception {
        // Ohne Bedingungs-Auswertung: ein Controller hinter @ConditionalOnProperty (Anmeldung, Enrollment) ist in
        // Produktion eingeschaltet und zählt mit.
        ClassPathScanningCandidateComponentProvider scanner = new ClassPathScanningCandidateComponentProvider(false) {
            @Override
            protected boolean isCandidateComponent(MetadataReader leser) {
                return leser.getAnnotationMetadata().hasAnnotation(RestController.class.getName());
            }
        };
        List<Class<?>> aus = new ArrayList<>();
        for (BeanDefinition b : scanner.findCandidateComponents("com.voltpilot.api")) {
            Class<?> c = Class.forName(b.getBeanClassName());
            // Nur der Produktivcode — Test-Routen (wie die Proben hier) liegen unter test-classes.
            String ort = c.getProtectionDomain().getCodeSource().getLocation().toString();
            if (!ort.contains("test-classes")) {
                aus.add(c);
            }
        }
        assertThat(aus).as("gefundene Controller").hasSizeGreaterThan(80);
        return aus;
    }

    private static List<Route> routen(List<Class<?>> controller) {
        List<Route> aus = new ArrayList<>();
        for (Class<?> c : controller) {
            RequestMapping basis = AnnotatedElementUtils.findMergedAnnotation(c, RequestMapping.class);
            List<String> basen = basis == null || basis.path().length == 0 ? List.of("") : List.of(basis.path());
            for (Method m : c.getDeclaredMethods()) {
                RequestMapping rm = AnnotatedElementUtils.findMergedAnnotation(m, RequestMapping.class);
                if (rm == null) {
                    continue;
                }
                List<String> eigene = rm.path().length == 0 ? List.of("") : List.of(rm.path());
                List<String> pfade = new ArrayList<>();
                for (String b : basen) {
                    for (String e : eigene) {
                        pfade.add(b + e);
                    }
                }
                Set<RequestMethod> methoden = new TreeSet<>(Arrays.asList(rm.method()));
                aus.add(new Route(c.getSimpleName() + "#" + m.getName(), c, m, pfade, methoden));
            }
        }
        aus.sort(Comparator.comparing(Route::schluessel));
        return aus;
    }
}
