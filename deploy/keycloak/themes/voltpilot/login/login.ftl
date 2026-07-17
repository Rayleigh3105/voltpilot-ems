<#--
  VoltPilot login page override (captain-approved login redesign).

  Copy of keycloak.v2's login.ftl (Keycloak 26.0.5) plus the calm-form
  additions from the reviewed mockup: the hint line under "Willkommen
  zurueck", the Passwort-vergessen support note (there is NO self-service
  reset without SMTP - realm.resetPasswordAllowed is off, the built-in
  forgot-password link renders automatically if it is ever enabled), and
  the Vertrauenszeile (Verschluesselt / Server in Deutschland / DSGVO).

  js/register-link.js inserts the "Konto erstellen" line right AFTER
  #kc-form-login, i.e. between the form and the trust row - keep that form
  id stable.
-->
<#import "template.ftl" as layout>
<#import "field.ftl" as field>
<#import "buttons.ftl" as buttons>
<#import "social-providers.ftl" as identityProviders>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('username','password') displayInfo=realm.password && realm.registrationAllowed && !registrationDisabled??; section>
<!-- template: login.ftl (voltpilot) -->

    <#if section = "header">
        ${msg("loginAccountTitle")}
    <#elseif section = "form">
        <p class="vp-login-hint">${msg("vpLoginHint")}</p>
        <div id="kc-form">
          <div id="kc-form-wrapper">
            <#if realm.password>
                <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}" method="post" novalidate="novalidate">
                    <#if !usernameHidden??>
                        <#assign label>
                            <#if !realm.loginWithEmailAllowed>${msg("username")}<#elseif !realm.registrationEmailAsUsername>${msg("usernameOrEmail")}<#else>${msg("email")}</#if>
                        </#assign>
                        <@field.input name="username" label=label autofocus=true autocomplete="username" value=login.username!'' />
                    </#if>

                    <@field.password name="password" label=msg("password") forgotPassword=realm.resetPasswordAllowed autofocus=usernameHidden?? autocomplete="current-password" />

                    <div class="${properties.kcFormGroupClass!}">
                        <#if realm.rememberMe && !usernameHidden??>
                            <@field.checkbox name="rememberMe" label=msg("rememberMe") value=login.rememberMe?? />
                        </#if>
                    </div>

                    <input type="hidden" id="id-hidden-input" name="credentialId" <#if auth.selectedCredential?has_content>value="${auth.selectedCredential}"</#if>/>
                    <@buttons.loginButton />
                </form>
                <#if !realm.resetPasswordAllowed>
                    <#-- No SMTP = no self-service reset; support recovers via the
                         admin reset-password lever (see the Benutzer page). -->
                    <p class="vp-forgot-note">${msg("vpForgotSupport")}</p>
                </#if>
                <div class="vp-trust">
                    <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>${msg("vpTrustEncrypted")}</span>
                    <span>${msg("vpTrustServers")}</span>
                    <span>${msg("vpTrustDsgvo")}</span>
                </div>
            </#if>
            </div>
        </div>
    <#elseif section = "info" >
        <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
            <div id="kc-registration-container" class="${properties.kcLoginFooterBand!}">
                <div id="kc-registration" class="${properties.kcLoginFooterBandItem!}">
                    <span>${msg("noAccount")} <a href="${url.registrationUrl}">${msg("doRegister")}</a></span>
                </div>
            </div>
        </#if>
    <#elseif section = "socialProviders" >
        <#if realm.password && social.providers?? && social.providers?has_content>
            <@identityProviders.show social=social/>
        </#if>
    </#if>

</@layout.registrationLayout>
