package com.voltpilot.api.ueberwachung;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Kunden-Alarmierung P1: der Text jeder Meldung gegen {@code docs/contracts/v2/meldungs-text-vectors.json} - dieselben
 * Fälle prüft das Portal ({@code meldungsText.vectors.test.ts}). Dazu Wächter, dass kein Text einen internen Schlüssel,
 * einen Rohwert oder eine ISO-Zeit trägt, und dass jede Meldungsart und jeder Zustand ein Kundenwort hat.
 */
class MeldungsTextVektorTest {

    private static final Path VEKTOREN = Path.of("../../docs/contracts/v2/meldungs-text-vectors.json");
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final WerteKatalog KATALOG = new WerteKatalog();
    private static final MeldungsText TEXTE = KATALOG.meldungsText();

    /** ISO-Zeit, Rohwort mit Unterstrich oder Katalogschlüssel mit Punkt („anlage.preis.jetzt“). */
    private static final Pattern VERBOTEN = Pattern.compile(
            "\\d{4}-\\d{2}-\\d{2}T|\\b[a-z]+_[a-z_]+\\b|\\b[a-z]+\\.[a-z_]+(\\.[a-z_]+)?\\b|null");

    private static JsonNode vektoren() throws IOException {
        return JSON.readTree(Files.readString(VEKTOREN));
    }

    static Stream<JsonNode> faelle() throws IOException {
        List<JsonNode> out = new ArrayList<>();
        vektoren().path("faelle").forEach(out::add);
        return out.stream();
    }

    static MeldungsText.Eingabe eingabe(JsonNode e) {
        JsonNode w = e.path("wert");
        MeldungsText.Wert wert = w.isNull() || w.isMissingNode() ? null
                : new MeldungsText.Wert(w.hasNonNull("zahl") ? w.path("zahl").asDouble() : null, text(w, "einheit"),
                        text(w, "zustand"), text(w, "satz"));
        return new MeldungsText.Eingabe(e.path("wertart").asText(), text(e, "herkunft"), text(e, "regelName"),
                text(e, "schwere"), text(e, "bezugArt"), text(e, "ort"),
                e.path("bedingung").isNull() ? null : e.path("bedingung"), wert, zeit(e, "beginn"), zeit(e, "ende"));
    }

    private static String text(JsonNode n, String feld) {
        return n.hasNonNull(feld) ? n.path(feld).asText() : null;
    }

    private static Instant zeit(JsonNode n, String feld) {
        return n.hasNonNull(feld) ? Instant.parse(n.path(feld).asText()) : null;
    }

    private static void gleich(MeldungsText.Nachricht ist, JsonNode soll, String fall) {
        assertThat(ist.titel()).as(fall + " titel").isEqualTo(soll.path("titel").asText());
        List<String> saetze = new ArrayList<>();
        soll.path("saetze").forEach(s -> saetze.add(s.asText()));
        assertThat(ist.saetze()).as(fall + " saetze").isEqualTo(saetze);
        assertThat(ist.betreff()).as(fall + " betreff").isEqualTo(soll.path("betreff").asText());
        assertThat(ist.pushTitel()).as(fall + " pushTitel").isEqualTo(soll.path("pushTitel").asText());
        assertThat(ist.pushText()).as(fall + " pushText").isEqualTo(soll.path("pushText").asText());
    }

    @ParameterizedTest(name = "{index}: {0}")
    @MethodSource("faelle")
    void jederFallErgibtDenselbenText(JsonNode fall) throws IOException {
        String name = fall.path("name").asText();
        String basis = vektoren().path("basis_url").asText();
        MeldungsText.Eingabe e = eingabe(fall.path("eingabe"));
        JsonNode erwartet = fall.path("erwartet");
        MeldungsText.Nachricht a = TEXTE.ausgeloest(e, Instant.parse(fall.path("jetzt").asText()));
        gleich(a, erwartet.path("ausgeloest"), name);
        assertThat(TEXTE.mailText(a, fall.path("kennzeichen").asText(), basis)).as(name + " mail")
                .isEqualTo(erwartet.path("mail").asText());
        if (fall.hasNonNull("jetzt_entwarnung")) {
            MeldungsText.Nachricht n = TEXTE.entwarnung(e, Instant.parse(fall.path("jetzt_entwarnung").asText()));
            gleich(n, erwartet.path("entwarnung"), name + " (Entwarnung)");
            assertThat(TEXTE.mailText(n, fall.path("kennzeichen").asText(), basis)).as(name + " Entwarnungs-Mail")
                    .isEqualTo(erwartet.path("entwarnung_mail").asText());
        }
    }

    @ParameterizedTest(name = "{index}: {0}")
    @MethodSource("faelle")
    void keinSchluesselKeinRohwertKeineIsoZeit(JsonNode fall) {
        MeldungsText.Eingabe e = eingabe(fall.path("eingabe"));
        MeldungsText.Nachricht a = TEXTE.ausgeloest(e, Instant.parse(fall.path("jetzt").asText()));
        List<String> texte = new ArrayList<>(a.saetze());
        texte.addAll(List.of(a.titel(), a.betreff(), a.pushTitel(), a.pushText()));
        if (e.ende() != null) {
            MeldungsText.Nachricht n = TEXTE.entwarnung(e, e.ende().plusSeconds(60));
            texte.addAll(n.saetze());
            texte.addAll(List.of(n.titel(), n.pushTitel(), n.pushText()));
        }
        for (String t : texte) {
            assertThat(VERBOTEN.matcher(t).find()).as("%s: „%s“", fall.path("name").asText(), t).isFalse();
        }
    }

    @Test
    void formateWieInDenVektoren() throws IOException {
        JsonNode v = vektoren();
        v.path("zeit").forEach(z -> assertThat(MeldungsText.zeit(Instant.parse(z.path("t").asText()),
                Instant.parse(z.path("jetzt").asText()))).as(z.toString()).isEqualTo(z.path("erwartet").asText()));
        v.path("dauer").forEach(d -> assertThat(MeldungsText.dauer(d.path("sekunden").asLong()))
                .as(d.toString()).isEqualTo(d.path("erwartet").asText()));
        v.path("zahl").forEach(z -> assertThat(MeldungsText.zahl(z.path("wert").asDouble(),
                z.hasNonNull("einheit") ? z.path("einheit").asText() : null)).as(z.toString())
                .isEqualTo(z.path("erwartet").asText()));
    }

    /** Jede feste Meldungsart und jede Wertart mit Zuständen hat ein Kundenwort je Zustand - kein Rohwert rutscht durch. */
    @Test
    void jederZustandHatEinKundenwort() throws IOException {
        JsonNode katalog = JSON.readTree(getClass().getResourceAsStream("/wertekatalog/katalog.json"));
        for (JsonNode e : katalog.path("eintraege")) {
            List<String> zustaende = new ArrayList<>();
            e.path("zustaende").forEach(z -> zustaende.add(z.asText()));
            if ("ereignis".equals(e.path("form").asText())) {
                e.path("leser").path("arten").forEach(z -> zustaende.add(z.asText()));
            }
            for (String z : zustaende) {
                assertThat(e.path("zustandsworte").hasNonNull(z)).as(e.path("wertart") + " ohne Wort für " + z)
                        .isTrue();
            }
            JsonNode meldung = e.path("meldung");
            if (!meldung.isMissingNode()) {
                for (String feld : List.of("titel", "lage", "ursache", "was_tun", "push", "entwarnung_titel",
                        "entwarnung")) {
                    assertThat(meldung.has(feld)).as(e.path("wertart") + " ohne " + feld).isTrue();
                }
            }
        }
    }

    /** Jede feste Meldungsart: Titel mit Ort, Lage · Ursache · was tun, Push, Entwarnung mit Uhrzeit (§6.3/§6.4). */
    @Test
    void jedeMeldungsartHatTitelSaetzeUndEntwarnung() throws IOException {
        JsonNode katalog = JSON.readTree(getClass().getResourceAsStream("/wertekatalog/katalog.json"));
        Instant beginn = Instant.parse("2026-11-13T11:18:00Z");
        Instant ende = Instant.parse("2026-11-13T12:00:00Z");
        int arten = 0;
        for (JsonNode e : katalog.path("eintraege")) {
            JsonNode art = e.path("meldung");
            if (art.isMissingNode()) {
                continue;
            }
            arten++;
            JsonNode gilt = art.path("gilt_bei");
            boolean zahl = gilt.has("herkunft");
            MeldungsText.Wert wert = zahl ? new MeldungsText.Wert(6.6, "ct/kWh", null, null)
                    : new MeldungsText.Wert(null, null, gilt.path("zustaende").get(0).asText(), null);
            JsonNode bedingung = JSON.readTree(zahl ? "{\"art\":\"unter\",\"schwelle\":8.2,\"dauer_s\":300}"
                    : "{\"art\":\"zustand\",\"dauer_s\":900}");
            MeldungsText.Eingabe eingabe = new MeldungsText.Eingabe(e.path("wertart").asText(),
                    zahl ? gilt.path("herkunft").asText() : "eigen", null, "warnung", "anlage", "Hof Lindenberg",
                    bedingung, wert, beginn, ende);
            String fall = e.path("wertart").asText();
            MeldungsText.Nachricht a = TEXTE.ausgeloest(eingabe, Instant.parse("2026-11-13T12:30:00Z"));
            assertThat(a.titel()).as(fall).isEqualTo("Hof Lindenberg: " + art.path("titel").asText());
            assertThat(a.saetze()).as(fall + ": Lage, Ursache, was tun").hasSize(3);
            assertThat(String.join(" ", a.saetze())).as(fall).contains("12:18 Uhr");
            assertThat(a.pushTitel()).as(fall).isEqualTo("Hof Lindenberg · " + art.path("titel").asText());
            assertThat(a.pushText()).as(fall).endsWith("Tippen für Einzelheiten.");
            MeldungsText.Nachricht n = TEXTE.entwarnung(eingabe, Instant.parse("2026-11-13T12:30:00Z"));
            assertThat(n.titel()).as(fall).isEqualTo("Hof Lindenberg: " + art.path("entwarnung_titel").asText());
            assertThat(n.saetze().getFirst()).as(fall).startsWith("Seit 13:00 Uhr");
            if (art.has("entwarnung_dauer")) {
                assertThat(n.saetze()).as(fall).hasSize(2);
                assertThat(n.saetze().get(1)).as(fall).contains("42 Minuten");
            }
            for (String t : List.of(a.titel(), String.join(" ", a.saetze()), a.pushText(), n.titel(),
                    String.join(" ", n.saetze()))) {
                assertThat(VERBOTEN.matcher(t).find()).as("%s: „%s“", fall, t).isFalse();
            }
        }
        assertThat(arten).as("feste Meldungsarten im Katalog").isEqualTo(14);
    }

    @Test
    void erinnerungNenntWieLangeOffen() throws IOException {
        JsonNode fall = vektoren().path("faelle").get(5); // Lastspitze droht, Dringend
        MeldungsText.Eingabe e = eingabe(fall.path("eingabe"));
        MeldungsText.Nachricht n = TEXTE.erinnerung(e, Instant.parse("2026-11-13T11:20:00Z"));
        assertThat(n.titel()).isEqualTo("Noch offen – Werk Lindach: Lastspitze droht");
        assertThat(n.betreff()).isEqualTo("Dringend: Noch offen – Werk Lindach: Lastspitze droht");
        assertThat(n.saetze().getFirst())
                .isEqualTo("Diese Meldung ist seit 11:15 Uhr offen und noch nicht als gesehen markiert.");
        assertThat(n.pushText()).isEqualTo(n.saetze().getFirst());
    }

    @Test
    void beginnUndEndeRechnenWartezeitUndErholdauerHeraus() throws IOException {
        JsonNode b = JSON.readTree("{\"dauer_s\":900,\"erholen_s\":300}");
        assertThat(MeldungsText.beginn(Instant.parse("2026-11-13T11:33:00Z"), b))
                .isEqualTo(Instant.parse("2026-11-13T11:18:00Z"));
        assertThat(MeldungsText.ende(Instant.parse("2026-11-13T12:05:00Z"), b))
                .isEqualTo(Instant.parse("2026-11-13T12:00:00Z"));
        assertThat(MeldungsText.ende(Instant.parse("2026-11-13T12:05:00Z"), null))
                .isEqualTo(Instant.parse("2026-11-13T12:00:00Z"));
    }
}
