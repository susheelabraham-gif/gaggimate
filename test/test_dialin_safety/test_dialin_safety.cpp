// Native tests for the Dial-in safety validator: pio test -e native -f test_dialin_safety
#include <display/plugins/dialin/SafetyValidator.h>
#include <unity.h>

using namespace dialin;

static PhaseSpec pressurePhase(float bar, float seconds, bool preinfusion = false) {
    PhaseSpec p;
    p.name = preinfusion ? "Preinfusion" : "Brew";
    p.preinfusion = preinfusion;
    p.duration = seconds;
    p.pressureMode = true;
    p.pressure = bar;
    p.flow = 0;
    return p;
}

static ProfileSpec goodProfile() {
    ProfileSpec s;
    s.type = "pro";
    s.temperature = 93;
    s.phases.push_back(pressurePhase(3, 8, true));
    PhaseSpec brew = pressurePhase(9, 30);
    brew.targets.push_back({TargetKind::Volumetric, 36});
    s.phases.push_back(brew);
    return s;
}

static bool hasErrorContaining(const std::vector<std::string> &errors, const char *text) {
    for (const auto &e : errors)
        if (e.find(text) != std::string::npos)
            return true;
    return false;
}

void setUp() {}
void tearDown() {}

void test_good_profile_passes() {
    auto errors = validate(goodProfile(), SafetyLimits{});
    TEST_ASSERT_EQUAL(0, errors.size());
}

void test_pressure_above_10_bar_rejected() {
    auto p = goodProfile();
    p.phases[1].pressure = 10.5f;
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "pressure 10.5 bar"));
}

void test_user_cannot_raise_pressure_ceiling() {
    SafetyLimits loose;
    loose.maxPressure = 12;
    auto p = goodProfile();
    p.phases[1].pressure = 11;
    TEST_ASSERT_FALSE(validate(p, loose).empty());
}

void test_temperature_above_96_rejected() {
    auto p = goodProfile();
    p.temperature = 97;
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "Temperature 97.0"));
    p.temperature = 93;
    p.phases[1].temperature = 98;
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "temperature 98.0"));
}

void test_flow_phase_without_pressure_cap_rejected() {
    auto p = goodProfile();
    p.phases[1].pressureMode = false;
    p.phases[1].flow = 2;
    p.phases[1].pressure = 0; // 0 = no cap in GaggiMate
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "need a pressure limit"));
    p.phases[1].pressure = 9;
    TEST_ASSERT_EQUAL(0, validate(p, SafetyLimits{}).size());
}

void test_pump_percent_rejected_but_pause_allowed() {
    auto p = goodProfile();
    p.phases[0].simplePump = true;
    p.phases[0].simplePercent = 100;
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "pump-percent"));
    p.phases[0].simplePercent = 0; // pump off: a pause / bloom
    TEST_ASSERT_EQUAL(0, validate(p, SafetyLimits{}).size());
}

void test_preinfusion_pressure_limited() {
    auto p = goodProfile();
    p.phases[0].pressure = 6;
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "at most 4.0 bar"));
}

void test_needs_yield_stop_and_time_caps() {
    auto p = goodProfile();
    p.phases[1].targets.clear();
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "yield"));
    p = goodProfile();
    p.phases[1].duration = 70;
    TEST_ASSERT_FALSE(validate(p, SafetyLimits{}).empty());
    p = goodProfile();
    p.type = "standard";
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "\"pro\""));
}

void test_first_phase_cannot_hold_measured_value() {
    auto p = goodProfile();
    p.phases[0].pressure = -1;
    TEST_ASSERT_FALSE(validate(p, SafetyLimits{}).empty());
    p = goodProfile();
    p.phases[1].pressure = -1; // later phase may hold
    TEST_ASSERT_EQUAL(0, validate(p, SafetyLimits{}).size());
}

void test_one_change_per_shot() {
    auto prev = goodProfile();
    auto next = goodProfile();
    next.temperature = 94; // +1 °C: fine
    TEST_ASSERT_EQUAL(0, validate(next, SafetyLimits{}, &prev).size());
    next.phases[1].pressure = 8.5f; // second variable
    TEST_ASSERT_TRUE(hasErrorContaining(validate(next, SafetyLimits{}, &prev), "settings at once"));
}

void test_step_sizes() {
    auto prev = goodProfile();
    auto next = goodProfile();
    next.temperature = 96; // +3 °C
    TEST_ASSERT_TRUE(hasErrorContaining(validate(next, SafetyLimits{}, &prev), "at most 2.0 °C per shot"));
    next = goodProfile();
    next.phases[1].pressure = 7; // -2 bar
    TEST_ASSERT_TRUE(hasErrorContaining(validate(next, SafetyLimits{}, &prev), "at most 1.0 bar per shot"));
    next = goodProfile();
    next.phases[1].targets[0].value = 42; // +6 g
    TEST_ASSERT_TRUE(hasErrorContaining(validate(next, SafetyLimits{}, &prev), "Yield changes by 6.0"));
}

void test_structure_change_needs_new_profile() {
    auto prev = goodProfile();
    auto next = goodProfile();
    next.phases.push_back(pressurePhase(6, 5));
    TEST_ASSERT_TRUE(hasErrorContaining(validate(next, SafetyLimits{}, &prev), "new profile"));
}

static ProfileSpec salamiProfile(int cups, float waterPerCup) {
    ProfileSpec s;
    s.type = "pro";
    s.salami = true;
    s.temperature = 93;
    s.phases.push_back(pressurePhase(3, 6, true));
    for (int i = 0; i < cups; i++) {
        PhaseSpec cup = pressurePhase(9, 12);
        cup.name = "Cup " + std::to_string(i + 1);
        cup.targets.push_back({TargetKind::Pumped, waterPerCup});
        s.phases.push_back(cup);
    }
    return s;
}

void test_salami_without_yield_stop_allowed() {
    TEST_ASSERT_EQUAL(0, validate(salamiProfile(4, 15), SafetyLimits{}).size());
}

void test_salami_cups_need_water_stop_and_limits() {
    auto p = salamiProfile(4, 15);
    p.phases[2].targets.clear();
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "must end after"));
    TEST_ASSERT_FALSE(validate(salamiProfile(4, 35), SafetyLimits{}).empty()); // cup too big
    TEST_ASSERT_TRUE(hasErrorContaining(validate(salamiProfile(1, 15), SafetyLimits{}), "at least 2 cups"));
    auto hot = salamiProfile(4, 15);
    hot.phases[1].pressure = 11; // pressure limits still apply
    TEST_ASSERT_FALSE(validate(hot, SafetyLimits{}).empty());
    auto longShot = salamiProfile(5, 15);
    for (auto &ph : longShot.phases)
        ph.duration = 15; // 75 s total
    TEST_ASSERT_TRUE(hasErrorContaining(validate(longShot, SafetyLimits{}), "Total of phase times"));
}

void test_normal_profile_still_needs_yield_stop() {
    auto p = salamiProfile(4, 15);
    p.salami = false;
    TEST_ASSERT_TRUE(hasErrorContaining(validate(p, SafetyLimits{}), "yield"));
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_good_profile_passes);
    RUN_TEST(test_pressure_above_10_bar_rejected);
    RUN_TEST(test_user_cannot_raise_pressure_ceiling);
    RUN_TEST(test_temperature_above_96_rejected);
    RUN_TEST(test_flow_phase_without_pressure_cap_rejected);
    RUN_TEST(test_pump_percent_rejected_but_pause_allowed);
    RUN_TEST(test_preinfusion_pressure_limited);
    RUN_TEST(test_needs_yield_stop_and_time_caps);
    RUN_TEST(test_first_phase_cannot_hold_measured_value);
    RUN_TEST(test_one_change_per_shot);
    RUN_TEST(test_step_sizes);
    RUN_TEST(test_structure_change_needs_new_profile);
    RUN_TEST(test_salami_without_yield_stop_allowed);
    RUN_TEST(test_salami_cups_need_water_stop_and_limits);
    RUN_TEST(test_normal_profile_still_needs_yield_stop);
    return UNITY_END();
}
