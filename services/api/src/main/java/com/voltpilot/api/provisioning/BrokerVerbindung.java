package com.voltpilot.api.provisioning;

import org.eclipse.paho.client.mqttv3.IMqttActionListener;
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.IMqttToken;
import org.eclipse.paho.client.mqttv3.MqttAsyncClient;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttException;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;

/**
 * Die Broker-Verbindung eines Rückmeldewegs (und des Messplan-Senders): EIN Paho-Client je Weg, einmal gebaut und nie
 * verworfen (Störung ab 12.10.2026: „measurement status subscribe failed: Client is not connected" und ein stehender
 * Scheduler).
 *
 * <ul>
 *   <li><b>Ein Client.</b> {@link #sicherstellen()} startet den Aufbau nur, solange noch nie eine Verbindung stand;
 *       ein laufender Aufbau ({@code CONNECT_IN_PROGRESS}) heißt „läuft". Danach verbindet ausschließlich Paho neu
 *       ({@code automaticReconnect}). Früher verwarf der Takt den Client mitten in Pahos eigenem Reconnect
 *       ({@code close()} scheitert dann still) und baute einen zweiten mit derselben festen ID; beide verdrängten sich
 *       beim Broker auf Dauer.</li>
 *   <li><b>Nie unbegrenzt blockieren.</b> Aufbau und Abo laufen asynchron, der Paho-Rückruf wartet auf nichts. Ein
 *       Erstaufbau ohne CONNACK endet nach {@link #ZEITGRENZE_MS} und beginnt neu; was synchron bleibt (Senden,
 *       Schließen), wartet höchstens so lange. Früher hielt ein Broker, der TCP annimmt und nicht antwortet, den
 *       einzigen Scheduler-Thread für immer, und ein Abo im Rückruf blockierte bei mehr als zehn gestauten
 *       Nachrichten Empfang und Rückruf gegenseitig.</li>
 *   <li><b>Kein stilles Verwerfen.</b> Jede Nachricht geht an den {@link Eingang} – auch eine, die vor dem SUBACK
 *       aus der Sitzung kommt; der leere Standard-Rückruf hatte sie bestätigt und weggeworfen.</li>
 * </ul>
 *
 * <p>Pahos eigener Reconnect kennt keine CONNACK-Frist: ein Wiederaufbau, den der Broker annimmt und nie beantwortet,
 * endet erst, wenn die Verbindung abreißt. Er hält dann nur diesen Client, keinen Thread der api.
 */
public final class BrokerVerbindung {

    /** Obergrenze jedes Wartens; größer als der TCP-Aufbau ({@code connectionTimeout} 5 s). */
    public static final long ZEITGRENZE_MS = 10_000;

    /** Abonniert auf dem gerade verbundenen Client – asynchron, die Quittung meldet ein Scheitern. */
    @FunctionalInterface
    public interface Abo {
        void abonnieren(MqttAsyncClient client, IMqttActionListener quittung) throws MqttException;
    }

    /** Der Eingang des Weges; wirft nie (eine Ausnahme im Paho-Rückruf trennte die Verbindung). */
    @FunctionalInterface
    public interface Eingang {
        void empfangen(String topic, MqttMessage message);
    }

    private final Logger log;
    private final String name, rolle, brokerUrl, clientId, username, password;
    private final boolean cleanSession;
    private final Abo abo;
    private final Eingang eingang;
    private MqttAsyncClient client;
    private IMqttToken aufbau;
    private long aufbauSeit;
    private boolean geschlossen;
    private volatile boolean jeVerbunden;

    /**
     * @param name  Weg in den Logzeilen, wie bisher: „measurement status" ergibt „measurement status listener awaits
     *              broker" und „measurement status subscribe failed"
     * @param abo   {@code null} für einen reinen Sender (dann auch {@code eingang})
     */
    public BrokerVerbindung(Logger log, String name, String brokerUrl, String clientId, boolean cleanSession,
            String username, String password, Abo abo, Eingang eingang) {
        this.log = log; this.name = name; this.rolle = abo == null ? "publisher" : "listener";
        this.brokerUrl = brokerUrl; this.clientId = clientId;
        this.cleanSession = cleanSession; this.username = username; this.password = password;
        this.abo = abo; this.eingang = eingang;
    }

    /** Baut den Client beim ersten Aufruf und startet den Erstaufbau; wartet nie auf den Broker. */
    public synchronized void sicherstellen() {
        if (geschlossen || jeVerbunden) return;
        try {
            if (client == null) client = bauen();
            aufbauen();
        } catch (MqttException e) {
            if (e.getReasonCode() != MqttException.REASON_CODE_CONNECT_IN_PROGRESS) {
                if (e.getReasonCode() != MqttException.REASON_CODE_CLIENT_CONNECTED) {
                    log.warn("{} {} awaits broker: {}", name, rolle, e.getMessage());
                }
                return;
            }
            if (System.nanoTime() - aufbauSeit < ZEITGRENZE_MS * 1_000_000) return; // der Aufbau läuft
            log.warn("{} {} awaits broker: no CONNACK within {} ms, connecting anew", name, rolle, ZEITGRENZE_MS);
            try {
                // Ohne DISCONNECT-Paket: der Broker hat nie geantwortet. Derselbe Client ist danach getrennt.
                client.disconnectForcibly(0, 0, false);
                aufbauen();
            } catch (MqttException neu) {
                log.warn("{} {} awaits broker: {}", name, rolle, neu.getMessage());
            }
        }
    }

    private void aufbauen() throws MqttException {
        long start = System.nanoTime();
        aufbau = client.connect(optionen(), null, new IMqttActionListener() {
            @Override public void onSuccess(IMqttToken token) { }
            @Override public void onFailure(IMqttToken token, Throwable e) {
                log.warn("{} {} awaits broker: {}", name, rolle, e == null ? "unknown" : e.getMessage());
            }
        });
        aufbauSeit = start;
    }

    /** Wartet höchstens {@link #ZEITGRENZE_MS} auf den laufenden Erstaufbau (Start des Senders). */
    public void erstaufbauAbwarten() {
        IMqttToken laufend;
        synchronized (this) { laufend = aufbau; }
        if (laufend == null) return;
        try {
            laufend.waitForCompletion(ZEITGRENZE_MS);
        } catch (MqttException e) {
            log.debug("{} initial connect: {}", name, e.getMessage());
        }
    }

    public boolean verbunden() {
        MqttAsyncClient c;
        synchronized (this) { c = client; }
        return c != null && c.isConnected();
    }

    /** Der verbundene Client, sonst {@code REASON_CODE_CLIENT_NOT_CONNECTED}; Paho verbindet selbst neu. */
    public MqttAsyncClient verbundenerClient() throws MqttException {
        sicherstellen();
        MqttAsyncClient c;
        synchronized (this) { c = client; }
        if (c == null || !c.isConnected()) {
            throw new MqttException(MqttException.REASON_CODE_CLIENT_NOT_CONNECTED);
        }
        return c;
    }

    /** Sauberes Ende ({@code @PreDestroy}): trennt, beendet einen laufenden Aufbau und schließt; nie wieder auf. */
    public synchronized void schliessen() {
        geschlossen = true;
        if (client == null) return;
        try {
            if (client.isConnected()) client.disconnect(0).waitForCompletion(ZEITGRENZE_MS);
        } catch (MqttException e) {
            log.debug("{} disconnect on shutdown: {}", name, e.getMessage());
        }
        try {
            client.close(true);
        } catch (MqttException e) {
            // Ein laufender Aufbau (der eigene oder Pahos Reconnect) lässt close nicht zu: hart beenden, dann schließen.
            try {
                client.disconnectForcibly(0, 0, false);
                client.close(true);
            } catch (MqttException hart) {
                log.debug("{} close on shutdown: {}", name, hart.getMessage());
            }
        }
    }

    private MqttAsyncClient bauen() throws MqttException {
        MqttAsyncClient c = new MqttAsyncClient(brokerUrl, clientId, new MemoryPersistence());
        c.setCallback(new MqttCallbackExtended() {
            @Override public void connectComplete(boolean reconnect, String uri) {
                jeVerbunden = true;
                if (abo == null) return;
                try {
                    // Auf genau dem Client, der sich verbunden hat, und ohne zu warten: der Rückruf-Thread muss
                    // frei bleiben, um die Nachrichten vor dem SUBACK abzuarbeiten.
                    abo.abonnieren(c, new IMqttActionListener() {
                        @Override public void onSuccess(IMqttToken token) { }
                        @Override public void onFailure(IMqttToken token, Throwable e) {
                            log.warn("{} subscribe failed: {}", name, e == null ? "unknown" : e.getMessage());
                        }
                    });
                } catch (MqttException e) {
                    log.warn("{} subscribe failed: {}", name, e.getMessage());
                }
            }
            @Override public void connectionLost(Throwable cause) {
                log.warn("{} {} lost the broker connection: {} (auto-reconnect active)", name, rolle,
                        cause == null ? "unknown" : cause.getMessage());
            }
            @Override public void messageArrived(String topic, MqttMessage message) {
                if (eingang != null) eingang.empfangen(topic, message);
            }
            @Override public void deliveryComplete(IMqttDeliveryToken token) { }
        });
        return c;
    }

    private MqttConnectOptions optionen() {
        MqttConnectOptions options = new MqttConnectOptions();
        options.setCleanSession(cleanSession);
        options.setAutomaticReconnect(true);
        options.setConnectionTimeout(5);
        if (username != null && !username.isBlank()) {
            options.setUserName(username);
            options.setPassword(password == null ? new char[0] : password.toCharArray());
        }
        return options;
    }
}
