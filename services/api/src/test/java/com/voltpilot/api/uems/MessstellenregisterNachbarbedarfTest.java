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

    @Disabled("A3 · Nachbar Wechselkorrektur: Ein angekündigter Wechsel hat noch keinen Korrektur-Schreibweg 10:00 → 10:40")
    @Test
    void a3AngekuendigtenWechselzeitpunktKorrigieren() {
        fail("Korrektur-Schreibweg für angekündigte Zählerwechsel fehlt");
    }

    @Disabled("A4 · Nachbar Register-Fakten: Einstellungsänderungen erscheinen noch nicht als Fakt in beiden Registerzeilen")
    @Test
    void a4EinstellungsfaktImRegister() {
        fail("Register-Fakt für Einstellungsänderungen fehlt");
    }

    @Disabled("A5 · Nachbar AP-06/Edge: Eine angewendete Wandlerfassung wird noch nicht an die Box zugestellt")
    @Test
    void a5WandlerfaktorAbGueltigkeitsbeginnAnDieBoxZustellen() {
        fail("Edge-Zustellung der angewendeten Wandlerfassung fehlt");
    }

    @Disabled("A10 · Nachbar AP-13: MS-21 Gas bietet auf der Wertefläche noch 'Quelle zuordnen' an")
    @Test
    void a10GasBietetKeinenKatalogQuellenwegAn() {
        fail("Portalweg für Gas widerspricht der serverseitigen Ablehnung medium_ohne_quelle");
    }

    @Disabled("A13 · Nachbar AP-12: Der unveränderte Juni-Bericht nach Archivierung ist noch nicht Ende-zu-Ende gekoppelt")
    @Test
    void a13ArchivierungLaesstJuniBerichtUnveraendert() {
        fail("Berichts-Bestandsschutz über die Messstellenarchivierung fehlt");
    }

    @Disabled("A16 · Nachbar AP-08: Die 5-/2-Minuten-Lücke am Zählerwechsel ist noch nicht als Viertelstunden- und Tagesurteil gekoppelt")
    @Test
    void a16LueckeBleibtInViertelstundenUndTagSichtbar() {
        fail("Periodenurteil über die Zählerwechsel-Lücke fehlt");
    }
}
