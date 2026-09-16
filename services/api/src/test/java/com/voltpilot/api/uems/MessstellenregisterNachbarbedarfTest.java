package com.voltpilot.api.uems;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.fail;

/**
 * Noch nicht ausführbare Teile der AP-04-Abnahme. Jeder Fall nennt den zuständigen Nachbarn;
 * die bereits grünen Kerne und ihre Methoden stehen im Wegweiser
 * {@code docs/agents/root/uems-messstellenregister-abnahme.md}.
 */
class MessstellenregisterNachbarbedarfTest {

    @Disabled("A2 · Nachbar AP-12: Die Folgen-Karte muss die betroffenen Tagesberichte 18./19.11. nennen")
    @Test
    void a2BerichtsfolgenDesSpaetenWechsels() {
        fail("AP-12 muss Berichtsfolgen des Zählerwechsels liefern");
    }

    @Disabled("A3 · eigener Folge-Schnitt: Korrektur braucht neue Rechte für sechs Zeitachsen und einen autorisierten Schreibweg")
    @Test
    void a3AngekuendigtenWechselzeitpunktKorrigieren() {
        fail("Korrektur-Schreibweg für angekündigte Zählerwechsel fehlt");
    }

    @Disabled("A5 · Nachbar AP-06/Edge: Eine angewendete Wandlerfassung wird noch nicht an die Box zugestellt")
    @Test
    void a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen() {
        fail("Edge-Zustellung der angewendeten Wandlerfassung fehlt");
    }

    @Disabled("A13 · Nachbar AP-12: Der unveränderte Juni-Bericht nach Archivierung ist noch nicht Ende-zu-Ende gekoppelt")
    @Test
    void a13ArchivierungLaesstJuniBerichtUnveraendert() {
        fail("Berichts-Bestandsschutz über die Messstellenarchivierung fehlt");
    }

}
