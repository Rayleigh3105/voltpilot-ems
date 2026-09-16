package com.voltpilot.api.uems;

import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

/**
 * Noch nicht ausführbare Teile der AP-04-Abnahme. Jeder Fall nennt den zuständigen Nachbarn;
 * die bereits grünen Kerne und ihre Methoden stehen im Wegweiser
 * {@code docs/agents/root/uems-messstellenregister-abnahme.md}.
 */
class MessstellenregisterNachbarbedarfTest {

    @Test
    void a2BerichtsfolgenDesSpaetenWechsels() {
        BerichtRegeln.Struktur folge = BerichtRegeln.struktur(BerichtRegeln.MESSSTELLE_AENDERUNG,
                StrukturAufloesung.MESSSTELLE, "zaehler_gewechselt", true, false);
        assertThat(folge.anstossArt()).isEqualTo(BerichtRegeln.ZUORDNUNG_RUECKWIRKEND);
        assertThat(folge.grund()).isNull();
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

    @Test
    void a13ArchivierungLaesstJuniBerichtUnveraendert() {
        BerichtRegeln.Struktur folge = BerichtRegeln.struktur(BerichtRegeln.MESSSTELLE_AENDERUNG,
                StrukturAufloesung.MESSSTELLE, "archiviert", true, false);
        assertThat(folge.anstossArt()).isNull();
        assertThat(folge.grund()).isEqualTo(BerichtRegeln.KEINE_STRUKTURAENDERUNG);
    }

}
