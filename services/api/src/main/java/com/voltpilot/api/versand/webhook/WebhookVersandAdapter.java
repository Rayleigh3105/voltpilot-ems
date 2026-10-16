package com.voltpilot.api.versand.webhook;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Der Webhook-Adapter (Alerting Scheibe 6, Konzept §7 Scheibe 6): ein generischer signierter
 * JSON-POST - derselbe Aufbau wie {@link com.voltpilot.api.versand.EmailVersandAdapter} und
 * {@link com.voltpilot.api.versand.webpush.WebPushAdapter}: EINE {@code senden}-Methode, die eine
 * Laufzeitausnahme wirft, die der {@code Zusteller} als Fehlschlag verbucht. Funktioniert für jeden
 * Empfänger, der einen signierten JSON-POST entgegennimmt - in der Praxis ein Microsoft-Teams-
 * Workflow ("Wenn eine Webanfrage empfangen wird") oder ein Slack-Incoming-Webhook (liest das
 * Feld {@code text} direkt).
 *
 * <p>SSRF-Schutz zwingend ({@link WebhookZielPruefung}): nur https, nur ein aufgelöstes Ziel außerhalb
 * privater/loopback/link-local/Multicast-Bereiche, keine Weiterleitungen (der Client folgt
 * grundsätzlich keinen Redirects - eine 3xx-Antwort ist ein Fehlschlag wie jede andere), knappe
 * Zeitgrenzen (Verbindung 5 s, gesamt 8 s).
 */
public class WebhookVersandAdapter {

    private static final Duration VERBINDUNGS_ZEITGRENZE = Duration.ofSeconds(5);
    private static final Duration GESAMT_ZEITGRENZE = Duration.ofSeconds(8);

    /** Austauschbar NUR für den Drahtebene-Test dieser Klasse - siehe den package-sichtbaren Konstruktor. */
    interface ZielValidator {
        URI pruefenUndAufloesen(String url);
    }

    private final ZielValidator validator;
    private final HttpClient http;

    public WebhookVersandAdapter() {
        this(WebhookZielPruefung::pruefenUndAufloesen);
    }

    /**
     * Package-sichtbar: NUR für den Drahtebene-Test (Signatur, Zeitgrenzen, Statuscode-Zuordnung)
     * gegen einen lokalen HTTP-Fänger, den die SSRF-Prüfung als Loopback-Ziel sonst zu Recht
     * sperren würde - {@link WebhookZielPruefung} selbst ist vollständig unabhängig davon
     * unit-getestet ({@code WebhookZielPruefungTest}). {@link VersandConfig} (ein anderes Paket)
     * erreicht ausschließlich den öffentlichen Konstruktor oben - die echte SSRF-Prüfung ist damit
     * für den Produktionscode nicht abwählbar.
     */
    WebhookVersandAdapter(ZielValidator validator) {
        this.validator = validator;
        this.http = HttpClient.newBuilder()
                .connectTimeout(VERBINDUNGS_ZEITGRENZE)
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** @throws WebhookException wenn das Ziel unsicher ist oder der Empfänger nicht erfolgreich (2xx) antwortet. */
    public void senden(String url, String geheimnis, String payloadJson) {
        URI ziel;
        try {
            ziel = validator.pruefenUndAufloesen(url);
        } catch (WebhookZielPruefung.UnsicheresZielException e) {
            throw new WebhookException(WebhookException.ZIEL_UNSICHER, e.getMessage());
        }
        String signatur = WebhookSignatur.signieren(geheimnis, payloadJson);
        HttpRequest request = HttpRequest.newBuilder(ziel)
                .header("Content-Type", "application/json")
                .header("X-VoltPilot-Signature", "sha256=" + signatur)
                .timeout(GESAMT_ZEITGRENZE)
                .POST(HttpRequest.BodyPublishers.ofString(payloadJson, StandardCharsets.UTF_8))
                .build();
        try {
            HttpResponse<Void> response = http.send(request, HttpResponse.BodyHandlers.discarding());
            if (response.statusCode() / 100 != 2) {
                throw new WebhookException(response.statusCode(), "Webhook-Ziel antwortete " + response.statusCode());
            }
        } catch (IOException e) {
            throw new WebhookException(0, e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new WebhookException(0, "Versand unterbrochen", e);
        }
    }
}
