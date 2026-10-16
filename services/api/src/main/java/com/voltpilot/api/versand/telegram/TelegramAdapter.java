package com.voltpilot.api.versand.telegram;

/**
 * Die Telegram-Bot-API, so weit wie der Versand sie braucht (Alerting Scheibe 6, Konzept §7 Scheibe
 * 6) - als Interface, DAMIT Tests nie gegen die echte Telegram-API laufen (Hausregel dieser Scheibe),
 * sondern gegen einen Stub (siehe {@code StubTelegramAdapter} in den Testquellen) oder einen lokalen
 * HTTP-Fänger, der {@link TelegramBotAdapter} selbst auf Drahtebene prüft.
 */
public interface TelegramAdapter {

    /** @throws TelegramException wenn der Bot nicht erfolgreich senden konnte. */
    void senden(String chatId, String text);

    /**
     * Die Antwort auf {@code /start <token>} (der Verbindungs-Fluss, §7 Scheibe 6 Punkt 2) - dieselbe
     * Methode wie {@link #senden}, mit festem Text, damit ein Aufrufer den Verbindungs-Erfolg nicht
     * selbst formulieren muss.
     */
    default void verbindungBestaetigen(String chatId) {
        senden(chatId, "VoltPilot ist jetzt verbunden. Sie erhalten hier künftig Meldungen.");
    }
}
