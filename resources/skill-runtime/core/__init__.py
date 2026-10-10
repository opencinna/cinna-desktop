"""
Cinna Desktop's stand-in for cinna-core's env-side ``core`` package.

Only ``core.cinna_api`` is provided, and of it only the credentials accessor
skill scripts use (``from core.cinna_api import credentials, CredentialMissing``).
Desktop puts the folder holding this package on ``PYTHONPATH`` for a kit
agent's engine. A top-level ``core`` package of the agent's own (in its folder
or on its own path) may shadow this one, and the other way round.
"""
