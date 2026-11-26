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

    /** Baut die gültige Konfiguration mit einer anderen ersten {@code remote}-Zeile. */
    private static String ovpnMitRemote(String remoteZeile) {
        return OVPN_GUELTIG.replace("remote vpn.luox-energy.de 1194 udp", remoteZeile);
    }

    private ZugangsdateiOeffner.Fehler fehlerFuerRemote(String remoteZeile) throws Exception {
        byte[] zip = baueZip("geheim123", Map.of("x.ovpn", ovpnMitRemote(remoteZeile)));
        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));
        assertThat(r).as(remoteZeile).isInstanceOf(ZugangsdateiOeffner.Fehlschlag.class);
        return ((ZugangsdateiOeffner.Fehlschlag) r).fehler();
    }

    @Test
    void einHostDerKeinDnsNameUndKeinIpLiteralIstWirdAbgelehnt() throws Exception {
        for (String remote : new String[] {
            "remote vpn.luox_energy.de 1194 udp", // Unterstrich
            "remote vpn.luox-energy.de/pfad 1194 udp", // Pfadzeichen
            "remote -vpn.luox-energy.de 1194 udp", // führender Bindestrich
            "remote vpn..luox-energy.de 1194 udp", // leeres Label
            "remote " + "a".repeat(254) + " 1194 udp", // zu lang
            "remote 2001:db8:::1 1194 udp", // kein gültiges IPv6-Literal
            "remote host;rm${IFS}-rf 1194 udp", // Shell-Metazeichen
        }) {
            assertThat(fehlerFuerRemote(remote)).as(remote)
                    .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
        }
    }

    @Test
    void einPortAusserhalbVon1Bis65535WirdAbgelehntAuchJenseitsDesIntBereichs() throws Exception {
        for (String remote : new String[] {
            "remote vpn.luox-energy.de 0 udp",
            "remote vpn.luox-energy.de 65536 udp",
            "remote vpn.luox-energy.de 999999999999 udp", // überliefe Integer.parseInt
            "remote vpn.luox-energy.de -1194 udp",
            "remote vpn.luox-energy.de elf udp",
        }) {
            assertThat(fehlerFuerRemote(remote)).as(remote)
                    .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
        }
    }

    @Test
    void nurTcpOderUdpGiltAlsProtokollUndMehrTokenGeltenNicht() throws Exception {
        for (String remote : new String[] {
            "remote vpn.luox-energy.de 1194 tcp-client",
            "remote vpn.luox-energy.de 1194 tcp4",
            "remote vpn.luox-energy.de 1194 icmp",
            "remote vpn.luox-energy.de 1194 udp extra",
            "remote vpn.luox-energy.de", // Port fehlt
        }) {
            assertThat(fehlerFuerRemote(remote)).as(remote)
                    .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
        }
    }

    @Test
    void ipLiteraleUndTcpGehenDurchUndDerHostWirdKleingeschrieben() throws Exception {
        byte[] zip = baueZip("geheim123",
                Map.of("x.ovpn", ovpnMitRemote("REMOTE VPN.Luox-Energy.DE 443 TCP")));
        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));
        ZugangsdateiOeffner.Geoeffnet g = ((ZugangsdateiOeffner.Erfolg) r).geoeffnet();
        assertThat(g.klartext().path("gegenstelle").path("host").asText()).isEqualTo("vpn.luox-energy.de");
        assertThat(g.klartext().path("gegenstelle").path("port").asInt()).isEqualTo(443);
        assertThat(g.klartext().path("gegenstelle").path("protokoll").asText()).isEqualTo("tcp");

        for (String host : new String[] {"203.0.113.10", "2001:db8::10", "::ffff:192.0.2.1"}) {
            byte[] ipZip = baueZip("geheim123", Map.of("x.ovpn", ovpnMitRemote("remote " + host + " 1194 udp")));
            ZugangsdateiOeffner.Ergebnis ip = oeffner.oeffne(ipZip, "geheim123",
                    Instant.parse("2026-11-26T00:00:00Z"));
            assertThat(ip).as(host).isInstanceOf(ZugangsdateiOeffner.Erfolg.class);
        }
    }

    @Test
    void dieErsteRemoteZeileEntscheidetEineUngueltigeWeichtNieAufEineSpaetereAus() throws Exception {
        String zweiZeilen = ovpnMitRemote("remote boese;zeile 1194 udp\nremote vpn.luox-energy.de 1194 udp");
        byte[] zip = baueZip("geheim123", Map.of("x.ovpn", zweiZeilen));
        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));
        assertThat(((ZugangsdateiOeffner.Fehlschlag) r).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }

    @Test
    void remoteCertTlsZaehltNichtAlsRemoteZeile() throws Exception {
        String konfiguration = "remote-cert-tls server\n" + OVPN_GUELTIG;
        byte[] zip = baueZip("geheim123", Map.of("x.ovpn", konfiguration));
        ZugangsdateiOeffner.Ergebnis r = oeffner.oeffne(zip, "geheim123", Instant.parse("2026-11-26T00:00:00Z"));
        assertThat(r).isInstanceOf(ZugangsdateiOeffner.Erfolg.class);
        assertThat(((ZugangsdateiOeffner.Erfolg) r).geoeffnet().klartext().path("gegenstelle").path("host").asText())
                .isEqualTo("vpn.luox-energy.de");
    }

    @Test
    void dieGegenstellenSchrankeLaesstNurGelisteteHostsDurch() throws Exception {
        byte[] zip = baueZip("geheim123", Map.of("x.ovpn", OVPN_GUELTIG));
        Instant jetzt = Instant.parse("2026-11-26T00:00:00Z");

        assertThat(oeffner.oeffne(zip, "geheim123", jetzt, java.util.List.of("vpn.luox-energy.de")))
                .isInstanceOf(ZugangsdateiOeffner.Erfolg.class);
        assertThat(oeffner.oeffne(zip, "geheim123", jetzt, java.util.List.of("*.luox-energy.de")))
                .isInstanceOf(ZugangsdateiOeffner.Erfolg.class);
        assertThat(oeffner.oeffne(zip, "geheim123", jetzt, java.util.List.of())) // leer = keine Schranke
                .isInstanceOf(ZugangsdateiOeffner.Erfolg.class);

        ZugangsdateiOeffner.Ergebnis fremd =
                oeffner.oeffne(zip, "geheim123", jetzt, java.util.List.of("vpn.anderer.de", "*.anderer.de"));
        assertThat(((ZugangsdateiOeffner.Fehlschlag) fremd).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);

        // Ein ungültiges Muster passt NIE (geschlossen scheitern), auch wenn es "ähnlich aussieht".
        ZugangsdateiOeffner.Ergebnis kaputt =
                oeffner.oeffne(zip, "geheim123", jetzt, java.util.List.of("*luox-energy.de"));
        assertThat(((ZugangsdateiOeffner.Fehlschlag) kaputt).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }

    @Test
    void ohnePasswortOderOhneInhaltIstKeineZugangsdatei() {
        assertThat(((ZugangsdateiOeffner.Fehlschlag) oeffner.oeffne(new byte[0], "x", Instant.now())).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
        assertThat(((ZugangsdateiOeffner.Fehlschlag) oeffner.oeffne(new byte[] {1, 2, 3}, "", Instant.now())).fehler())
                .isEqualTo(ZugangsdateiOeffner.Fehler.KEINE_ZUGANGSDATEI);
    }
}
