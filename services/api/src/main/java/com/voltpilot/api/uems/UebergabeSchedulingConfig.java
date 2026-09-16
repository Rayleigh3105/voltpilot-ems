package com.voltpilot.api.uems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

@Configuration
@EnableScheduling
@ConditionalOnProperty(name="voltpilot.uems.uebergabe.enabled", havingValue="true", matchIfMissing=true)
public class UebergabeSchedulingConfig {}
