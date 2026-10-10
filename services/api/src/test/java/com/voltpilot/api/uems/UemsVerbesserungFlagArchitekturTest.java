package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Der Flag-Nachweis der Verbesserung (UEMS AP-18 IP-15, §6.6): {@code voltpilot.uems.verbesserung.enabled} (Vorgabe AN)
 * schaltet NUR die Auffälligkeits-Naht ({@link VerbesserungNaht}; seit IP-17 auch den Anstoß am Vorgang) — keine
 * Route, kein DTO, kein Portal, kein Läufer liest ihn; der Testlauf lässt sie an. Die Reihenfolge der Not-Aus-Tabelle hält {@code UemsBezugsbasisFlagArchitekturTest}.
 * Und die Naht hängt IN der Transaktion des Werts: im Regellauf von {@link KennzahlLauf} nach dem Schreiben der Zeile, in
 * der {@link KennzahlKaskade} nach {@code KennzahlNeuGebildet.melden}.
 *
 * <p>Ein reiner Quelltext-Wächter ohne Datenbank; das Verhalten prüft {@code VerbesserungNahtTest}.
 */
class UemsVerbesserungFlagArchitekturTest {

    private static final String SCHALTER = "voltpilot.uems.verbesserung.enabled";
    private static final Path MAIN = Path.of("src", "main", "java");
    private static final Path UEMS = MAIN.resolve("com/voltpilot/api/uems");

    @Test
    void derSchalterLiestNurDieNaht() throws IOException {
        assertThat(quellen().filter(p -> text(p).contains(SCHALTER)).map(p -> p.getFileName().toString()).toList())
                .as("wer %s nennt", SCHALTER).containsExactly("VerbesserungNaht.java");
        assertThat(text(UEMS.resolve("VerbesserungNaht.java"))).as("ein Feld mit Vorgabe AN, keine Bean-Bedingung")
                .contains("@Value(\"${\" + SCHALTER + \":true}\")").doesNotContain("@ConditionalOnProperty");
        assertThat(VerbesserungNaht.SCHALTER).isEqualTo(SCHALTER);
        assertThat(quellen().filter(p -> text(p).contains("VerbesserungNaht.SCHALTER")).toList())
                .as("niemand liest den Schalter über die Konstante").isEmpty();
        assertThat(text(Path.of("src", "main", "resources", "application.yml")))
                .contains("enabled: ${VOLTPILOT_UEMS_VERBESSERUNG_ENABLED:true}");
        assertThat(text(Path.of("pom.xml"))).as("surefire lässt die Naht an").doesNotContain(SCHALTER);
    }

    @Test
    void keineRouteUndKeinPortalKenntDenSchalter() throws IOException {
        assertThat(quellen().filter(p -> p.toString().contains("/web/"))
                .filter(p -> text(p).contains("uems.verbesserung") || text(p).contains("VerbesserungNaht")).toList())
                .as("Controller und DTOs").isEmpty();
        try (Stream<Path> portal = Files.walk(Path.of("..", "..", "frontend", "portal", "src"))) {
            assertThat(portal.filter(p -> p.toString().endsWith(".ts") || p.toString().endsWith(".tsx"))
                    .filter(p -> text(p).contains("VERBESSERUNG_ENABLED") || text(p).contains("verbesserung.enabled"))
                    .toList()).as("das Portal hat keinen Schalter").isEmpty();
        }
    }

    /** Takt: nach dem Schreiben der Zeile, in DERSELBEN Transaktion ({@code inTransaktion}); Kaskade: nach der Meldung. */
    @Test
    void dieNahtHaengtInDerTransaktionDesWerts() {
        String lauf = text(UEMS.resolve("KennzahlLauf.java"));
        int transaktion = lauf.indexOf("ausgang = inTransaktion(con -> {");
        int zeile = lauf.indexOf("zeile(con, r, f, art, p, bisher, b, zustand, am, endgueltigAb, false)", transaktion);
        int naht = lauf.indexOf("verbesserung.vermerken(con, ", zeile);
        int ende = lauf.indexOf("});", zeile);
        assertThat(List.of(transaktion, zeile, naht)).as("Regellauf").allMatch(i -> i > 0);
        assertThat(naht).as("im Lambda der Transaktion").isLessThan(ende);

        String kaskade = text(UEMS.resolve("KennzahlKaskade.java"));
        int melden = kaskade.indexOf("KennzahlNeuGebildet.melden(con, ");
        int vermerken = kaskade.indexOf("verbesserung.vermerken(con, betroffen.tenant(), n.endgueltig()");
        assertThat(melden).isPositive();
        assertThat(vermerken).as("nach KennzahlNeuGebildet.melden").isGreaterThan(melden);
    }

    /**
     * IP-17 (M5): der Anstoß am Vorgang läuft über denselben Schalter — Pfad 1 in der Kaskade NACH dem
     * Bezugsbasis-Anstoß Pfad 1 (dieselbe Verbindung, dieselbe Anlass-Kennung), Pfad 2 im Zweig der Bezugsbasis des
     * Struktur-Läufers VOR dem Wasserzeichen; {@link VorgangAnstoss} ruft niemand an der Naht vorbei.
     */
    @Test
    void derAnstossAmVorgangHaengtAnDerNaht() throws IOException {
        String kaskade = text(UEMS.resolve("KennzahlKaskade.java"));
        int basis = kaskade.indexOf("bezugsbasis.nachKorrektur(con, betroffen, n.neu())");
        int anstossen = kaskade.indexOf("verbesserung.anstossen(con, betroffen.tenant(), "
                + "BezugsbasisAnstoss.kennung(betroffen), n.neu(),");
        assertThat(basis).isPositive();
        assertThat(anstossen).as("nach dem Bezugsbasis-Anstoß Pfad 1").isGreaterThan(basis);

        String anstoss = text(UEMS.resolve("BezugsbasisAnstoss.java"));
        int zweig = anstoss.indexOf("verbesserung.messgrundlage(con, z.tenant(), z.objekt(), z.art(), z.id(), jetzt)");
        int wasserzeichen = anstoss.indexOf("INSERT INTO bezugsbasis_struktur_gelesen");
        assertThat(zweig).isPositive();
        assertThat(zweig).as("vor dem Wasserzeichen, in lesen()").isLessThan(wasserzeichen);

        assertThat(quellen().filter(p -> text(p).contains("VorgangAnstoss.nachKorrektur(")
                        || text(p).contains("VorgangAnstoss.anVorgaengen("))
                .map(p -> p.getFileName().toString()).toList()).containsExactly("VerbesserungNaht.java");
    }

    private static Stream<Path> quellen() throws IOException {
        try (Stream<Path> s = Files.walk(MAIN)) {
            return s.filter(p -> p.toString().endsWith(".java")).toList().stream();
        }
    }

    private static String text(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            throw new IllegalStateException(p.toString(), e);
        }
    }
}
