#ifndef DIALIN_SAFETYVALIDATOR_H
#define DIALIN_SAFETYVALIDATOR_H

// Safety checks for profiles written by the Dial-in assistant.
// Plain C++17 with no Arduino dependencies, so it can be unit-tested natively
// (test/test_dialin_safety). DialInPlugin converts GaggiMate's Profile into the
// specs below before calling validate().

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace dialin {

// Absolute ceilings. User settings can only be tighter than these.
struct HardLimits {
    static constexpr float maxPressure = 10.0f;            // bar
    static constexpr float maxPreinfusionPressure = 4.0f;  // bar
    static constexpr float minTemperature = 80.0f;         // °C
    static constexpr float maxTemperature = 96.0f;         // °C
    static constexpr float minFlow = 0.5f;                 // g/s
    static constexpr float maxFlow = 4.0f;                 // g/s
    static constexpr float maxPhaseDuration = 60.0f;       // s
    static constexpr float maxTotalDuration = 60.0f;       // s
    static constexpr float maxYield = 60.0f;               // g
    static constexpr int maxPhases = 8;
};

struct SafetyLimits {
    float maxPressure = 10.0f;
    float maxPreinfusionPressure = 4.0f;
    float minTemperature = 85.0f;
    float maxTemperature = 96.0f;
    float minFlow = 0.5f;
    float maxFlow = 4.0f;
    float maxPhaseDuration = 60.0f;
    float maxTotalDuration = 60.0f;
    float maxYield = 60.0f;
    int maxPhases = 8;
    // Largest change allowed between the stored profile and the new one.
    float maxTemperatureStep = 2.0f;
    float maxPressureStep = 1.0f;
    float maxFlowStep = 0.5f;
    float maxDurationStep = 5.0f;
    float maxYieldStep = 4.0f;
    int maxChangedVariables = 1;

    // Pull every value inside the hard limits (tighten-only).
    void clampToHard() {
        maxPressure = std::clamp(maxPressure, 0.0f, HardLimits::maxPressure);
        maxPreinfusionPressure = std::clamp(maxPreinfusionPressure, 0.0f, std::min(HardLimits::maxPreinfusionPressure, maxPressure));
        maxTemperature = std::clamp(maxTemperature, HardLimits::minTemperature, HardLimits::maxTemperature);
        minTemperature = std::clamp(minTemperature, HardLimits::minTemperature, maxTemperature);
        maxFlow = std::clamp(maxFlow, HardLimits::minFlow, HardLimits::maxFlow);
        minFlow = std::clamp(minFlow, HardLimits::minFlow, maxFlow);
        maxPhaseDuration = std::clamp(maxPhaseDuration, 1.0f, HardLimits::maxPhaseDuration);
        maxTotalDuration = std::clamp(maxTotalDuration, 1.0f, HardLimits::maxTotalDuration);
        maxYield = std::clamp(maxYield, 1.0f, HardLimits::maxYield);
        maxPhases = std::clamp(maxPhases, 1, HardLimits::maxPhases);
        maxTemperatureStep = std::max(0.0f, maxTemperatureStep);
        maxPressureStep = std::max(0.0f, maxPressureStep);
        maxFlowStep = std::max(0.0f, maxFlowStep);
        maxDurationStep = std::max(0.0f, maxDurationStep);
        maxYieldStep = std::max(0.0f, maxYieldStep);
        maxChangedVariables = std::max(1, maxChangedVariables);
    }
};

enum class TargetKind { Volumetric, Pressure, Flow, Pumped };

struct TargetSpec {
    TargetKind kind;
    float value;
};

struct PhaseSpec {
    std::string name;
    bool preinfusion = false;
    float duration = 0;
    bool simplePump = false;
    int simplePercent = 0;
    bool pressureMode = true; // advanced pump: true = pressure setpoint, false = flow setpoint
    float pressure = 0;       // bar; -1 = hold measured value
    float flow = 0;           // g/s; -1 = hold measured value; 0 = no cap (pressure mode only)
    float temperature = 0;    // °C; 0 = inherit profile temperature
    std::vector<TargetSpec> targets;
};

struct ProfileSpec {
    std::string type; // "standard" | "pro"
    bool utility = false;
    float temperature = 0;
    std::vector<PhaseSpec> phases;
};

namespace detail {

inline std::string fmt(float v) {
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%.1f", v);
    return buf;
}

inline std::string phaseLabel(size_t i, const PhaseSpec &p) {
    std::string s = "Phase " + std::to_string(i + 1);
    if (!p.name.empty())
        s += " (" + p.name + ")";
    return s;
}

inline float effectiveTemp(const ProfileSpec &profile, const PhaseSpec &phase) {
    return phase.temperature > 0 ? phase.temperature : profile.temperature;
}

inline float yieldOf(const ProfileSpec &profile) {
    float y = 0;
    for (const auto &ph : profile.phases)
        for (const auto &t : ph.targets)
            if (t.kind == TargetKind::Volumetric)
                y = std::max(y, t.value);
    return y;
}

constexpr float kTolerance = 0.001f;

} // namespace detail

// Returns human-readable problems; empty means the profile is safe to save.
// `previous` is the currently stored version of the same profile, if any.
inline std::vector<std::string> validate(const ProfileSpec &profile, const SafetyLimits &limitsIn,
                                         const ProfileSpec *previous = nullptr) {
    using detail::kTolerance;
    using detail::fmt;
    SafetyLimits L = limitsIn;
    L.clampToHard();
    std::vector<std::string> errors;

    if (profile.type != "pro")
        errors.push_back("Profile type must be \"pro\" so every phase time limit is enforced.");
    if (profile.utility)
        errors.push_back("Utility profiles (cleaning, flushing) can't be changed by the assistant.");
    if (profile.phases.empty())
        errors.push_back("Profile has no phases.");
    if ((int)profile.phases.size() > L.maxPhases)
        errors.push_back("Too many phases: " + std::to_string(profile.phases.size()) + " (max " + std::to_string(L.maxPhases) + ").");
    if (profile.temperature < L.minTemperature - kTolerance || profile.temperature > L.maxTemperature + kTolerance)
        errors.push_back("Temperature " + fmt(profile.temperature) + " °C is outside " + fmt(L.minTemperature) + "–" +
                         fmt(L.maxTemperature) + " °C.");

    float total = 0;
    bool hasYieldStop = false;
    for (size_t i = 0; i < profile.phases.size(); i++) {
        const auto &ph = profile.phases[i];
        const std::string label = detail::phaseLabel(i, ph);
        const float pressureCap = ph.preinfusion ? L.maxPreinfusionPressure : L.maxPressure;

        if (ph.duration <= 0 || ph.duration > L.maxPhaseDuration + kTolerance)
            errors.push_back(label + ": duration " + fmt(ph.duration) + " s must be above 0 and at most " + fmt(L.maxPhaseDuration) + " s.");
        total += std::max(0.0f, ph.duration);

        if (ph.temperature != 0 && (ph.temperature < L.minTemperature - kTolerance || ph.temperature > L.maxTemperature + kTolerance))
            errors.push_back(label + ": temperature " + fmt(ph.temperature) + " °C is outside " + fmt(L.minTemperature) + "–" +
                             fmt(L.maxTemperature) + " °C.");

        if (ph.simplePump) {
            if (ph.simplePercent != 0)
                errors.push_back(label + ": pump-percent phases have no pressure limit; use pressure or flow control.");
        } else if (ph.pressureMode) {
            if (ph.pressure == -1) {
                if (i == 0)
                    errors.push_back(label + ": the first phase can't hold a measured pressure; set a value.");
            } else if (ph.pressure <= 0 || ph.pressure > pressureCap + kTolerance) {
                errors.push_back(label + ": pressure " + fmt(ph.pressure) + " bar must be above 0 and at most " + fmt(pressureCap) + " bar.");
            }
            if (ph.flow != 0 && ph.flow != -1 && (ph.flow < 0 || ph.flow > L.maxFlow + kTolerance))
                errors.push_back(label + ": flow limit " + fmt(ph.flow) + " g/s is above " + fmt(L.maxFlow) + " g/s.");
        } else {
            if (ph.flow == -1) {
                if (i == 0)
                    errors.push_back(label + ": the first phase can't hold a measured flow; set a value.");
            } else if (ph.flow < L.minFlow - kTolerance || ph.flow > L.maxFlow + kTolerance) {
                errors.push_back(label + ": flow " + fmt(ph.flow) + " g/s is outside " + fmt(L.minFlow) + "–" + fmt(L.maxFlow) + " g/s.");
            }
            if (ph.pressure <= 0 || ph.pressure > pressureCap + kTolerance)
                errors.push_back(label + ": flow-controlled phases need a pressure limit above 0 and at most " + fmt(pressureCap) +
                                 " bar (0 would mean no limit).");
        }

        for (const auto &t : ph.targets) {
            if (t.kind == TargetKind::Volumetric) {
                hasYieldStop = true;
                if (t.value <= 0 || t.value > L.maxYield + kTolerance)
                    errors.push_back(label + ": yield target " + fmt(t.value) + " g must be above 0 and at most " + fmt(L.maxYield) + " g.");
            } else if (t.kind == TargetKind::Pressure && t.value > L.maxPressure + kTolerance) {
                errors.push_back(label + ": pressure stop condition " + fmt(t.value) + " bar is above " + fmt(L.maxPressure) + " bar.");
            }
        }
    }
    if (total > L.maxTotalDuration + kTolerance)
        errors.push_back("Total of phase times is " + fmt(total) + " s; the limit is " + fmt(L.maxTotalDuration) + " s.");
    if (!profile.phases.empty() && !hasYieldStop)
        errors.push_back("Profile needs a yield (weight) target so the shot stops on the scale.");

    // Change-per-shot limits against the stored version.
    if (previous && errors.empty()) {
        if (previous->phases.size() != profile.phases.size()) {
            errors.push_back("Phase count changed; save this as a new profile instead of editing the existing one.");
            return errors;
        }
        bool changedTemp = false, changedPressure = false, changedFlow = false, changedDuration = false, changedYield = false;
        float dt = std::fabs(profile.temperature - previous->temperature);
        if (dt > kTolerance)
            changedTemp = true;
        if (dt > L.maxTemperatureStep + kTolerance)
            errors.push_back("Temperature changes by " + fmt(dt) + " °C; at most " + fmt(L.maxTemperatureStep) + " °C per shot.");
        for (size_t i = 0; i < profile.phases.size(); i++) {
            const auto &a = previous->phases[i];
            const auto &b = profile.phases[i];
            const std::string label = detail::phaseLabel(i, b);
            if (a.simplePump != b.simplePump || (!a.simplePump && a.pressureMode != b.pressureMode)) {
                errors.push_back(label + ": control mode changed; save this as a new profile instead.");
                continue;
            }
            float pdt = std::fabs(detail::effectiveTemp(profile, b) - detail::effectiveTemp(*previous, a));
            if (pdt > kTolerance)
                changedTemp = true;
            if (pdt > L.maxTemperatureStep + kTolerance)
                errors.push_back(label + ": temperature changes by " + fmt(pdt) + " °C; at most " + fmt(L.maxTemperatureStep) + " °C per shot.");
            if (!b.simplePump) {
                float dp = std::fabs(b.pressure - a.pressure);
                if (dp > kTolerance)
                    changedPressure = true;
                if (dp > L.maxPressureStep + kTolerance)
                    errors.push_back(label + ": pressure changes by " + fmt(dp) + " bar; at most " + fmt(L.maxPressureStep) + " bar per shot.");
                float df = std::fabs(b.flow - a.flow);
                if (df > kTolerance)
                    changedFlow = true;
                if (df > L.maxFlowStep + kTolerance)
                    errors.push_back(label + ": flow changes by " + fmt(df) + " g/s; at most " + fmt(L.maxFlowStep) + " g/s per shot.");
            }
            float dd = std::fabs(b.duration - a.duration);
            if (dd > kTolerance)
                changedDuration = true;
            if (dd > L.maxDurationStep + kTolerance)
                errors.push_back(label + ": time changes by " + fmt(dd) + " s; at most " + fmt(L.maxDurationStep) + " s per shot.");
        }
        float dy = std::fabs(detail::yieldOf(profile) - detail::yieldOf(*previous));
        if (dy > kTolerance)
            changedYield = true;
        if (dy > L.maxYieldStep + kTolerance)
            errors.push_back("Yield changes by " + fmt(dy) + " g; at most " + fmt(L.maxYieldStep) + " g per shot.");
        int changed = changedTemp + changedPressure + changedFlow + changedDuration + changedYield;
        if (changed > L.maxChangedVariables)
            errors.push_back("Changes " + std::to_string(changed) + " settings at once; at most " + std::to_string(L.maxChangedVariables) +
                             " per shot, so each change can be judged by taste.");
    }
    return errors;
}

} // namespace dialin

#endif // DIALIN_SAFETYVALIDATOR_H
