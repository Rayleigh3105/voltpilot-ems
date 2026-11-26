package com.voltpilot.api.direktvermarktung;

import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.CA;
import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.CERT_ABGELAUFEN;
import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.CERT_GUELTIG;
import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.KEY;
import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.OVPN_GUELTIG;
import static com.voltpilot.api.direktvermarktung.ZugangsdateiTestfixturen.baueZip;
import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Konzept vp-direktvermarktung-konzept d2 §5.7 "Die Zugangsdatei": der Öffner arbeitet gegen
 * passwortgeschützte ZIPs ({@link ZugangsdateiTestfixturen}, zip4j, in-memory) - kein Byte berührt die
 * Platte, auch im Test nicht.
 */
class ZugangsdateiOeffnerTest {

    private final ObjectMapper json = new ObjectMapper();
    private final ZugangsdateiOeffner oeffner = new ZugangsdateiOeffner(json);

    @Test
    void oeffnetEineEchteZugangsdateiUndBautDasKlartextJson() throws Exception {
        Map<String, String> eintraege = new LinkedHashMap<>();
        eintraege.put("ABC_1234567.ovpn", OVPN_GUELTIG);
        byte[] zip = baueZip("geheim123", eintraege);

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Erfolg.class);
        ZugangsdateiOeffner.Geoeffnet g = ((ZugangsdateiOeffner.Erfolg) r).geoeffnet();
        assertThat(g.fingerabdruck()).matches("^[0-9a-f]{2}(:[0-9a-f]{2}){31}$");
        assertThat(g.gueltigBis()).isAfter(Instant.parse("2036-01-01T00:00:00Z"));
        assertThat(g.klartext().path("gegenstelle").path("host").asText()).isEqualTo("vpn.luox-energy.de");
        assertThat(g.klartext().path("gegenstelle").path("port").asInt()).isEqualTo(1194);
        assertThat(g.klartext().path("gegenstelle").path("protokoll").asText()).isEqualTo("udp");
        assertThat(g.klartext().path("tls_schluessel").asText()).isEqualTo("tls_crypt");
        assertThat(g.klartext().path("dateien").path("zertifikat_pem").asText()).contains("BEGIN CERTIFICATE");
        assertThat(g.klartext().path("dateien").path("schluessel_pem").asText()).contains("BEGIN PRIVATE KEY");
        assertThat(g.klartext().path("dateien").path("ca_pem").asText()).contains("BEGIN CERTIFICATE");
        assertThat(g.klartext().path("dateien").path("tls_schluessel_pem").asText()).contains("OpenVPN Static key");
    }

    @Test
    void falschesPasswortWirdAlsSolchesErkanntNieAlsBeschaedigt() throws Exception {
        Map<String, String> eintraege = Map.of("ABC.ovpn", OVPN_GUELTIG);
        byte[] zip = baueZip("geheim123", eintraege);

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "falsches-passwort", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler()).isEqualTo(ZugangsdateiOeffner.Fehler.PASSWORT_FALSCH);
    }

    @Test
    void garKeinZipGiltAlsKeineZugangsdateiNichtAlsBeschaedigt() {
        // zip4j findet in gar keinem ZIP-Container auch keinen einzigen Eintrag (kein Fehler, keine
        // Ausnahme) - das ist derselbe Fall wie ein ZIP ohne die erwartete Konfiguration; die hilfreichere
        // Meldung ist "keine Zugangsdatei von luox" (die .zip aus der E-Mail wählen), nicht "beschädigt"
        // (das suggerierte faelschlich, es sei die richtige Datei gewesen).
        byte[] zufall = "das ist offensichtlich kein ZIP".getBytes(StandardCharsets.UTF_8);

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zufall, "irgendein-passwort", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }

    @Test
    void einZipOhneOvpnOderMitFehlendenBloeckenIstKeineZugangsdatei() throws Exception {
        Map<String, String> eintraege = Map.of("readme.txt", "Hallo Welt");
        byte[] zip = baueZip("geheim123", eintraege);

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }

    @Test
    void einZertifikatOhneCaOderSchluesselIstEbenfallsKeineZugangsdatei() throws Exception {
        String ovpnOhneKey = """
                remote vpn.luox-energy.de 1194 udp
                <cert>
                %s</cert>
                """.formatted(CERT_GUELTIG);
        byte[] zip = baueZip("geheim123", Map.of("x.ovpn", ovpnOhneKey));

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }

    @Test
    void zuVieleEintraegeGeltenAlsBeschaedigtZipBombenSchutz() throws Exception {
        Map<String, String> eintraege = new LinkedHashMap<>();
        for (int i = 0; i < 25; i++) eintraege.put("datei" + i + ".txt", "x");
        byte[] zip = baueZip("geheim123", eintraege);

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler()).isEqualTo(ZugangsdateiOeffner.Fehler.BESCHAEDIGT);
    }

    @Test
    void einZuGrosserEintragGiltAlsBeschaedigtZipBombenSchutz() throws Exception {
        byte[] zip = baueZip("geheim123", Map.of("riesig.ovpn", "x".repeat(200_000)));

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler()).isEqualTo(ZugangsdateiOeffner.Fehler.BESCHAEDIGT);
    }

    @Test
    void einEintragsnameMitPfadausbruchGiltAlsBeschaedigt() throws Exception {
        byte[] zip = baueZip("geheim123", Map.of("../../etc/passwd", "x"));

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.now());

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler()).isEqualTo(ZugangsdateiOeffner.Fehler.BESCHAEDIGT);
    }

    @Test
    void einAbgelaufenesZertifikatWirdAbgelehntNichtAlsErfolgDurchgewinkt() throws Exception {
        String ovpnAbgelaufen = """
                remote vpn.luox-energy.de 1194 udp
                <ca>
                %s</ca>
                <cert>
                %s</cert>
                <key>
                %s</key>
                """.formatted(CA, CERT_ABGELAUFEN, KEY);
        byte[] zip = baueZip("geheim123", Map.of("abgelaufen.ovpn", ovpnAbgelaufen));

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler()).isEqualTo(ZugangsdateiOeffner.Fehler.ABGELAUFEN);
    }

    @Test
    void ohneTlsSchluesselBlockStehtKeineAlsTlsSchluesselArt() throws Exception {
        String ovpnOhneTls = """
                remote vpn.luox-energy.de 1194 udp
                <ca>
                %s</ca>
                <cert>
                %s</cert>
                <key>
                %s</key>
                """.formatted(CA, CERT_GUELTIG, KEY);
        byte[] zip = baueZip("geheim123", Map.of("x.ovpn", ovpnOhneTls));

        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));

        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Erfolg.class);
        ZugangsdateiOeffner.Geoeffnet g = ((ZugangsdateiOeffner.Erfolg) r).geoeffnet();
        assertThat(g.klartext().path("tls_schluessel").asText()).isEqualTo("keine");
        assertThat(g.klartext().path("dateien").has("tls_schluessel_pem")).isFalse();
    }

    @Test
    void ohnePasswortOderOhneInhaltIstKeineZugangsdatei() {
        assertThat(((ZugangsdateiOeffner.Fehlschlag) oeffner.oeffne(new byte[0], "x", Instant.now())).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) oeffner.oeffne(new byte[] {1, 2, 3}, "", Instant.now())).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }
}
