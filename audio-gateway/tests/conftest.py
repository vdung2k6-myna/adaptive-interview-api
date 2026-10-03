"""Load this service's module under a name unique to this service.

Both services in this repository ship a `main.py`, so their test suites cannot
both `import main` in one pytest run: whichever directory reached `sys.path`
last would win, and the other suite would silently exercise the wrong module.
Loading by path under a distinct name keeps each suite correct on its own and
together.
"""

import importlib.util
import sys
from pathlib import Path

_SERVICE_DIR = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location(
    "audio_gateway_main", _SERVICE_DIR / "main.py"
)
assert _spec is not None and _spec.loader is not None

module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = module
_spec.loader.exec_module(module)
