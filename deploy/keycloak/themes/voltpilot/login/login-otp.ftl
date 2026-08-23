<#--
  Einmalcode (OTP). VORBEREITET: der Browser-Flow traegt "Conditional OTP",
  heute hat kein Konto OTP eingerichtet - die Seite ist damit erreichbar,
  sobald eines es tut, und traegt dann schon das richtige Kleid.

  autocomplete="one-time-code" + inputmode="numeric" fuellen den Code am
  Telefon aus der SMS/App und blenden die Buchstaben-Tastatur aus.
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('totp'); section>
<!-- template: login-otp.ftl (voltpilot) -->
    <#if section = "header">
        ${msg("vpOtpTitle")}
    <#elseif section = "hint">
        <p class="vpl-hint">${msg("vpOtpHint")}</p>
    <#elseif section = "form">
        <form id="kc-otp-login-form" class="vpl-form" action="${url.loginAction}" method="post" novalidate="novalidate">
            <input id="selectedCredentialId" type="hidden" name="selectedCredentialId" value="${otpLogin.selectedCredentialId!''}">
            <#if otpLogin.userOtpCredentials?size gt 1>
                <div class="vpl-field">
                    <span class="vpl-label">${msg("vpOtpPickDevice")}</span>
                    <div class="vpl-otp-list">
                        <#list otpLogin.userOtpCredentials as otpCredential>
                            <label class="vpl-otp-item">
                                <input type="radio" name="vp-otp-pick" value="${otpCredential.id}"
                                       onchange="document.getElementById('selectedCredentialId').value = this.value;"
                                       <#if otpCredential.id == otpLogin.selectedCredentialId>checked</#if>>
                                <span>${otpCredential.userLabel}</span>
                            </label>
                        </#list>
                    </div>
                </div>
            </#if>

            <div class="vpl-field">
                <label class="vpl-label" for="otp">${msg("loginOtpOneTime")}</label>
                <input class="vpl-input vpl-otp" id="otp" name="otp" type="text"
                       inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*"
                       maxlength="6" placeholder="••••••" autofocus enterkeyhint="go"
                       aria-invalid="${messagesPerField.existsError('totp')?string('true','false')}"
                       <#if messagesPerField.existsError('totp')>aria-describedby="vp-otp-error"</#if> />
                <#if messagesPerField.existsError('totp')>
                    <p class="vpl-error" id="vp-otp-error">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
                        <span>${kcSanitize(messagesPerField.get('totp'))?no_esc}</span>
                    </p>
                </#if>
            </div>

            <button type="submit" class="vpl-submit" name="login" data-vp-busy="${msg("vpChecking")}">
                <span class="vpl-spin" hidden aria-hidden="true"></span>
                <span class="vpl-submit-label">${msg("vpOtpSubmit")}</span>
            </button>
        </form>
    </#if>
</@layout.registrationLayout>
