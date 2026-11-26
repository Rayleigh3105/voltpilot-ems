package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.repo.DirektvermarktungRepository;
import com.voltpilot.api.repo.DirektvermarktungRepository.ZugangChiffrat;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * BEIDE Richtungen der in {@link PartnerzugangSpeicher} festgeschriebenen Ablageform an EINER Stelle:
 * Schlüssel, Nonce, Format und die AAD-Bindung wohnen nur hier. Die Zustellung liest
 * ({@link #lade}); die Zugangsdatei-Übernahme (eigener, beim Captain gehaltener Auftrag) schreibt über
 * {@link #verschluessele} - sie erzeugt nie selbst ein Chiffrat.
 *
 * <p><b>AAD-Bindung:</b> jedes Chiffrat ist über die GCM-Zusatzdaten an Mandant, Anlage und die
 * Zugangs-Zeile gebunden ({@link #aad}: {@code vp-partnerzugang.v1|tenant|site|zugangId}). Ein Chiffrat,
 * das in eine andere Zeile, eine andere Anlage oder einen anderen Mandanten kopiert wird, entschlüsselt
 * NICHT - der GCM-Tag fällt, bevor ein Byte Klartext entsteht. Die Zugangs-ID vergibt die Übernahme vor
 * dem INSERT (client-seitige UUID, das Muster jeder Zeile hier); die ID und nicht der Fingerabdruck,
 * weil ein Ersatz-Upload desselben Zertifikats eine NEUE Zeile ist und das alte Chiffrat auch dort nicht
 * gelten darf. Es gibt keine Alt-Chiffrate ohne AAD (die Übernahme ist noch nicht gebaut), darum keine
 * Übergangslesung.
 *
 * <p>Jede Abweichung ist dasselbe stille {@code empty()}: welcher Teil fehlte oder welcher Tag fiel,
 * gehört nicht in ein Log neben ein Chiffrat.
 */
@Component
public class AesGcmPartnerzugangSpeicher implements PartnerzugangSpeicher {

    private static final Logger log = LoggerFactory.getLogger(AesGcmPartnerzugangSpeicher.class);
    private static final int GCM_TAG_BITS = 128;
    private static final int NONCE_BYTES = 12;
    /** Fassung der AAD-Bindung; eine neue Fassung wäre eine neue Ablageform mit eigener Übergangsregel. */
    private static final String AAD_FASSUNG = "vp-partnerzugang.v1";

    /** Chiffrat und Nonce, wie die Übernahme sie in {@code direktvermarktung_zugang} ablegt. */
    public record Verschluesselt(byte[] chiffrat, byte[] nonce) {}

    private final DirektvermarktungRepository repo;
    private final ObjectMapper json;
    private final SecureRandom random = new SecureRandom();
    private final byte[] schluessel;

    public AesGcmPartnerzugangSpeicher(DirektvermarktungRepository repo, ObjectMapper json,
            @Value("${voltpilot.direktvermarktung.partnerzugang-schluessel:}") String schluesselBase64) {
        this.repo = repo;
        this.json = json;
        byte[] k = null;
        if (schluesselBase64 != null && !schluesselBase64.isBlank()) {
            try {
                k = Base64.getDecoder().decode(schluesselBase64.trim());
                if (k.length != 32) {
                    log.error("direktvermarktung: VP_PARTNERZUGANG_SCHLUESSEL hat {} Byte statt 32 - "
                            + "Zugaenge sind nicht lesbar", k.length);
                    k = null;
                }
            } catch (IllegalArgumentException e) {
                log.error("direktvermarktung: VP_PARTNERZUGANG_SCHLUESSEL ist kein Base64 - "
                        + "Zugaenge sind nicht lesbar");
            }
        }
        this.schluessel = k;
    }

    /**
     * Verschlüsselt den Klartext (das Draht-JSON mit {@code dateien} und {@code gegenstelle}) für GENAU
     * die Zeile {@code zugangId} der Anlage {@code siteId} des Mandanten {@code tenantId}, mit frischer
     * Nonce. {@code empty()} ohne Schlüssel oder für einen Klartext, der nicht die Ablageform ist - die
     * Übernahme legt dann nichts ab, nie ein halbes oder ungebundenes Chiffrat.
     */
    public Optional<Verschluesselt> verschluessele(UUID tenantId, UUID siteId, UUID zugangId, JsonNode klartext) {
        if (schluessel == null) {
            log.warn("direktvermarktung: Zugang kann nicht abgelegt werden - kein VP_PARTNERZUGANG_SCHLUESSEL");
            return Optional.empty();
        }
        if (klartext == null || !klartext.isObject() || !klartext.has("dateien") || !klartext.has("gegenstelle")) {
            log.warn("direktvermarktung: Klartext nicht in der Ablageform - nichts abgelegt");
            return Optional.empty();
        }
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(schluessel, "AES"),
                    new GCMParameterSpec(GCM_TAG_BITS, nonce));
            cipher.updateAAD(aad(tenantId, siteId, zugangId));
            byte[] chiffrat = cipher.doFinal(json.writeValueAsBytes(klartext));
            return Optional.of(new Verschluesselt(chiffrat, nonce));
        } catch (Exception e) {
            // Bewusst ohne e.getMessage(): neben einem Klartext gehoert kein Grund ins Log.
            log.warn("direktvermarktung: Zugang {} nicht verschluesselbar", zugangId);
            return Optional.empty();
        }
    }

    @Override
    public Optional<JsonNode> lade(UUID zugangId) {
        if (schluessel == null) {
            log.warn("direktvermarktung: Zugang {} angefragt, aber kein VP_PARTNERZUGANG_SCHLUESSEL gesetzt",
                    zugangId);
            return Optional.empty();
        }
        ZugangChiffrat z = repo.zugangChiffrat(zugangId);
        if (z == null || z.chiffrat() == null || z.nonce() == null
                || z.tenantId() == null || z.siteId() == null) {
            return Optional.empty();
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(schluessel, "AES"),
                    new GCMParameterSpec(GCM_TAG_BITS, z.nonce()));
            // Die Bindung an die EIGENE Zeile: ein in eine andere Zeile kopiertes Chiffrat
            // entschluesselt hier nicht.
            cipher.updateAAD(aad(z.tenantId(), z.siteId(), zugangId));
            byte[] klartext = cipher.doFinal(z.chiffrat());
            JsonNode doc = json.readTree(klartext);
            if (!doc.isObject() || !doc.has("dateien") || !doc.has("gegenstelle")) {
                log.warn("direktvermarktung: Zugang {} entschluesselt, aber nicht in der Ablageform", zugangId);
                return Optional.empty();
            }
            return Optional.of(doc);
        } catch (Exception e) {
            // Bewusst ohne e.getMessage(): neben einem Chiffrat gehoert kein Grund ins Log.
            log.warn("direktvermarktung: Zugang {} nicht entschluesselbar", zugangId);
            return Optional.empty();
        }
    }

    /** Die GCM-Zusatzdaten beider Richtungen - die eine Definition der Bindung. */
    private static byte[] aad(UUID tenantId, UUID siteId, UUID zugangId) {
        return (AAD_FASSUNG + "|" + tenantId + "|" + siteId + "|" + zugangId)
                .getBytes(StandardCharsets.UTF_8);
    }
}
