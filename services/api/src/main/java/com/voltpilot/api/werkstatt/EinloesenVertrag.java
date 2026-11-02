package com.voltpilot.api.werkstatt;

import com.voltpilot.api.fernwartung.WireguardSchluessel;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Der Vertrag des Einlösens ({@code docs/contracts/werkstatt-einloesen-v1.md},
 * Vektoren {@code werkstatt-einloesen-vectors.json}): welche Felder die Box
 * schickt, welcher Text signiert wird und wie die API die Signatur prüft. Der
 * Zwilling auf der Box ist der Befehl {@code werkstatt-anmelden} im Go-Core
 * (P7); beide lesen dieselben Vektoren.
 *
 * <p>Signiert wird ein Text aus Zeilen {@code name=wert}, jede mit {@code \n}
 * abgeschlossen, in fester Reihenfolge; die Zertifikatsanfrage geht als sha256
 * ihrer Bytes ein. Signatur: ECDSA P-256 mit SHA-256, ASN.1 DER, Base64 - mit
 * dem Geräteschlüssel, der auch die Zertifikatsanfrage trägt.
 */
public final class EinloesenVertrag {

    public static final String SCHEMA = "vp-werkstatt-einloesen.v1";

    /** {@code wk-} und 26 Zeichen Base32 (RFC 4648, klein, ohne Auffüllung): 128 Bit. */
    public static final Pattern CODE = Pattern.compile("^wk-[a-z2-7]{26}$");
    public static final Pattern HOST_SCHLUESSEL = Pattern.compile("^SHA256:[A-Za-z0-9+/]{43}$");
    public static final Pattern FASSUNG = Pattern.compile("^[a-z0-9][a-z0-9.+-]{0,63}$");
    public static final int MAX_CSR = 20_480;

    /** Was die Box beim Einlösen schickt. */
    public record Anfrage(String edgeRef, String code, String fassung, String geraeteSchluessel,
            String wireguardSchluessel, String hostSchluessel, String csrPem, String signatur) {
    }

    private EinloesenVertrag() {
    }

    /** Der signierte Text. Setzt eine formal geprüfte Anfrage voraus ({@link #formfehler}). */
    public static String kanonisch(Anfrage a) {
        return SCHEMA + "\n"
                + "edge_ref=" + a.edgeRef() + "\n"
                + "code=" + a.code() + "\n"
                + "fassung=" + a.fassung() + "\n"
                + "geraete_schluessel=" + a.geraeteSchluessel() + "\n"
                + "wireguard_schluessel=" + a.wireguardSchluessel() + "\n"
                + "host_schluessel=" + a.hostSchluessel() + "\n"
                + "csr_sha256=" + sha256Hex(a.csrPem()) + "\n";
    }

    /**
     * Formfehler in Worten; leer heißt: jedes Feld hat seine Form. Keine Zeile
     * darf einen Zeilenumbruch tragen, sonst wäre der signierte Text mehrdeutig.
     * Ob es die Referenz, den Code oder die Box gibt, sagt diese Prüfung nicht.
     */
    public static List<String> formfehler(Anfrage a) {
        List<String> f = new ArrayList<>();
        if (a.edgeRef() == null || !com.voltpilot.api.web.EdgeRef.isValid(a.edgeRef())) {
            f.add("edgeRef: eine Kennung der Box mit gültigem Prüfzeichen (edge-…)");
        }
        if (a.code() == null || !CODE.matcher(a.code()).matches()) {
            f.add("code: Form wk- und 26 Zeichen");
        }
        if (a.fassung() == null || !FASSUNG.matcher(a.fassung()).matches()) {
            f.add("fassung: die Fassung des Programms auf der Box");
        }
        if (a.geraeteSchluessel() == null || geraeteSchluessel(a.geraeteSchluessel()) == null) {
            f.add("geraeteSchluessel: ein öffentlicher EC-P-256-Schlüssel (SubjectPublicKeyInfo, Base64)");
        }
        if (a.wireguardSchluessel() == null || !WireguardSchluessel.gueltig(a.wireguardSchluessel())) {
            f.add("wireguardSchluessel: ein öffentlicher WireGuard-Schlüssel (44 Zeichen Base64)");
        }
        if (a.hostSchluessel() == null || !HOST_SCHLUESSEL.matcher(a.hostSchluessel()).matches()) {
            f.add("hostSchluessel: Form SHA256: und 43 Zeichen");
        }
        if (a.csrPem() == null || a.csrPem().isBlank() || a.csrPem().length() > MAX_CSR) {
            f.add("csrPem: die Zertifikatsanfrage der Box (PEM, höchstens " + MAX_CSR + " Zeichen)");
        }
        if (a.signatur() == null || a.signatur().length() > 200 || !base64(a.signatur())) {
            f.add("signatur: ECDSA-Signatur (DER, Base64)");
        }
        return f;
    }

    /** Der Geräteschlüssel als EC-P-256-Schlüssel, sonst {@code null}. */
    public static PublicKey geraeteSchluessel(String spkiBase64) {
        try {
            byte[] roh = Base64.getDecoder().decode(spkiBase64);
            PublicKey key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(roh));
            if (key instanceof ECPublicKey ec && ec.getParams().getCurve().getField().getFieldSize() == 256
                    && ec.getParams().getOrder().bitLength() == 256) {
                return key;
            }
            return null;
        } catch (IllegalArgumentException | GeneralSecurityException e) {
            return null;
        }
    }

    /** Der Schlüssel in der festgehaltenen Form: SPKI (DER) über JCA neu kodiert, Base64. */
    public static String spki(PublicKey key) {
        return Base64.getEncoder().encodeToString(key.getEncoded());
    }

    /** Prüft die Signatur über den kanonischen Text. */
    public static boolean signaturGueltig(Anfrage a) {
        PublicKey key = geraeteSchluessel(a.geraeteSchluessel());
        if (key == null) {
            return false;
        }
        try {
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initVerify(key);
            s.update(kanonisch(a).getBytes(StandardCharsets.UTF_8));
            return s.verify(Base64.getDecoder().decode(a.signatur()));
        } catch (IllegalArgumentException | GeneralSecurityException e) {
            return false;
        }
    }

    public static String sha256Hex(String text) {
        return sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }

    public static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static boolean base64(String s) {
        try {
            Base64.getDecoder().decode(s);
            return !s.isEmpty();
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
