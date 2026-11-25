package com.voltpilot.api.direktvermarktung;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Optional;
import java.util.UUID;

/**
 * Liest das entschlüsselte Material eines Partnerzugangs aus {@code direktvermarktung_zugang} - die EINE
 * Schnittstelle zwischen der Zustellung (dieser Auftrag) und der Zugangsdatei-Übernahme (eigener,
 * sicherheitskritischer Auftrag, beim Captain; sie schreibt Chiffrat und Nonce).
 *
 * <p><b>Ablageform, an die sich BEIDE Seiten binden</b> (Migration V20261125140000, Konzept §5.7 "Die
 * Zugangsdatei"): AES-256-GCM, Schlüssel aus {@code VP_PARTNERZUGANG_SCHLUESSEL} (Base64, 32 Byte, nur
 * Umgebung), {@code nonce} 12 Byte, Tag im Chiffrat. Der KLARTEXT ist das JSON-Objekt, das auch über den
 * Draht geht (Vertrag {@code docs/contracts/v2/direktvermarktung-zustellung.md} §3):
 *
 * <pre>{ "gegenstelle": { "host": …, "port": …, "protokoll": … },
 *   "dateien": { "zertifikat_pem": …, "schluessel_pem": …, "ca_pem": …, "tls_schluessel_pem": … } }</pre>
 *
 * <p>Kein Byte davon erreicht je ein Log, ein Protokoll oder eine Fehlermeldung; loggbar ist allein der
 * Fingerabdruck. {@link Optional#empty()} heißt: nicht entschlüsselbar (Schlüssel fehlt oder passt nicht,
 * Zeile beschädigt) - der Aufrufer antwortet der Box dann schlicht nicht.
 */
public interface PartnerzugangSpeicher {

    Optional<JsonNode> lade(UUID zugangId);
}
