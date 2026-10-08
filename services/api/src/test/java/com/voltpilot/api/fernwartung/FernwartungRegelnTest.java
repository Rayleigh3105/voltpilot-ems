package com.voltpilot.api.fernwartung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Die reinen Regeln der Fernwartung, ohne Datenbank und ohne Docker:
 * Adressvergabe, Schlüsselprüfung, Konfiguration und die Form des Soll-Stands
 * gegen den Vertragsvektor, den auch der Tunnel-Dienst (Go) liest.
 */
class FernwartungRegelnTest {

    private static final Path VEKTOR =
            Path.of("..", "..", "docs", "contracts", "fernwartung-soll-v1.example.json");

    // ── Netz ──────────────────────────────────────────────────────────────

    @Test
    void dieVergabeBeginntNachDemServerUndUeberspringtNullUndZweihundertfuenfundfuenfzig() {
        Ipv4Netz netz = Ipv4Netz.parse("10.10.16.0/20");
        assertThat(Ipv4Netz.text(netz.serverAdresse())).isEqualTo("10.10.16.1");
        assertThat(netz.freieAdresse(Set.of()).map(Ipv4Netz::text)).contains("10.10.16.2");

        Set<Integer> belegt = new java.util.HashSet<>();
        for (int a = Ipv4Netz.adresse("10.10.16.2"); a <= Ipv4Netz.adresse("10.10.16.254"); a++) {
            belegt.add(a);
        }
        // .255 und .0 sehen in einer Konfiguration wie Tippfehler aus.
        assertThat(netz.freieAdresse(belegt).map(Ipv4Netz::text)).contains("10.10.17.1");
    }

    @Test
    void einVollesNetzMeldetSichStattEineAdresseZuErfinden() {
        Ipv4Netz netz = Ipv4Netz.parse("10.10.32.0/30");
        // /30: .0 Netz, .1 Server, .2 frei, .3 Broadcast.
        assertThat(netz.freieAdresse(Set.of()).map(Ipv4Netz::text)).contains("10.10.32.2");
        assertThat(netz.freieAdresse(Set.of(Ipv4Netz.adresse("10.10.32.2")))).isEmpty();
    }

    @Test
    void falscheNetzeWerdenAbgelehnt() {
        assertThatThrownBy(() -> Ipv4Netz.parse("10.10.16.5/20")).hasMessageContaining("keine Netzadresse");
        assertThatThrownBy(() -> Ipv4Netz.parse("10.10.16.0")).hasMessageContaining("CIDR");
        assertThatThrownBy(() -> Ipv4Netz.parse("10.10.256.0/24")).hasMessageContaining("IPv4");
        assertThatThrownBy(() -> Ipv4Netz.parse("10.10.16.0/31")).hasMessageContaining("/30");
        assertThat(Ipv4Netz.parse("10.10.16.0/20").enthaelt(Ipv4Netz.adresse("10.10.31.254"))).isTrue();
        assertThat(Ipv4Netz.parse("10.10.16.0/20").enthaelt(Ipv4Netz.adresse("10.10.32.2"))).isFalse();
    }

    // ── Schlüssel ─────────────────────────────────────────────────────────

    @Test
    void nurEchteOeffentlicheWireguardSchluesselGehenDurch() {
        assertThat(WireguardSchluessel.gueltig("jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=")).isTrue();
        assertThat(WireguardSchluessel.gueltig("LnLMuBG+dDEeaEKlQrdTlPifX2fk0hOaB/NFc/BudjE=")).isTrue();
        // 4 Nutzbits im letzten Zeichen: 'B' ist kein gültiges Ende.
        assertThat(WireguardSchluessel.gueltig("jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEB=")).isFalse();
        assertThat(WireguardSchluessel.gueltig("jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM")).isFalse();
        assertThat(WireguardSchluessel.gueltig("")).isFalse();
        assertThat(WireguardSchluessel.gueltig(null)).isFalse();
        assertThat(WireguardSchluessel.kurz("jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM="))
                .isEqualTo("jUg9DePF…5HiEM=");
    }

    // ── Konfiguration ─────────────────────────────────────────────────────

    @Test
    void dieVorgabenSindDokumentiertUndInSichStimmig() {
        FernwartungProperties p = new FernwartungProperties(null, null, null, null, 0, "");
        assertThat(p.boxNetz()).isEqualTo("10.10.16.0/20");
        assertThat(p.technikerNetz()).isEqualTo("10.10.32.0/24");
        assertThat(p.maxFensterDauer()).isEqualTo(Duration.ofHours(24));
        assertThat(p.serverEndpunkt()).isEqualTo("wartung.voltpilot.de");
        assertThat(p.serverPort()).isEqualTo(51820);
        assertThat(p.serverPublicKey()).isNull();
    }

    @Test
    void eineWidersinnigeKonfigurationBrichtDenStartAb() {
        assertThatThrownBy(() -> new FernwartungProperties("10.10.0.0/16", "10.10.32.0/24", null, null, 0, null))
                .hasMessageContaining("überschneiden");
        assertThatThrownBy(() -> new FernwartungProperties(null, null, Duration.ofDays(8), null, 0, null))
                .hasMessageContaining("7 Tagen");
        assertThatThrownBy(() -> new FernwartungProperties(null, null, null, null, 0, "kein-schluessel"))
                .hasMessageContaining("Schlüssel");
        assertThatThrownBy(() -> new FernwartungProperties(null, null, null, null, 70000, null))
                .hasMessageContaining("Port");
    }

    @Test
    void dauerTextFuerFehlermeldungen() {
        assertThat(FernwartungService.dauerText(Duration.ofHours(24))).isEqualTo("24 Stunden");
        assertThat(FernwartungService.dauerText(Duration.ofHours(1))).isEqualTo("1 Stunde");
        assertThat(FernwartungService.dauerText(Duration.ofMinutes(90))).isEqualTo("90 Minuten");
    }

    // ── Vertrag ───────────────────────────────────────────────────────────

    /**
     * Der Soll-Stand, wie die API ihn serialisiert, trägt auf jeder Ebene genau
     * die Felder des Vertragsvektors - denselben, den der Tunnel-Dienst in
     * seinem Test STRENG (unbekannte Felder verboten) einliest. Ein neues oder
     * umbenanntes Feld fällt so auf beiden Seiten auf.
     */
    @Test
    void derSollStandHatDieFelderDesVertragsvektors() throws Exception {
        ObjectMapper json = new ObjectMapper().registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        UUID box = UUID.randomUUID();
        UUID techniker = UUID.randomUUID();
        FernwartungService.Soll soll = new FernwartungService.Soll(1, Instant.parse("2026-10-07T14:00:00Z"),
                "10.10.16.0/20", "10.10.32.0/24",
                List.of(new FernwartungService.SollPeer("box", box, "edge-zay5sdd",
                                "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=", "10.10.16.2"),
                        new FernwartungService.SollPeer("techniker", techniker, "Max (Laptop)",
                                "FY4LLXFaOvh8LPZu/gA4AeS2WJjXkuOUPB4hlxBI8/Y=", "10.10.32.2")),
                List.of(new FernwartungService.SollFenster(UUID.randomUUID(), box, techniker,
                        Instant.parse("2026-10-07T13:30:00Z"), Instant.parse("2026-10-07T17:30:00Z"))));
        JsonNode ist = json.readTree(json.writeValueAsString(soll));
        JsonNode vektor = json.readTree(Files.readString(VEKTOR));

        assertThat(felder(ist)).isEqualTo(felder(vektor));
        assertThat(felder(ist.get("peers").get(0))).isEqualTo(felder(vektor.get("peers").get(0)));
        assertThat(felder(ist.get("fenster").get(0))).isEqualTo(felder(vektor.get("fenster").get(0)));
        assertThat(ist.get("version").asInt()).isEqualTo(vektor.get("version").asInt());
        // Zeitpunkte als ISO-8601-Text, nie als Zahl.
        assertThat(ist.get("fenster").get(0).get("ende").isTextual()).isTrue();

        // Der Vektor selbst hält die Regeln, die der Dienst prüft.
        for (JsonNode peer : vektor.get("peers")) {
            assertThat(WireguardSchluessel.gueltig(peer.get("publicKey").asText())).isTrue();
            Ipv4Netz netz = Ipv4Netz.parse(vektor.get("box".equals(peer.get("art").asText())
                    ? "boxNetz" : "technikerNetz").asText());
            assertThat(netz.enthaelt(Ipv4Netz.adresse(peer.get("adresse").asText()))).isTrue();
        }
    }

    private static Set<String> felder(JsonNode knoten) {
        Set<String> namen = new TreeSet<>();
        for (Iterator<String> it = knoten.fieldNames(); it.hasNext();) {
            namen.add(it.next());
        }
        return namen;
    }
}
