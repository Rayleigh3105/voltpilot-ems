package com.voltpilot.api.enrollment;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.context.PropertyPlaceholderAutoConfiguration;
import org.springframework.boot.convert.ApplicationConversionService;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * Regression proof for the production Spring wiring of {@link BrokerAuthzReloader}.
 *
 * <p>The class has two constructors (the {@code @Value}-injected production one and
 * a package-private test seam). When {@code broker-authz-reload.enabled=true}
 * matches its {@code @ConditionalOnProperty}, the container must instantiate the
 * bean - and with multiple constructors and none marked, Spring could not choose
 * the injection constructor, fell back to a (non-existent) no-arg constructor and
 * crash-looped the whole api context on startup in prod (regression from the
 * auto-reload increment). {@code @Autowired} on the production constructor resolves
 * the ambiguity.
 *
 * <p>This boots a focused context slice with the flag ENABLED and the minimal EMQX
 * config, asserting the bean is created via its {@code @Value} constructor. It fails
 * against the pre-fix code (context refuses to start: "No default constructor
 * found") and passes after the fix. The unit/live tests construct the class
 * directly, so this Spring-wiring path was previously unexercised - which is why the
 * crash reached prod.
 */
class BrokerAuthzReloaderContextTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            // The production app context carries Boot's ApplicationConversionService,
            // which parses the @Value Duration defaults (PT5S/PT0.3S). Register it on
            // this focused slice too, so it faithfully mirrors the real wiring.
            .withInitializer(ctx -> ctx.getBeanFactory()
                    .setConversionService(ApplicationConversionService.getSharedInstance()))
            .withConfiguration(AutoConfigurations.of(PropertyPlaceholderAutoConfiguration.class))
            .withUserConfiguration(BrokerAuthzReloader.class);

    @Test
    void contextStartsAndBeanIsCreatedWhenReloadEnabled() {
        runner.withPropertyValues(
                        "voltpilot.enrollment.broker-authz-reload.enabled=true",
                        "voltpilot.enrollment.acl-file=/tmp/voltpilot-test-acl.conf",
                        "voltpilot.enrollment.broker-authz-reload.api-url=http://emqx:18083/api/v5",
                        "voltpilot.enrollment.broker-authz-reload.api-key=test-key",
                        "voltpilot.enrollment.broker-authz-reload.api-secret=test-secret")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).hasSingleBean(BrokerAuthzReloader.class);
                });
    }

    @Test
    void beanIsAbsentWhenReloadDisabled() {
        runner.withPropertyValues("voltpilot.enrollment.broker-authz-reload.enabled=false")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context).doesNotHaveBean(BrokerAuthzReloader.class);
                });
    }
}
