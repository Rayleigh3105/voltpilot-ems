package com.voltpilot.api.versand.webpush;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Duration;
import org.bouncycastle.crypto.params.ECPrivateKeyParameters;

/**
 * Der Web-Push-Adapter (Alerting Scheibe 3, Konzept §6.7, §9): verschlüsselt eine Nutzlast nach
 * RFC 8291 und sendet sie mit einer VAPID-Signatur (RFC 8292) an den Push-Dienst des Browsers (FCM,
 * Mozilla Autopush, …) - derselbe Aufbau wie {@link com.voltpilot.api.versand.EmailVersandAdapter}:
 * EINE {@code senden}-Methode, die eine Laufzeitausnahme wirft, die der {@code Zusteller} als
 * Fehlschlag verbucht.
 *
 * <p>Ein leerer VAPID-Schlüssel führt NICHT zu einem abweichenden Bean - wie beim SMTP-Adapter
 * (VersandConfig) - sondern zu einem ehrlichen Fehler beim ersten tatsächlichen Versand.
 */
public class WebPushAdapter {

    /** Ein Geräte-Abo (Browser {@code PushSubscription.toJSON()}: endpoint + keys.p256dh + keys.auth). */
    public record Abo(String endpoint, String p256dh, String auth) {
    }

    private static final Duration VAPID_GUELTIGKEIT = Duration.ofHours(12);
    private static final Duration STANDARD_TTL = Duration.ofHours(4);

    private final ECPrivateKeyParameters vapidPrivateKey;
    private final String vapidPublicKeyBase64Url;
    private final String subjectMailto;
    private final HttpClient http;
    private final SecureRandom zufall = new SecureRandom();

    public WebPushAdapter(String vapidPublicKeyBase64Url, String vapidPrivateKeyBase64Url, String subjectMailto) {
        this.vapidPublicKeyBase64Url = vapidPublicKeyBase64Url;
        this.vapidPrivateKey = P256.schluesselPrivat(Base64Url.decode(vapidPrivateKeyBase64Url));
        this.subjectMailto = subjectMailto;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    }

    /** @throws WebPushException wenn der Push-Dienst nicht erfolgreich (2xx) antwortet. */
    public void senden(Abo abo, String payloadJson) {
        byte[] uaOeffentlich = Base64Url.decode(abo.p256dh());
        byte[] authGeheimnis = Base64Url.decode(abo.auth());
        byte[] koerper = WebPushEncryption.verschluesseln(uaOeffentlich, authGeheimnis,
                payloadJson.getBytes(StandardCharsets.UTF_8), zufall);

        URI endpoint = URI.create(abo.endpoint());
        int port = endpoint.getPort();
        String audience = endpoint.getScheme() + "://" + endpoint.getHost() + (port > 0 ? ":" + port : "");
        String jwt = VapidJwt.erzeugen(audience, subjectMailto, VAPID_GUELTIGKEIT, vapidPrivateKey);

        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .header("Content-Encoding", "aes128gcm")
                .header("Content-Type", "application/octet-stream")
                .header("TTL", String.valueOf(STANDARD_TTL.toSeconds()))
                .header("Authorization", "vapid t=" + jwt + ", k=" + vapidPublicKeyBase64Url)
                .POST(HttpRequest.BodyPublishers.ofByteArray(koerper))
                .build();
        try {
            HttpResponse<Void> response = http.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() / 100 != 2) {
                throw new WebPushException(response.statusCode(),
                        "Push-Dienst antwortete " + response.statusCode());
            }
        } catch (IOException e) {
            throw new WebPushException(0, e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new WebPushException(0, "Versand unterbrochen", e);
        }
    }
}
