"""A small position controller used to try First Read."""

import logging

logger = logging.getLogger(__name__)


def control_step(action: float, telemetry_age: float, default_pos: float) -> dict:
    logger.debug("received a control step")
    if telemetry_age > 0.1:
        return {"mode": "damping", "target": None}

    action_scale = 0.25
    target = (
        default_pos
        + action_scale * action
    )
    limited_target = min(1.5, max(-1.5, target))
    return {"mode": "position", "target": limited_target}
