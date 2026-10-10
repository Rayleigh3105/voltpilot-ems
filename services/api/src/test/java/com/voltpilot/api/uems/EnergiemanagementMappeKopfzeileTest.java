package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Review r1 P6-2: die Kopfzeile der Mappen-CSV ist genau eine Zeile. Der Name kommt aus dem Konto; ein Name mit
 * Zeilenumbruch und „=…“ darf keine eigene Zeile beginnen, die eine Tabellenkalkulation als Formel liest.
 */
class EnergiemanagementMappeKopfzeileTest {

    @Test
    void einNameMitZeilenumbruchBleibtInDerKopfzeile() {
        String kopf = EnergiemanagementMappeService.kopfzeile("Unterlagen für das Audit", "Audit von außen",
                "Ines Kaltenbach\r\n=HYPERLINK(\"https://example.invalid\";\"Klick\")");
        assertThat(kopf).endsWith("\r\n");
        String ohneEnde = kopf.substring(0, kopf.length() - 2);
        assertThat(ohneEnde).doesNotContain("\r").doesNotContain("\n");
        assertThat(kopf.split("\r\n", -1)).hasSize(2).allSatisfy(z -> assertThat(z).doesNotStartWith("="));
        assertThat(ohneEnde).isEqualTo("# Unterlagen für das Audit (Audit von außen), zusammengestellt von Ines Kaltenbach "
                + "=HYPERLINK(\"https://example.invalid\";\"Klick\")");
    }

    @Test
    void auchSeltenereZeilentrennerUndSteuerzeichenFallenWeg() {
        String kopf = EnergiemanagementMappeService.kopfzeile("Titel zwei", "Anlass\u0085", "Name\u0000\tmit Tab");
        assertThat(kopf).isEqualTo("# Titel zwei (Anlass), zusammengestellt von Name mit Tab\r\n");
    }
}
