#include <algorithm>
#include <iostream>

struct Command {
    enum class Mode { Damping, Position } mode;
    double target;
};

Command controlStep(double action, double telemetryAge, double defaultPos) {
    std::clog << "received a control step\n";
    if (telemetryAge > 0.1) {
        return {Command::Mode::Damping, 0.0};
    }

    constexpr double actionScale = 0.25;
    const double target =
        defaultPos +
        actionScale * action;
    return {Command::Mode::Position, std::clamp(target, -1.5, 1.5)};
}
