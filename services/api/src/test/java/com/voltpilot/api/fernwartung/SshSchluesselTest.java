package com.voltpilot.api.fernwartung;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Die Regeln für den öffentlichen SSH-Schlüssel eines Technikers, ohne
 * Datenbank und ohne Docker. Die Schlüssel entstehen zur Laufzeit
 * ({@link SshTestSchluessel}); fest steht nur der öffentliche Schlüssel des
 * Vertragsvektors, dessen Fingerabdruck einmal mit {@code ssh-keygen -lf}
 * (OpenSSH 10.0) bestimmt wurde.
 */
class SshSchluesselTest {

    private static final Path VEKTOR =
            Path.of("..", "..", "docs", "contracts", "fernwartung-soll-v1.example.json");

    private static final BigInteger E = BigInteger.valueOf(65537);

    // ── Angenommen ────────────────────────────────────────────────────────

    @Test
    void rsaAbZweitausendachtundvierzigBitWirdAngenommenUndInNormalformGebracht() {
        for (int bits : new int[] {2048, 3072, 4096}) {
            String zeile = SshTestSchluessel.rsa(bits);
            SshSchluessel.Geprueft g = SshSchluessel.pruefe(zeile);
            assertThat(g.zeile()).as("%d Bit", bits).isEqualTo(zeile);
            assertThat(g.bits()).isEqualTo(bits);
            assertThat(g.fingerabdruck()).isEqualTo(SshTestSchluessel.fingerabdruck(zeile))
                    .startsWith("SHA256:").hasSize(50);
        }
    }

    @Test
    void kommentarUndSchreibweiseWerdenVerworfen() {
        String zeile = SshTestSchluessel.rsa(2048);
        for (String eingabe : new String[] {
                zeile + " max@laptop",
                zeile + " Max Mustermann (Laptop, Büro) <max@example.test>",
                "  " + zeile + "  max@laptop  \n",
                zeile.replace(" ", "\t") + "\tmax@laptop",
                zeile.replace(" ", "   ") + "   max@laptop\r\n"}) {
            assertThat(SshSchluessel.pruefe(eingabe).zeile()).as(eingabe.substring(eingabe.length() - 20))
                    .isEqualTo(zeile);
        }
    }

    /** Dropbear vergleicht Bytes: führende Nullen im Schlüssel dürfen nicht gespeichert werden. */
    @Test
    void eineUmstaendlicheKodierungWirdZurNormalform() {
        java.security.interfaces.RSAPublicKey k = schluessel();
        String normal = SshTestSchluessel.rsa(k.getPublicExponent(), k.getModulus());
        String umstaendlich = SshTestSchluessel.zeile("ssh-rsa", "ssh-rsa".getBytes(StandardCharsets.US_ASCII),
                mitNullen(k.getPublicExponent().toByteArray()), mitNullen(k.getModulus().toByteArray()));
        assertThat(umstaendlich).isNotEqualTo(normal);
        SshSchluessel.Geprueft g = SshSchluessel.pruefe(umstaendlich);
        assertThat(g.zeile()).isEqualTo(normal);
        assertThat(g.fingerabdruck()).isEqualTo(SshTestSchluessel.fingerabdruck(normal));
    }

    /**
     * Der Schlüssel des Vertragsvektors gegen OpenSSH selbst:
     * {@code ssh-keygen -lf} nennt für ihn „3072 SHA256:TDOx…".
     */
    @Test
    void derFingerabdruckIstDerVonSshKeygen() throws Exception {
        String zeile = vektorSchluessel();
        SshSchluessel.Geprueft g = SshSchluessel.pruefe(zeile + " vektor@beispiel");
        assertThat(g.zeile()).as("der Vektor trägt die Normalform").isEqualTo(zeile);
        assertThat(g.bits()).isEqualTo(3072);
        assertThat(g.fingerabdruck()).isEqualTo("SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc");
    }

    // ── Abgelehnt ─────────────────────────────────────────────────────────

    @Test
    void einAndererSchluesseltypWirdMitDemPassendenBefehlAbgelehnt() {
        Map<String, String> faelle = new LinkedHashMap<>();
        faelle.put(SshTestSchluessel.ed25519() + " max@laptop", "Ed25519");
        faelle.put("ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= max@laptop", "ECDSA");
        faelle.put("sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t max@laptop", "FIDO");
        faelle.put("sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTY= max@laptop", "FIDO");
        faelle.put("ssh-dss AAAAB3NzaC1kc3M= max@laptop", "DSA");
        faelle.forEach((eingabe, name) -> assertThatThrownBy(() -> SshSchluessel.pruefe(eingabe))
                .as(name).isInstanceOf(SshSchluessel.Ungueltig.class)
                .hasMessageContaining(name).hasMessageContaining("nur RSA")
                .hasMessageContaining("ssh-keygen -t rsa -b 3072"));
    }

    @Test
    void zuKurzeUndZuLangeSchluesselWerdenMitIhrerLaengeAbgelehnt() {
        assertThatThrownBy(() -> SshSchluessel.pruefe(SshTestSchluessel.rsa(1024)))
                .isInstanceOf(SshSchluessel.Ungueltig.class).hasMessageContaining("nur 1024 Bit")
                .hasMessageContaining("mindestens 2048").hasMessageContaining("ssh-keygen -t rsa -b 3072");
        // Genau an der Grenze, mit Zahlen statt echter Schlüssel: geprüft wird die Länge, nicht die Primzahl.
        assertThatThrownBy(() -> SshSchluessel.pruefe(SshTestSchluessel.rsa(E, ungerade(2047))))
                .hasMessageContaining("nur 2047 Bit");
        assertThat(SshSchluessel.pruefe(SshTestSchluessel.rsa(E, ungerade(2048))).bits()).isEqualTo(2048);
        assertThat(SshSchluessel.pruefe(SshTestSchluessel.rsa(E, ungerade(4096))).bits()).isEqualTo(4096);
        assertThatThrownBy(() -> SshSchluessel.pruefe(SshTestSchluessel.rsa(E, ungerade(4097))))
                .hasMessageContaining("4097 Bit").hasMessageContaining("bis 4096");
        assertThatThrownBy(() -> SshSchluessel.pruefe(SshTestSchluessel.rsa(E, ungerade(8192))))
                .hasMessageContaining("8192 Bit");
    }

    @Test
    void muellWirdAbgelehnt() {
        String zeile = SshTestSchluessel.rsa(2048);
        String base64 = zeile.split(" ")[1];
        for (String eingabe : new String[] {
                "hallo welt",
                "jUg9DePFPkIQ+KNIAXqSEuVTw2UNHwbUH/HPFK5HiEM=", // ein WireGuard-Schlüssel
                base64, // der Schlüssel ohne den Typ davor
                "ssh-rsa",
                "ssh-rsa !!!kein-base64!!!",
                "ssh-rsa AAAA",
                "ssh-rsa " + base64.substring(0, base64.length() - 41), // abgeschnitten kopiert
                "ssh-rsa " + base64.substring(0, base64.length() - 40),
                "SSH-RSA " + base64,
                "ssh-rsa-cert-v01@openssh.com " + base64,
                "---- BEGIN SSH2 PUBLIC KEY ---- " + base64,
                zeile.replace(' ', ' '),
                zeile + "\u0000",
                "x".repeat(2001)}) {
            assertThatThrownBy(() -> SshSchluessel.pruefe(eingabe))
                    .as(eingabe.length() > 40 ? eingabe.substring(0, 40) : eingabe)
                    .isInstanceOf(SshSchluessel.Ungueltig.class);
        }
        for (String leer : new String[] {null, "", "   ", "\n"}) {
            assertThatThrownBy(() -> SshSchluessel.pruefe(leer)).hasMessageContaining("fehlt");
        }
    }

    @Test
    void einSchluesselDerInnenNichtStimmtWirdAbgelehnt() {
        java.security.interfaces.RSAPublicKey k = schluessel();
        BigInteger n = k.getModulus();
        byte[] typ = "ssh-rsa".getBytes(StandardCharsets.US_ASCII);
        byte[] ohneVorzeichenbyte = java.util.Arrays.copyOfRange(n.toByteArray(), 1, n.toByteArray().length);
        Map<String, String> faelle = new LinkedHashMap<>();
        faelle.put("innen ein anderer Typ",
                "ssh-rsa " + SshTestSchluessel.ed25519().split(" ")[1]);
        faelle.put("ein Feld zu viel",
                SshTestSchluessel.zeile("ssh-rsa", typ, E.toByteArray(), n.toByteArray(), new byte[] {1}));
        faelle.put("ein Feld zu wenig", SshTestSchluessel.zeile("ssh-rsa", typ, E.toByteArray()));
        faelle.put("gerader Modulus", SshTestSchluessel.rsa(E, n.clearBit(0)));
        faelle.put("negativer Modulus", SshTestSchluessel.zeile("ssh-rsa", typ, E.toByteArray(), ohneVorzeichenbyte));
        faelle.put("Exponent 1", SshTestSchluessel.rsa(BigInteger.ONE, n));
        faelle.put("gerader Exponent", SshTestSchluessel.rsa(BigInteger.valueOf(65536), n));
        faelle.put("riesiger Exponent", SshTestSchluessel.rsa(n.subtract(BigInteger.TWO), n));
        faelle.put("leerer Exponent", SshTestSchluessel.zeile("ssh-rsa", typ, new byte[0], n.toByteArray()));
        faelle.forEach((name, eingabe) -> assertThatThrownBy(() -> SshSchluessel.pruefe(eingabe)).as(name)
                .isInstanceOf(SshSchluessel.Ungueltig.class).hasMessageContaining("beschädigt"));
    }

    /** Optionen vor dem Schlüssel könnten an der Box einen Befehl erzwingen: nie annehmen. */
    @Test
    void optionenVorDemSchluesselWerdenAbgelehnt() {
        String zeile = SshTestSchluessel.rsa(2048);
        for (String davor : new String[] {"command=\"/bin/sh\"", "restrict", "no-pty,permitopen=\"10.0.0.1:22\"",
                "from=\"10.10.32.2\""}) {
            assertThatThrownBy(() -> SshSchluessel.pruefe(davor + " " + zeile + " max@laptop")).as(davor)
                    .isInstanceOf(SshSchluessel.Ungueltig.class).hasMessageContaining("keine Optionen");
        }
    }

    @Test
    void mehrzeiligesWirdAbgelehnt() {
        String zeile = SshTestSchluessel.rsa(2048);
        String zweite = SshTestSchluessel.rsa(3072);
        for (String eingabe : new String[] {
                zeile + "\n" + zweite, // zwei Schlüssel
                zeile + " max@laptop\r\n" + zweite + " max@tablet",
                zeile.substring(0, 80) + "\n" + zeile.substring(80), // im Terminal umbrochen kopiert
                zeile + "\nmax@laptop",
                "# mein Schlüssel\n" + zeile}) {
            assertThatThrownBy(() -> SshSchluessel.pruefe(eingabe)).as(eingabe.substring(0, 20))
                    .isInstanceOf(SshSchluessel.Ungueltig.class).hasMessageContaining("genau eine Zeile");
        }
    }

    /** Ein versehentlich eingefügter privater Schlüssel: eigene Meldung, und nichts davon kommt zurück. */
    @Test
    void einPrivaterSchluesselWirdErkanntUndKeineMeldungWiederholtDieEingabe() {
        String geheim = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gtcn";
        for (String kopf : new String[] {"-----BEGIN OPENSSH PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY-----"}) {
            assertThatThrownBy(() -> SshSchluessel.pruefe(kopf + "\n" + geheim + "\n" + kopf.replace("BEGIN", "END")))
                    .as(kopf).isInstanceOf(SshSchluessel.Ungueltig.class)
                    .hasMessageContaining("privater Schlüssel").hasMessageContaining(".pub")
                    .hasMessageNotContaining(geheim);
        }
        String zeile = SshTestSchluessel.rsa(1024);
        String base64 = zeile.split(" ")[1];
        for (String eingabe : new String[] {zeile, "restrict " + zeile, base64, "ssh-ed25519 " + base64,
                zeile + "\n" + zeile, "ssh-rsa " + base64.substring(0, 60)}) {
            assertThatThrownBy(() -> SshSchluessel.pruefe(eingabe))
                    .isInstanceOf(SshSchluessel.Ungueltig.class)
                    .hasMessageNotContaining(base64.substring(0, 24));
        }
    }

    // ── Gespeichert ───────────────────────────────────────────────────────

    /** Was nicht in Normalform in der Datenbank steht, gilt nicht als hinterlegt. */
    @Test
    void nurDieNormalformGiltAlsHinterlegt() {
        String zeile = SshTestSchluessel.rsa(2048);
        assertThat(SshSchluessel.gespeichert(zeile)).map(SshSchluessel.Geprueft::fingerabdruck)
                .contains(SshTestSchluessel.fingerabdruck(zeile));
        assertThat(SshSchluessel.gespeichert(null)).isEmpty();
        assertThat(SshSchluessel.gespeichert(zeile + " max@laptop")).isEmpty();
        assertThat(SshSchluessel.gespeichert(SshTestSchluessel.ed25519())).isEmpty();
        assertThat(SshSchluessel.gespeichert("kaputt")).isEmpty();
    }

    // ── Hilfen ────────────────────────────────────────────────────────────

    static String vektorSchluessel() throws Exception {
        JsonNode vektor = new ObjectMapper().readTree(Files.readString(VEKTOR));
        for (JsonNode peer : vektor.get("peers")) {
            if (peer.has("sshPublicKey")) {
                return peer.get("sshPublicKey").asText();
            }
        }
        throw new AssertionError("der Vektor trägt keinen sshPublicKey");
    }

    private static java.security.interfaces.RSAPublicKey schluessel() {
        try {
            java.security.KeyPairGenerator g = java.security.KeyPairGenerator.getInstance("RSA");
            g.initialize(2048);
            return (java.security.interfaces.RSAPublicKey) g.generateKeyPair().getPublic();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Eine ungerade Zahl mit genau so vielen Bit. */
    private static BigInteger ungerade(int bits) {
        return BigInteger.ONE.shiftLeft(bits - 1).setBit(0);
    }

    private static byte[] mitNullen(byte[] zahl) {
        byte[] mit = new byte[zahl.length + 2];
        System.arraycopy(zahl, 0, mit, 2, zahl.length);
        return mit;
    }
}
